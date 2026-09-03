import { describe, expect, it, vi } from "vitest";

import type * as Gateway from "../../lib/gateway";
import { foldCustodyStatus, readCustodyStatus } from "./custody-status";
import type {
  CustodyBucket,
  CustodyStatusVault,
  CustodyTotals,
} from "./custody-status";

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
    fetchJson.mockRejectedValue(new Error("offline"));
    await expect(readCustodyStatus("https://gw.test")).resolves.toBeNull();
  });
});
