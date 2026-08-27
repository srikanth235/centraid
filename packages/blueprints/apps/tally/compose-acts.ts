// THE ACTS — every write this app can take, wired to the one door.
//
// Separated from `compose-state.ts`: the bag is what a member has typed; this
// is what happens when they press. The orchestrator can hand composing routes
// the group id they need before the ledger read that answers it.
//
// UNDO ONLY WHERE A TRUE REVERSE WRITE EXISTS. Three pairs: trash ↔ restore,
// an edit ↔ `undo-expense`, pause ↔ resume. Adding, settling, minting a
// friend, skipping and materialising state their outcome and offer no reverse.
//
// A SURFACE STAYS STANDING WHEN ITS WRITE DOES NOT LAND. `ledger.write`
// answers `false` on a refusal; navigating away would lose the typed draft.
import { useCallback, useMemo } from "react";

import { COMPOSE_OUTCOMES } from "./compose-copy.ts";
import type { ComposeState } from "./compose-state.ts";
import type { ContribRow, ContribVerb } from "./contrib-model.ts";
import {
  addExpenseInput,
  draftFromEntry,
  editExpenseInput,
  expenseVerdict,
  settleInput,
  settleVerdict,
} from "./draft-model.ts";
import type { LedgerReads } from "./ledger-reads.ts";
import { receiptLineItems } from "./receipt-model.ts";
import type { LineSelection } from "./receipt-model.ts";
import type { DueOccurrence } from "./schedule-model.ts";
import { templateSaveBase } from "./schedule-model.ts";
import { ACTIVITY, WAITING } from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import type { GroupMember, LedgerEntry, RecurringTemplate } from "./types.ts";
import { OUTCOMES } from "./view-copy.ts";
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

export interface ComposeActs {
  /** Open Add expense PRE-FILLED from an expense that already exists. The same
   *  surface, because editing an expense is the same six decisions. */
  openEditFrom: (entry: LedgerEntry) => void;
  commitExpense: () => void;
  commitSettle: () => void;
  /** Whichever sheet is open — friend, group, rename, member, delete, trash. */
  commitSheet: () => void;
  restore: (expenseId: string) => void;
  undo: (expenseId: string, revisionId: string) => void;
  pauseTemplate: (template: RecurringTemplate) => void;
  skipTemplate: (template: RecurringTemplate) => void;
  materialise: (due: DueOccurrence) => void;
  contribVerb: (verb: ContribVerb, row: ContribRow) => void;
  removeMember: (partyId: string) => void;
  /** Commit the receipt's allocation as it currently stands. */
  reallocate: (entry: LedgerEntry, selection: LineSelection) => void;
  /** Turn simplification on or off for the open group. */
  setSimplify: (groupId: string, simplify: boolean) => void;
  /** Prepare a reminder. It ALWAYS parks, and the deep link is to Waiting. */
  nudge: (input: {
    partyId: string;
    name: string;
    groupId: string | null;
    asOfMinor: number;
  }) => void;
}

export function useComposeActs(args: {
  compose: ComposeState;
  ledger: LedgerReads;
  /** The chosen group's members, in the order the allocation table draws. */
  members: readonly GroupMember[];
  currency: string;
  go: (shelf: ShelfId) => void;
  openGroupId: string | null;
}): ComposeActs {
  const { compose, ledger, members, currency, go, openGroupId } = args;
  const act = ledger.write;
  const bagRef = compose.bagRef;
  const participants = useMemo(
    () => members.map((member) => member.party_id),
    [members]
  );

  const openEditFrom = useCallback(
    (entry: LedgerEntry) => compose.openEdit(draftFromEntry(entry)),
    [compose]
  );

  const commitExpense = useCallback(() => {
    const bag = bagRef.current;
    const draft = bag.draft;
    const verdict = expenseVerdict(draft, participants, currency);
    if (!verdict.ok) return;
    const editing = bag.editing && draft.expenseId !== undefined;
    const write = editing
      ? editExpenseWrite(editExpenseInput(draft, verdict, currency))
      : addExpenseWrite(addExpenseInput(draft, verdict, currency));
    void (async () => {
      const landed = await act(write, {
        outcome: editing ? COMPOSE_OUTCOMES.edited : COMPOSE_OUTCOMES.added,
      });
      if (landed) go(ACTIVITY);
    })();
  }, [act, bagRef, currency, go, participants]);

  const commitSettle = useCallback(() => {
    const draft = bagRef.current.settle;
    const verdict = settleVerdict(draft, ledger.dashboard.me);
    if (!verdict.ok) return;
    void (async () => {
      const landed = await act(settleUpWrite(settleInput(draft, verdict)), {
        outcome: COMPOSE_OUTCOMES.settled,
      });
      if (landed) go(null);
    })();
  }, [act, bagRef, go, ledger.dashboard.me]);

  const commitSheet = useCallback(() => {
    const open = bagRef.current.overlay;
    if (!open) return;
    const done = (): void => compose.close();
    if (open.kind === "leave") {
      const groupId = open.groupId;
      void (async () => {
        // NO UNDO: the reverse of leaving is being re-added with a role this
        // write never carried, so the outcome states what happened instead.
        const landed = await act(leaveGroupWrite(groupId), {
          outcome: COMPOSE_OUTCOMES.left,
        });
        compose.close();
        if (landed) go(null);
      })();
      return;
    }
    if (open.kind === "archive") {
      const { groupId, archived } = open;
      void act(archiveGroupWrite(groupId, !archived), {
        outcome: archived
          ? COMPOSE_OUTCOMES.unarchived
          : COMPOSE_OUTCOMES.archived,
        // The same write with the other boolean IS the reverse write.
        undo: () => void act(archiveGroupWrite(groupId, archived)),
      });
      done();
      return;
    }
    if (open.kind === "nudge") {
      const ask = open;
      void (async () => {
        // ALWAYS PARKS. `ledger.write` narrates a parked outcome itself, and
        // this act adds the deep link rather than a second sentence.
        await act(
          nudgeWrite({
            partyId: ask.partyId,
            groupId: ask.groupId,
            asOfMinor: ask.asOfMinor,
            note: ask.note,
          })
        );
        compose.close();
        go(WAITING);
      })();
      return;
    }
    if (open.kind === "friend") {
      void act(addFriendWrite(open.name.trim()), {
        outcome: COMPOSE_OUTCOMES.friendAdded,
      });
      done();
      return;
    }
    if (open.kind === "group") {
      void act(
        createGroupWrite({
          name: open.name.trim(),
          icon: open.icon,
          color: open.color,
          memberIds: open.memberIds,
        }),
        { outcome: COMPOSE_OUTCOMES.groupCreated }
      );
      done();
      return;
    }
    if (open.kind === "rename") {
      void act(renameGroupWrite(open.groupId, open.name.trim()), {
        outcome: COMPOSE_OUTCOMES.groupRenamed,
      });
      done();
      return;
    }
    if (open.kind === "member") {
      void act(addMemberWrite(open.groupId, open.partyId), {
        outcome: COMPOSE_OUTCOMES.memberAdded,
      });
      done();
      return;
    }
    if (open.kind === "deleteGroup") {
      void (async () => {
        const landed = await act(deleteGroupWrite(open.groupId), {
          outcome: COMPOSE_OUTCOMES.groupDeleted,
        });
        compose.close();
        if (landed) go(null);
      })();
      return;
    }
    if (open.kind === "trash") {
      const expenseId = open.expenseId;
      void (async () => {
        const landed = await act(trashExpenseWrite(expenseId), {
          outcome: COMPOSE_OUTCOMES.trashed,
          // The true reverse write, and the pair this app's Undo rests on.
          undo: () => void act(restoreExpenseWrite(expenseId)),
        });
        compose.close();
        if (landed) go(ACTIVITY);
      })();
      return;
    }
    done();
  }, [act, bagRef, compose, go]);

  const restore = useCallback(
    (expenseId: string) => {
      void act(restoreExpenseWrite(expenseId), {
        outcome: OUTCOMES.restored,
        undo: () => void act(trashExpenseWrite(expenseId)),
      });
    },
    [act]
  );

  /** The vault's own durable snapshot, applied once. It IS the reverse write,
   *  which is why this act offers no Undo of its own: a second one-shot undo
   *  of an undo would be two windows over one snapshot. */
  const undo = useCallback(
    (expenseId: string, revisionId: string) => {
      void act(undoExpenseWrite(expenseId, revisionId), {
        outcome: COMPOSE_OUTCOMES.undone,
      });
    },
    [act]
  );

  const pauseTemplate = useCallback(
    (template: RecurringTemplate) => {
      const base = templateSaveBase(template);
      if (base === null) return;
      const paused = template.status === "paused";
      const next = paused ? "active" : "paused";
      void act(saveRecurringWrite({ ...base, status: next }), {
        outcome: paused ? COMPOSE_OUTCOMES.resumed : COMPOSE_OUTCOMES.paused,
        // Pause and resume are the same write with the other word, so each is
        // the other's true reverse.
        undo: () =>
          void act(
            saveRecurringWrite({
              ...base,
              status: paused ? "paused" : "active",
            })
          ),
      });
    },
    [act]
  );

  const skipTemplate = useCallback(
    (template: RecurringTemplate) => {
      const start = template.next_start;
      if (typeof start !== "string" || start === "") return;
      void act(
        editOccurrenceWrite({
          templateId: template.template_id,
          originalStart: start,
          scope: "occurrence",
          action: "skip",
        }),
        { outcome: COMPOSE_OUTCOMES.skipped }
      );
    },
    [act]
  );

  const materialise = useCallback(
    (due: DueOccurrence) => {
      void act(materializeWrite(due.templateId, due.originalStart), {
        outcome: COMPOSE_OUTCOMES.materialised,
      });
    },
    [act]
  );

  /** The outbox's own verbs, through the outbox's own doors. Nothing here goes
   *  near `window.centraid.write`: a queued intent is not re-sent by writing
   *  it again, it is retried, discarded or cancelled where it lives. */
  const contribVerb = useCallback(
    (verb: ContribVerb, row: ContribRow) => {
      const client = window.centraid;
      if (verb === "approvals") {
        client.openApprovals?.();
        return;
      }
      // THE STEWARD'S ANSWER goes through its own door and reports its own
      // outcome — including the one where the request had already settled
      // before the answer arrived, which is a fact and not an error.
      if (verb === "approve" || verb === "decline") {
        void (async () => {
          let decided: { decided: boolean } | undefined;
          try {
            decided = await client.decideCommonsIntent?.({
              intentId: row.intentId,
              decision: verb,
            });
          } catch {
            // The door's own failure is not this app's to paraphrase; the
            // next read shows the intent exactly as it still stands.
          }
          ledger.say(
            decided && !decided.decided
              ? COMPOSE_OUTCOMES.decidedAlready
              : verb === "approve"
                ? COMPOSE_OUTCOMES.approved
                : COMPOSE_OUTCOMES.declined
          );
          await ledger.refresh();
        })();
        return;
      }
      const door =
        verb === "cancel"
          ? () => client.cancelCommonsIntent?.({ intentId: row.intentId })
          : verb === "retry"
            ? () => client.retryPendingWrite?.(row.intentId)
            : () => client.discardPendingWrite?.(row.intentId);
      void (async () => {
        try {
          await door();
        } catch {
          // The door's own failure is not this app's to paraphrase; the next
          // read shows the intent exactly as it still stands.
        }
        ledger.say(
          verb === "cancel"
            ? COMPOSE_OUTCOMES.cancelled
            : verb === "retry"
              ? COMPOSE_OUTCOMES.retried
              : COMPOSE_OUTCOMES.discarded
        );
        await ledger.refresh();
      })();
    },
    [ledger]
  );

  /**
   * The receipt's allocation, committed.
   *
   * The lines and the shares go in ONE write because they are one fact: an
   * `edit-expense` that rewrote the splits would leave the stored line
   * allocations disagreeing with them inside the vault. The command
   * re-validates that the lines still sum to the expense, and the amount never
   * changes.
   */
  const reallocate = useCallback(
    (entry: LedgerEntry, selection: LineSelection) => {
      const lines = entry.receipt?.lines ?? entry.line_items ?? [];
      const items = receiptLineItems(lines, selection);
      const totals = new Map<string, number>(
        participants.map((partyId) => [partyId, 0])
      );
      for (const item of items)
        for (const allocation of item.allocations)
          totals.set(
            allocation.party_id,
            (totals.get(allocation.party_id) ?? 0) + allocation.share_minor
          );
      const splits = [...totals.entries()].map(([party_id, share_minor]) => ({
        party_id,
        share_minor,
      }));
      void act(
        reallocateReceiptWrite({
          expenseId: entry.expense_id,
          lineItems: items,
          splits,
        }),
        { outcome: COMPOSE_OUTCOMES.reallocated }
      );
    },
    [act, participants]
  );

  /** The opt-in flag, and nothing else: the proposal is derived at read time
   *  and written nowhere. Each direction is the other's true reverse. */
  const setSimplify = useCallback(
    (groupId: string, simplify: boolean) => {
      void act(setSimplificationWrite(groupId, simplify), {
        outcome: simplify
          ? COMPOSE_OUTCOMES.simplifyOn
          : COMPOSE_OUTCOMES.simplifyOff,
        undo: () => void act(setSimplificationWrite(groupId, !simplify)),
      });
    },
    [act]
  );

  const nudge = useCallback(
    (input: {
      partyId: string;
      name: string;
      groupId: string | null;
      asOfMinor: number;
    }) => {
      compose.show({
        kind: "nudge",
        partyId: input.partyId,
        name: input.name,
        groupId: input.groupId,
        asOfMinor: input.asOfMinor,
        note: "",
      });
    },
    [compose]
  );

  /** The removal itself, once the guard has let the question be put. No Undo:
   *  re-adding a member needs their role back, which the removal does not
   *  carry, and a half-working Undo is worse than none. */
  const removeMember = useCallback(
    (partyId: string) => {
      compose.close();
      if (!openGroupId) return;
      void act(removeMemberWrite(openGroupId, partyId), {
        outcome: OUTCOMES.removed,
      });
    },
    [act, compose, openGroupId]
  );

  return useMemo(
    () => ({
      openEditFrom,
      commitExpense,
      commitSettle,
      commitSheet,
      restore,
      undo,
      pauseTemplate,
      skipTemplate,
      materialise,
      contribVerb,
      removeMember,
      reallocate,
      setSimplify,
      nudge,
    }),
    [
      openEditFrom,
      commitExpense,
      commitSettle,
      commitSheet,
      restore,
      undo,
      pauseTemplate,
      skipTemplate,
      materialise,
      contribVerb,
      removeMember,
      reallocate,
      setSimplify,
      nudge,
    ]
  );
}
