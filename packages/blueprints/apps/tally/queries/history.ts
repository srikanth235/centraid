import { readPages } from "../../_shared/paged-reads.ts";
import { deniedPayload } from "./dashboard.ts";

interface RevisionRow {
  revision_id: string;
  operation: string;
  snapshot_json: string;
  recorded_at: string;
  undo_until: string;
  undone_at?: string | null;
}

/** Expense edit/trash history, constrained to tally.expense by grant. */
export default async function expenseHistory({ input, ctx }: HandlerArgs) {
  const expenseId = String(input?.expense_id ?? "");
  if (!expenseId) return { revisions: [] };
  try {
    // ONE EXPENSE'S OCCURRENCES, AS A PAGE (#996 wave 4, R8). This was the last
    // `ctx.vault.read` in any app: the declarative request took a window of 100
    // and said nothing when an expense had more, and the statement below says
    // which rows in SQL and walks to the end of them.
    const rows = await readPages<RevisionRow>(ctx, {
      name: "tally.history.revisions",
      select:
        "revision_id, entity_type, entity_id, operation, snapshot_json, " +
        "recorded_at, undo_until, undone_at",
      from: "core_entity_revision",
      where: "entity_type = ? AND entity_id = ?",
      bind: ["tally.expense", expenseId],
      order: {
        sortColumn: "recorded_at",
        pkColumn: "revision_id",
        descending: true,
      },
    });
    return {
      revisions: rows.map((row) => ({
        revision_id: row.revision_id,
        operation: row.operation,
        snapshot: JSON.parse(row.snapshot_json) as unknown,
        recorded_at: row.recorded_at,
        undo_until: row.undo_until,
        undone_at: row.undone_at ?? null,
      })),
    };
  } catch (error) {
    return {
      revisions: [],
      vaultDenied: deniedPayload(error),
    };
  }
}
