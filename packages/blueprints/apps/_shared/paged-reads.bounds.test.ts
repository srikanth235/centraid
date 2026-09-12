/*
 * THE CAP A READ ACTUALLY REACHES (#1020, R-1020-35).
 *
 * Porting the app kit to Rust made two numbers measurable for the first time,
 * and both were wrong in v0:
 *
 *   1. A FAN-OUT REACHED HALF THE ROWS IT NAMED. `readPages` asked for
 *      `bound.pageSize` rows a page, and the host clamps every request to
 *      `MAX_PAGE_ROWS` (500). So Tally's `LEDGER_FAN_OUT` — declared
 *      `{ pageSize: 1000, fanOutPages: 8 }`, 8,000 rows — walked eight pages
 *      of 500, saw 4,000, and threw a refusal naming 8,000. The message named
 *      the half it had never read.
 *
 *   2. A DECLARED WINDOW CAME BACK A QUARTER LONG. A handler that wanted a
 *      2,000-row window asked for it as one page, took `.rows`, and dropped
 *      the `next` cursor that said there were 1,500 more. Tally's dashboard
 *      then folded a balance over it, which is a WRONG NUMBER and not a slow
 *      screen — the words its own doctrine comment uses.
 *
 * Both are tested against the real clamp: the fake host below applies
 * `probeLimit`/`pageOf` from `@centraid/core/page` rather than honouring
 * whatever limit it is handed, so a test cannot pass by being asked nicely.
 */

import { describe, expect, it } from "vitest";

import { MAX_PAGE_ROWS, pageOf, probeLimit } from "@centraid/core/page";

import { reachableBound, readPages, readWindow } from "./paged-reads.ts";

interface Row extends Record<string, unknown> {
  id: string;
}

/** `count` rows, keyed and sorted on `id`. */
function rows(count: number): Row[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `row-${String(index).padStart(5, "0")}`,
  }));
}

/**
 * A host that clamps exactly as the real one does.
 *
 * It runs the caller's limit through `probeLimit`, slices that many rows from
 * the keyset boundary, and hands the slice to `pageOf` — so the clamp, the
 * probe row and the cursor are the shipped code, not a restatement of it.
 */
function clampingCtx(all: Row[]) {
  const limits: number[] = [];
  return {
    limits,
    ctx: {
      vault: {
        page: <R extends object>(request: {
          query: { order: { sortColumn: string; pkColumn: string } };
          limit: number;
          after?: { sortKey: string; pk: string };
        }): Promise<{ rows: R[]; next?: { sortKey: string; pk: string } }> => {
          limits.push(request.limit);
          const start = request.after
            ? all.findIndex((row) => row.id === request.after!.pk) + 1
            : 0;
          const fetched = all.slice(start, start + probeLimit(request));
          const page = pageOf(fetched, request, (row) => ({
            sortKey: row.id,
            pk: row.id,
          }));
          return Promise.resolve(page as never);
        },
      },
    } as never,
  };
}

const QUERY = {
  name: "test.rows",
  select: "id",
  from: "rows",
  order: { sortColumn: "id", pkColumn: "id", descending: false },
} as const;

describe("a fan-out bound reaches the rows it states", () => {
  it("restates a page above the ceiling as more pages, keeping the product", () => {
    expect(reachableBound({ pageSize: 1000, fanOutPages: 8 })).toStrictEqual({
      pageSize: MAX_PAGE_ROWS,
      pages: 16,
      cap: 8000,
    });
    // A bound already inside the ceiling is untouched.
    expect(reachableBound({ pageSize: 500, fanOutPages: 8 })).toStrictEqual({
      pageSize: 500,
      pages: 8,
      cap: 4000,
    });
  });

  it("walks all 8,000 rows of Tally's stated ledger fan-out", async () => {
    // Red before the fix: the walk stopped after eight pages of 500 and threw
    // `test.rows: fan-out passed 8000 rows` having collected 4,000.
    const { ctx, limits } = clampingCtx(rows(8000));
    const walked = await readPages<Row>(ctx, QUERY, {
      pageSize: 1000,
      fanOutPages: 8,
    });
    expect(walked).toHaveLength(8000);
    expect(walked.at(-1)!.id).toBe("row-07999");
    // Every request was inside the ceiling, so none of them was clamped.
    expect(new Set(limits)).toStrictEqual(new Set([MAX_PAGE_ROWS]));
  });

  it("refuses past the cap it states, not past half of it", async () => {
    const { ctx } = clampingCtx(rows(8001));
    await expect(
      readPages<Row>(ctx, QUERY, { pageSize: 1000, fanOutPages: 8 })
    ).rejects.toThrow(/fan-out passed 8000 rows/u);
  });
});

describe("a stated window is walked to its end", () => {
  it("reads all 2,000 rows of a 2,000-row window", async () => {
    // Red before the fix: `ctx.vault.page({ limit: 2000 })` answered with 500
    // rows and a cursor, and the handler took `.rows`.
    const { ctx, limits } = clampingCtx(rows(2000));
    const walked = await readWindow<Row>(ctx, QUERY, 2000);
    expect(walked).toHaveLength(2000);
    expect(limits).toStrictEqual([500, 500, 500, 500]);
  });

  it("stops at the window rather than throwing, and never overruns it", async () => {
    const { ctx } = clampingCtx(rows(2600));
    const walked = await readWindow<Row>(ctx, QUERY, 2000);
    expect(walked).toHaveLength(2000);
    expect(walked.at(-1)!.id).toBe("row-01999");
  });

  it("stops at the rows when they end before the window", async () => {
    const { ctx, limits } = clampingCtx(rows(6));
    await expect(readWindow<Row>(ctx, QUERY, 2000)).resolves.toHaveLength(6);
    // One request only: the rows ended, so there was no continuation to make.
    expect(limits).toStrictEqual([500]);
  });

  it("asks for a window inside the ceiling in one request", async () => {
    const { ctx, limits } = clampingCtx(rows(400));
    await expect(readWindow<Row>(ctx, QUERY, 100)).resolves.toHaveLength(100);
    expect(limits).toStrictEqual([100]);
  });

  it("refuses a window that is not a positive whole number of rows", async () => {
    const { ctx } = clampingCtx(rows(10));
    await expect(readWindow<Row>(ctx, QUERY, 0)).rejects.toThrow(
      /must be a positive whole number of rows/u
    );
  });
});
