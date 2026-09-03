import { deniedPayload } from "./dashboard.ts";

interface RevisionRow {
  revision_id: string;
  operation: string;
  snapshot_json: string;
  recorded_at: string;
  undo_until: string;
  undone_at?: string | null;
}

export default async function expenseHistory({ input, ctx }: HandlerArgs) {
  const expenseId = String(input?.expense_id ?? "");
  if (!expenseId) return { revisions: [] };
  try {
    const result = await ctx.vault.read({
      entity: "core.entity_revision",
      where: [
        { column: "entity_type", op: "eq", value: "tally.expense" },
        { column: "entity_id", op: "eq", value: expenseId },
      ],
      orderBy: { column: "recorded_at", dir: "desc" },
      limit: 100,
      purpose: "dpv:ServiceProvision",
    });
    return {
      revisions: ((result.rows ?? []) as unknown as RevisionRow[]).map(
        (row) => ({
          revision_id: row.revision_id,
          operation: row.operation,
          snapshot: JSON.parse(row.snapshot_json) as unknown,
          recorded_at: row.recorded_at,
          undo_until: row.undo_until,
          undone_at: row.undone_at ?? null,
        })
      ),
    };
  } catch (error) {
    return {
      revisions: [],
      vaultDenied: deniedPayload(error),
    };
  }
}
