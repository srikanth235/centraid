/**
 * The home-inventory projection: owned asset items joined to their place
 * name and latest warranty, plus maintenance plans with a projected
 * next-due date. Everything comes from the vault — this app holds no rows
 * of its own, and (until the home command pack ships) writes nothing back.
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
    const [items, warranties, plans, places, contents, attachments] = await Promise.all([
      ctx.vault.read({ entity: 'home.asset_item', purpose }),
      ctx.vault.read({ entity: 'home.warranty', purpose }),
      ctx.vault.read({ entity: 'home.maintenance_plan', purpose }),
      ctx.vault.read({ entity: 'core.place', purpose }),
      ctx.vault.read({ entity: 'core.content_item', purpose }),
      ctx.vault.read({
        entity: 'core.attachment',
        where: [{ column: 'subject_type', op: 'eq', value: 'home.asset_item' }],
        purpose,
      }),
    ]);
    const today = new Date().toISOString().slice(0, 10);

    const placeName = new Map((places.rows ?? []).map((p) => [p.place_id, p.name]));
    const contentById = new Map((contents.rows ?? []).map((c) => [c.content_id, c]));
    const attByItem = attachmentsBySubject('home.asset_item', attachments.rows ?? [], contentById);

    // Latest warranty per item (an item can accumulate several over time);
    // "active" is computed from home_warranty.ends_on against today.
    const warrantyByItem = new Map();
    for (const w of warranties.rows ?? []) {
      const prev = warrantyByItem.get(w.item_id);
      if (!prev || String(w.ends_on) > String(prev.ends_on)) warrantyByItem.set(w.item_id, w);
    }

    const owned = (items.rows ?? []).filter((it) => it.disposed_on == null);
    const joined = owned
      .map((it) => {
        const w = warrantyByItem.get(it.item_id);
        return {
          item_id: it.item_id,
          name: it.name,
          serial_no: it.serial_no ?? null,
          acquired_on: it.acquired_on ?? null,
          place_name: (it.place_id != null && placeName.get(it.place_id)) || null,
          warranty: w
            ? { ends_on: w.ends_on, active: String(w.ends_on).slice(0, 10) >= today }
            : null,
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

    return { items: joined, maintenance };
  } catch (err) {
    return { items: [], maintenance: [], vaultDenied: { code: err.code, message: err.message } };
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
