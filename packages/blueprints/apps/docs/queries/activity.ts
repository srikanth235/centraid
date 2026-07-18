/**
 * A document's REAL activity trail (issue #352 phase 4): the app-plane read
 * over consent.provenance — journal.db already records one provenance row
 * per command write, keyed by (entity_type, entity_id)
 * (packages/vault/src/gateway/evidence.ts's writeProvenance, called from
 * execution.ts on every executed command). This replaces Details.tsx's old
 * synthesized timeline, which only ever fabricated two events from the
 * document's own created_at/updated_at — this ships what actually happened,
 * per row: which command (`prov_activity`, e.g. "command.core.rename_document"),
 * who ran it (`agent_kind`: owner/app/ai_agent/import), and when
 * (`occurred_at`).
 *
 * The gateway holds a non-owner read of this one table to an EXTRA rule
 * beyond the normal grant (provenanceScopeFailure in gateway.ts, see
 * activity-read.test.ts): it must scope to exactly one (entity_type,
 * entity_id) eq pair, and the caller must independently hold read consent on
 * that entity's own table — which is exactly the shape below (docs already
 * holds core.document read).
 *
 * No rows is an honest, first-class outcome — a document seeded outside the
 * command pipeline (a schema recreate, a fixture) has no provenance yet, not
 * an error — the caller renders that as an empty state, never a failure.
 */

const DOCUMENT_TARGET_TYPE = 'core.document';

interface ProvenanceRow {
  prov_activity: string;
  agent_kind: string;
  occurred_at: string;
}

export default async ({ input, ctx }: HandlerArgs) => {
  const purpose = 'dpv:ServiceProvision';
  const documentId = String(input?.document_id ?? '');
  if (!documentId) return { events: [] };
  try {
    const result = await ctx.vault.read({
      entity: 'consent.provenance',
      where: [
        { column: 'entity_type', op: 'eq', value: DOCUMENT_TARGET_TYPE },
        { column: 'entity_id', op: 'eq', value: documentId },
      ],
      purpose,
    });
    // Newest first — the journal is append-only but gives no ordering
    // guarantee to the app plane beyond what it hands back, so sort here
    // rather than trust row order.
    const events = ((result.rows ?? []) as unknown as ProvenanceRow[])
      .map((r) => ({
        activity: r.prov_activity,
        agent_kind: r.agent_kind,
        occurred_at: r.occurred_at,
      }))
      .toSorted((a, b) => String(b.occurred_at ?? '').localeCompare(String(a.occurred_at ?? '')));
    return { events };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { events: [], vaultDenied: { code: e.code, message: e.message } };
  }
};
