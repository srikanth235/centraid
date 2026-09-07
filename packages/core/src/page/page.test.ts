// THE PAGE, RED FIRST (#996 wave 4).
//
// The claims under test are the ones the read vocabulary this replaces could
// not make. `acceptTruncation` let a caller declare no window and be handed
// whatever the reader felt like; `truncated` then told it, after the fact, that
// the answer had been cut. A page has neither: the window is the request, and
// "there is more" is a cursor you can continue from rather than a flag you can
// only report.
//
//   1. a request has a limit or it does not compile, and the probe row is the
//      only thing that separates "the window filled" from "the rows ended";
//   2. the cursor is the sort key, so a continuation seeks rather than counts —
//      no OFFSET is derivable from what a caller is handed;
//   3. the ceiling is the host's safety net and it clamps, silently to the
//      member and loudly to the work counters — it is not a refusal.

import { describe, expect, it } from "vitest";

import { MAX_PAGE_ROWS, pageOf, probeLimit } from "./window.js";
import type { PageRequest } from "./window.js";

interface Row {
  id: string;
  at: string;
}

const rows = (n: number, from = 0): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `r${String(from + i).padStart(3, "0")}`,
    at: `2026-01-${String(((from + i) % 28) + 1).padStart(2, "0")}`,
  }));

const key = (row: Row) => ({ sortKey: row.at, pk: row.id });

describe("the page request", () => {
  it("asks for one row more than the window, as the probe", () => {
    expect(probeLimit({ limit: 20 })).toBe(21);
  });

  it("clamps the window to the host ceiling, probe included", () => {
    expect(probeLimit({ limit: MAX_PAGE_ROWS + 5_000 })).toBe(
      MAX_PAGE_ROWS + 1
    );
  });

  it("refuses a window that is not a positive whole number of rows", () => {
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => probeLimit({ limit } as PageRequest)).toThrow(/page limit/u);
  });
});

describe("the page result", () => {
  it("drops the probe row and names where to continue", () => {
    const page = pageOf(rows(21), { limit: 20 }, key);
    expect(page.rows).toHaveLength(20);
    expect(page.next).toStrictEqual({ sortKey: page.rows[19]!.at, pk: "r019" });
  });

  it("has no cursor when the rows ended inside the window", () => {
    const page = pageOf(rows(7), { limit: 20 }, key);
    expect(page.rows).toHaveLength(7);
    expect(page.next).toBeUndefined();
  });

  it("has no cursor when the rows ended exactly on the window", () => {
    // The probe is what makes this distinguishable from a filled window; a
    // reader that fetched `limit` rows could not tell these two apart and had
    // to announce a truncation it was not sure of.
    const page = pageOf(rows(20), { limit: 20 }, key);
    expect(page.rows).toHaveLength(20);
    expect(page.next).toBeUndefined();
  });

  it("walks a whole set exactly once, with no gap and no overlap", () => {
    const all = rows(53);
    const seen: string[] = [];
    let after: PageRequest["after"];
    for (let guard = 0; guard < 10; guard += 1) {
      const from = after ? all.findIndex((r) => r.id === after?.pk) + 1 : 0;
      const page = pageOf(
        all.slice(from, from + 11),
        { limit: 10, after },
        key
      );
      seen.push(...page.rows.map((r) => r.id));
      if (!page.next) break;
      after = page.next;
    }
    expect(seen).toStrictEqual(all.map((r) => r.id));
  });

  it("clamps an oversized window rather than refusing it", () => {
    const page = pageOf(rows(MAX_PAGE_ROWS + 1), { limit: 10_000_000 }, key);
    expect(page.rows).toHaveLength(MAX_PAGE_ROWS);
    expect(page.next).toBeDefined();
  });
});
