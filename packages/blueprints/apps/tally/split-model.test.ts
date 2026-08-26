// The six divisions and the three laws that decide whether one commits.
//
// These are the rules a member reads off the reconcile line, so they are
// pinned as arithmetic rather than as rendering: the odd penny goes to the
// PAYER (not to the first row, which is what the phone's receipt allocator
// does and what a copy of it would have done here), exact amounts get ONE
// penny of tolerance and not two, and percentages will not commit at 99.
import { describe, expect, it } from "vitest";

import {
  DIVISIONS,
  allocate,
  allocateEqually,
  allocateWeighted,
  divisionSpec,
  prefill,
} from "./split-model.ts";

const THREE = ["me", "ana", "tom"];

describe("equal shares, and where the odd penny lands", () => {
  it("splits evenly when it divides evenly", () => {
    expect(allocateEqually(9000, THREE, "me")).toStrictEqual([
      { party_id: "me", share_minor: 3000 },
      { party_id: "ana", share_minor: 3000 },
      { party_id: "tom", share_minor: 3000 },
    ]);
  });

  it("gives the odd penny to the payer, wherever the payer sits", () => {
    // £100.00 three ways is 33.34 / 33.33 / 33.33, and the extra penny is the
    // payer's — Tom's here, even though he is the LAST row.
    expect(allocateEqually(10_000, THREE, "tom")).toStrictEqual([
      { party_id: "me", share_minor: 3333 },
      { party_id: "ana", share_minor: 3333 },
      { party_id: "tom", share_minor: 3334 },
    ]);
  });

  it("spills the second penny in table order, and always sums exactly", () => {
    const shares = allocateEqually(10_001, THREE, "ana");
    expect(shares.map((share) => share.share_minor)).toStrictEqual([
      3334, 3334, 3333,
    ]);
    expect(shares.reduce((sum, share) => sum + share.share_minor, 0)).toBe(
      10_001
    );
  });

  it("hands the whole amount to the only participant", () => {
    expect(allocateEqually(999, ["me"], "me")).toStrictEqual([
      { party_id: "me", share_minor: 999 },
    ]);
  });

  it("allocates nothing between nobody rather than throwing", () => {
    expect(allocateEqually(500, [], "me")).toStrictEqual([]);
  });

  it("falls back to zeroes when every weight is zero", () => {
    expect(
      allocateWeighted(
        500,
        THREE.map((party_id) => ({ party_id, value: 0 })),
        "me"
      )
    ).toStrictEqual([
      { party_id: "me", share_minor: 0 },
      { party_id: "ana", share_minor: 0 },
      { party_id: "tom", share_minor: 0 },
    ]);
  });

  it("gives the payer the penny even when they are not on the expense", () => {
    // A payer outside the participants simply takes no remainder; the pennies
    // fall to the table order instead of vanishing.
    const shares = allocateWeighted(
      10_000,
      THREE.map((party_id) => ({ party_id, value: 1 })),
      "priya"
    );
    expect(shares.reduce((sum, share) => sum + share.share_minor, 0)).toBe(
      10_000
    );
    expect(shares[0]?.share_minor).toBe(3334);
  });
});

const base = {
  amountMinor: 10_000,
  participants: THREE,
  payerId: "me",
  currency: "GBP",
};

describe("what each division commits, and what it says", () => {
  it("equal always commits, and names the odd penny", () => {
    const out = allocate({ ...base, division: "equal", entries: {} });
    expect(out.ok).toBe(true);
    expect(out.line).toContain("the odd penny goes to the payer, always");
  });

  it("exact amounts commit inside a penny of tolerance", () => {
    const out = allocate({
      ...base,
      division: "exact",
      entries: { me: 3333, ana: 3333, tom: 3333 },
    });
    // 99.99 against 100.00 — one penny out, which is the tolerance.
    expect(out.ok).toBe(true);
    expect(out.line).toContain("a penny of tolerance either way");
  });

  it("exact amounts refuse at two pennies out, and say by how much", () => {
    const out = allocate({
      ...base,
      division: "exact",
      entries: { me: 3333, ana: 3333, tom: 3332 },
    });
    expect(out.ok).toBe(false);
    expect(out.balanced).toBe(false);
    expect(out.line).toContain("and this is more");
  });

  it("percentages commit at 100 and refuse at 99", () => {
    const hundred = allocate({
      ...base,
      division: "percent",
      entries: { me: 40, ana: 35, tom: 25 },
    });
    expect(hundred.ok).toBe(true);
    expect(hundred.line).toBe("40 + 35 + 25 = 100 · it will not commit at 99");
    expect(hundred.shares).toStrictEqual([
      { party_id: "me", share_minor: 4000 },
      { party_id: "ana", share_minor: 3500 },
      { party_id: "tom", share_minor: 2500 },
    ]);

    const ninetyNine = allocate({
      ...base,
      division: "percent",
      entries: { me: 40, ana: 35, tom: 24 },
    });
    expect(ninetyNine.ok).toBe(false);
    expect(ninetyNine.line).toContain("= 99");
  });

  it("percentages still allocate to the last penny", () => {
    const out = allocate({
      ...base,
      amountMinor: 10_001,
      division: "percent",
      entries: { me: 33, ana: 33, tom: 34 },
    });
    expect(out.shares.reduce((sum, s) => sum + s.share_minor, 0)).toBe(10_001);
  });

  it.each([
    ["shares" as const, "weights, the way a recurring template already splits"],
    ["adjust" as const, "An equal base, then the adjustments"],
    ["lines" as const, "typed lines totalling"],
  ])("%s is drawn in full and refuses the commit", (division, fragment) => {
    const out = allocate({
      ...base,
      division,
      entries: { me: 2, ana: 1, tom: 1 },
    });
    // The shares exist — the table is the review surface — and the commit
    // does not, because the vault does not back the method.
    expect(out.shares).toHaveLength(3);
    expect(out.ok).toBe(false);
    expect(out.line).toContain(fragment);
  });

  it("adjusts an equal base by the typed deltas", () => {
    const out = allocate({
      ...base,
      amountMinor: 9000,
      division: "adjust",
      entries: { me: 500, ana: -500, tom: 0 },
    });
    expect(out.shares).toStrictEqual([
      { party_id: "me", share_minor: 3500 },
      { party_id: "ana", share_minor: 2500 },
      { party_id: "tom", share_minor: 3000 },
    ]);
    expect(out.balanced).toBe(true);
  });
});

describe("the register the table is typed in", () => {
  it("names exactly six divisions, three of them backed", () => {
    expect(DIVISIONS).toHaveLength(6);
    expect(
      DIVISIONS.filter((spec) => spec.backed).map((spec) => spec.id)
    ).toStrictEqual(["equal", "exact", "percent"]);
  });

  it("says what unit each division's cell is typed in", () => {
    expect(divisionSpec("equal").unit).toBe("derived");
    expect(divisionSpec("percent").unit).toBe("percent");
    expect(divisionSpec("shares").unit).toBe("shares");
    expect(divisionSpec("lines").unit).toBe("money");
  });

  it("pre-fills percentages that already total 100", () => {
    const filled = prefill("percent", 10_000, THREE, "me");
    expect(Object.values(filled).reduce((sum, n) => sum + n, 0)).toBe(100);
  });

  it("pre-fills exact amounts from the equal split", () => {
    expect(prefill("exact", 10_000, THREE, "me")).toStrictEqual({
      me: 3334,
      ana: 3333,
      tom: 3333,
    });
  });
});
