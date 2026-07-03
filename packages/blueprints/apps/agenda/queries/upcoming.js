/**
 * The agenda projection: non-cancelled canonical events from the start of
 * today forward, plus the calendars a proposal could land on. Everything
 * comes from the vault — this app holds no rows of its own.
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
    const startOfToday = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
    const [events, calendars, contents, attachments] = await Promise.all([
      ctx.vault.read({
        entity: 'core.event',
        where: [
          { column: 'status', op: 'ne', value: 'cancelled' },
          { column: 'dtstart', op: 'gte', value: startOfToday },
        ],
        purpose,
      }),
      ctx.vault.read({ entity: 'schedule.calendar', purpose }),
      ctx.vault.read({ entity: 'core.content_item', purpose }),
      ctx.vault.read({
        entity: 'core.attachment',
        where: [{ column: 'subject_type', op: 'eq', value: 'core.event' }],
        purpose,
      }),
    ]);
    const contentById = new Map((contents.rows ?? []).map((c) => [c.content_id, c]));
    const attByEvent = attachmentsBySubject('core.event', attachments.rows ?? [], contentById);
    const rows = (events.rows ?? [])
      .map((e) => ({ ...e, attachments: attByEvent.get(e.event_id) ?? [] }))
      .toSorted((a, b) => String(a.dtstart).localeCompare(String(b.dtstart)));
    return {
      events: rows,
      calendars: calendars.rows ?? [],
    };
  } catch (err) {
    return { events: [], calendars: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
