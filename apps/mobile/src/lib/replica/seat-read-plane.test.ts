import { describe, expect, it } from "vitest";

import type {
  InlinePage,
  InlineQueryRunnable,
  ReplicaReadWireResult,
} from "@centraid/client/replica/native";

import type { NativeInlineQuerySession } from "./inline-query-ctx.native";
import { runNativeInlineQuery, seatReadPlane } from "./inline-query-ctx.native";

/**
 * THE PHONE'S `ctx.vault.page` (#996 wave 4b).
 *
 * Until this wave, `buildNativeInlineCtx` built the ctx out of `read` and
 * `search` only, so `ctx.vault.page` on a phone was the core's online-only
 * stub — which is why the shared `readRepresentations` conversion had to be
 * reverted with Tally and Locker named as the blockers. What is pinned here is
 * that a handler's page reaches the SEAT, and that a phone without one still
 * refuses rather than reaching for the old store's file.
 */
const rowsOnly: NativeInlineQuerySession = {
  read: (): Promise<ReplicaReadWireResult> =>
    Promise.resolve({ rows: [] } as unknown as ReplicaReadWireResult),
  search: () =>
    Promise.reject(new Error("the handler under test never searches")),
};

const handler = {
  default: async ({ ctx }: { ctx: unknown }) => {
    const vault = (ctx as { vault: { page: InlinePage } }).vault;
    return vault.page({
      query: {
        name: "notes/list",
        select: "note_id, updated_at",
        from: "core_note",
        order: {
          sortColumn: "updated_at",
          pkColumn: "note_id",
          descending: false,
        },
      },
      limit: 2,
    });
  },
} as unknown as InlineQueryRunnable;

describe("the seat's page on the phone's read plane", () => {
  it("answers a handler's page from the seat, overlay and window included", async () => {
    const asked: { limit: number; overlay: unknown }[] = [];
    const page: InlinePage = (request) => {
      asked.push({ limit: request.limit, overlay: request.overlay });
      return Promise.resolve({
        rows: [{ note_id: "n1" }, { note_id: "n2" }],
        next: { sortKey: "n2", pk: "n2" },
      } as never);
    };
    const answer = (await runNativeInlineQuery(handler, {
      session: seatReadPlane(rowsOnly, {
        page,
        search: () => Promise.reject(new Error("not this test's question")),
      }),
      appId: "notes",
    })) as { rows: unknown[]; next?: unknown };
    expect(answer.rows).toHaveLength(2);
    expect(answer.next).toBeDefined();
    expect(asked).toStrictEqual([{ limit: 2, overlay: undefined }]);
  });

  it("refuses online-only when this phone holds no seat, rather than reading the old store", async () => {
    await expect(
      runNativeInlineQuery(handler, {
        session: seatReadPlane(rowsOnly, undefined),
        appId: "notes",
      })
    ).rejects.toThrow(/online-only/u);
  });
});
