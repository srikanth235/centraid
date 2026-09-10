import path from "node:path";

import { describe, expect, it } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { applySeatLogPage } from "./applier.js";
import {
  createSeatBlobPresence,
  readSeatBlob,
  recordSeatBlob,
} from "./blob-presence.js";
import {
  parseSeatCarryOver,
  readSeatCarryOver,
  seatCarryOverApplied,
  serializeSeatCarryOver,
  shasPendingIntentsNeed,
  writeSeatCarryOver,
} from "./carry-over.js";
import { openSeatFile } from "./driver.js";
import { NodeSeatDriver } from "./node-seat-driver.js";
import { nodeSeatCarryOverSidecar, nodeSeatStaging } from "./node-staging.js";
import {
  addSeatOutboxIntent,
  createSeatOutbox,
  readSeatOutbox,
} from "./outbox.js";
import {
  seatArtifact,
  seatArtifactTransport,
} from "./seat-artifact.test-fixtures.js";
import {
  clearSeatOverlaysAtCommit,
  SeatIntentStore,
  seatOverlayClearingHook,
} from "./seat-intent-store.js";
import { initSeatState, readSeatState } from "./state.js";
import { seatWatermark, seatWatermarkLine } from "./watermark.js";
import { SeatWorkerCore } from "./worker-core.js";

const OPEN = {
  vaultId: "vault-1",
  dbName: "/seat.db",
  remember: true,
} as const;

function worker(
  root: string,
  install?: (run: () => Promise<void>) => Promise<void>,
  artifact?: Uint8Array
): SeatWorkerCore {
  // The fixture builds a source database in `root`, so it is built ONCE per
  // root and handed back in for every later worker over the same seat.
  const bytes = artifact ?? seatArtifact(root);
  const databasePath = path.join(root, "seat.db");
  return new SeatWorkerCore({
    openDatabase: () => new NodeSeatDriver(databasePath),
    staging: () => {
      const staging = nodeSeatStaging({
        directory: path.join(root, "staging"),
        databasePath,
      });
      if (!install) return staging;
      return {
        ...staging,
        install: (etag, prepare) =>
          install(() => staging.install(etag, prepare)),
      };
    },
    carryOver: () => nodeSeatCarryOverSidecar(databasePath),
    transport: () => seatArtifactTransport(bytes, 7),
  });
}

/** What a phone killed mid-swap leaves behind, without killing the runner. */
class KilledError extends Error {
  override readonly name = "KilledError";
}

function queueOne(root: string, intentId: string): void {
  const driver = new NodeSeatDriver(path.join(root, "seat.db"));
  createSeatOutbox(driver);
  addSeatOutboxIntent(driver, {
    intentId,
    appId: "notes",
    action: "notes.create_note",
    input: { title: "made on a train" },
    payloadHash: `h-${intentId}`,
    createdOrder: 1,
  });
  driver.close();
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

  it("keeps the queue when the process dies between install and write-back", async () => {
    const root = tempDirSync("seat-carry-kill-");
    const bytes = seatArtifact(root);
    const first = worker(root, undefined, bytes);
    await first.open(OPEN);
    await first.bootstrap({ vaultId: "vault-1", snapshotUrl: "/s" });
    first.close();
    queueOne(root, "i-train");

    // THE KILL (#1014, C5/T6). The install lands — on native it has already
    // deleted the old file — and the process dies before `writeSeatCarryOver`.
    // Before the sidecar this lost `i-train` with no way back.
    const dying = worker(
      root,
      async (run) => {
        await run();
        throw new KilledError("killed after install");
      },
      bytes
    );
    await dying.open(OPEN);
    await expect(
      dying.bootstrap({ vaultId: "vault-1", snapshotUrl: "/s" })
    ).rejects.toThrow(KilledError);

    // The new file is in place and has no queue in it: the stash is the only
    // copy at this instant, which is exactly what it is for.
    const swapped = new NodeSeatDriver(path.join(root, "seat.db"));
    openSeatFile(swapped);
    createSeatOutbox(swapped);
    expect(readSeatOutbox(swapped)).toStrictEqual([]);
    swapped.close();

    // The next open replays it — and the intent is whole, not a stub.
    const reopened = worker(root, undefined, bytes);
    await reopened.open(OPEN);
    const outbox = readSeatOutbox(
      (reopened as unknown as { required: () => NodeSeatDriver }).required()
    );
    expect(outbox.map((row) => row.intentId)).toStrictEqual(["i-train"]);
    expect(outbox[0]?.input).toStrictEqual({ title: "made on a train" });
    expect(outbox[0]?.createdOrder).toBe(1);
    reopened.close();
  });

  it("never replays a stash the file has already taken", async () => {
    const root = tempDirSync("seat-carry-once-");
    const bytes = seatArtifact(root);
    const first = worker(root, undefined, bytes);
    await first.open(OPEN);
    await first.bootstrap({ vaultId: "vault-1", snapshotUrl: "/s" });
    first.close();
    queueOne(root, "i-drained");

    const core = worker(root, undefined, bytes);
    await core.open(OPEN);
    await core.bootstrap({ vaultId: "vault-1", snapshotUrl: "/s" });
    core.close();

    // The write-back committed, and then the clear did not happen — the one
    // non-atomic step left. Put the stash back to stand for that crash.
    const driver = new NodeSeatDriver(path.join(root, "seat.db"));
    openSeatFile(driver);
    const carried = readSeatCarryOver(driver);
    const stash = serializeSeatCarryOver(carried, "vault-1");
    const token = parseSeatCarryOver(stash, "vault-1")?.token;
    expect(token).toBeDefined();
    expect(seatCarryOverApplied(driver, token as string)).toBe(true);
    // The seat then drains it, as it would have.
    driver.run(`DELETE FROM seat_outbox WHERE intent_id = 'i-drained'`);
    driver.close();
    await nodeSeatCarryOverSidecar(path.join(root, "seat.db")).write(stash);

    const reopened = worker(root, undefined, bytes);
    await reopened.open(OPEN);
    // A settled intent is NOT resurrected: the marker in the file says this
    // stash already landed.
    expect(
      readSeatOutbox(
        (reopened as unknown as { required: () => NodeSeatDriver }).required()
      )
    ).toStrictEqual([]);
    await expect(
      nodeSeatCarryOverSidecar(path.join(root, "seat.db")).read()
    ).resolves.toBeUndefined();
    reopened.close();
  });

  it("refuses to replay a stash that belongs to another vault", () => {
    const stash = serializeSeatCarryOver(
      { outbox: [], blobs: [], contents: "full" },
      "vault-family"
    );
    expect(parseSeatCarryOver(stash, "vault-personal")).toBeUndefined();
    expect(parseSeatCarryOver(stash, "vault-family")?.vaultId).toBe(
      "vault-family"
    );
    expect(parseSeatCarryOver("{ not json", "vault-family")).toBeUndefined();
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

describe("the overlay clears in the transaction that carries its commit", () => {
  it("settles inside the applier's own transaction, not after it", () => {
    const driver = new NodeSeatDriver();
    openSeatFile(driver);
    driver.exec(`
      CREATE TABLE note (note_id TEXT PRIMARY KEY, title TEXT NOT NULL) STRICT;
    `);
    initSeatState(driver, {
      vaultId: "vault-1",
      epoch: "e1",
      schemaEpoch: 2,
      appliedSeq: 10,
    });
    const store = SeatIntentStore.create(driver);
    driver.run(
      `INSERT INTO seat_outbox (intent_id, created_order, app_id, action,
         input_json, payload_hash, state, attempts, depends_on_json,
         base_versions_json, optimistic_json, commit_seq, waiting_on_json,
         needs_blobs_json, enqueued_at, updated_at, record_json)
       VALUES ('i-1', 1, 'notes', 'notes.create_note', '{}', 'h', 'awaiting-change',
               1, NULL, NULL, NULL, 7, NULL, NULL, '2026-01-01T00:00:00.000Z',
               '2026-01-01T00:00:00.000Z', ?)`,
      [
        JSON.stringify({
          intentId: "i-1",
          createdOrder: 1,
          appId: "notes",
          action: "notes.create_note",
          input: {},
          payloadHash: "h",
          state: "awaiting-change",
          attempts: 1,
          optimistic: [],
          commitSeq: 7,
        }),
      ]
    );

    const seen: number[] = [];
    const result = applySeatLogPage(
      driver,
      {
        vaultId: "vault-1",
        epoch: "e1",
        schemaEpoch: 2,
        ddlVersion: 0,
        floor: 0,
        watermark: 11,
        next: 11,
        hasMore: false,
        rows: [
          {
            seq: 11,
            commitSeq: 7,
            schemaEpoch: 2,
            ddlVersion: 0,
            table: "note",
            op: "insert",
            pk: ["n1"],
            row: { note_id: "n1", title: "the row the intent made" },
            producer: "gateway",
            committedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
      {
        onCommitInTransaction: (commitSeq) => {
          seen.push(commitSeq);
          seatOverlayClearingHook(driver).inTransaction(commitSeq);
        },
      }
    );

    expect(result.applied).toBe(1);
    expect(seen).toStrictEqual([7]);
    // The row landed and the overlay went, together.
    expect(driver.all(`SELECT note_id FROM note`)).toStrictEqual([
      { note_id: "n1" },
    ]);
    expect(readSeatOutbox(driver)).toStrictEqual([]);
    expect(
      driver.all<{ intent_id: string }>(
        `SELECT intent_id FROM seat_outbox_settled`
      )
    ).toStrictEqual([{ intent_id: "i-1" }]);
    void store;
    driver.close();
  });

  it("leaves an overlay whose commit the cursor has not reached", () => {
    const driver = new NodeSeatDriver();
    openSeatFile(driver);
    SeatIntentStore.create(driver);
    addSeatOutboxIntent(driver, {
      intentId: "i-2",
      appId: "notes",
      action: "notes.create_note",
      input: {},
      payloadHash: "h2",
      state: "awaiting-change",
      commitSeq: 99,
    });
    expect(clearSeatOverlaysAtCommit(driver, 98)).toStrictEqual([]);
    expect(clearSeatOverlaysAtCommit(driver, 99)).toStrictEqual(["i-2"]);
    driver.close();
  });
});
