import path from "node:path";

import { describe, expect, it } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { inProcessSeatChannel } from "./in-process-channel.js";
import { NodeSeatDriver } from "./node-seat-driver.js";
import { nodeSeatStaging } from "./node-staging.js";
import { seatArtifact } from "./seat-artifact.test-fixtures.js";
import { SeatLoop } from "./seat-loop.js";
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
});
