// The minimal-transfer engine is opt-in because it rewires who owes whom, so
// the two things it must never get wrong are the money (a proposal that does
// not clear every position is worse than no proposal) and the claim it makes
// about itself (the before/after counts are the whole consent argument).

import { describe, expect, test } from "vitest";

import type { TallyBalanceData } from "./tally-balance.js";
import { tallyGroupNet } from "./tally-balance.js";
import { minimalTransfers, tallySimplification } from "./tally-simplify.js";

const GROUP = "group-flat";

function data(
  expenses: TallyBalanceData["expenses"],
  settlements: TallyBalanceData["settlements"] = [],
  members: string[] = ["ana", "ben", "cy"]
): TallyBalanceData {
  return { membersByGroup: new Map([[GROUP, members]]), expenses, settlements };
}

/** Apply the proposal to the positions and check everyone lands level. */
function settleAll(net: Map<string, number>): Map<string, number> {
  const after = new Map(net);
  for (const transfer of minimalTransfers(net)) {
    after.set(
      transfer.from,
      (after.get(transfer.from) ?? 0) + transfer.amount_minor
    );
    after.set(
      transfer.to,
      (after.get(transfer.to) ?? 0) - transfer.amount_minor
    );
  }
  return after;
}

describe("the minimal payment set", () => {
  test("clears every position exactly", () => {
    const cases: Array<Record<string, number>> = [
      { ana: 600, ben: -300, cy: -300 },
      { ana: -1, ben: 1 },
      { ana: 501, ben: -167, cy: -167, dee: -167 },
      { ana: 0, ben: 0 },
      { ana: 1_000, ben: -999, cy: -1 },
    ];
    for (const positions of cases)
      for (const value of settleAll(
        new Map(Object.entries(positions))
      ).values())
        expect(value).toBe(0);
  });

  test("never proposes more payments than there are non-level members", () => {
    const net = new Map(
      Object.entries({ ana: 700, ben: 300, cy: -400, dee: -600 })
    );
    const transfers = minimalTransfers(net);
    expect(transfers.length).toBeLessThanOrEqual(3);
    for (const transfer of transfers)
      expect(transfer.amount_minor).toBeGreaterThan(0);
  });

  test("a level group is proposed nothing", () => {
    expect(minimalTransfers(new Map([["ana", 0]]))).toStrictEqual([]);
  });

  test("the same positions always propose the same payments", () => {
    const positions = { ana: 500, ben: 500, cy: -400, dee: -600 };
    const once = minimalTransfers(new Map(Object.entries(positions)));
    const again = minimalTransfers(
      new Map(Object.entries(positions).toReversed())
    );
    expect(again).toStrictEqual(once);
  });
});

describe("the group proposal", () => {
  // Ana paid for dinner, Ben paid for the taxi; three ways each. Ana and Ben
  // partly cancel out, so three directed debts stand: ben→ana, cy→ana, cy→ben.
  const ledger = data([
    {
      group_id: GROUP,
      paid_by: "ana",
      amount_minor: 900,
      splits: { ana: 300, ben: 300, cy: 300 },
      payers: { ana: 900 },
    },
    {
      group_id: GROUP,
      paid_by: "ben",
      amount_minor: 600,
      splits: { ana: 200, ben: 200, cy: 200 },
      payers: { ben: 600 },
    },
  ]);

  test("a group that has not opted in is proposed nothing, and says so", () => {
    const result = tallySimplification(ledger, GROUP, false);
    expect(result.opted_in).toBe(false);
    expect(result.transfers).toStrictEqual([]);
    // With no proposal, "after" is what stands today — never a smaller number
    // the group did not agree to.
    expect(result.payments_after).toBe(result.debts_before);
  });

  test("an opted-in group is told what the proposal rewired", () => {
    const result = tallySimplification(ledger, GROUP, true);
    expect(result.opted_in).toBe(true);
    expect(result.debts_before).toBe(3);
    expect(result.payments_after).toBe(result.transfers.length);
    expect(result.payments_after).toBeLessThan(result.debts_before);
    // And the proposal still clears the group.
    const after = new Map(tallyGroupNet(ledger, GROUP));
    for (const transfer of result.transfers) {
      after.set(
        transfer.from,
        (after.get(transfer.from) ?? 0) + transfer.amount_minor
      );
      after.set(
        transfer.to,
        (after.get(transfer.to) ?? 0) - transfer.amount_minor
      );
    }
    for (const value of after.values()) expect(value).toBe(0);
  });

  test("a multi-payer ledger simplifies without losing a cent", () => {
    const multi = data([
      {
        group_id: GROUP,
        paid_by: "ana",
        amount_minor: 1_001,
        splits: { ana: 333, ben: 334, cy: 334 },
        payers: { ana: 700, cy: 301 },
      },
    ]);
    const result = tallySimplification(multi, GROUP, true);
    const after = new Map(tallyGroupNet(multi, GROUP));
    for (const transfer of result.transfers) {
      after.set(
        transfer.from,
        (after.get(transfer.from) ?? 0) + transfer.amount_minor
      );
      after.set(
        transfer.to,
        (after.get(transfer.to) ?? 0) - transfer.amount_minor
      );
    }
    for (const value of after.values()) expect(value).toBe(0);
  });
});
