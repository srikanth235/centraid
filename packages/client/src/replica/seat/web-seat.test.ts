import path from "node:path";

import { describe, expect, it } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { NodeSeatDriver } from "./node-seat-driver.js";
import { nodeSeatStaging } from "./node-staging.js";
import { seatArtifact } from "./seat-artifact.test-fixtures.js";
import type { SeatWorkerLike } from "./seat-worker-client.js";
import { WebSeat } from "./web-seat.js";
import { SeatWorkerCore } from "./worker-core.js";
import type {
  SeatWorkerRequest,
  SeatWorkerResponse,
} from "./worker-protocol.js";
import { serializeSeatError } from "./worker-protocol.js";

/**
 * A worker without a thread: the REAL `SeatWorkerCore` over `node:sqlite` and
 * `node:fs`, driven through the same message protocol the browser's worker
 * uses. What is faked is the thread, not the program.
 */
function inlineWorker(
  root: string,
  artifact: () => Uint8Array
): SeatWorkerLike {
  const listeners = new Set<
    (event: MessageEvent<SeatWorkerResponse>) => void
  >();
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
  const emit = (message: SeatWorkerResponse): void => {
    for (const listener of listeners)
      listener({ data: message } as MessageEvent<SeatWorkerResponse>);
  };
  return {
    postMessage: (request: SeatWorkerRequest) => {
      void core.dispatch(request).then(
        (result) => emit({ id: request.id, ok: true, result }),
        (error: unknown) =>
          emit({ id: request.id, ok: false, error: serializeSeatError(error) })
      );
    },
    addEventListener: ((type: string, listener: unknown) => {
      if (type === "message")
        listeners.add(
          listener as (event: MessageEvent<SeatWorkerResponse>) => void
        );
    }) as SeatWorkerLike["addEventListener"],
    removeEventListener: ((type: string, listener: unknown) => {
      if (type === "message")
        listeners.delete(
          listener as (event: MessageEvent<SeatWorkerResponse>) => void
        );
    }) as SeatWorkerLike["removeEventListener"],
    terminate: () => listeners.clear(),
  };
}

function artifactBytes(root: string): Uint8Array {
  const cached = artifacts.get(root);
  if (cached) return cached;
  // ONE artifact per workspace: the door serves the same bytes to every
  // request, and rebuilding it would make a resumed download splice two files.
  const bytes = seatArtifact(root);
  artifacts.set(root, bytes);
  return bytes;
}

const artifacts = new Map<string, Uint8Array>();

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

function seatOver(
  root: string,
  door: ReturnType<typeof doorAnswering>
): Promise<WebSeat> {
  return WebSeat.open({
    vaultId: "vault-1",
    dbName: "/centraid-seat-abc.sqlite3",
    remember: true,
    baseUrl: "https://gateway.test",
    workerFactory: () => inlineWorker(root, () => artifactBytes(root)),
    fetch: door.fetch,
  });
}

describe("the web seat's sync loop", () => {
  it("bootstraps when it holds nothing, then tails until it is caught up", async () => {
    const root = tempDirSync("web-seat-");
    const door = doorAnswering([
      { rows: 2, hasMore: true, watermark: 11 },
      { rows: 2, hasMore: false, watermark: 11 },
    ]);
    const seat = await seatOver(root, door);
    const watermark = await seat.sync();
    expect(watermark).toMatchObject({ applied: 11, head: 11, behind: 0 });
    // The first page asked from the SNAPSHOT's position, not from zero.
    expect(door.asked[0]).toContain("since=7");
    expect(door.asked[1]).toContain("since=9");
    await seat.close();
  });

  it("re-bootstraps once when the gateway refuses the cursor, and no more", async () => {
    const root = tempDirSync("web-seat-409-");
    const door = doorAnswering([
      {
        rows: 0,
        hasMore: false,
        watermark: 0,
        status: 409,
        body: {
          error: "seat_rebootstrap_required",
          reason: "retention",
          snapshot: "/centraid/_vault/seat/snapshot",
        },
      },
      { rows: 1, hasMore: false, watermark: 8 },
    ]);
    const seat = await seatOver(root, door);
    const watermark = await seat.sync();
    expect(watermark).toMatchObject({ applied: 8 });
    await seat.close();
  });

  it("gives up rather than re-downloading the artifact in a loop", async () => {
    const root = tempDirSync("web-seat-loop-");
    const door = doorAnswering([
      {
        rows: 0,
        hasMore: false,
        watermark: 0,
        status: 409,
        body: { error: "seat_rebootstrap_required", reason: "retention" },
      },
    ]);
    const seat = await seatOver(root, door);
    // The door refuses every time. One re-bootstrap, then the refusal is the
    // caller's to handle — a seat that kept trying would spend a member's
    // data allowance on a 9 MB artifact it cannot use.
    await expect(seat.sync()).rejects.toThrow(
      /cannot serve this seat's cursor/u
    );
    await seat.close();
  });

  it("reports a seat that has fallen behind rather than pretending", async () => {
    const root = tempDirSync("web-seat-behind-");
    const door = doorAnswering([{ rows: 1, hasMore: false, watermark: 4_000 }]);
    const seat = await seatOver(root, door);
    const watermark = await seat.sync();
    // The page's own watermark is the gateway's head; the seat applied one row
    // of it, so it is honest about the distance rather than saying "up to
    // date" because the page it got had no more.
    expect(watermark).toMatchObject({ applied: 8, head: 4_000, behind: 3_992 });
    await seat.close();
  });
});
