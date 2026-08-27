// The write door: the manifest action each act invokes, and the input its
// schema requires.
//
// These are pinned because a write is the one thing a render cannot be trusted
// to assemble: `app.json` declares `restore-expense` with `expense_id`
// required and nothing else permitted, and a field spread in from a view model
// is refused by the vault at the far end of a member's press.
import { describe, expect, it } from "vitest";

import {
  addExpenseWrite,
  addFriendWrite,
  addMemberWrite,
  archiveGroupWrite,
  createGroupWrite,
  deleteGroupWrite,
  editExpenseWrite,
  editOccurrenceWrite,
  leaveGroupWrite,
  materializeWrite,
  nudgeWrite,
  reallocateReceiptWrite,
  removeMemberWrite,
  renameGroupWrite,
  restoreExpenseWrite,
  saveRecurringWrite,
  setSimplificationWrite,
  settleUpWrite,
  trashExpenseWrite,
  undoExpenseWrite,
} from "./writes.ts";

describe("the acts this wave can take", () => {
  it("restores a trashed expense by id alone", () => {
    expect(restoreExpenseWrite("x1")).toStrictEqual({
      action: "restore-expense",
      input: { expense_id: "x1" },
    });
  });

  it("trashes with the write that is a restore's true reverse", () => {
    // The Undo beside a restore issues exactly this, which is why the pair is
    // the only one in this wave that offers Undo at all.
    expect(trashExpenseWrite("x1")).toStrictEqual({
      action: "delete-expense",
      input: { expense_id: "x1" },
    });
  });

  it("removes a member by group and party, and names no third thing", () => {
    expect(removeMemberWrite("flat", "ana")).toStrictEqual({
      action: "remove-group-member",
      input: { group_id: "flat", party_id: "ana" },
    });
  });

  it("applies the vault's own pre-edit snapshot, keyed by both ids", () => {
    // The undo window is the vault's, not a timer this app keeps: the write
    // names the revision, and the command applies it exactly once.
    expect(undoExpenseWrite("x1", "rev_9")).toStrictEqual({
      action: "undo-expense",
      input: { expense_id: "x1", revision_id: "rev_9" },
    });
  });

  it("passes an already-resolved expense input through untouched", () => {
    // The splits arrive resolved and validated by `draft-model.ts`; the
    // builder names the action and adds NOTHING, so a view model cannot leak
    // a field into a schema that forbids it.
    const input = { group_id: "flat", description: "Shop" };
    expect(addExpenseWrite(input)).toStrictEqual({
      action: "add-expense",
      input,
    });
    expect(editExpenseWrite(input)).toStrictEqual({
      action: "edit-expense",
      input,
    });
    expect(settleUpWrite(input)).toStrictEqual({
      action: "settle-up",
      input,
    });
    expect(saveRecurringWrite(input)).toStrictEqual({
      action: "save-recurring-expense",
      input,
    });
  });

  it("mints a friend by name alone — the party is People's to make", () => {
    expect(addFriendWrite("Priya")).toStrictEqual({
      action: "add-friend",
      input: { name: "Priya" },
    });
  });

  it("creates a group with its members as ids, and its colour only if chosen", () => {
    expect(
      createGroupWrite({
        name: "The coast",
        icon: "map",
        color: "teal",
        memberIds: ["ana", "tom"],
      })
    ).toStrictEqual({
      action: "create-group",
      input: {
        name: "The coast",
        icon: "map",
        color: "teal",
        member_ids: ["ana", "tom"],
      },
    });
    expect(
      createGroupWrite({ name: "Flat", icon: "home", memberIds: [] }).input
    ).toStrictEqual({ name: "Flat", icon: "home", member_ids: [] });
  });

  it("renames, adds and deletes a group by id", () => {
    expect(renameGroupWrite("flat", "14 Sitwell Road")).toStrictEqual({
      action: "rename-group",
      input: { group_id: "flat", name: "14 Sitwell Road" },
    });
    expect(addMemberWrite("flat", "priya")).toStrictEqual({
      action: "add-group-member",
      input: { group_id: "flat", party_id: "priya" },
    });
    expect(deleteGroupWrite("flat")).toStrictEqual({
      action: "delete-group",
      input: { group_id: "flat" },
    });
  });

  it("skips one occurrence without touching the series", () => {
    expect(
      editOccurrenceWrite({
        templateId: "r1",
        originalStart: "2026-09-01T09:00:00.000Z",
        scope: "occurrence",
        action: "skip",
      })
    ).toStrictEqual({
      action: "edit-recurring-expense-occurrence",
      input: {
        template_id: "r1",
        original_start: "2026-09-01T09:00:00.000Z",
        scope: "occurrence",
        action: "skip",
      },
    });
  });

  it("materialises one exact occurrence — the one write with no optimistic copy", () => {
    expect(materializeWrite("r1", "2026-09-01T09:00:00.000Z")).toStrictEqual({
      action: "materialize-recurring-expense",
      input: {
        template_id: "r1",
        original_start: "2026-09-01T09:00:00.000Z",
      },
    });
  });

  it("re-cuts a receipt's lines and its shares in ONE write", () => {
    // The lines and the shares are one fact; two writes would let the vault
    // hold a cut whose lines and shares disagree.
    expect(
      reallocateReceiptWrite({
        expenseId: "x1",
        lineItems: [
          {
            kind: "item",
            description: "Wine",
            amount_minor: 6000,
            allocations: [{ party_id: "me", share_minor: 6000 }],
          },
        ],
        splits: [{ party_id: "me", share_minor: 6000 }],
      })
    ).toStrictEqual({
      action: "reallocate-receipt",
      input: {
        expense_id: "x1",
        line_items: [
          {
            kind: "item",
            description: "Wine",
            amount_minor: 6000,
            allocations: [{ party_id: "me", share_minor: 6000 }],
          },
        ],
        splits: [{ party_id: "me", share_minor: 6000 }],
      },
    });
  });

  it("stores the simplification opt-in flag, and nothing else", () => {
    expect(setSimplificationWrite("flat", true)).toStrictEqual({
      action: "set-group-simplification",
      input: { group_id: "flat", simplify: true },
    });
  });

  it("leaves a group, defaulting to the owner when no party is named", () => {
    expect(leaveGroupWrite("flat")).toStrictEqual({
      action: "leave-group",
      input: { group_id: "flat" },
    });
    expect(leaveGroupWrite("flat", "ana").input).toStrictEqual({
      group_id: "flat",
      party_id: "ana",
    });
  });

  it("archives and un-archives with the same write and the other boolean", () => {
    expect(archiveGroupWrite("flat", true)).toStrictEqual({
      action: "archive-group",
      input: { group_id: "flat", archived: true },
    });
    expect(archiveGroupWrite("flat", false).input).toStrictEqual({
      group_id: "flat",
      archived: false,
    });
  });

  it("prepares a reminder, carrying only what the member gave it", () => {
    expect(
      nudgeWrite({ partyId: "tom", groupId: null, asOfMinor: 8100 })
    ).toStrictEqual({
      action: "nudge",
      input: { party_id: "tom", as_of_minor: 8100 },
    });
    expect(
      nudgeWrite({
        partyId: "tom",
        groupId: "flat",
        asOfMinor: 8100,
        note: "  before the trip  ",
      }).input
    ).toStrictEqual({
      party_id: "tom",
      as_of_minor: 8100,
      group_id: "flat",
      note: "before the trip",
    });
  });
});
