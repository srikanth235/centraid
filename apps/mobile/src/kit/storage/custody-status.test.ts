// The fold of the gateway's custody rollup (#712 B3). What is pinned here is
// the one property the whole block exists for: an UNCOUNTED vault contributes
// nothing and is NAMED, rather than being summed in as a row of zeroes.

import { describe, expect, it, vi } from "vitest";

import type * as Gateway from "../../lib/gateway";
import { foldCustodyStatus, readCustodyStatus } from "./custody-status";
import type {
  CustodyBucket,
  CustodyStatusVault,
  CustodyTotals,
} from "./custody-status";

// Mocked the way `lib/daily-brief.test.ts` mocks it, so the HTTP shape is
// exercised without a real gateway — and without pulling react-native in.
const { apiHeaders, fetchJson } = vi.hoisted(() => ({
  apiHeaders: vi.fn<typeof Gateway.apiHeaders>(() => ({})),
  fetchJson: vi.fn<typeof Gateway.fetchJson>(),
}));
vi.mock(
  import("../../lib/gateway"),
  () => ({ apiHeaders, fetchJson }) as unknown as typeof Gateway
);

const vault = (
  name: string,
  computedAt: string | null,
  buckets: Partial<Record<CustodyBucket, CustodyTotals>> = {}
): CustodyStatusVault => ({ name, custody: { computedAt, buckets } });

describe(foldCustodyStatus, () => {
  it("sums counted vaults and keeps the OLDEST sweep instant", () => {
    // A total is only as current as its stalest part, so the weakest link is
    // what the surface may claim it was counted at.
    const folded = foldCustodyStatus([
      vault("Mine", "2026-08-06T10:00:00.000Z", {
        freeable: { count: 2, bytes: 200 },
      }),
      vault("Household", "2026-08-05T09:00:00.000Z", {
        freeable: { count: 3, bytes: 300 },
      }),
    ]);
    expect(folded.computedAt).toBe("2026-08-05T09:00:00.000Z");
    expect(folded.buckets.freeable).toStrictEqual({ count: 5, bytes: 500 });
    expect(folded.uncounted).toStrictEqual([]);
  });

  it("names an unswept vault instead of summing its zeroes", () => {
    const folded = foldCustodyStatus([
      vault("Mine", "2026-08-06T10:00:00.000Z", {
        "local-unproven": { count: 4, bytes: 40 },
      }),
      vault("Household", null, {}),
    ]);
    expect(folded.uncounted).toStrictEqual(["Household"]);
    expect(folded.buckets["local-unproven"]).toStrictEqual({
      count: 4,
      bytes: 40,
    });
  });

  it("computedAt stays null when NOT ONE vault has been swept", () => {
    // The load-bearing difference: null means "nobody has looked", and the
    // surface must say so rather than render zeroes, which read as "you have
    // nothing".
    const folded = foldCustodyStatus([vault("Mine", null), vault("B", null)]);
    expect(folded.computedAt).toBeNull();
    expect(folded.uncounted).toStrictEqual(["Mine", "B"]);
  });

  it("a gateway too old to send the block is uncounted, not empty", () => {
    const folded = foldCustodyStatus([{ name: "Legacy" }]);
    expect(folded.computedAt).toBeNull();
    expect(folded.uncounted).toStrictEqual(["Legacy"]);
  });

  it("zero-fills every bucket so no caller needs a `?? 0`", () => {
    const folded = foldCustodyStatus([
      vault("Mine", "2026-08-06T10:00:00.000Z", {
        replicated: { count: 1, bytes: 10 },
      }),
    ]);
    expect(folded.buckets.missing).toStrictEqual({ count: 0, bytes: 0 });
    expect(folded.buckets["pending-offsite"]).toStrictEqual({
      count: 0,
      bytes: 0,
    });
  });
});

describe(readCustodyStatus, () => {
  it("folds the route's vaults", async () => {
    fetchJson.mockResolvedValue({
      vaults: [
        {
          name: "Mine",
          custody: {
            computedAt: "2026-08-06T10:00:00.000Z",
            buckets: { freeable: { count: 1, bytes: 10 } },
          },
        },
      ],
    } as never);
    const status = await readCustodyStatus("https://gw.test");
    expect(status?.buckets.freeable).toStrictEqual({ count: 1, bytes: 10 });
  });

  it("answers null when the read fails — never a fold of zeroes", async () => {
    // Zeroes would render as "your library is empty and nothing is freeable",
    // which is a claim about the originals rather than about this read.
    fetchJson.mockRejectedValue(new Error("offline"));
    await expect(readCustodyStatus("https://gw.test")).resolves.toBeNull();
  });
});
