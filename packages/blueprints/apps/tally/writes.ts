export interface TallyWrite {
  action: string;
  input: Record<string, unknown>;
}

export function restoreExpenseWrite(expenseId: string): TallyWrite {
  return { action: "restore-expense", input: { expense_id: expenseId } };
}

export function trashExpenseWrite(expenseId: string): TallyWrite {
  return { action: "delete-expense", input: { expense_id: expenseId } };
}

export function undoExpenseWrite(
  expenseId: string,
  revisionId: string
): TallyWrite {
  return {
    action: "undo-expense",
    input: { expense_id: expenseId, revision_id: revisionId },
  };
}

export function removeMemberWrite(
  groupId: string,
  partyId: string
): TallyWrite {
  return {
    action: "remove-group-member",
    input: { group_id: groupId, party_id: partyId },
  };
}

export function addExpenseWrite(input: Record<string, unknown>): TallyWrite {
  return { action: "add-expense", input };
}

export function editExpenseWrite(input: Record<string, unknown>): TallyWrite {
  return { action: "edit-expense", input };
}

export function settleUpWrite(input: Record<string, unknown>): TallyWrite {
  return { action: "settle-up", input };
}

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

export function deleteGroupWrite(groupId: string): TallyWrite {
  return { action: "delete-group", input: { group_id: groupId } };
}

export function saveRecurringWrite(input: Record<string, unknown>): TallyWrite {
  return { action: "save-recurring-expense", input };
}

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

export function reallocateReceiptWrite(input: {
  expenseId: string;
  lineItems: readonly Record<string, unknown>[];
  splits: readonly Record<string, unknown>[];
}): TallyWrite {
  return {
    action: "reallocate-receipt",
    input: {
      expense_id: input.expenseId,
      line_items: [...input.lineItems],
      splits: [...input.splits],
    },
  };
}

export function setSimplificationWrite(
  groupId: string,
  simplify: boolean
): TallyWrite {
  return {
    action: "set-group-simplification",
    input: { group_id: groupId, simplify },
  };
}

export function leaveGroupWrite(groupId: string, partyId?: string): TallyWrite {
  return {
    action: "leave-group",
    input: { group_id: groupId, ...(partyId ? { party_id: partyId } : {}) },
  };
}

export function archiveGroupWrite(
  groupId: string,
  archived: boolean
): TallyWrite {
  return { action: "archive-group", input: { group_id: groupId, archived } };
}

export function nudgeWrite(input: {
  partyId: string;
  groupId?: string | null;
  asOfMinor: number;
  note?: string;
}): TallyWrite {
  return {
    action: "nudge",
    input: {
      party_id: input.partyId,
      as_of_minor: input.asOfMinor,
      ...(input.groupId ? { group_id: input.groupId } : {}),
      ...(input.note && input.note.trim() !== ""
        ? { note: input.note.trim() }
        : {}),
    },
  };
}

export function materializeWrite(
  templateId: string,
  originalStart: string
): TallyWrite {
  return {
    action: "materialize-recurring-expense",
    input: { template_id: templateId, original_start: originalStart },
  };
}
