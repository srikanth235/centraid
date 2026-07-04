/**
 * The home-inventory projection as a bounded recent window: the newest owned
 * asset items (caller-sized, default 500), never the whole home.asset_item
 * table, because vault data has no upper bound (issue #262). home_asset_item
 * carries no timestamp, but item_id is UUIDv7, so descending PK order IS
 * newest-first acquisition. Each windowed item is joined to its place name,
 * purchase value and warranty history; disposed items (disposal keeps the
 * row) ride beside the window as a fixed history shelf; maintenance plans
 * are projected to a next-due date for the windowed items; and the owner's
 * places fill the room picker. Anything older is reachable through the FTS
 * search query or by growing the window (`truncated` tells the UI to offer
 * that). Everything comes from the vault — this app holds no rows of its
 * own; writes go back through the home domain's typed commands.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */

/**
 * Group the owner's attachments for one subject type into a map keyed by
 * subject_id, each value a UI-ready list joined to its content item. This is
 * the shared attachment-projection shape every app copies — polymorphic edges
 * in core.attachment, bytes in core.content_item.
 */
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
  const window = Math.min(Math.max(Number(input?.limit) || 500, 20), 2000);
  try {
    const [ownedRead, disposedRead, places] = await Promise.all([
      ctx.vault.read({
        entity: 'home.asset_item',
        where: [{ column: 'disposed_on', op: 'is-null' }],
        orderBy: { column: 'item_id', dir: 'desc' },
        limit: window,
        purpose,
      }),
      // The disposed shelf is history, not inventory: a fixed 200 newest
      // disposals answers "which one was that?" without a caller-sized
      // window of its own — anything older is a search away (disposal
      // keeps the row, and disposed items stay in the FTS index).
      ctx.vault.read({
        entity: 'home.asset_item',
        where: [{ column: 'disposed_on', op: 'not-null' }],
        orderBy: { column: 'disposed_on', dir: 'desc' },
        limit: 200,
        purpose,
      }),
      // core.place stays a full read — the room list is the picker's
      // option set and stays small (rooms, not items).
      ctx.vault.read({ entity: 'core.place', purpose }),
    ]);
    const today = new Date().toISOString().slice(0, 10);

    const placeName = new Map((places.rows ?? []).map((p) => [p.place_id, p.name]));

    // The owner's places, name-sorted — the room picker's option list.
    const placeList = (places.rows ?? [])
      .map((p) => ({ place_id: p.place_id, name: p.name }))
      .toSorted((a, b) => String(a.name).localeCompare(String(b.name)));

    // Disposal keeps the row — disposed items stay visible as history,
    // newest disposal first (the window's read order).
    const disposed = (disposedRead.rows ?? []).map((it) => ({
      item_id: it.item_id,
      name: it.name,
      serial_no: it.serial_no ?? null,
      disposed_on: it.disposed_on,
      place_name: (it.place_id != null && placeName.get(it.place_id)) || null,
    }));

    const owned = ownedRead.rows ?? [];
    // A full window means there may be older items beyond it — the UI
    // offers "Show more" (a re-read with a larger window) and search.
    const truncated = owned.length >= window;

    // `in` with an empty array throws — with zero owned items there is
    // nothing to join, so return the empty inventory (history and the
    // room picker still stand).
    if (owned.length === 0) {
      return { items: [], disposed, maintenance: [], places: placeList, truncated, window };
    }
    const itemIds = owned.map((it) => it.item_id);

    // Joins are `in`-bounded by the window — warranty history, maintenance
    // plans and attachment edges only for the items on screen.
    const [warranties, plans, attachments] = await Promise.all([
      ctx.vault.read({
        entity: 'home.warranty',
        where: [{ column: 'item_id', op: 'in', value: itemIds }],
        purpose,
      }),
      // Maintenance plans are shown for windowed items only — a plan whose
      // item aged out of the window ages out with it (grow the window or
      // search to bring the item, and its plans, back).
      ctx.vault.read({
        entity: 'home.maintenance_plan',
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

    // Fetch only the content items this app's attachments reference — a
    // wholesale core.content_item read would ship every photo's bytes on
    // every refresh (same scoping pattern as the threads query).
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

    // Full warranty history per item, newest coverage first (an item can
    // accumulate several over time); "active" is computed from
    // home_warranty.ends_on against today.
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

    const joined = owned
      .map((it) => {
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
        };
      })
      .toSorted(
        (a, b) =>
          String(a.place_name ?? '￿').localeCompare(String(b.place_name ?? '￿')) ||
          String(a.name).localeCompare(String(b.name)),
      );

    const itemName = new Map(owned.map((it) => [it.item_id, it.name]));
    const maintenance = (plans.rows ?? [])
      .map((p) => ({
        plan_id: p.plan_id,
        name: p.name,
        item_name: itemName.get(p.item_id),
        rrule: p.rrule,
        last_done_on: p.last_done_on ?? null,
        next_due_on: nextDueOn(p.rrule, p.last_done_on, today),
      }))
      .toSorted((a, b) => String(a.next_due_on ?? '￿').localeCompare(String(b.next_due_on ?? '￿')));

    return { items: joined, disposed, maintenance, places: placeList, truncated, window };
  } catch (err) {
    return {
      items: [],
      disposed: [],
      maintenance: [],
      places: [],
      vaultDenied: { code: err.code, message: err.message },
    };
  }
};

/**
 * Project a plan's next due date from its real columns: last_done_on
 * advanced by the rrule's FREQ/INTERVAL. A never-done plan is due today;
 * an rrule we can't read yields null (the UI simply doesn't surface it).
 *
 * @param {string} rrule
 * @param {string | null | undefined} lastDoneOn
 * @param {string} today ISO date (YYYY-MM-DD)
 * @returns {string | null}
 */
function nextDueOn(rrule, lastDoneOn, today) {
  if (!lastDoneOn) return today;
  const freq = /FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/i.exec(rrule ?? '')?.[1]?.toUpperCase();
  if (!freq) return null;
  const interval = Math.max(1, Number(/INTERVAL=(\d+)/i.exec(rrule ?? '')?.[1] ?? 1));
  const d = new Date(`${String(lastDoneOn).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  if (freq === 'DAILY') d.setUTCDate(d.getUTCDate() + interval);
  else if (freq === 'WEEKLY') d.setUTCDate(d.getUTCDate() + 7 * interval);
  else if (freq === 'MONTHLY') d.setUTCMonth(d.getUTCMonth() + interval);
  else d.setUTCFullYear(d.getUTCFullYear() + interval);
  return d.toISOString().slice(0, 10);
}
