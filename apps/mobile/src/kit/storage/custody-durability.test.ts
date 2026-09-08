// TWO STATES AND A CACHE BIT (#996, R7). The rollup carries five custody
// states and two local counters; a member gets two sentences and one bit.
import { describe, expect, it } from "vitest";

import { CUSTODY_BUCKETS, custodyDurability } from "./custody-durability";
import type { CustodyBucket, CustodyStatus } from "./custody-durability";

const rollup = (
  counts: Partial<Record<CustodyBucket, number>>
): CustodyStatus => ({
  computedAt: "2026-09-07T00:00:00Z",
  uncounted: [],
  buckets: Object.fromEntries(
    CUSTODY_BUCKETS.map((bucket) => [
      bucket,
      { count: counts[bucket] ?? 0, bytes: (counts[bucket] ?? 0) * 1_000 },
    ])
  ) as CustodyStatus["buckets"],
});

describe(custodyDurability, () => {
  it("folds the four states that mean the gateway holds it into one", () => {
    // The gateway's own disk, the remote tier, both, or both-and-queued. Four
    // spellings of "the CAS holds this sha, verified".
    const totals = custodyDurability(
      rollup({
        replicated: 4,
        "remote-only": 3,
        "local-only": 2,
        "pending-offsite": 1,
      })
    );
    expect(totals.backedUp).toStrictEqual({ count: 10, bytes: 10_000 });
    expect(totals.notBackedUp).toStrictEqual({ count: 0, bytes: 0 });
  });

  it("counts only `missing` as not backed up", () => {
    // The one state that says the bytes are in NEITHER tier. Anything else in
    // this column would tell a member their photograph is at risk when the
    // vault is holding it.
    const totals = custodyDurability(rollup({ replicated: 9, missing: 2 }));
    expect(totals.notBackedUp).toStrictEqual({ count: 2, bytes: 2_000 });
    expect(totals.backedUp.count).toBe(9);
  });

  it("keeps the cache bit out of both states", () => {
    // `freeable` counts SHAs and the states count ITEMS ("never sum",
    // `custody-rollup.ts`), and releasable is not a risk — it is a choice.
    const totals = custodyDurability(rollup({ replicated: 5, freeable: 5 }));
    expect(totals.releasable).toStrictEqual({ count: 5, bytes: 5_000 });
    expect(totals.backedUp.count).toBe(5);
    expect(totals.notBackedUp.count).toBe(0);
  });

  it("does not render `local-unproven` as a sixth state", () => {
    // It is the arithmetic complement of `freeable` over the local set, in a
    // different unit from the states beside it. Summing it into either column
    // is the confusion R7 names.
    const totals = custodyDurability(
      rollup({ replicated: 3, "local-unproven": 7 })
    );
    expect(totals.backedUp.count).toBe(3);
    expect(totals.notBackedUp.count).toBe(0);
  });
});
