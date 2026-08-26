// THE ACTS — every write this app can take, wired to the one door.
//
// Separated from `compose-state.ts` because they are two different concerns
// with two different lifetimes: the bag is what a member has typed, and this
// is what happens when they press the thing. Keeping them apart is also what
// lets the orchestrator hand the composing routes the group id they need
// BEFORE the ledger read that answers it — the bag is built first, the reads
// stand on it, and the acts close over both.
//
// UNDO ONLY WHERE A TRUE REVERSE WRITE EXISTS, and this file is where that
// rule is actually enforced. Three pairs qualify: trash ↔ restore, an edit ↔
// the vault's own `undo-expense` snapshot, and pause ↔ resume, which are the
// same write with the other word. Adding an expense, settling up, minting a
// friend, skipping an occurrence and materialising one all state their outcome
// and offer nothing to press.
//
// A SURFACE STAYS STANDING WHEN ITS WRITE DOES NOT LAND. `ledger.write`
// answers `false` on a refusal and puts the vault's own reason on the status
// line; a commit that navigated away regardless would lose what the member
// typed and leave them reading a refusal about a screen they can no longer
// see.
import { useCallback } from "react";

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
import type { DueOccurrence } from "./schedule-model.ts";
import { templateSaveBase } from "./schedule-model.ts";
import { ACTIVITY } from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import type { GroupMember, LedgerEntry, RecurringTemplate } from "./types.ts";
import { OUTCOMES } from "./view-copy.ts";
import {
  addExpenseWrite,
  addFriendWrite,
  addMemberWrite,
  createGroupWrite,
  deleteGroupWrite,
  editExpenseWrite,
  editOccurrenceWrite,
  materializeWrite,
  removeMemberWrite,
  renameGroupWrite,
  restoreExpenseWrite,
  saveRecurringWrite,
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
  const participants = members.map((member) => member.party_id);

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

  return {
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
  };
}
