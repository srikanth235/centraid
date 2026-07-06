/**
 * Face proposals for one asset (issue #299 phase 3): the enricher's
 * media.face_region rows — unconfirmed proposals with confidence, plus
 * whatever the owner already confirmed — and a bounded people list for
 * the confirm picker. A consent denial is a first-class outcome the UI
 * renders as the ask-for-access state.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */
export default async ({ input, ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  const assetId = String(input?.asset_id ?? '');
  if (!assetId) return { status: 400, body: { error: 'asset_id required' } };
  try {
    const [regions, people] = await Promise.all([
      ctx.vault.read({
        entity: 'media.face_region',
        where: [{ column: 'asset_id', op: 'eq', value: assetId }],
        limit: 50,
        purpose,
      }),
      ctx.vault.read({
        entity: 'core.party',
        orderBy: { column: 'display_name', dir: 'asc' },
        limit: 200,
        purpose,
      }),
    ]);
    const persons = (people.rows ?? []).filter((p) => p.kind === 'person');
    const nameOf = new Map(persons.map((p) => [p.party_id, p.display_name]));
    return {
      status: 200,
      body: {
        regions: (regions.rows ?? []).map((r) => ({
          region_id: r.region_id,
          bbox: safeParse(r.bbox_json),
          party_id: r.party_id ?? null,
          person_name: r.party_id ? (nameOf.get(r.party_id) ?? null) : null,
          confidence: r.confidence ?? null,
          confirmed: r.confirmed_by_party_id != null,
        })),
        people: persons.map((p) => ({ party_id: p.party_id, name: p.display_name })),
      },
    };
  } catch (err) {
    if (err.code === 'VAULT_CONSENT') {
      return { status: 200, body: { denied: true, reason: err.message } };
    }
    return { status: 200, body: { regions: [], people: [], error: String(err.message ?? err) } };
  }
};

function safeParse(json) {
  try {
    return JSON.parse(String(json ?? 'null'));
  } catch {
    return null;
  }
}
