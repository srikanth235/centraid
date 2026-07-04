/**
 * Recipient search for the New-message picker: the inbox query ships a
 * capped recent shortlist (newest 500 parties) as the instant zero-term
 * state, and this query is how the picker reaches EVERYONE beyond it
 * without growing that cap. The vault's FTS5 index over core.party
 * (display_name + sort_name) does the matching inside SQLite and returns
 * only the ranked hits — never a whole-directory pull, because vault data
 * has no upper bound. The owner's own party is excluded the same way the
 * shortlist excludes it: a fact read from core.vault, never a guess.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */
export default async ({ input, ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  const term = String(input?.term ?? '').trim();
  if (!term) return { people: [] };
  try {
    const [matches, vaultRow] = await Promise.all([
      ctx.vault.search({ entity: 'core.party', query: term, limit: 50, purpose }),
      ctx.vault.read({ entity: 'core.vault', purpose }),
    ]);
    const ownerPartyId = vaultRow.rows?.[0]?.owner_party_id ?? null;
    // Vault order is rank order (best match first) — keep it.
    const people = (matches.rows ?? [])
      .filter((p) => p.party_id !== ownerPartyId)
      .map((p) => ({ party_id: p.party_id, display_name: p.display_name }));
    return { people };
  } catch (err) {
    return { people: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
