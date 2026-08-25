// The cross-scope merge (#599, generalised for #726 D11 to
// apps/_shared/scope-merge.ts): k-way ordering, cross-scope dedupe, the
// shared safe horizon, and the null-keyed tail bucket. Loaded by file URL
// like the other blueprint-app fixtures.
//
// Two suites: "Photos-shaped merge" pins the exact behaviour `merge.ts` had
// before the extraction (taken_at desc, sha-else-content-id), proving the
// generalisation changed nothing for the app it was lifted from. "A
// record-only app" proves the OTHER end of the two parameters — ascending
// order by the row's own id, identity same as sort key — the shape a
// second, record-only app (apps/tasks) declares.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

interface Asset {
  asset_id: string;
  content_id: string;
  sha256?: string | null;
  taken_at?: string | null;
}
interface Page<TRow> {
  scopeId: string;
  rows: readonly TRow[];
  tail: string | null;
  truncated: boolean;
}
interface Result<TRow> {
  rows: (TRow & { scope_id: string })[];
  horizon: string | null;
  horizonScopeIds: string[];
  withheld: number;
  truncated: boolean;
}
interface MergeOptions<TRow> {
  ownScopeId: string;
  sortKey: (row: TRow) => string | null | undefined;
  direction: "asc" | "desc";
  dedupeIdentity: (row: TRow) => string;
}

const moduleUrl = pathToFileURL(
  path.resolve(import.meta.dirname, "../apps/_shared/scope-merge.ts")
).href;
const { mergeScopePages } = (await import(moduleUrl)) as {
  mergeScopePages: <TRow>(
    pages: readonly Page<TRow>[],
    options: MergeOptions<TRow>
  ) => Result<TRow>;
};

/** An asset whose id doubles as its content id unless a sha is given. */
const asset = (id: string, takenAt: string | null, sha?: string): Asset => ({
  asset_id: id,
  content_id: `c-${id}`,
  sha256: sha ?? null,
  taken_at: takenAt,
});

/** A complete (untruncated) page: `tail` is its oldest row, nothing beyond. */
const page = (
  scopeId: string,
  rows: Asset[],
  truncated = false
): Page<Asset> => ({
  scopeId,
  rows,
  tail: rows.length > 0 ? (rows[rows.length - 1]!.taken_at ?? null) : null,
  truncated,
});

/** Photos' own two hardcodes (taken_at desc, sha-else-content-id), restated
 *  as the parameters `mergeScopePages` now takes. */
const photoDedupeIdentity = (a: Asset): string =>
  a.sha256 != null && a.sha256 !== ""
    ? `sha:${a.sha256}`
    : `content:${a.content_id}`;
const merge = (pages: Page<Asset>[]) =>
  mergeScopePages(pages, {
    ownScopeId: "own",
    sortKey: (a) => a.taken_at ?? null,
    direction: "desc",
    dedupeIdentity: photoDedupeIdentity,
  });
const ids = (result: Result<Asset>) => result.rows.map((a) => a.asset_id);

describe("Photos-shaped merge (#599, #726)", () => {
  it("interleaves three scopes newest-first", () => {
    const result = merge([
      page("own", [asset("a", "2026-05-01"), asset("d", "2026-01-01")]),
      page("family", [asset("b", "2026-04-01")]),
      page("club", [asset("c", "2026-03-01")]),
    ]);
    expect(ids(result)).toStrictEqual(["a", "b", "c", "d"]);
    expect(result.rows.map((a) => a.scope_id)).toStrictEqual([
      "own",
      "family",
      "club",
      "own",
    ]);
    expect(result.horizon).toBeNull();
    expect(result.truncated).toBe(false);
    expect(result.withheld).toBe(0);
  });

  it("breaks identical timestamps by identity, deterministically", () => {
    const forward = merge([
      page("own", [asset("zz", "2026-05-01")]),
      page("family", [asset("aa", "2026-05-01")]),
    ]);
    const reversed = merge([
      page("family", [asset("aa", "2026-05-01")]),
      page("own", [asset("zz", "2026-05-01")]),
    ]);
    expect(ids(forward)).toStrictEqual(["aa", "zz"]);
    expect(ids(reversed)).toStrictEqual(ids(forward));
  });

  it("dedupes a shared photo on sha256 and keeps the own-scope copy", () => {
    const shared = (id: string) => asset(id, "2026-05-01", "sha-shared");
    // Audience page first: the own copy must still win the tile.
    const result = merge([
      page("family", [shared("family-copy")]),
      page("own", [shared("own-copy")]),
    ]);
    expect(ids(result)).toStrictEqual(["own-copy"]);
    expect(result.rows[0]!.scope_id).toBe("own");
  });

  it("dedupes on content_id when no sha is recorded", () => {
    const inFamily: Asset = {
      asset_id: "f1",
      content_id: "c-shared",
      taken_at: "2026-05-01",
    };
    const inOwn: Asset = {
      asset_id: "o1",
      content_id: "c-shared",
      taken_at: "2026-05-01",
    };
    const result = merge([page("own", [inOwn]), page("family", [inFamily])]);
    expect(ids(result)).toStrictEqual(["o1"]);
  });

  it("keeps the first audience copy when a duplicate spans two audiences", () => {
    const shared = (id: string) => asset(id, "2026-05-01", "sha-shared");
    const result = merge([
      page("family", [shared("family-copy")]),
      page("club", [shared("club-copy")]),
    ]);
    expect(ids(result)).toStrictEqual(["family-copy"]);
    expect(result.rows[0]!.scope_id).toBe("family");
  });

  it("withholds nothing when the single scope is complete", () => {
    const result = merge([page("own", [asset("a", "2026-05-01")])]);
    expect(result).toMatchObject({
      horizon: null,
      horizonScopeIds: [],
      withheld: 0,
    });
  });

  it("caps a single truncated scope at its own tail", () => {
    const result = merge([
      page("own", [asset("a", "2026-05-01"), asset("b", "2026-04-01")], true),
    ]);
    // Its own tail is the horizon, and the tail row itself is still safe.
    expect(result.horizon).toBe("2026-04-01");
    expect(ids(result)).toStrictEqual(["a", "b"]);
    expect(result.horizonScopeIds).toStrictEqual(["own"]);
  });

  it("caps two scopes at the NEWEST tail among the truncated ones", () => {
    const result = merge([
      // Shallow: truncated at July.
      page("own", [asset("a", "2026-07-10"), asset("b", "2026-07-01")], true),
      // Deep: reaches March, so its May row is not safe to show yet.
      page(
        "family",
        [asset("c", "2026-06-01"), asset("d", "2026-05-01")],
        true
      ),
    ]);
    expect(result.horizon).toBe("2026-07-01");
    expect(ids(result)).toStrictEqual(["a", "b"]);
    expect(result.withheld).toBe(2);
    expect(result.horizonScopeIds).toStrictEqual(["own"]);
    expect(result.truncated).toBe(true);
  });

  it("ignores complete scopes when computing the horizon", () => {
    const result = merge([
      page("own", [asset("a", "2026-07-10"), asset("b", "2026-07-01")], true),
      // Complete: its older rows stay visible because nothing can precede them.
      page("family", [asset("c", "2026-06-01")], false),
    ]);
    expect(result.horizon).toBe("2026-07-01");
    expect(ids(result)).toStrictEqual(["a", "b"]);
    expect(result.withheld).toBe(1);
    expect(result.horizonScopeIds).toStrictEqual(["own"]);
  });

  it("names only the scopes sitting at the horizon across three scopes", () => {
    const result = merge([
      page("own", [asset("a", "2026-07-01")], true),
      // Same tail as own — both must be re-queried to page deeper.
      page("family", [asset("b", "2026-07-01")], true),
      // Deeper, so paging it alone would not lower the horizon.
      page("club", [asset("c", "2026-06-01")], true),
    ]);
    expect(result.horizon).toBe("2026-07-01");
    expect(result.horizonScopeIds).toStrictEqual(["own", "family"]);
    expect(ids(result)).toStrictEqual(["a", "b"]);
    expect(result.withheld).toBe(1);
  });

  it("withholds nothing when every scope is complete, however uneven", () => {
    const result = merge([
      page("own", [asset("a", "2026-07-01")]),
      page("family", [asset("b", "2026-01-01")]),
    ]);
    expect(result.horizon).toBeNull();
    expect(ids(result)).toStrictEqual(["a", "b"]);
    expect(result.horizonScopeIds).toStrictEqual([]);
  });

  it("sorts undated assets after every dated one, per scope, stably", () => {
    const result = merge([
      page("own", [asset("a", "2026-05-01"), asset("n2", null)]),
      page("family", [asset("b", "2026-04-01"), asset("n1", null)]),
    ]);
    expect(ids(result)).toStrictEqual(["a", "b", "n1", "n2"]);
  });

  it("withholds the undated bucket while any scope is truncated", () => {
    const result = merge([
      page("own", [asset("a", "2026-05-01"), asset("n1", null)]),
      page("family", [asset("b", "2026-04-01")], true),
    ]);
    expect(ids(result)).toStrictEqual(["a", "b"]);
    expect(result.withheld).toBe(1);
  });

  it("does not let a null-tailed truncated scope raise the dated horizon", () => {
    const result = merge([
      // Ran out inside its undated bucket: dated rows are all known.
      {
        scopeId: "own",
        rows: [asset("a", "2026-05-01"), asset("n1", null)],
        tail: null,
        truncated: true,
      },
      page("family", [asset("b", "2026-04-01")], true),
    ]);
    expect(result.horizon).toBe("2026-04-01");
    expect(ids(result)).toStrictEqual(["a", "b"]);
    // Both must page: family sets the dated horizon, own caps the undated tail.
    expect(result.horizonScopeIds).toStrictEqual(["own", "family"]);
    expect(result.withheld).toBe(1);
  });

  it("handles an empty page without breaking the horizon", () => {
    const result = merge([
      page("own", [asset("a", "2026-05-01")], true),
      { scopeId: "family", rows: [], tail: null, truncated: false },
    ]);
    expect(result.horizon).toBe("2026-05-01");
    expect(ids(result)).toStrictEqual(["a"]);
    expect(result.horizonScopeIds).toStrictEqual(["own"]);
  });
});

// A record-only app (apps/tasks' declared shape, #726 D11 task 3): no
// separate content identity, so `sortKey` and `dedupeIdentity` both read the
// row's own id, ascending (oldest/lowest first — the mirror image of
// Photos' newest-first).
interface Row {
  row_id: string;
}
const record = (id: string): Row => ({ row_id: id });
const recordPage = (
  scopeId: string,
  rows: Row[],
  truncated = false
): Page<Row> => ({
  scopeId,
  rows,
  tail: rows.length > 0 ? rows[rows.length - 1]!.row_id : null,
  truncated,
});
const mergeRecords = (pages: Page<Row>[]) =>
  mergeScopePages(pages, {
    ownScopeId: "own",
    sortKey: (r) => r.row_id,
    direction: "asc",
    dedupeIdentity: (r) => r.row_id,
  });

describe("A record-only app's merge (ascending by row id, #726 D11)", () => {
  it("interleaves two scopes lowest-id-first", () => {
    const result = mergeRecords([
      recordPage("own", [record("a1"), record("a3")]),
      recordPage("shared", [record("a2")]),
    ]);
    expect(result.rows.map((r) => r.row_id)).toStrictEqual(["a1", "a2", "a3"]);
    expect(result.horizon).toBeNull();
  });

  it("dedupes on the row's own id, own scope winning", () => {
    const result = mergeRecords([
      recordPage("shared", [record("dup")]),
      recordPage("own", [record("dup")]),
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.scope_id).toBe("own");
  });

  it("caps the horizon at the shallowest truncated tail, ascending", () => {
    const result = mergeRecords([
      // Shallow: truncated after a2.
      recordPage("own", [record("a1"), record("a2")], true),
      // Deep: reaches a5, so a3/a4 are not yet safe to show.
      recordPage("shared", [record("a3"), record("a4")], true),
    ]);
    expect(result.horizon).toBe("a2");
    expect(result.rows.map((r) => r.row_id)).toStrictEqual(["a1", "a2"]);
    expect(result.horizonScopeIds).toStrictEqual(["own"]);
  });
});
