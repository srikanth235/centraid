// TYPED LINES — the sixth division's arithmetic, and the payload two commands
// take.
//
// PINNED HERE because the same fold serves *By line* on Add expense and the
// allocation editor on Receipt: if these two disagreed, one receipt would read
// two ways on two seats. The tie-break on a LINE is position, not the payer.
import { describe, expect, it } from "vitest";

import {
  allocateByLine,
  allocateLine,
  lineItems,
  lineShares,
  lineTotal,
  unallocatedCount,
} from "./line-model.ts";
import type { LineDraft } from "./line-model.ts";

const THREE = ["me", "ana", "tom"];

/** How this app renders one amount, stubbed to the pence so the sentence under
 *  test is the sentence and not the formatter. */
const money = (minor: number): string => (minor / 100).toFixed(2);

function line(over: Partial<LineDraft> = {}): LineDraft {
  return {
    lineId: "l1",
    kind: "item",
    description: "Wine",
    amount: "60.00",
    who: ["me", "ana"],
    ...over,
  };
}

describe("one line, split between the people on it", () => {
  it("splits evenly when it divides evenly", () => {
    expect(allocateLine(6000, ["me", "ana"])).toStrictEqual([
      { party_id: "me", share_minor: 3000 },
      { party_id: "ana", share_minor: 3000 },
    ]);
  });

  it("hands the remainder to the EARLIER party, not to a payer", () => {
    // A line has nobody out of pocket, so position is the only honest
    // tie-break — and it is the one the phone's capture flow already uses.
    expect(allocateLine(1000, THREE)).toStrictEqual([
      { party_id: "me", share_minor: 334 },
      { party_id: "ana", share_minor: 333 },
      { party_id: "tom", share_minor: 333 },
    ]);
  });

  it("leaves a line nobody is on with no allocations at all", () => {
    expect(allocateLine(6000, [])).toStrictEqual([]);
  });
});

describe("the payload the two commands take", () => {
  it("drops a line with no description, and keeps one with no people", () => {
    const items = lineItems([
      line(),
      line({ lineId: "l2", description: "   ", amount: "40.00" }),
      line({ lineId: "l3", description: "Bread", amount: "40.00", who: [] }),
    ]);
    expect(items.map((item) => item.description)).toStrictEqual([
      "Wine",
      "Bread",
    ]);
    expect(unallocatedCount(items)).toBe(1);
  });

  it("totals the lines, and folds them into a share per participant", () => {
    const items = lineItems([
      line(),
      line({
        lineId: "l2",
        description: "Food",
        amount: "40.00",
        who: ["tom"],
      }),
    ]);
    expect(lineTotal(items)).toBe(10_000);
    expect(lineShares(items, THREE)).toStrictEqual([
      { party_id: "me", share_minor: 3000 },
      { party_id: "ana", share_minor: 3000 },
      { party_id: "tom", share_minor: 4000 },
    ]);
  });

  it("gives a participant on no line a zero, rather than leaving them out", () => {
    const items = lineItems([line({ who: ["me"], amount: "100.00" })]);
    expect(lineShares(items, THREE)).toStrictEqual([
      { party_id: "me", share_minor: 10_000 },
      { party_id: "ana", share_minor: 0 },
      { party_id: "tom", share_minor: 0 },
    ]);
  });
});

describe("the reconciliation, stated as arithmetic", () => {
  const lines = [
    line(),
    line({ lineId: "l2", description: "Food", amount: "40.00", who: ["tom"] }),
  ];

  it("says the three figures the spec names, in that order", () => {
    const out = allocateByLine({
      lines,
      amountMinor: 10_000,
      participants: THREE,
      me: "me",
      currency: "GBP",
      money,
    });
    expect(out.line).toBe(
      "2 lines total 100.00, the expense is 100.00, yours is 30.00"
    );
    expect(out.ok).toBe(true);
  });

  it("refuses when the lines do not come to the expense", () => {
    const out = allocateByLine({
      lines,
      amountMinor: 13_250,
      participants: THREE,
      me: "me",
      currency: "GBP",
      money,
    });
    expect(out.ok).toBe(false);
    expect(out.balanced).toBe(false);
    expect(out.line).toContain("the expense is 132.50");
  });

  it("refuses an empty table rather than calling nothing balanced", () => {
    const out = allocateByLine({
      lines: [],
      amountMinor: 0,
      participants: THREE,
      me: "me",
      currency: "GBP",
      money,
    });
    expect(out.ok).toBe(false);
  });
});
