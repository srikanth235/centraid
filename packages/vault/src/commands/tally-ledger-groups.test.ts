import { beforeEach, describe, expect, test } from "vitest";

import { tallyLedgerFixture } from "./tally-ledger-test-kit.js";
import type { TallyLedgerFixture } from "./tally-ledger-test-kit.js";

let fx: TallyLedgerFixture;

describe("tally — #872 group commands", () => {
  beforeEach(() => {
    fx = tallyLedgerFixture();
  });

  describe("group life", () => {
    test("simplification is off by default and is the only thing the opt-in stores", () => {
      const priya = fx.addFriend("Priya");
      const groupId = fx.group([priya]);
      const before = fx.db.vault
        .prepare("SELECT simplify_opt_in FROM tally_group WHERE group_id = ?")
        .get(groupId) as { simplify_opt_in: number };
      expect(before.simplify_opt_in).toBe(0);
      fx.out(
        fx.invoke("tally.set_group_simplification", {
          group_id: groupId,
          simplify: true,
        })
      );
      const after = fx.db.vault
        .prepare("SELECT simplify_opt_in FROM tally_group WHERE group_id = ?")
        .get(groupId) as { simplify_opt_in: number };
      expect(after.simplify_opt_in).toBe(1);
    });

    test("leaving keeps every ledger row and only drops the membership", () => {
      const priya = fx.addFriend("Priya");
      const groupId = fx.group([priya]);
      fx.out(
        fx.invoke("tally.add_expense", {
          group_id: groupId,
          description: "Taxi",
          amount_minor: 600,
          paid_by: priya,
          category: "transport",
          splits: [
            { party_id: fx.me, share_minor: 300 },
            { party_id: priya, share_minor: 300 },
          ],
        })
      );
      expect(
        fx.invoke("tally.remove_group_member", {
          group_id: groupId,
          party_id: priya,
        }).status
      ).toBe("failed");

      const result = fx.out<{ party_id: string; on_ledger: boolean }>(
        fx.invoke("tally.leave_group", { group_id: groupId, party_id: priya })
      );
      expect(result.on_ledger).toBe(true);
      const members = fx.db.vault
        .prepare(
          `SELECT m.party_id AS id FROM social_circle_member m
             JOIN tally_group g ON g.circle_id = m.circle_id
            WHERE g.group_id = ?`
        )
        .all(groupId) as { id: string }[];
      expect(members.map((m) => m.id)).toStrictEqual([fx.me]);
      const splits = fx.db.vault
        .prepare(
          "SELECT count(*) AS n FROM tally_expense_split WHERE party_id = ?"
        )
        .get(priya) as { n: number };
      expect(splits.n).toBe(1);
    });

    test("leaving defaults to you", () => {
      const priya = fx.addFriend("Priya");
      const groupId = fx.group([priya]);
      const result = fx.out<{ party_id: string }>(
        fx.invoke("tally.leave_group", { group_id: groupId })
      );
      expect(result.party_id).toBe(fx.me);
    });

    test("archiving needs no settled balance, and keeps everything", () => {
      const priya = fx.addFriend("Priya");
      const groupId = fx.group([priya]);
      fx.out(
        fx.invoke("tally.add_expense", {
          group_id: groupId,
          description: "Taxi",
          amount_minor: 600,
          paid_by: fx.me,
          category: "transport",
          splits: [
            { party_id: fx.me, share_minor: 300 },
            { party_id: priya, share_minor: 300 },
          ],
        })
      );
      const archived = fx.out<{ archived_at: string | null }>(
        fx.invoke("tally.archive_group", { group_id: groupId })
      );
      const storedStamp = fx.db.vault
        .prepare("SELECT archived_at FROM tally_group WHERE group_id = ?")
        .get(groupId) as { archived_at: string | null };
      expect(archived.archived_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
      );
      expect(archived.archived_at).toBe(storedStamp.archived_at);
      const expenses = fx.db.vault
        .prepare("SELECT count(*) AS n FROM tally_expense WHERE group_id = ?")
        .get(groupId) as { n: number };
      expect(expenses.n).toBe(1);
      const restored = fx.out<{ archived_at: string | null }>(
        fx.invoke("tally.archive_group", { group_id: groupId, archived: false })
      );
      expect(restored.archived_at).toBeNull();
    });
  });

  describe("prepared reminders", () => {
    test("a nudge records an intention and states that nothing was sent", () => {
      const priya = fx.addFriend("Priya");
      const result = fx.out<{ nudge_id: string; sent: boolean }>(
        fx.invoke("tally.nudge", {
          party_id: priya,
          as_of_minor: -3400,
          note: "Ferry, back in June",
        })
      );
      expect(result.sent).toBe(false);
      const row = fx.db.vault
        .prepare(
          "SELECT party_id, as_of_minor, note FROM tally_nudge WHERE nudge_id = ?"
        )
        .get(result.nudge_id) as {
        party_id: string;
        as_of_minor: number;
        note: string;
      };
      expect({ ...row }).toStrictEqual({
        party_id: priya,
        as_of_minor: -3400,
        note: "Ferry, back in June",
      });
    });

    test("the command requires owner confirmation, so an app-issued nudge parks", () => {
      const capability = fx.db.vault
        .prepare(
          `SELECT cap.requires_confirmation AS n
             FROM agent_capability cap
             JOIN agent_command c ON c.command_id = cap.command_id
            WHERE c.name = 'tally.nudge'`
        )
        .get() as { n: number };
      expect(capability.n).toBe(1);
    });
  });
});
