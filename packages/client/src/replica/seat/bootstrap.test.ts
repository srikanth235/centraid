import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import type { SeatSnapshotHead } from "@centraid/core/protocol";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { bootstrapSeatFile, seatBootstrapRoomRequired } from "./bootstrap.js";
import type { SeatSnapshotTransport } from "./bootstrap.js";
import { NodeSeatDriver } from "./node-seat-driver.js";
import { nodeSeatStaging } from "./node-staging.js";
import { SeatBootstrapNoRoomError } from "./seat-bootstrap-no-room-error.js";
import { SeatSnapshotMovedError } from "./seat-snapshot-moved-error.js";
import { readSeatState } from "./state.js";

function workspace(): string {
  return tempDirSync("seat-bootstrap-");
}

/** A gzipped SQLite file, the shape the snapshot door serves. */
function artifact(root: string): { bytes: Uint8Array; etag: string } {
  const source = path.join(root, "source.db");
  const db = new DatabaseSync(source);
  db.exec(`
    CREATE TABLE note (note_id TEXT PRIMARY KEY, title TEXT NOT NULL) STRICT;
    INSERT INTO note VALUES ('n1', 'gateway row'), ('n2', 'another');
    -- Enough rows that the compressed artifact spans several chunks: a resume
    -- test over a file that fits in one chunk proves nothing.
    WITH RECURSIVE bulk(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM bulk WHERE n < 4000)
    INSERT INTO note SELECT 'bulk-' || n, 'row ' || n || ' ' || hex(randomblob(24)) FROM bulk;
    CREATE VIRTUAL TABLE fts_note USING fts5(note_id UNINDEXED, title);
    INSERT INTO fts_note (note_id, title) SELECT note_id, title FROM note;
  `);
  db.close();
  return { bytes: gzipSync(readFileSync(source)), etag: '"e1-42"' };
}

interface StubOptions {
  /** Throw after this many chunks have been yielded — the killed worker. */
  readonly dieAfterChunks?: number;
  readonly chunkSize?: number;
  readonly etagOverride?: string;
}

function stubTransport(
  bytes: Uint8Array,
  etag: string,
  options: StubOptions = {}
): SeatSnapshotTransport & { readonly requestedStarts: number[] } {
  const starts: number[] = [];
  const size = options.chunkSize ?? 4_096;
  return {
    requestedStarts: starts,
    head: (): Promise<SeatSnapshotHead> =>
      Promise.resolve({
        etag: options.etagOverride ?? etag,
        bytes: bytes.byteLength,
        seq: 42,
        epoch: "e1",
        schemaEpoch: 2,
      }),
    range: (start: number): AsyncIterable<Uint8Array> => {
      starts.push(start);
      return {
        async *[Symbol.asyncIterator]() {
          let sent = 0;
          for (let at = start; at < bytes.byteLength; at += size) {
            if (
              options.dieAfterChunks !== undefined &&
              sent >= options.dieAfterChunks
            ) {
              throw new Error("worker died mid-download");
            }
            yield bytes.subarray(at, Math.min(at + size, bytes.byteLength));
            sent += 1;
          }
        },
      };
    },
  };
}

function staging(root: string): ReturnType<typeof nodeSeatStaging> {
  return nodeSeatStaging({
    directory: path.join(root, "staging"),
    databasePath: path.join(root, "seat.db"),
  });
}

/** The `open` seam, keeping every driver it hands out so the test can close them. */
function opener(root: string, drivers: NodeSeatDriver[]): () => NodeSeatDriver {
  return () => {
    const driver = new NodeSeatDriver(path.join(root, "seat.db"));
    drivers.push(driver);
    return driver;
  };
}

describe("seat file bootstrap", () => {
  it("downloads, installs, rebuilds FTS and records where the file sits", async () => {
    const root = workspace();
    const { bytes, etag } = artifact(root);
    const drivers: NodeSeatDriver[] = [];
    const result = await bootstrapSeatFile({
      transport: stubTransport(bytes, etag),
      staging: staging(root),
      vaultId: "vault-1",
      open: opener(root, drivers),
    });
    expect(result.seq).toBe(42);
    expect(result.resumedFrom).toBe(0);
    expect(result.ftsRebuilt).toStrictEqual(["fts_note"]);
    const driver = drivers.at(-1)!;
    expect(
      driver.all(
        `SELECT note_id FROM note WHERE note_id LIKE 'n%' ORDER BY note_id`
      )
    ).toStrictEqual([{ note_id: "n1" }, { note_id: "n2" }]);
    // The rebuilt index answers for the rows the file actually has.
    expect(
      driver.all(`SELECT note_id FROM fts_note WHERE fts_note MATCH 'gateway'`)
    ).toStrictEqual([{ note_id: "n1" }]);
    const state = readSeatState(driver);
    expect(state).toMatchObject({
      vaultId: "vault-1",
      epoch: "e1",
      schemaEpoch: 2,
      appliedSeq: 42,
      gatewayWatermark: 42,
      deferredFrom: undefined,
    });
    for (const held of drivers) held.close();
  });

  it("resumes by byte range after a killed worker instead of starting over", async () => {
    const root = workspace();
    const { bytes, etag } = artifact(root);
    const store = staging(root);
    const first = stubTransport(bytes, etag, {
      dieAfterChunks: 2,
      chunkSize: 1_024,
    });
    await expect(
      bootstrapSeatFile({
        transport: first,
        staging: store,
        vaultId: "vault-1",
        open: () => new NodeSeatDriver(path.join(root, "seat.db")),
      })
    ).rejects.toThrow(/worker died/u);
    expect(first.requestedStarts).toStrictEqual([0]);

    // A NEW staging object over the SAME directory: the resume survives the
    // process, not merely the object, which is the whole point.
    const second = stubTransport(bytes, etag, { chunkSize: 1_024 });
    const drivers: NodeSeatDriver[] = [];
    const result = await bootstrapSeatFile({
      transport: second,
      staging: staging(root),
      vaultId: "vault-1",
      open: opener(root, drivers),
    });
    expect(result.resumedFrom).toBe(2_048);
    expect(second.requestedStarts).toStrictEqual([2_048]);
    expect(drivers.at(-1)!.all(`SELECT count(*) AS n FROM note`)).toStrictEqual(
      [{ n: 4_002 }]
    );
    for (const held of drivers) held.close();
  });

  it("discards a staged prefix of a different artifact rather than splicing", async () => {
    const root = workspace();
    const { bytes, etag } = artifact(root);
    const store = staging(root);
    await expect(
      bootstrapSeatFile({
        transport: stubTransport(bytes, etag, {
          dieAfterChunks: 2,
          chunkSize: 1_024,
        }),
        staging: store,
        vaultId: "vault-1",
        open: () => new NodeSeatDriver(path.join(root, "seat.db")),
      })
    ).rejects.toThrow(/worker died/u);

    const moved = stubTransport(bytes, etag, {
      chunkSize: 1_024,
      etagOverride: '"e1-99"',
    });
    const drivers: NodeSeatDriver[] = [];
    const result = await bootstrapSeatFile({
      transport: moved,
      staging: staging(root),
      vaultId: "vault-1",
      open: opener(root, drivers),
    });
    expect(result.resumedFrom).toBe(0);
    expect(moved.requestedStarts).toStrictEqual([0]);
    for (const held of drivers) held.close();
  });

  it("refuses before the first byte when there is no room for both files", async () => {
    const root = workspace();
    const { bytes, etag } = artifact(root);
    const store = staging(root);
    // A seat that already holds a file: the check has to count it, because a
    // re-bootstrap holds the old one until the new one is in place.
    writeFileSync(path.join(root, "seat.db"), Buffer.alloc(4_096));
    const transport = stubTransport(bytes, etag);
    const cramped = {
      ...store,
      freeBytes: (): Promise<number | undefined> => Promise.resolve(1_024),
    };
    await expect(
      bootstrapSeatFile({
        transport,
        staging: cramped,
        vaultId: "vault-1",
        open: () => new NodeSeatDriver(path.join(root, "seat.db")),
      })
    ).rejects.toBeInstanceOf(SeatBootstrapNoRoomError);
    // Nothing was requested: the refusal is BEFORE the download, not during.
    expect(transport.requestedStarts).toStrictEqual([]);
    expect(seatBootstrapRoomRequired(bytes.byteLength, 4_096)).toBe(
      bytes.byteLength * 9 + 4_096
    );
  });

  it("proceeds when the host will not estimate free space", async () => {
    const root = workspace();
    const { bytes, etag } = artifact(root);
    const store = staging(root);
    const drivers: NodeSeatDriver[] = [];
    const result = await bootstrapSeatFile({
      transport: stubTransport(bytes, etag),
      staging: {
        ...store,
        freeBytes: (): Promise<number | undefined> =>
          Promise.resolve(undefined),
      },
      vaultId: "vault-1",
      open: opener(root, drivers),
    });
    expect(result.seq).toBe(42);
    for (const held of drivers) held.close();
  });

  it("refuses a short artifact rather than installing a prefix", async () => {
    const root = workspace();
    const { bytes, etag } = artifact(root);
    const short = stubTransport(bytes.subarray(0, bytes.byteLength - 16), etag);
    await expect(
      bootstrapSeatFile({
        transport: {
          head: () =>
            Promise.resolve({
              etag,
              bytes: bytes.byteLength,
              seq: 42,
              epoch: "e1",
              schemaEpoch: 2,
            }),
          range: short.range,
        },
        staging: staging(root),
        vaultId: "vault-1",
        open: () => new NodeSeatDriver(path.join(root, "seat.db")),
      })
    ).rejects.toBeInstanceOf(SeatSnapshotMovedError);
  });
});
