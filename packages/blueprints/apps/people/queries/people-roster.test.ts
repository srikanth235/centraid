// The roster window must not drop people with no notice.
import { describe, expect, it } from "vitest";

import { pagedFixture } from "../../_shared/paged-ctx.test-fixtures.ts";
import { STATUS } from "../people-copy.ts";
import peopleHandler from "./people.ts";

function profiles(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    party_id: `p${String(index).padStart(3, "0")}`,
    created_at: "2026-01-01T00:00:00Z",
    cadence_days: 0,
  }));
}

function ctxOf(rows: Array<Record<string, unknown>>) {
  const parties = rows.map((row) => ({
    party_id: row.party_id,
    display_name: String(row.party_id),
  }));
  // The roster is a page since #996 wave 4, and the fixture pages for real:
  // it sorts by the statement's own two columns, honours the window and
  // produces a cursor exactly when a row was left behind. That is what makes
  // "not silently capped" a claim this test can still make — a fixture that
  // returned everything regardless of `limit` could not tell the two apart.
  const { page, statements } = pagedFixture({
    "core.party": parties,
    "people.profile": rows,
  });
  return {
    ctx: { vault: { page } } as unknown as HandlerArgs["ctx"],
    statements,
  };
}

describe("the roster is not silently capped at 200 rows", () => {
  it("returns every person when more than 200 are in hand", async () => {
    const result = await peopleHandler({
      input: {},
      ...ctxOf(profiles(250)),
    } as unknown as HandlerArgs);
    expect(result.people).toHaveLength(250);
    expect(result.truncated).toBe(false);
  });

  it("names a remaining cap on the status line instead of dropping quietly", () => {
    expect(STATUS.roster(200, 3, 1, true)).toContain("shown");
    expect(STATUS.roster(200, 3, 1)).not.toContain("shown");
  });
});
