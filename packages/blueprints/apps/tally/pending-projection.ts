import {
  definePendingProjection,
  pendingInputValues,
  pendingPatch,
  pendingUpsert,
  stablePendingRowId,
} from "../_shared/pending-overlay.js";

const EXPENSE_FIELDS = [
  "group_id",
  "split_method",
  "description",
  "amount_minor",
  "original_amount_minor",
  "original_currency",
  "settlement_currency",
  "rate_scaled",
  "rate_scale",
  "rate_source",
  "rate_date",
  "paid_by",
  "category",
  "spent_on",
] as const;

const RECURRING_FIELDS = [
  "group_id",
  "description",
  "original_amount_minor",
  "original_currency",
  "settlement_currency",
  "paid_by",
  "category",
  "rrule",
  "anchor_start",
  "time_zone",
  "rate_scaled",
  "rate_scale",
  "rate_source",
  "rate_date",
  "status",
] as const;

const expenseProjection = ({
  input,
  intentId,
}: {
  input: Readonly<Record<string, unknown>>;
  intentId: string;
}) => {
  const expenseId = stablePendingRowId(intentId, "expense");
  const mutations = [
    pendingUpsert("tally.expense", expenseId, {
      expense_id: expenseId,
      deleted_at: null,
      ...pendingInputValues(input, EXPENSE_FIELDS),
    }),
  ];
  if (Array.isArray(input.payers)) {
    input.payers.forEach((raw, index) => {
      if (!raw || typeof raw !== "object") return;
      const payer = raw as Record<string, unknown>;
      const payerId = stablePendingRowId(intentId, `payer-${index}`);
      mutations.push(
        pendingUpsert("tally.expense_payer", payerId, {
          __centraid_row_id: payerId,
          expense_id: expenseId,
          ...pendingInputValues(payer, ["party_id", "paid_minor"]),
        })
      );
    });
  } else if (typeof input.paid_by === "string") {
    const payerId = stablePendingRowId(intentId, "payer-0");
    mutations.push(
      pendingUpsert("tally.expense_payer", payerId, {
        __centraid_row_id: payerId,
        expense_id: expenseId,
        party_id: input.paid_by,
        paid_minor:
          typeof input.amount_minor === "number" ? input.amount_minor : 0,
      })
    );
  }
  if (Array.isArray(input.splits)) {
    input.splits.forEach((raw, index) => {
      if (!raw || typeof raw !== "object") return;
      const split = raw as Record<string, unknown>;
      const splitId = stablePendingRowId(intentId, `split-${index}`);
      mutations.push(
        pendingUpsert("tally.expense_split", splitId, {
          __centraid_row_id: splitId,
          expense_id: expenseId,
          ...pendingInputValues(split, ["party_id", "share_minor"]),
        })
      );
    });
  }
  return mutations;
};

export const tallyPendingProjection = definePendingProjection({
  appId: "tally",
  revisions: {
    "edit-expense": ["add-expense", "add-receipt-expense"],
    "rename-group": ["create-group"],
    "save-recurring-expense": ["save-recurring-expense"],
  },
  actions: {
    "add-expense": expenseProjection,
    "add-receipt-expense": expenseProjection,
    "edit-expense": ({ input }) =>
      pendingPatch("tally.expense", input.expense_id, input, EXPENSE_FIELDS),
    "delete-expense": ({ input }) =>
      pendingPatch("tally.expense", input.expense_id, input),
    "undo-expense": ({ input }) =>
      pendingPatch("tally.expense", input.expense_id, input),
    "restore-expense": ({ input }) =>
      pendingPatch("tally.expense", input.expense_id, input),
    "settle-up": ({ input, intentId }) => {
      const settlementId = stablePendingRowId(intentId, "settlement");
      return [
        pendingUpsert("tally.settlement", settlementId, {
          settlement_id: settlementId,
          deleted_at: null,
          ...pendingInputValues(input, [
            "group_id",
            "from_party",
            "to_party",
            "amount_minor",
            "paid_on",
          ]),
        }),
      ];
    },
    "add-friend": ({ input, intentId }) => {
      const partyId = stablePendingRowId(intentId, "party");
      const friendId = stablePendingRowId(intentId, "friend");
      return [
        pendingUpsert("core.party", partyId, {
          party_id: partyId,
          display_name:
            typeof input.name === "string" ? input.name : "Pending friend",
        }),
        pendingUpsert("tally.friend", friendId, {
          friend_id: friendId,
          party_id: partyId,
        }),
      ];
    },
    "create-group": ({ input, intentId }) => {
      const groupId = stablePendingRowId(intentId, "group");
      const circleId = stablePendingRowId(intentId, "circle");
      return [
        pendingUpsert("social.circle", circleId, {
          circle_id: circleId,
          name: typeof input.name === "string" ? input.name : "Pending group",
        }),
        pendingUpsert("tally.group", groupId, {
          group_id: groupId,
          circle_id: circleId,
          ...pendingInputValues(input, ["icon", "color"]),
        }),
      ];
    },
    "rename-group": ({ input }) =>
      pendingPatch("tally.group", input.group_id, input),
    "add-group-member": ({ input }) =>
      pendingPatch("tally.group", input.group_id, input),
    "remove-group-member": ({ input }) =>
      pendingPatch("tally.group", input.group_id, input),
    "delete-group": ({ input }) =>
      pendingPatch("tally.group", input.group_id, input),
    "save-recurring-expense": ({ input, intentId }) => {
      const templateId =
        typeof input.template_id === "string"
          ? input.template_id
          : stablePendingRowId(intentId, "recurring");
      return [
        pendingUpsert("tally.recurring_expense", templateId, {
          template_id: templateId,
          ...pendingInputValues(input, RECURRING_FIELDS),
          ...(Array.isArray(input.splits)
            ? { splits_json: JSON.stringify(input.splits) }
            : {}),
        }),
      ];
    },
    "reallocate-receipt": ({ input }) =>
      pendingPatch("tally.expense", input.expense_id, input),
    "set-group-simplification": ({ input }) =>
      pendingPatch("tally.group", input.group_id, {
        simplify_opt_in: input.simplify ? 1 : 0,
      }),
    "leave-group": ({ input }) =>
      pendingPatch("tally.group", input.group_id, input),
    "archive-group": ({ input }) =>
      pendingPatch("tally.group", input.group_id, {
        archived_at: input.archived === false ? null : new Date().toISOString(),
      }),
    nudge: {
      excluded: true,
      reason:
        "A nudge always parks for the owner's confirmation, so there is no outcome to show optimistically.",
    },
    "materialize-recurring-expense": {
      excluded: true,
      reason:
        "The materialized occurrence id is minted by the canonical recurrence engine.",
    },
    "edit-recurring-expense-occurrence": ({ input }) =>
      pendingPatch("tally.recurring_expense", input.template_id, input),
  },
});
