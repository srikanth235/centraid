import { beforeEach, describe, expect, test } from "vitest";

import { tallyLedgerFixture } from "./tally-ledger-test-kit.js";
import type { TallyLedgerFixture } from "./tally-ledger-test-kit.js";

let fx: TallyLedgerFixture;

describe("tally — #872 expense entry", () => {
  beforeEach(() => {
    fx = tallyLedgerFixture();
  });

  describe("split methods", () => {
    test("the method and its parameters ride on the expense so an edit re-opens the way it was entered", () => {
      const priya = fx.addFriend("Priya");
      const groupId = fx.group([priya]);
      const { expense_id } = fx.out<{ expense_id: string }>(
        fx.invoke("tally.add_expense", {
          group_id: groupId,
          description: "Rent",
          amount_minor: 1000,
          paid_by: fx.me,
          category: "rent",
          split_method: "shares",
          split_params: { weights: [{ party_id: fx.me, weight: 3 }] },
          splits: [
            { party_id: fx.me, share_minor: 750 },
            { party_id: priya, share_minor: 250 },
          ],
        })
      );
      const row = fx.db.vault
        .prepare(
          "SELECT split_method, split_params_json FROM tally_expense WHERE expense_id = ?"
        )
        .get(expense_id) as {
        split_method: string;
        split_params_json: string;
      };
      expect(row.split_method).toBe("shares");
      expect(JSON.parse(row.split_params_json)).toStrictEqual({
        weights: [{ party_id: fx.me, weight: 3 }],
      });
    });

    test("an expense entered without a method reads as exact amounts, never as a guess", () => {
      const priya = fx.addFriend("Priya");
      const groupId = fx.group([priya]);
      const { expense_id } = fx.out<{ expense_id: string }>(
        fx.invoke("tally.add_expense", {
          group_id: groupId,
          description: "Taxi",
          amount_minor: 500,
          paid_by: fx.me,
          category: "transport",
          splits: [{ party_id: fx.me, share_minor: 500 }],
        })
      );
      const row = fx.db.vault
        .prepare("SELECT split_method FROM tally_expense WHERE expense_id = ?")
        .get(expense_id) as { split_method: string };
      expect(row.split_method).toBe("exact");
    });

    test("by-line: typed lines need no receipt photo, and their totals are re-validated", () => {
      const priya = fx.addFriend("Priya");
      const groupId = fx.group([priya]);
      const { expense_id } = fx.out<{ expense_id: string }>(
        fx.invoke("tally.add_expense", {
          group_id: groupId,
          description: "Dinner",
          amount_minor: 1200,
          paid_by: fx.me,
          category: "food",
          splits: [
            { party_id: fx.me, share_minor: 700 },
            { party_id: priya, share_minor: 500 },
          ],
          line_items: [
            {
              kind: "item",
              description: "Curry",
              amount_minor: 1000,
              allocations: [
                { party_id: fx.me, share_minor: 600 },
                { party_id: priya, share_minor: 400 },
              ],
            },
            {
              kind: "tip",
              description: "Tip",
              amount_minor: 200,
              allocations: [
                { party_id: fx.me, share_minor: 100 },
                { party_id: priya, share_minor: 100 },
              ],
            },
          ],
        })
      );
      const lines = fx.db.vault
        .prepare(
          "SELECT line_item_id, receipt_id FROM tally_expense_line_item WHERE expense_id = ? ORDER BY sort_order"
        )
        .all(expense_id) as { line_item_id: string; receipt_id: null }[];
      expect(lines).toHaveLength(2);
      for (const line of lines) expect(line.receipt_id).toBeNull();
      const method = fx.db.vault
        .prepare("SELECT split_method FROM tally_expense WHERE expense_id = ?")
        .get(expense_id) as { split_method: string };
      expect(method.split_method).toBe("by_line");
    });

    test("lines that do not sum to the expense are refused", () => {
      const priya = fx.addFriend("Priya");
      const groupId = fx.group([priya]);
      const reason = fx.refusal(
        fx.invoke("tally.add_expense", {
          group_id: groupId,
          description: "Dinner",
          amount_minor: 1200,
          paid_by: fx.me,
          category: "food",
          splits: [{ party_id: fx.me, share_minor: 1200 }],
          line_items: [
            {
              kind: "item",
              description: "Curry",
              amount_minor: 1000,
              allocations: [{ party_id: fx.me, share_minor: 1000 }],
            },
          ],
        })
      );
      expect(reason).toContain("lines must sum to the expense amount");
    });

    test("a line whose allocations do not sum to it is refused", () => {
      const priya = fx.addFriend("Priya");
      const groupId = fx.group([priya]);
      const reason = fx.refusal(
        fx.invoke("tally.add_expense", {
          group_id: groupId,
          description: "Dinner",
          amount_minor: 1000,
          paid_by: fx.me,
          category: "food",
          splits: [{ party_id: fx.me, share_minor: 1000 }],
          line_items: [
            {
              kind: "item",
              description: "Curry",
              amount_minor: 1000,
              allocations: [{ party_id: fx.me, share_minor: 900 }],
            },
          ],
        })
      );
      expect(reason).toContain(
        'allocations for "Curry" must sum to its amount'
      );
    });
  });

  describe("multiple payers", () => {
    test("a single-payer expense still writes its one degenerate payer row", () => {
      const priya = fx.addFriend("Priya");
      const groupId = fx.group([priya]);
      const { expense_id } = fx.out<{ expense_id: string }>(
        fx.invoke("tally.add_expense", {
          group_id: groupId,
          description: "Hotel",
          amount_minor: 900,
          paid_by: fx.me,
          category: "travel",
          splits: [{ party_id: fx.me, share_minor: 900 }],
        })
      );
      const payers = fx.db.vault
        .prepare(
          "SELECT party_id, paid_minor FROM tally_expense_payer WHERE expense_id = ?"
        )
        .all(expense_id) as { party_id: string; paid_minor: number }[];
      expect(payers.map((p) => ({ ...p }))).toStrictEqual([
        { party_id: fx.me, paid_minor: 900 },
      ]);
    });

    test("several payers are recorded, and paid_by stays the named principal", () => {
      const priya = fx.addFriend("Priya");
      const groupId = fx.group([priya]);
      const { expense_id } = fx.out<{ expense_id: string }>(
        fx.invoke("tally.add_expense", {
          group_id: groupId,
          description: "Villa",
          amount_minor: 1000,
          paid_by: priya,
          payers: [
            { party_id: fx.me, paid_minor: 400 },
            { party_id: priya, paid_minor: 600 },
          ],
          category: "travel",
          splits: [
            { party_id: fx.me, share_minor: 500 },
            { party_id: priya, share_minor: 500 },
          ],
        })
      );
      const payers = fx.db.vault
        .prepare(
          "SELECT party_id, paid_minor FROM tally_expense_payer WHERE expense_id = ? ORDER BY paid_minor"
        )
        .all(expense_id) as { party_id: string; paid_minor: number }[];
      expect(payers.map((p) => ({ ...p }))).toStrictEqual([
        { party_id: fx.me, paid_minor: 400 },
        { party_id: priya, paid_minor: 600 },
      ]);
      const row = fx.db.vault
        .prepare("SELECT paid_by FROM tally_expense WHERE expense_id = ?")
        .get(expense_id) as { paid_by: string };
      expect(row.paid_by).toBe(priya);
    });

    test("payers that do not sum to the amount are refused", () => {
      const priya = fx.addFriend("Priya");
      const groupId = fx.group([priya]);
      const reason = fx.refusal(
        fx.invoke("tally.add_expense", {
          group_id: groupId,
          description: "Villa",
          amount_minor: 1000,
          paid_by: fx.me,
          payers: [
            { party_id: fx.me, paid_minor: 400 },
            { party_id: priya, paid_minor: 100 },
          ],
          category: "travel",
          splits: [{ party_id: fx.me, share_minor: 1000 }],
        })
      );
      expect(reason).toContain("payers must sum to the amount");
    });

    test("a named payer outside the payer list is refused", () => {
      const priya = fx.addFriend("Priya");
      const groupId = fx.group([priya]);
      const reason = fx.refusal(
        fx.invoke("tally.add_expense", {
          group_id: groupId,
          description: "Villa",
          amount_minor: 1000,
          paid_by: fx.me,
          payers: [{ party_id: priya, paid_minor: 1000 }],
          category: "travel",
          splits: [{ party_id: fx.me, share_minor: 1000 }],
        })
      );
      expect(reason).toContain("the named payer is not in the payer list");
    });

    test("a payer who is not in the group is refused", () => {
      const priya = fx.addFriend("Priya");
      const outsider = fx.addFriend("Outsider");
      const groupId = fx.group([priya]);
      const reason = fx.refusal(
        fx.invoke("tally.add_expense", {
          group_id: groupId,
          description: "Villa",
          amount_minor: 1000,
          paid_by: fx.me,
          payers: [
            { party_id: fx.me, paid_minor: 500 },
            { party_id: outsider, paid_minor: 500 },
          ],
          category: "travel",
          splits: [{ party_id: fx.me, share_minor: 1000 }],
        })
      );
      expect(reason).toContain("payer is not a member of this group");
    });
  });

  describe("group-less 1:1 expenses", () => {
    test("an expense with no group is recorded against the friend roster", () => {
      const priya = fx.addFriend("Priya");
      const { expense_id } = fx.out<{ expense_id: string }>(
        fx.invoke("tally.add_expense", {
          description: "Ferry",
          amount_minor: 800,
          paid_by: fx.me,
          category: "transport",
          splits: [
            { party_id: fx.me, share_minor: 400 },
            { party_id: priya, share_minor: 400 },
          ],
        })
      );
      const row = fx.db.vault
        .prepare("SELECT group_id FROM tally_expense WHERE expense_id = ?")
        .get(expense_id) as { group_id: string | null };
      expect(row.group_id).toBeNull();
    });

    test("a participant who is neither you nor a Tally friend is refused", () => {
      const stranger = "party-never-enrolled";
      fx.db.vault
        .prepare(
          `INSERT INTO core_party (party_id, kind, display_name, sort_name, birth_date, avatar_content_id, created_at, updated_at)
           VALUES (?, 'person', 'Stranger', NULL, NULL, NULL, ?, ?)`
        )
        .run(stranger, new Date().toISOString(), new Date().toISOString());
      const reason = fx.refusal(
        fx.invoke("tally.add_expense", {
          description: "Ferry",
          amount_minor: 800,
          paid_by: fx.me,
          category: "transport",
          splits: [{ party_id: stranger, share_minor: 800 }],
        })
      );
      expect(reason).toContain("must be you or a Tally friend");
    });

    test("a group that does not exist is still refused when one is named", () => {
      const reason = fx.refusal(
        fx.invoke("tally.add_expense", {
          group_id: "group-does-not-exist",
          description: "Ferry",
          amount_minor: 800,
          paid_by: fx.me,
          category: "transport",
          splits: [{ party_id: fx.me, share_minor: 800 }],
        })
      );
      expect(reason).toContain("group_exists");
    });
  });

  describe("reallocate_receipt", () => {
    function itemised(): { expenseId: string; priya: string } {
      const priya = fx.addFriend("Priya");
      const groupId = fx.group([priya]);
      const { expense_id } = fx.out<{ expense_id: string }>(
        fx.invoke("tally.add_expense", {
          group_id: groupId,
          description: "Dinner",
          amount_minor: 1000,
          paid_by: fx.me,
          category: "food",
          splits: [
            { party_id: fx.me, share_minor: 500 },
            { party_id: priya, share_minor: 500 },
          ],
          line_items: [
            {
              kind: "item",
              description: "Shared platter",
              amount_minor: 1000,
              allocations: [
                { party_id: fx.me, share_minor: 500 },
                { party_id: priya, share_minor: 500 },
              ],
            },
          ],
        })
      );
      return { expenseId: expense_id, priya };
    }

    test("lines and the derived splits move together in one write", () => {
      const { expenseId, priya } = itemised();
      fx.out(
        fx.invoke("tally.reallocate_receipt", {
          expense_id: expenseId,
          line_items: [
            {
              kind: "item",
              description: "Mine",
              amount_minor: 700,
              allocations: [{ party_id: fx.me, share_minor: 700 }],
            },
            {
              kind: "item",
              description: "Hers",
              amount_minor: 300,
              allocations: [{ party_id: priya, share_minor: 300 }],
            },
          ],
          splits: [
            { party_id: fx.me, share_minor: 700 },
            { party_id: priya, share_minor: 300 },
          ],
        })
      );
      const splits = fx.db.vault
        .prepare(
          "SELECT party_id, share_minor FROM tally_expense_split WHERE expense_id = ? ORDER BY share_minor"
        )
        .all(expenseId) as { party_id: string; share_minor: number }[];
      expect(splits.map((r) => ({ ...r }))).toStrictEqual([
        { party_id: priya, share_minor: 300 },
        { party_id: fx.me, share_minor: 700 },
      ]);
      const lines = fx.db.vault
        .prepare(
          "SELECT description, amount_minor FROM tally_expense_line_item WHERE expense_id = ? ORDER BY sort_order"
        )
        .all(expenseId) as { description: string; amount_minor: number }[];
      expect(lines.map((r) => ({ ...r }))).toStrictEqual([
        { description: "Mine", amount_minor: 700 },
        { description: "Hers", amount_minor: 300 },
      ]);
    });

    test("a re-allocation whose splits no longer reconcile leaves nothing behind", () => {
      const { expenseId, priya } = itemised();
      const reason = fx.refusal(
        fx.invoke("tally.reallocate_receipt", {
          expense_id: expenseId,
          line_items: [
            {
              kind: "item",
              description: "Mine",
              amount_minor: 1000,
              allocations: [{ party_id: fx.me, share_minor: 1000 }],
            },
          ],
          splits: [{ party_id: priya, share_minor: 400 }],
        })
      );
      expect(reason).toContain("splits must sum to the amount");
      const lines = fx.db.vault
        .prepare(
          "SELECT description FROM tally_expense_line_item WHERE expense_id = ?"
        )
        .all(expenseId) as { description: string }[];
      expect(lines.map((r) => ({ ...r }))).toStrictEqual([
        { description: "Shared platter" },
      ]);
    });

    test("the pre-image carries the lines, so one undo puts both halves back", () => {
      const { expenseId, priya } = itemised();
      const { revision_id } = fx.out<{ revision_id: string }>(
        fx.invoke("tally.reallocate_receipt", {
          expense_id: expenseId,
          line_items: [
            {
              kind: "item",
              description: "Mine",
              amount_minor: 1000,
              allocations: [{ party_id: fx.me, share_minor: 1000 }],
            },
          ],
          splits: [{ party_id: fx.me, share_minor: 1000 }],
        })
      );
      fx.out(
        fx.invoke("tally.undo_expense", {
          expense_id: expenseId,
          revision_id,
        })
      );
      const lines = fx.db.vault
        .prepare(
          "SELECT description FROM tally_expense_line_item WHERE expense_id = ?"
        )
        .all(expenseId) as { description: string }[];
      expect(lines.map((r) => ({ ...r }))).toStrictEqual([
        { description: "Shared platter" },
      ]);
      const splits = fx.db.vault
        .prepare(
          "SELECT party_id, share_minor FROM tally_expense_split WHERE expense_id = ? ORDER BY party_id"
        )
        .all(expenseId) as { party_id: string; share_minor: number }[];
      expect(splits).toHaveLength(2);
      expect(splits.map((s) => s.share_minor)).toStrictEqual([500, 500]);
      expect(new Set(splits.map((s) => s.party_id))).toStrictEqual(
        new Set([fx.me, priya])
      );
    });
  });
});
