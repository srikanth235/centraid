/**
 * The bookings projection: your availability windows, and the bookings held
 * against your calendar — each a canonical core.event with a client attendee.
 * Everything comes from the vault; this app holds no rows of its own. A
 * tentative event is a pending request awaiting your confirmation; a
 * confirmed one is on the books.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Human day list from a 7-bit Monday-first weekday mask. */
function maskDays(mask) {
  return WEEKDAYS.filter((_, i) => (mask & (1 << i)) !== 0);
}

/** Shared attachment-projection shape (see the Notes app). */
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
    const [rules, calendars, events, exts, attendees, parties, contents, attachments] =
      await Promise.all([
        ctx.vault.read({ entity: 'schedule.availability_rule', purpose }),
        ctx.vault.read({ entity: 'schedule.calendar', purpose }),
        ctx.vault.read({
          entity: 'core.event',
          where: [{ column: 'status', op: 'ne', value: 'cancelled' }],
          purpose,
        }),
        ctx.vault.read({ entity: 'schedule.event_ext', purpose }),
        ctx.vault.read({ entity: 'schedule.attendee', purpose }),
        ctx.vault.read({ entity: 'core.party', purpose }),
        ctx.vault.read({ entity: 'core.content_item', purpose }),
        ctx.vault.read({
          entity: 'core.attachment',
          where: [{ column: 'subject_type', op: 'eq', value: 'core.event' }],
          purpose,
        }),
      ]);

    const partyName = new Map((parties.rows ?? []).map((p) => [p.party_id, p.display_name]));
    const calName = new Map((calendars.rows ?? []).map((c) => [c.calendar_id, c.name]));
    const contentById = new Map((contents.rows ?? []).map((c) => [c.content_id, c]));
    const attByEvent = attachmentsBySubject('core.event', attachments.rows ?? [], contentById);

    // Only events that live on a calendar (have an event_ext) are bookings.
    const calByEvent = new Map((exts.rows ?? []).map((x) => [x.event_id, x.calendar_id]));
    // First attendee is the client the slot was held for.
    const requesterByEvent = new Map();
    for (const a of attendees.rows ?? []) {
      if (!requesterByEvent.has(a.event_id)) {
        requesterByEvent.set(a.event_id, partyName.get(a.party_id) ?? 'Someone');
      }
    }

    const bookings = (events.rows ?? [])
      .filter((e) => calByEvent.has(e.event_id))
      .map((e) => ({
        event_id: e.event_id,
        summary: e.summary,
        dtstart: e.dtstart,
        dtend: e.dtend,
        status: e.status, // tentative = pending, confirmed = booked
        calendar: calName.get(calByEvent.get(e.event_id)) ?? 'Calendar',
        requester: requesterByEvent.get(e.event_id) ?? null,
        attachments: attByEvent.get(e.event_id) ?? [],
      }))
      .toSorted((a, b) => String(a.dtstart).localeCompare(String(b.dtstart)));

    const availability = (rules.rows ?? [])
      .filter((r) => r.kind === 'work')
      .map((r) => ({
        rule_id: r.rule_id,
        weekday_mask: r.weekday_mask,
        window_start: r.window_start,
        window_end: r.window_end,
        tz: r.tz,
        days: maskDays(r.weekday_mask),
      }));

    return {
      availability,
      bookings,
      calendars: (calendars.rows ?? []).map((c) => ({ calendar_id: c.calendar_id, name: c.name })),
      parties: (parties.rows ?? [])
        .map((p) => ({ party_id: p.party_id, display_name: p.display_name }))
        .toSorted((a, b) => String(a.display_name).localeCompare(String(b.display_name))),
    };
  } catch (err) {
    return {
      availability: [],
      bookings: [],
      calendars: [],
      parties: [],
      vaultDenied: { code: err.code, message: err.message },
    };
  }
};
