// Activity trail (#352). Non-owner reads obey provenanceScopeFailure
// (activity-read.test.ts): exactly one eq pair + read consent on the entity's own table.

const DOCUMENT_TARGET_TYPE = "core.document";

interface ProvenanceRow {
  prov_activity: string;
  agent_kind: string;
  occurred_at: string;
}

export default async function activityHandler({ input, ctx }: HandlerArgs) {
  const documentId = String(input?.document_id ?? "");
  if (!documentId) return { events: [] };
  try {
    const result = await ctx.vault.read({
      acceptTruncation: true,
      entity: "access.provenance",
      where: [
        { column: "entity_type", op: "eq", value: DOCUMENT_TARGET_TYPE },
        { column: "entity_id", op: "eq", value: documentId },
      ],
    });
    // No ordering guarantee; sort here.
    const events = ((result.rows ?? []) as unknown as ProvenanceRow[])
      .map((r) => ({
        activity: r.prov_activity,
        agent_kind: r.agent_kind,
        occurred_at: r.occurred_at,
      }))
      .toSorted((a, b) =>
        String(b.occurred_at ?? "").localeCompare(String(a.occurred_at ?? ""))
      );
    return { events };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { events: [], vaultDenied: { code: e.code, message: e.message } };
  }
}
