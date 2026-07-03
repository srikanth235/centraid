/**
 * The home-inventory projection: owned asset items joined to their place
 * name, purchase value and warranty history, plus disposed items (disposal
 * keeps the row), maintenance plans with a projected next-due date, and the
 * owner's places (the room picker's options). Everything comes from the
 * vault — this app holds no rows of its own; writes go back through the
 * home domain's typed commands.
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

export default async ({ ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  try {
    const [items, warranties, plans, places, attachments] = await Promise.all([
      ctx.vault.read({ entity: 'home.asset_item', purpose }),
      ctx.vault.read({ entity: 'home.warranty', purpose }),
      ctx.vault.read({ entity: 'home.maintenance_plan', purpose }),
      ctx.vault.read({ entity: 'core.place', purpose }),
      ctx.vault.read({
        entity: 'core.attachment',
        where: [{ column: 'subject_type', op: 'eq', value: 'home.asset_item' }],
        purpose,
      }),
    ]);
    const today = new Date().toISOString().slice(0, 10);

    const placeName = new Map((places.rows ?? []).map((p) => [p.place_id, p.name]));

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

    const owned = (items.rows ?? []).filter((it) => it.disposed_on == null);
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

    // Disposal keeps the row — disposed items stay visible as history,
    // newest disposal first.
    const disposed = (items.rows ?? [])
      .filter((it) => it.disposed_on != null)
      .map((it) => ({
        item_id: it.item_id,
        name: it.name,
        serial_no: it.serial_no ?? null,
        disposed_on: it.disposed_on,
        place_name: (it.place_id != null && placeName.get(it.place_id)) || null,
      }))
      .toSorted((a, b) => String(b.disposed_on).localeCompare(String(a.disposed_on)));

    const itemName = new Map(owned.map((it) => [it.item_id, it.name]));
    const maintenance = (plans.rows ?? [])
      .filter((p) => itemName.has(p.item_id))
      .map((p) => ({
        plan_id: p.plan_id,
        name: p.name,
        item_name: itemName.get(p.item_id),
        rrule: p.rrule,
        last_done_on: p.last_done_on ?? null,
        next_due_on: nextDueOn(p.rrule, p.last_done_on, today),
      }))
      .toSorted((a, b) => String(a.next_due_on ?? '￿').localeCompare(String(b.next_due_on ?? '￿')));

    // The owner's places, name-sorted — the room picker's option list.
    const placeList = (places.rows ?? [])
      .map((p) => ({ place_id: p.place_id, name: p.name }))
      .toSorted((a, b) => String(a.name).localeCompare(String(b.name)));

    return { items: joined, disposed, maintenance, places: placeList };
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
