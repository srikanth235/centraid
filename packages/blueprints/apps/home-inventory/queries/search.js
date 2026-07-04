/**
 * Item search as a vault projection: the FTS5 index inside the vault does
 * the matching (name + serial number), so the app never pulls the whole
 * home.asset_item table to grep it — vault data has no upper bound. Only
 * the matched owned items are joined with their place names, warranty
 * history and attachments, mirroring the inventory projection's row shape
 * row-for-row so the UI renders either list with the same code, plus a hit
 * snippet. Disposed items stay in the index deliberately — "where did that
 * old thing go?" is exactly a search — and come back in a separate
 * `disposed` array in the inventory query's disposed row shape, so the UI
 * shelves them apart from what's still owned.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */

/** The shared attachment projection — see inventory.js for the shape's home. */
function attachmentsBySubject(subjectType, attachments, contentById) {
  const bySubject = new Map();
  for (const a of attachments) {
    if (a.subject_type !== subjectType) continue;
    const content = contentById.get(a.content_id);
    if (!bySubject.has(a.subject_id)) bySubject.set(a.subject_id, []);
    bySubject.get(a.subject_id).push({
      attachment_id: a.attachment_id,
      content_id: a.content_id,
      role: a.role,
      is_primary: a.is_primary,
      media_type: content?.media_type ?? 'application/octet-stream',
      title: content?.title ?? null,
      content_uri: content?.content_uri ?? '',
      byte_size: content?.byte_size ?? 0,
    });
  }
  for (const list of bySubject.values()) {
    list.sort((x, y) => (y.is_primary ?? 0) - (x.is_primary ?? 0));
  }
  return bySubject;
}

export default async ({ input, ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  const term = String(input?.term ?? '').trim();
  if (!term) return { items: [], disposed: [] };
  try {
    const matches = await ctx.vault.search({
      entity: 'home.asset_item',
      query: term,
      limit: 100,
      purpose,
    });
    const hits = matches.rows ?? [];
    if (hits.length === 0) return { items: [], disposed: [] };

    // core.place stays a full read — the room list is small (rooms, not
    // items) and both result shapes want a place name.
    const places = await ctx.vault.read({ entity: 'core.place', purpose });
    const placeName = new Map((places.rows ?? []).map((p) => [p.place_id, p.name]));

    // Vault order is rank order (best match first) — keep it in both lists.
    // Disposed hits shelve as history (name, serial, room, date): no
    // warranty or attachment joins, matching the inventory query's shape.
    const disposed = hits
      .filter((it) => it.disposed_on != null)
      .map((it) => ({
        item_id: it.item_id,
        name: it.name,
        serial_no: it.serial_no ?? null,
        disposed_on: it.disposed_on,
        place_name: (it.place_id != null && placeName.get(it.place_id)) || null,
        snippet: typeof it._snippet === 'string' ? it._snippet : '',
      }));

    const owned = hits.filter((it) => it.disposed_on == null);
    // `in` with an empty array throws — every hit disposed means nothing
    // left to join.
    if (owned.length === 0) return { items: [], disposed };
    const itemIds = owned.map((it) => it.item_id);
    const today = new Date().toISOString().slice(0, 10);

    // Joins are `in`-bounded by the matched owned ids — warranty history
    // and attachment edges only for the rows going back to the UI.
    const [warranties, attachments] = await Promise.all([
      ctx.vault.read({
        entity: 'home.warranty',
        where: [{ column: 'item_id', op: 'in', value: itemIds }],
        purpose,
      }),
      ctx.vault.read({
        entity: 'core.attachment',
        where: [
          { column: 'subject_type', op: 'eq', value: 'home.asset_item' },
          { column: 'subject_id', op: 'in', value: itemIds },
        ],
        purpose,
      }),
    ]);

    // Only the content items the matched attachments reference — never a
    // wholesale core.content_item read (same scoping as inventory.js).
    const contentIds = [
      ...new Set((attachments.rows ?? []).map((a) => a.content_id).filter(Boolean)),
    ];
    const contentById = new Map();
    if (contentIds.length > 0) {
      const contents = await ctx.vault.read({
        entity: 'core.content_item',
        where: [{ column: 'content_id', op: 'in', value: contentIds }],
        purpose,
      });
      for (const c of contents.rows ?? []) contentById.set(c.content_id, c);
    }
    const attByItem = attachmentsBySubject('home.asset_item', attachments.rows ?? [], contentById);

    // Full warranty history per matched item, newest coverage first —
    // the same projection the inventory query builds.
    const warrantiesByItem = new Map();
    for (const w of warranties.rows ?? []) {
      if (!warrantiesByItem.has(w.item_id)) warrantiesByItem.set(w.item_id, []);
      warrantiesByItem.get(w.item_id).push({
        warranty_id: w.warranty_id,
        starts_on: w.starts_on,
        ends_on: w.ends_on,
        claim_uri: w.claim_uri ?? null,
        active: String(w.ends_on).slice(0, 10) >= today,
      });
    }
    for (const list of warrantiesByItem.values()) {
      list.sort((x, y) => String(y.ends_on).localeCompare(String(x.ends_on)));
    }

    const items = owned.map((it) => {
      const itemWarranties = warrantiesByItem.get(it.item_id) ?? [];
      const latest = itemWarranties[0];
      return {
        item_id: it.item_id,
        name: it.name,
        serial_no: it.serial_no ?? null,
        acquired_on: it.acquired_on ?? null,
        place_id: it.place_id ?? null,
        place_name: (it.place_id != null && placeName.get(it.place_id)) || null,
        purchase_price_minor: it.purchase_price_minor ?? null,
        purchase_currency: it.purchase_currency ?? null,
        warranty: latest ? { ends_on: latest.ends_on, active: latest.active } : null,
        warranties: itemWarranties,
        attachments: attByItem.get(it.item_id) ?? [],
        snippet: typeof it._snippet === 'string' ? it._snippet : '',
      };
    });

    return { items, disposed };
  } catch (err) {
    return { items: [], disposed: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
