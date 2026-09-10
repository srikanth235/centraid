import path from "node:path";

import { describe, expect, it } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { inProcessSeatChannel } from "./in-process-channel.js";
import { NodeSeatDriver } from "./node-seat-driver.js";
import { nodeSeatStaging } from "./node-staging.js";
import { seatArtifact } from "./seat-artifact.test-fixtures.js";
import { SeatDriftParkedError } from "./seat-drift-parked-error.js";
import {
  parseSeatLogPage,
  SEAT_SNAPSHOT_MOVE_RETRIES,
  SeatLoop,
} from "./seat-loop.js";
import { SeatSnapshotMovedError } from "./seat-snapshot-moved-error.js";
import { SeatWorkerCore } from "./worker-core.js";

/**
 * THE PHONE'S ASSEMBLY, WITHOUT THE PHONE (#996 wave 4b).
 *
 * `SeatWorkerCore` over a real SQLite file and a real staging directory,
 * reached with no thread in between — which is exactly what
 * `apps/mobile/src/lib/replica/native-seat.ts` builds, with expo-sqlite where
 * this has `node:sqlite`. The loop under test is the SAME object the browser's
 * `WebSeat` drives through a Worker, so what these cases pin is that the two
 * hosts differ in their channel and in nothing else.
 */
function loopOver(
  root: string,
  fetch: typeof globalThis.fetch,
  artifact: () => Uint8Array
): SeatLoop {
  const core = new SeatWorkerCore({
    openDatabase: () => new NodeSeatDriver(path.join(root, "seat.db")),
    staging: () =>
      nodeSeatStaging({
        directory: path.join(root, "staging"),
        databasePath: path.join(root, "seat.db"),
      }),
    transport: () => ({
      head: () => {
        const bytes = artifact();
        return Promise.resolve({
          etag: '"e1-7"',
          bytes: bytes.byteLength,
          seq: 7,
          epoch: "e1",
          schemaEpoch: 2,
        });
      },
      range: (start: number) => ({
        async *[Symbol.asyncIterator]() {
          yield artifact().subarray(start);
        },
      }),
    }),
  });
  return new SeatLoop(inProcessSeatChannel(core), {
    vaultId: "vault-1",
    dbName: path.join(root, "seat.db"),
    remember: true,
    baseUrl: "https://gateway.test",
    fetch,
  });
}

interface PageStub {
  readonly rows: number;
  readonly hasMore: boolean;
  readonly watermark: number;
  readonly status?: number;
  readonly body?: Record<string, unknown>;
}

function doorAnswering(pages: readonly PageStub[]): {
  fetch: typeof globalThis.fetch;
  asked: string[];
} {
  const asked: string[] = [];
  let at = 0;
  const call = (input: RequestInfo | URL): Promise<Response> => {
    asked.push(String(input));
    const page = pages[Math.min(at, pages.length - 1)];
    at += 1;
    if (page?.status !== undefined) {
      return Promise.resolve(
        new Response(JSON.stringify(page.body ?? {}), {
          status: page.status,
          headers: { "content-type": "application/json" },
        })
      );
    }
    const since = Number(new URL(String(input)).searchParams.get("since"));
    const rows = Array.from({ length: page?.rows ?? 0 }, (_value, index) => ({
      seq: since + index + 1,
      commitSeq: since + index + 1,
      schemaEpoch: 2,
      ddlVersion: 0,
      table: "note",
      op: "insert" as const,
      pk: [`applied-${since + index + 1}`],
      row: {
        note_id: `applied-${since + index + 1}`,
        title: "applied by the seat",
      },
      producer: "gateway",
      committedAt: "2026-01-01T00:00:00.000Z",
    }));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          vaultId: "vault-1",
          epoch: "e1",
          schemaEpoch: 2,
          ddlVersion: 0,
          floor: 0,
          watermark: page?.watermark ?? since,
          next: rows.at(-1)?.seq ?? since,
          hasMore: page?.hasMore ?? false,
          rows,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
  };
  return { fetch: call as unknown as typeof globalThis.fetch, asked };
}

describe("the seat loop with no worker in it", () => {
  it("bootstraps, tails to the head, and answers a read off the file", async () => {
    const root = tempDirSync("seat-loop-");
    const artifact = seatArtifact(root);
    const door = doorAnswering([
      { rows: 2, hasMore: true, watermark: 11 },
      { rows: 2, hasMore: false, watermark: 11 },
    ]);
    const loop = loopOver(root, door.fetch, () => artifact);
    await loop.open();
    await expect(loop.sync()).resolves.toMatchObject({
      applied: 11,
      head: 11,
      behind: 0,
    });
    // The first page asked from the SNAPSHOT's position, not from zero.
    expect(door.asked[0]).toContain("since=7");
    const rows = await loop.query<{ note_id: string }>({
      sql: "SELECT note_id FROM note WHERE note_id = ?",
      bind: ["applied-11"],
    });
    expect(rows).toHaveLength(1);
    await loop.close();
  });

  it("re-bootstraps once when the door refuses the cursor, exactly as the worker seat does", async () => {
    const root = tempDirSync("seat-loop-409-");
    const artifact = seatArtifact(root);
    const door = doorAnswering([
      {
        rows: 0,
        hasMore: false,
        watermark: 0,
        status: 409,
        body: { error: "seat_rebootstrap_required", reason: "retention" },
      },
      { rows: 1, hasMore: false, watermark: 8 },
    ]);
    const loop = loopOver(root, door.fetch, () => artifact);
    await loop.open();
    await expect(loop.sync()).resolves.toMatchObject({ applied: 8 });
    await loop.close();
  });

  it("refuses a read on a seat with no copy instead of answering it empty", async () => {
    // ABSENT IS NEVER EMPTY. The file carries the vault's DDL from the
    // baseline, so every table a copy would hold already exists and an
    // unguarded read of one answers zero rows — an empty library drawn over a
    // vault full of them, with nothing to tell the member which it is.
    const root = tempDirSync("seat-loop-nocopy-");
    const loop = loopOver(root, doorAnswering([]).fetch, () =>
      seatArtifact(root)
    );
    await loop.open();
    await expect(loop.query({ sql: "SELECT 1" })).rejects.toThrow(
      /holds no copy/u
    );
    await loop.close();
  });

  it("turns the core's SYNCHRONOUS refusal into a rejection, not a thrown call", async () => {
    // A read before `open` throws inside the core. Across a worker that is a
    // serialised error and a rejected promise; in process it would be a throw
    // past the caller's `await` unless the channel wraps it — and the loop's
    // drift recovery is written against a rejection. Asserted on the CHANNEL:
    // the loop refuses a copyless read of its own accord now, so it never
    // reaches the core to be thrown at.
    const core = new SeatWorkerCore({
      openDatabase: () => new NodeSeatDriver(":memory:"),
      staging: () => {
        throw new Error("no bootstrap in this case");
      },
      transport: () => {
        throw new Error("no bootstrap in this case");
      },
    });
    await expect(
      inProcessSeatChannel(core).query({ sql: "SELECT 1" })
    ).rejects.toThrow(/has not been opened/u);
  });
  // #1014, C15. `return body as unknown as SeatLogPageWire` — a cast, on JSON
  // off the wire, straight into a transaction that writes the member's file
  // and moves the cursor with it.
  describe("a page the door should not have served", () => {
    it.each([
      ["carries no rows array", { rows: undefined }],
      ["a watermark that is a string", { watermark: "11" }],
      ["a negative seq on a row", { negativeSeq: true }],
      ["an op this seat cannot read", { op: "upsert" }],
      ["no vault id", { vaultId: undefined }],
    ])("is refused rather than applied: %s", (_name, mutation) => {
      const shape = mutation as Record<string, unknown>;
      const page: Record<string, unknown> = {
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
            seq: shape["negativeSeq"] === true ? -1 : 11,
            commitSeq: 4,
            schemaEpoch: 2,
            ddlVersion: 0,
            table: "note",
            op: shape["op"] ?? "insert",
            pk: ["n1"],
            producer: "gateway",
            committedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      };
      if ("rows" in shape) page["rows"] = shape["rows"];
      if ("watermark" in shape) page["watermark"] = shape["watermark"];
      if ("vaultId" in shape) page["vaultId"] = shape["vaultId"];
      expect(() => parseSeatLogPage(page)).toThrow(/seat log page/u);
    });

    it("takes the page the gateway actually serves", () => {
      expect(
        parseSeatLogPage({
          vaultId: "vault-1",
          epoch: "e1",
          schemaEpoch: 2,
          ddlVersion: 0,
          floor: 0,
          watermark: 11,
          next: 11,
          hasMore: false,
          rows: [],
        })
      ).toMatchObject({ watermark: 11 });
    });
  });

  // #1014, C14. A drift the gateway cannot resolve was one full artifact
  // download every retry interval, forever, with no user-visible cause: R25
  // measured ~6 s and 560 lines of gateway log.
  it("parks after three drift re-bootstraps in a row instead of a fourth", async () => {
    const root = tempDirSync("seat-loop-drift-");
    const artifact = seatArtifact(root);
    let asked = 0;
    // Every page names another vault, so every apply refuses as drift and the
    // re-bootstrap that follows cannot help.
    const call = (input: RequestInfo | URL): Promise<Response> => {
      asked += 1;
      const since = Number(new URL(String(input)).searchParams.get("since"));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            vaultId: "someone-elses-vault",
            epoch: "e1",
            schemaEpoch: 2,
            ddlVersion: 0,
            floor: 0,
            watermark: since + 1,
            next: since + 1,
            hasMore: false,
            rows: [
              {
                seq: since + 1,
                commitSeq: since + 1,
                schemaEpoch: 2,
                ddlVersion: 0,
                table: "note",
                op: "insert",
                pk: ["n1"],
                row: { note_id: "n1", title: "not this vault" },
                producer: "gateway",
                committedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    };
    const loop = loopOver(
      root,
      call as unknown as typeof globalThis.fetch,
      () => artifact
    );
    await loop.open();

    let parked: unknown;
    for (
      let attempt = 0;
      attempt < 6 && !(parked instanceof SeatDriftParkedError);
      attempt += 1
    ) {
      // The host's retry timer without the timer: each pass is one `sync()`.
      // oxlint-disable-next-line no-await-in-loop
      parked = await loop.sync().then(
        () => undefined,
        (error: unknown) => error
      );
    }
    expect(parked).toBeInstanceOf(SeatDriftParkedError);
    expect((parked as SeatDriftParkedError).drift.reason).toBe("vault");
    // Bounded: three drift re-bootstraps, not one per retry until the phone
    // is out of battery.
    expect(asked).toBeLessThanOrEqual(4);
    // And it stays parked: another pass does not start the count over.
    await expect(loop.sync()).rejects.toBeInstanceOf(SeatDriftParkedError);
  });
});

/**
 * A BUSY GATEWAY IS NOT A FAILED BOOTSTRAP (#1014, V4).
 *
 * The door builds for the current watermark, and the gateway commits while the
 * phone downloads — the system recognition automations write their conversation
 * ledger on every boot and those rows replicate. So the artifact really does
 * move under a slow download, `If-Range` really does refuse the resume, and the
 * only question is whether the seat starts over or gives up. It used to give
 * up: `SeatSnapshotMovedError` left `sync()` with no copy and the library drew
 * empty over a vault holding rows.
 */
function loopOverMovingDoor(
  root: string,
  fetch: typeof globalThis.fetch,
  bytes: Uint8Array,
  movesFor: number
): { loop: SeatLoop; heads: () => number } {
  let heads = 0;
  let moved = 0;
  const core = new SeatWorkerCore({
    openDatabase: () => new NodeSeatDriver(path.join(root, "seat.db")),
    staging: () =>
      nodeSeatStaging({
        directory: path.join(root, "staging"),
        databasePath: path.join(root, "seat.db"),
      }),
    transport: () => ({
      head: () => {
        heads += 1;
        return Promise.resolve({
          // A NEW ETAG EACH TIME, because the gateway really has moved on.
          etag: `"e1-${6 + heads}"`,
          bytes: bytes.byteLength,
          seq: 7,
          epoch: "e1",
          schemaEpoch: 2,
        });
      },
      range: (start: number, etag: string) => ({
        async *[Symbol.asyncIterator]() {
          if (moved < movesFor) {
            moved += 1;
            throw new SeatSnapshotMovedError(etag, `"e1-${7 + moved}"`);
          }
          yield bytes.subarray(start);
        },
      }),
    }),
  });
  return {
    loop: new SeatLoop(inProcessSeatChannel(core), {
      vaultId: "vault-1",
      dbName: path.join(root, "seat.db"),
      remember: true,
      baseUrl: "https://gateway.test",
      fetch,
    }),
    heads: () => heads,
  };
}

describe("a snapshot that moves under the download", () => {
  it("re-HEADs and finishes the bootstrap the busy gateway interrupted", async () => {
    const root = tempDirSync("seat-loop-moved-");
    const door = doorAnswering([{ rows: 1, hasMore: false, watermark: 8 }]);
    const { loop, heads } = loopOverMovingDoor(
      root,
      door.fetch,
      seatArtifact(root),
      SEAT_SNAPSHOT_MOVE_RETRIES - 1
    );
    await loop.open();
    await expect(loop.sync()).resolves.toMatchObject({ head: 8 });
    expect(
      heads(),
      "the retry reused the head it already had rather than asking the door where the artifact is now"
    ).toBe(SEAT_SNAPSHOT_MOVE_RETRIES);
    await loop.close();
  });

  it("gives up after the bound rather than downloading forever", async () => {
    // A gateway committing faster than this phone can download will never
    // converge; three passes is enough to say so, and the caller's retry timer
    // is what tries again later.
    const root = tempDirSync("seat-loop-moving-");
    const door = doorAnswering([{ rows: 1, hasMore: false, watermark: 8 }]);
    const { loop, heads } = loopOverMovingDoor(
      root,
      door.fetch,
      seatArtifact(root),
      Number.POSITIVE_INFINITY
    );
    await loop.open();
    await expect(loop.sync()).rejects.toThrow(SeatSnapshotMovedError);
    expect(heads()).toBe(SEAT_SNAPSHOT_MOVE_RETRIES);
    await loop.close();
  });
});
