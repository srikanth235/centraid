import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import {
  createSeatBlobPresence,
  readSeatBlob,
  recordSeatBlob,
} from "./blob-presence.js";
import type { SeatSnapshotTransport } from "./bootstrap.js";
import {
  readSeatCarryOver,
  shasPendingIntentsNeed,
  writeSeatCarryOver,
} from "./carry-over.js";
import { openSeatFile } from "./driver.js";
import { NodeSeatDriver } from "./node-seat-driver.js";
import { nodeSeatStaging } from "./node-staging.js";
import {
  addSeatOutboxIntent,
  createSeatOutbox,
  readSeatOutbox,
} from "./outbox.js";
import { readSeatState } from "./state.js";
import { seatWatermark, seatWatermarkLine } from "./watermark.js";
import { SeatWorkerCore } from "./worker-core.js";

function artifact(root: string): Uint8Array {
  const source = path.join(root, "source.db");
  const db = new DatabaseSync(source);
  db.exec(`
    CREATE TABLE note (note_id TEXT PRIMARY KEY, title TEXT NOT NULL) STRICT;
    INSERT INTO note VALUES ('n1', 'from the gateway');
  `);
  db.close();
  return gzipSync(readFileSync(source));
}

function transport(bytes: Uint8Array, seq: number): SeatSnapshotTransport {
  return {
    head: () =>
      Promise.resolve({
        etag: `"e1-${seq}"`,
        bytes: bytes.byteLength,
        seq,
        epoch: "e1",
        schemaEpoch: 2,
      }),
    range: (start: number) => ({
      async *[Symbol.asyncIterator]() {
        yield bytes.subarray(start);
      },
    }),
  };
}

const OPEN = {
  vaultId: "vault-1",
  dbName: "/seat.db",
  remember: true,
} as const;

function worker(root: string): SeatWorkerCore {
  const bytes = artifact(root);
  return new SeatWorkerCore({
    openDatabase: () => new NodeSeatDriver(path.join(root, "seat.db")),
    staging: () =>
      nodeSeatStaging({
        directory: path.join(root, "staging"),
        databasePath: path.join(root, "seat.db"),
      }),
    transport: () => transport(bytes, 7),
  });
}

describe("what survives a re-bootstrap", () => {
  it("carries a pending intent, its order and its pins across the swap", async () => {
    const root = tempDirSync("seat-carry-");
    const core = worker(root);
    await core.open(OPEN);
    await core.bootstrap({ vaultId: "vault-1", snapshotUrl: "/snapshot" });

    // The seat's own state: queued work and held bytes. Neither exists at the
    // gateway, and the new file is a copy of the gateway.
    const driver = new NodeSeatDriver(path.join(root, "seat.db"));
    createSeatOutbox(driver);
    createSeatBlobPresence(driver);
    addSeatOutboxIntent(driver, {
      intentId: "i-2",
      appId: "notes",
      action: "notes.rename_note",
      input: { noteId: "n1", title: "renamed on a train" },
      payloadHash: "h2",
      dependsOn: ["i-1"],
      needsBlobs: ["sha-capture"],
      createdOrder: 2,
    });
    addSeatOutboxIntent(driver, {
      intentId: "i-1",
      appId: "notes",
      action: "notes.create_note",
      input: { title: "made offline" },
      payloadHash: "h1",
      createdOrder: 1,
    });
    recordSeatBlob(driver, {
      sha: "sha-capture",
      kind: "original",
      byteSize: 2_048,
      capturedHere: true,
    });
    recordSeatBlob(driver, {
      sha: "sha-pinned",
      kind: "preview",
      byteSize: 512,
      pinned: true,
    });
    driver.close();

    // Re-bootstrap: the file is replaced whole.
    await core.open(OPEN);
    await core.bootstrap({ vaultId: "vault-1", snapshotUrl: "/snapshot" });

    const after = new NodeSeatDriver(path.join(root, "seat.db"));
    openSeatFile(after);
    const outbox = readSeatOutbox(after);
    expect(outbox.map((row) => row.intentId)).toStrictEqual(["i-1", "i-2"]);
    // VERBATIM ORDER: a re-bootstrap that renumbers the queue reorders the
    // member's work.
    expect(outbox.map((row) => row.createdOrder)).toStrictEqual([1, 2]);
    expect(outbox[1]?.dependsOn).toStrictEqual(["i-1"]);
    expect(outbox[1]?.needsBlobs).toStrictEqual(["sha-capture"]);
    expect(readSeatBlob(after, "sha-pinned")?.pinned).toBe(true);
    expect(readSeatBlob(after, "sha-capture")?.capturedHere).toBe(true);
    // And the file itself really was replaced.
    expect(readSeatState(after).appliedSeq).toBe(7);
    after.close();
    core.close();
  });

  it("names the hashes no eviction may touch, and forgets them once settled", () => {
    const driver = new NodeSeatDriver();
    openSeatFile(driver);
    createSeatOutbox(driver);
    addSeatOutboxIntent(driver, {
      intentId: "i-1",
      appId: "photos",
      action: "photos.upload",
      input: {},
      payloadHash: "h1",
      needsBlobs: ["sha-a"],
    });
    addSeatOutboxIntent(driver, {
      intentId: "i-2",
      appId: "photos",
      action: "photos.upload",
      input: {},
      payloadHash: "h2",
      needsBlobs: ["sha-b"],
      state: "executed",
    });
    expect(
      shasPendingIntentsNeed({ outbox: readSeatOutbox(driver) }).sort()
    ).toStrictEqual(["sha-a"]);
    driver.close();
  });

  it("treats an absent table as nothing to save, not a failed repair", () => {
    const driver = new NodeSeatDriver();
    openSeatFile(driver);
    const carried = readSeatCarryOver(driver);
    expect(carried).toStrictEqual({ outbox: [], blobs: [], contents: "full" });
    writeSeatCarryOver(driver, carried);
    expect(readSeatOutbox(driver)).toStrictEqual([]);
    driver.close();
  });
});

describe("the seat watermark", () => {
  it("is a distance in log positions, and says when waiting will not fix it", () => {
    const base = {
      vaultId: "v",
      epoch: "e1",
      schemaEpoch: 2,
      ddlVersion: 0,
      appliedCommitSeq: 3,
      contents: "full" as const,
    };
    expect(
      seatWatermarkLine(
        seatWatermark({
          ...base,
          appliedSeq: 1_000,
          gatewayWatermark: 1_000,
          deferredFrom: undefined,
        })
      )
    ).toBe("up to date");
    expect(
      seatWatermarkLine(
        seatWatermark({
          ...base,
          appliedSeq: 1_000,
          gatewayWatermark: 1_001,
          deferredFrom: undefined,
        })
      )
    ).toBe("1 change behind");
    expect(
      seatWatermarkLine(
        seatWatermark({
          ...base,
          appliedSeq: 1_000,
          gatewayWatermark: 2_204,
          deferredFrom: undefined,
        })
      )
    ).toBe("1,204 changes behind");
    // A deferred span does not clear by waiting, so it is said instead.
    expect(
      seatWatermarkLine(
        seatWatermark({
          ...base,
          appliedSeq: 2_204,
          gatewayWatermark: 2_204,
          deferredFrom: 900,
        })
      )
    ).toBe("a large update is waiting for wifi");
    expect(seatWatermarkLine(undefined)).toBeUndefined();
  });

  it("never reports a negative distance from a stale head", () => {
    const watermark = seatWatermark({
      vaultId: "v",
      epoch: "e1",
      schemaEpoch: 2,
      ddlVersion: 0,
      appliedSeq: 50,
      appliedCommitSeq: 3,
      gatewayWatermark: 10,
      deferredFrom: undefined,
      contents: "full",
    });
    expect(watermark.behind).toBe(0);
    expect(watermark.head).toBe(50);
  });
});
