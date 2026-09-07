/** The rail shows a hundred; the read is the rail. */
const HISTORY_ROWS = 100;

interface RevisionRow {
  revision_id: string;
  operation: string;
  snapshot_json: string;
  recorded_at: string;
  undo_until: string;
  undone_at?: string | null;
}

/** Version/undo history for one person, row-filtered by the app grant. */
export default async function peopleHistory({ input, ctx }: HandlerArgs) {
  const partyId = String(input?.party_id ?? "");
  if (!partyId) return { revisions: [] };
  try {
    const result = await ctx.vault.page<RevisionRow>({
      query: {
        name: "people.history.revisions",
        select:
          "revision_id, entity_type, entity_id, operation, snapshot_json, recorded_at, undo_until, undone_at",
        from: "core_entity_revision",
        where: "entity_type = ? AND entity_id = ?",
        bind: ["people.person", partyId],
        order: {
          sortColumn: "recorded_at",
          pkColumn: "revision_id",
          descending: true,
        },
      },
      limit: HISTORY_ROWS,
    });
    return {
      revisions: result.rows.map((row) => ({
        revision_id: row.revision_id,
        operation: row.operation,
        snapshot: JSON.parse(row.snapshot_json) as unknown,
        recorded_at: row.recorded_at,
        undo_until: row.undo_until,
        undone_at: row.undone_at ?? null,
      })),
    };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return {
      revisions: [],
      vaultDenied: { code: e.code, message: e.message },
    };
  }
}
