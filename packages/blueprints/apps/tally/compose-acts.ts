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
  openEditFrom: (entry: LedgerEntry) => void;
  commitExpense: () => void;
  commitSettle: () => void;
  commitSheet: () => void;
  restore: (expenseId: string) => void;
  undo: (expenseId: string, revisionId: string) => void;
  pauseTemplate: (template: RecurringTemplate) => void;
  skipTemplate: (template: RecurringTemplate) => void;
  materialise: (due: DueOccurrence) => void;
  contribVerb: (verb: ContribVerb, row: ContribRow) => void;
  removeMember: (partyId: string) => void;
  reallocate: (entry: LedgerEntry, selection: LineSelection) => void;
  setSimplify: (groupId: string, simplify: boolean) => void;
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
        undo: () => void act(archiveGroupWrite(groupId, archived)),
      });
      done();
      return;
    }
    if (open.kind === "nudge") {
      const ask = open;
      void (async () => {
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

  const contribVerb = useCallback(
    (verb: ContribVerb, row: ContribRow) => {
      const client = window.centraid;
      if (verb === "approvals") {
        client.openApprovals?.();
        return;
      }
      if (verb === "approve" || verb === "decline") {
        void (async () => {
          let decided: { decided: boolean } | undefined;
          try {
            decided = await client.decideCommonsIntent?.({
              intentId: row.intentId,
              decision: verb,
            });
          } catch {
            // Intentionally empty.
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
          // Intentionally empty.
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
