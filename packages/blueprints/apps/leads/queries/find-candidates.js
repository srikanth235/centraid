/**
 * Candidate lookup for the add-lead picker: the vault's FTS5 index matches
 * over core.party (display name + sort name) and returns only the hits, so
 * the picker reaches every non-enrolled party ever recorded without growing
 * the pipeline query's 300-party shortlist cap — the shortlist stays a
 * convenience, this is the directory. Enrolment must be judged exactly, not
 * against whatever clients happen to be on the board — a party whose client
 * row aged out of the pipeline window is still a client, and offering them
 * here would collide with business_client's one-client-per-party. One
 * `in`-bounded read over the hit ids settles it without pulling the client
 * table. Survivors keep FTS rank order (best match first).
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */

export default async ({ input, ctx }) => {
  const purpose = 'dpv:Billing';
  const term = String(input?.term ?? '').trim();
  if (!term) return { candidates: [] };
  try {
    const hits = await ctx.vault.search({ entity: 'core.party', query: term, limit: 50, purpose });
    const hitRows = hits.rows ?? [];
    // `in` with an empty array throws — no hits means no join and no picks.
    if (hitRows.length === 0) return { candidates: [] };

    const clients = await ctx.vault.read({
      entity: 'business.client',
      where: [{ column: 'party_id', op: 'in', value: hitRows.map((p) => p.party_id) }],
      purpose,
    });
    const enrolled = new Set((clients.rows ?? []).map((c) => c.party_id));

    const candidates = hitRows
      .filter((p) => !enrolled.has(p.party_id))
      .map((p) => ({ party_id: p.party_id, display_name: p.display_name }));
    return { candidates };
  } catch (err) {
    return { candidates: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
