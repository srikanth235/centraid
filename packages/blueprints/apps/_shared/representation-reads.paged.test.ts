// THE ONE READ EVERY APP MAKES, PAGED (#996 wave 4b, R8).
//
// `readRepresentations` is what fills in a row's `media_type` — every first-
// party app calls it, and it said `acceptTruncation: true`, so on a vault with
// enough representations the answer silently stopped and rows came back with no
// type rather than with the wrong one. It could not be converted in wave 4
// because the phone's inline ctx had no `page` (Tally and Locker run through
// it); the phone's seat lands that, so this does.
//
// The claims:
//
//   1. it reaches the vault ONLY through `ctx.vault.page` — the fake ctx has no
//      `read`, so a survivor is a `TypeError` rather than a quiet pass;
//   2. the set is `in`-bounded by the caller's OWN content ids, and it is
//      walked to the end of that bounded set rather than windowed again;
//   3. the keyset's second axis is `representation_id`, not `content_id`: one
//      sha read as two things by two owners is the row this table exists for,
//      and a cursor keyed on `content_id` would stall on it;
//   4. a denial is still not an error — the caller renders without a type.

import { describe, expect, it, vi } from "vitest";

import { ownerKey, readRepresentations } from "./representation-reads.ts";

interface Statement {
  name: string;
  select: string;
  from: string;
  where?: string;
  bind?: readonly (string | number | null)[];
  order: { sortColumn: string; pkColumn: string; descending: boolean };
}

interface Cursor {
  sortKey: string;
  pk: string;
}

function pagingCtx(
  rows: Record<string, unknown>[],
  options: { pageSize?: number; fail?: boolean } = {}
) {
  const statements: Statement[] = [];
  const page = vi.fn<
    (request: {
      query: Statement;
      limit: number;
      after?: Cursor;
    }) => Promise<{ rows: Record<string, unknown>[]; next?: Cursor }>
  >(
    (request: {
      query: Statement;
      limit: number;
      after?: Cursor;
    }): Promise<{ rows: Record<string, unknown>[]; next?: Cursor }> => {
      statements.push(request.query);
      if (options.fail) return Promise.reject(new Error("consent denied"));
      const size = options.pageSize ?? rows.length;
      const after = request.after;
      const from = after
        ? rows.findIndex((row) => row["representation_id"] === after.pk) + 1
        : 0;
      const window = rows.slice(from, from + size);
      const last = window.at(-1);
      const more = from + window.length < rows.length;
      return Promise.resolve({
        rows: window,
        ...(more && last
          ? {
              next: {
                sortKey: String(last["created_at"]),
                pk: String(last["representation_id"]),
              },
            }
          : {}),
      });
    }
  );
  return { ctx: { vault: { page } } as never, statements, page };
}

const ROWS = [
  {
    representation_id: "rep-1",
    content_id: "sha-1",
    owner_type: "core.document",
    owner_id: "doc-1",
    media_type: "text/html",
    created_at: "2026-01-01T00:00:00.000Z",
  },
  {
    representation_id: "rep-2",
    content_id: "sha-1",
    owner_type: "knowledge.note",
    owner_id: "note-1",
    media_type: "text/plain",
    created_at: "2026-01-02T00:00:00.000Z",
  },
];

describe("the shared representation read", () => {
  it("indexes by owner and by content, from pages alone", async () => {
    const { ctx, statements } = pagingCtx(ROWS);
    const index = await readRepresentations({ ctx, contentIds: ["sha-1"] });
    expect(index.byOwner.get(ownerKey("core.document", "doc-1"))).toBe(
      "text/html"
    );
    expect(index.byOwner.get(ownerKey("knowledge.note", "note-1"))).toBe(
      "text/plain"
    );
    // Oldest first, so the content-keyed fallback is the same deterministic
    // answer the vault's own resolver gives.
    expect(index.byContent.get("sha-1")).toBe("text/html");
    expect(statements).toHaveLength(1);
    const statement = statements[0]!;
    expect(statement.from).toBe("core_content_representation");
    expect(statement.where).toBe("content_id IN (?)");
    expect(statement.bind).toStrictEqual(["sha-1"]);
    expect(statement.order).toStrictEqual({
      sortColumn: "created_at",
      pkColumn: "representation_id",
      descending: false,
    });
    // The cursor is read off the row by those two columns, so both are
    // projected or there is no cursor to continue with.
    expect(statement.select).toContain("created_at");
    expect(statement.select).toContain("representation_id");
  });

  it("walks to the end of the caller's bounded set rather than taking one page", async () => {
    const { ctx, page } = pagingCtx(ROWS, { pageSize: 1 });
    const index = await readRepresentations({ ctx, contentIds: ["sha-1"] });
    expect(page).toHaveBeenCalledTimes(2);
    expect(index.byOwner.size).toBe(2);
  });

  it("asks for nothing at all when the caller's set is empty", async () => {
    const { ctx, page } = pagingCtx(ROWS);
    const index = await readRepresentations({ ctx, contentIds: [] });
    expect(page).not.toHaveBeenCalled();
    expect(index.byOwner.size).toBe(0);
  });

  it("renders without a type when the vault refuses, rather than failing the screen", async () => {
    const { ctx } = pagingCtx(ROWS, { fail: true });
    const index = await readRepresentations({ ctx, contentIds: ["sha-1"] });
    expect(index.byContent.size).toBe(0);
  });
});
