import { describe, expect, it, vi } from "vitest";

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
  const read = vi.fn<
    (request: {
      entity: string;
      limit?: number;
    }) => Promise<{ rows: unknown[] }>
  >(async (request) => {
    if (request.entity === "people.profile") {
      const cap = request.limit ?? rows.length;
      return { rows: rows.slice(0, cap) };
    }
    if (request.entity === "core.party") return { rows: parties };
    return { rows: [] };
  });
  return { ctx: { vault: { read } } as unknown as HandlerArgs["ctx"], read };
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
