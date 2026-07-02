/**
 * The people projection: every party in the vault, sorted by display name,
 * joined in the handler with its identifiers (core.party_identifier) and
 * contact card (social.contact_card) if one decorates it. Everything comes
 * from the vault — this app holds no rows of its own.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */
export default async ({ ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  try {
    const [parties, identifiers, cards] = await Promise.all([
      ctx.vault.read({ entity: 'core.party', purpose }),
      ctx.vault.read({ entity: 'core.party_identifier', purpose }),
      ctx.vault.read({ entity: 'social.contact_card', purpose }),
    ]);
    const idsByParty = new Map();
    for (const row of identifiers.rows ?? []) {
      if (!idsByParty.has(row.party_id)) idsByParty.set(row.party_id, []);
      idsByParty.get(row.party_id).push(row);
    }
    const cardByParty = new Map();
    for (const card of cards.rows ?? []) cardByParty.set(card.party_id, card);
    const people = (parties.rows ?? [])
      .toSorted((a, b) => String(a.display_name).localeCompare(String(b.display_name)))
      .map((party) => ({
        ...party,
        identifiers: idsByParty.get(party.party_id) ?? [],
        card: cardByParty.get(party.party_id) ?? null,
      }));
    return { people };
  } catch (err) {
    return { people: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
