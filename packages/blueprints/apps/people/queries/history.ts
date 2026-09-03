interface RevisionRow {
  revision_id: string;
  operation: string;
  snapshot_json: string;
  recorded_at: string;
  undo_until: string;
  undone_at?: string | null;
}

export default async function peopleHistory({ input, ctx }: HandlerArgs) {
  const partyId = String(input?.party_id ?? "");
  if (!partyId) return { revisions: [] };
  try {
    const result = await ctx.vault.read({
      entity: "core.entity_revision",
      where: [
        { column: "entity_type", op: "eq", value: "people.person" },
        { column: "entity_id", op: "eq", value: partyId },
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
    const e = error as { code?: string; message?: string };
    return {
      revisions: [],
      vaultDenied: { code: e.code, message: e.message },
    };
  }
}
