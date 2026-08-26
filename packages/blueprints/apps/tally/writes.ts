// The Tally write door: every act this app can take, as a value.
//
// A WRITE IS A VALUE so the door in `ledger-reads.ts` stays one function and
// the acts stay testable without a renderer. Each builder names the manifest
// action it invokes (`app.json`'s `actions`) and carries exactly the input that
// action's schema requires — nothing is spread in from a view model, so a field
// the vault would reject cannot arrive from a render.
//
// UNDO IS ONLY WHERE A TRUE REVERSE WRITE EXISTS, and this app has exactly
// three such pairs:
//
//   * `delete-expense` ↔ `restore-expense` — trashing and putting it back,
//     whole, with its splits and revisions;
//   * `undo-expense` — the vault's own durable pre-edit snapshot, applied once,
//     inside the window `queries/history.ts` reports as `undo_until`. It IS the
//     reverse write, which is why the expense's revision list offers it and the
//     status line does not have to invent one;
//   * `save-recurring-expense` status ↔ status — pausing and resuming are the
//     same write with the other word, so each is the other's reverse.
//
// Everything else states its outcome and offers no Undo. Removing a member has
// no re-add without their role, adding an expense has no un-add that keeps the
// revision honest, and a half-working Undo is worse than none.

export interface TallyWrite {
  action: string;
  input: Record<string, unknown>;
}

/** Put a trashed expense back on the ledger, with its splits and history. */
export function restoreExpenseWrite(expenseId: string): TallyWrite {
  return { action: "restore-expense", input: { expense_id: expenseId } };
}

/** Send an expense to the trash. The reverse of a restore, and the write the
 *  restore's Undo issues. */
export function trashExpenseWrite(expenseId: string): TallyWrite {
  return { action: "delete-expense", input: { expense_id: expenseId } };
}

/** Apply one durable pre-edit or pre-trash snapshot, exactly once. */
export function undoExpenseWrite(
  expenseId: string,
  revisionId: string
): TallyWrite {
  return {
    action: "undo-expense",
    input: { expense_id: expenseId, revision_id: revisionId },
  };
}

/** Take a member out of a group. Guarded at the call site: a member who
 *  appears on the ledger is marked departed instead, and this write is never
 *  reached for them. */
export function removeMemberWrite(
  groupId: string,
  partyId: string
): TallyWrite {
  return {
    action: "remove-group-member",
    input: { group_id: groupId, party_id: partyId },
  };
}

/** Add an expense. The input arrives already resolved and validated by
 *  `draft-model.ts`; this builder only names the action. */
export function addExpenseWrite(input: Record<string, unknown>): TallyWrite {
  return { action: "add-expense", input };
}

/** Rewrite an expense — the same fields as add, re-validated the same way. */
export function editExpenseWrite(input: Record<string, unknown>): TallyWrite {
  return { action: "edit-expense", input };
}

/** Record a payment that happened. From and To are both open: two friends can
 *  settle with the owner as neither party. */
export function settleUpWrite(input: Record<string, unknown>): TallyWrite {
  return { action: "settle-up", input };
}

/** Mint a canonical person. A friend is a person in People — this writes there,
 *  and Tally mints nothing of its own. */
export function addFriendWrite(name: string): TallyWrite {
  return { action: "add-friend", input: { name } };
}

export function createGroupWrite(input: {
  name: string;
  icon: string;
  color?: string;
  memberIds: readonly string[];
}): TallyWrite {
  return {
    action: "create-group",
    input: {
      name: input.name,
      icon: input.icon,
      ...(input.color ? { color: input.color } : {}),
      member_ids: [...input.memberIds],
    },
  };
}

export function renameGroupWrite(groupId: string, name: string): TallyWrite {
  return { action: "rename-group", input: { group_id: groupId, name } };
}

export function addMemberWrite(groupId: string, partyId: string): TallyWrite {
  return {
    action: "add-group-member",
    input: { group_id: groupId, party_id: partyId },
  };
}

/** Delete a group. The vault refuses while it still holds expenses, and the
 *  refusal's own reason is what the surface states. */
export function deleteGroupWrite(groupId: string): TallyWrite {
  return { action: "delete-group", input: { group_id: groupId } };
}

/** Create or rewrite a recurring template. The input is the WHOLE template —
 *  the command upserts rather than patches — which is why the caller assembles
 *  it from `schedule-model.ts`'s `templateSaveBase`. */
export function saveRecurringWrite(input: Record<string, unknown>): TallyWrite {
  return { action: "save-recurring-expense", input };
}

/** Skip or override one occurrence, this and future ones, or the series. */
export function editOccurrenceWrite(input: {
  templateId: string;
  originalStart: string;
  scope: "occurrence" | "future" | "series";
  action: "skip" | "override";
}): TallyWrite {
  return {
    action: "edit-recurring-expense-occurrence",
    input: {
      template_id: input.templateId,
      original_start: input.originalStart,
      scope: input.scope,
      action: input.action,
    },
  };
}

/** Materialise one occurrence into an ordinary expense. THE ONE WRITE WITH NO
 *  OPTIMISTIC COPY: `pending-projection.ts` excludes it by construction because
 *  the occurrence's id is minted by the canonical recurrence engine, so it
 *  needs the gateway and Due next says so. */
export function materializeWrite(
  templateId: string,
  originalStart: string
): TallyWrite {
  return {
    action: "materialize-recurring-expense",
    input: { template_id: templateId, original_start: originalStart },
  };
}
