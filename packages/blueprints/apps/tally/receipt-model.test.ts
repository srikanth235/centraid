// The receipt's reconciliation, stated as arithmetic.
//
// The FLOWS.md example is the fixture: six lines totalling £132.50 against an
// expense of £132.50, with the owner's own part coming to £41.17. It is pinned
// because the whole design of the surface rests on that sentence being true —
// a mis-allocation has to be visible before saving, and a foot that computed
// the wrong total would hide exactly the thing it exists to show.
import { describe, expect, it } from "vitest";

import {
  allocateLine,
  onLine,
  reconcile,
  selectionOf,
  toggleLine,
} from "./receipt-model.ts";
import type { ReceiptLine } from "./types.ts";

const PEOPLE = ["me", "ana", "tom"];

function line(
  id: string,
  description: string,
  amount: number,
  to: readonly string[],
  kind: ReceiptLine["kind"] = "item"
): ReceiptLine {
  return {
    line_item_id: id,
    kind,
    description,
    amount_minor: amount,
    sort_order: Number(id.slice(1)),
    allocations: to.map((party_id) => ({
      party_id,
      name: party_id,
      share_minor: 0,
    })),
  };
}

/** FLOWS.md's own receipt: the dinner at the Ship. */
const LINES: ReceiptLine[] = [
  line("l1", "Two mains", 3800, ["me", "tom"]),
  line("l2", "Fish, whole", 2900, ["ana"]),
  line("l3", "Bottle of the Picpoul", 2600, PEOPLE),
  line("l4", "Sides, three", 1450, PEOPLE),
  line("l5", "Puddings", 1200, ["ana", "tom"]),
  line("l6", "Service, 12.5%", 1300, PEOPLE, "tip"),
];

describe("one line, split between the people on it", () => {
  it("splits evenly and, where it cannot, to the EARLIER party", () => {
    // A line has no payer — four claims on a bottle are four equal claims —
    // so position is the tie-break, exactly as the phone's capture flow
    // resolves it. This is the one place Tally does NOT prefer the payer.
    expect(allocateLine(1000, PEOPLE)).toStrictEqual([
      { party_id: "me", share_minor: 334 },
      { party_id: "ana", share_minor: 333 },
      { party_id: "tom", share_minor: 333 },
    ]);
  });

  it("gives a line with nobody on it to nobody", () => {
    expect(allocateLine(1000, [])).toStrictEqual([]);
  });
});

describe("the chips, as a selection", () => {
  it("starts from the allocation the vault already holds", () => {
    const selection = selectionOf(LINES);
    expect(selection.l2).toStrictEqual(["ana"]);
    expect(onLine(selection, "l1", "tom")).toBe(true);
    expect(onLine(selection, "l1", "ana")).toBe(false);
  });

  it("adds and removes one person from one line, leaving the rest alone", () => {
    const start = selectionOf(LINES);
    const added = toggleLine(start, "l2", "tom");
    expect(added.l2).toStrictEqual(["ana", "tom"]);
    expect(added.l1).toStrictEqual(start.l1);
    expect(toggleLine(added, "l2", "tom").l2).toStrictEqual(["ana"]);
  });
});

describe("the foot states the arithmetic", () => {
  const folded = reconcile({
    lines: LINES,
    selection: selectionOf(LINES),
    expenseMinor: 13_250,
    me: "me",
    currency: "GBP",
    participants: PEOPLE,
  });

  it("adds the lines up to the expense", () => {
    expect(folded.lineTotalMinor).toBe(13_250);
    expect(folded.reconciles).toBe(true);
  });

  it("folds the owner's own part out of the line allocations", () => {
    // 1900 (mains) + 867 (wine) + 484 (sides) + 434 (service) = 3685.
    expect(folded.yoursMinor).toBe(3685);
  });

  it("says all of it in one sentence, with both figures in it", () => {
    expect(folded.sentence).toContain("6 lines total £132.50");
    expect(folded.sentence).toContain("the expense is £132.50");
    expect(folded.sentence).toContain("they reconcile");
    expect(folded.sentence).toContain("£36.85");
  });

  it("hands every penny of every line to somebody", () => {
    const total = folded.shares.reduce(
      (sum, share) => sum + share.share_minor,
      0
    );
    expect(total).toBe(13_250);
  });

  it("counts the lines nobody is on rather than hiding them", () => {
    const stripped = reconcile({
      lines: LINES,
      selection: { ...selectionOf(LINES), l2: [] },
      expenseMinor: 13_250,
      me: "me",
      currency: "GBP",
      participants: PEOPLE,
    });
    expect(stripped.unallocated).toBe(1);
    // The LINES still total the expense; it is the shares that fall short.
    expect(stripped.lineTotalMinor).toBe(13_250);
    expect(
      stripped.shares.reduce((sum, share) => sum + share.share_minor, 0)
    ).toBe(10_350);
  });

  it("says so out loud when the lines are not the expense", () => {
    const off = reconcile({
      lines: LINES,
      selection: selectionOf(LINES),
      expenseMinor: 12_800,
      me: "me",
      currency: "GBP",
      participants: PEOPLE,
    });
    expect(off.reconciles).toBe(false);
    expect(off.sentence).toContain("they do not reconcile");
  });

  it("reports no share of its own where there is no owner", () => {
    const anonymous = reconcile({
      lines: LINES,
      selection: selectionOf(LINES),
      expenseMinor: 13_250,
      me: null,
      currency: "GBP",
      participants: PEOPLE,
    });
    expect(anonymous.yoursMinor).toBe(0);
  });
});
