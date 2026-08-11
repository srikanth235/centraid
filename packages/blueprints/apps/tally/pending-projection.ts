// Tally's declaration for the shared pending-write overlay engine (issue
// #738, scope-declaration.ts style): how add/edit/delete-expense project into
// the `tally.expense` row the group/friend/dashboard/activity ledger queries
// read (queries/dashboard.ts's `loadTally`), so a pending write shows up in
// the SAME query result a fetched expense does — no app-owned overlay state.
//
// `tally_expense_split` is deliberately NOT projected here even though the
// ledger's `splits`/`your_role`/`your_amount_minor` are derived from it: its
// primary key is composite (expense_id, party_id), so the replica exposes it
// under a server-HMAC row id (`replicaWireRowId`) the client cannot mint
// offline — an optimistic create for it would be silently dropped the moment
// a query composed it (`applyOptimisticMutations` rejects a new row whose
// synthetic id it cannot already recognise). The expense row alone is enough
// to surface the pending line; `logic.ts`'s `roleAndAmount` recomputes the
// owner's stance from the write's cached `input` instead, exactly where the
// query would have folded in real split rows.
//
// restore-expense/undo-expense are deliberately undeclared: both revert to a
// prior canonical state (a soft-delete flag, a past revision) this device has
// no faithful values for offline, so they stay online-only rather than
// project a guess.
import type {
  PendingMutation,
  PendingProjectionDeclaration,
} from "../_shared/pending-overlay.ts";

/** The `tally_expense` columns add/edit-expense may set — the actions' own
 *  `KEYS` (actions/add-expense.ts, actions/edit-expense.ts) minus `splits`,
 *  which is relational, not a column on this entity. */
const EXPENSE_FIELDS = [
  "group_id",
  "description",
  "amount_minor",
  "paid_by",
  "spent_on",
  "category",
  "original_amount_minor",
  "original_currency",
  "settlement_currency",
  "rate_scaled",
  "rate_scale",
  "rate_source",
  "rate_date",
] as const;

function expenseValues(
  input: Record<string, unknown>
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const key of EXPENSE_FIELDS) {
    if (input[key] !== undefined && input[key] !== null)
      values[key] = input[key];
  }
  return values;
}

export const tallyPendingProjection: PendingProjectionDeclaration = {
  appId: "tally",
  actions: {
    "add-expense": (input, ctx): PendingMutation[] => [
      {
        op: "upsert",
        entity: "tally.expense",
        rowId: ctx.rowId,
        values: { expense_id: ctx.rowId, ...expenseValues(input) },
      },
    ],
    "edit-expense": (input): PendingMutation[] => {
      const expenseId = String(input.expense_id ?? "");
      if (!expenseId) return [];
      return [
        {
          op: "upsert",
          entity: "tally.expense",
          rowId: expenseId,
          values: expenseValues(input),
        },
      ];
    },
    "delete-expense": (input): PendingMutation[] => {
      const expenseId = String(input.expense_id ?? "");
      if (!expenseId) return [];
      return [{ op: "delete", entity: "tally.expense", rowId: expenseId }];
    },
  },
};
