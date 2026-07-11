/**
 * The agenda projection: non-cancelled canonical events, plus the calendars
 * a proposal could land on. Everything comes from the vault — this app holds
 * no rows of its own.
 *
 * Input (all optional): `{ from, to }` ISO instants. Without them the window
 * is the start of today forward (the list view's "upcoming"); the month and
 * week views pass the visible range so past periods render too. Events are
 * fetched from a few weeks before `from` so multi-day events that began
 * earlier but span into the window still arrive; the in-memory filter below
 * re-applies the true lower bound against each event's end.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/app-engine').QueryHandler}
 */

/**
 * Group the owner's attachments for one subject type into a map keyed by
 * subject_id, each value a UI-ready list joined to its content item. This is
 * the shared attachment-projection shape every app copies — polymorphic edges
 * in core.attachment, bytes in core.content_item.
 */
function attachmentsBySubject(subjectType, attachments, contentById) {
  // Blob-backed bytes serve as same-origin URLs (issue #296).
  const srcOf = (c) =>
    typeof c?.content_uri === 'string' && c.content_uri.startsWith('blob:')
      ? `/centraid/_vault/blobs/${c.content_id}`
      : c?.content_uri;
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
      content_uri: srcOf(content) ?? '',
      byte_size: content?.byte_size ?? 0,
    });
  }
  for (const list of bySubject.values()) {
    list.sort((x, y) => (y.is_primary ?? 0) - (x.is_primary ?? 0));
  }
  return bySubject;
}

/**
 * Group `schedule_attendee` rows into a map keyed by event_id, each value the
 * UI-ready guest list the EventDrawer renders: `{ party_id, name, partstat,
 * is_you }`, with the caller ("you") first so its RSVP-controls row leads the
 * Guests section. `nameById` resolves display names from the joined
 * `core_party` rows; `mePartyId` is the vault's owner party, so `is_you`
 * marks the one guest who gets the Going/Maybe/Decline controls.
 */
function attendeesByEvent(attendees, nameById, mePartyId) {
  const byEvent = new Map();
  for (const a of attendees) {
    if (!byEvent.has(a.event_id)) byEvent.set(a.event_id, []);
    byEvent.get(a.event_id).push({
      party_id: a.party_id,
      name: nameById.get(a.party_id) ?? 'Guest',
      partstat: a.partstat,
      role: a.role,
      is_you: mePartyId != null && a.party_id === mePartyId,
    });
  }
  for (const list of byEvent.values()) {
    list.sort(
      (x, y) =>
        (y.is_you ? 1 : 0) - (x.is_you ? 1 : 0) || String(x.name).localeCompare(String(y.name)),
    );
  }
  return byEvent;
}

// How far back of `from` the dtstart filter reaches so still-running
// multi-day events are not cut off at the window edge.
const SPAN_BUFFER_MS = 31 * 24 * 60 * 60 * 1000;

export default async ({ query, ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  try {
    const from =
      typeof query?.from === 'string' && query.from
        ? query.from
        : `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
    const to = typeof query?.to === 'string' && query.to ? query.to : null;
    const fromMs = new Date(from).getTime();
    const fromLower = Number.isNaN(fromMs) ? from : new Date(fromMs - SPAN_BUFFER_MS).toISOString();
    const where = [
      { column: 'status', op: 'ne', value: 'cancelled' },
      { column: 'dtstart', op: 'gte', value: fromLower },
    ];
    if (to) where.push({ column: 'dtstart', op: 'lt', value: to });
    const [events, calendars] = await Promise.all([
      ctx.vault.read({ entity: 'core.event', where, purpose }),
      ctx.vault.read({ entity: 'schedule.calendar', purpose }),
    ]);
    const windowed = events.rows ?? [];
    if (windowed.length === 0) {
      return { events: [], calendars: calendars.rows ?? [] };
    }
    const eventIds = windowed.map((e) => e.event_id);
    // Joins are `in`-bounded by the windowed events (issue #264) — the
    // event→calendar edge in schedule.event_ext (the UI colors and filters
    // by calendar, so each event carries its calendar_id), the attachment
    // edges, and the guest list (schedule.attendee, joined to core.party for
    // names below). The owner's own party comes from core.vault so a guest
    // that IS you gets the RSVP controls (issue #337).
    const [exts, attachments, attendeesRes, vaultRes] = await Promise.all([
      ctx.vault.read({
        entity: 'schedule.event_ext',
        where: [{ column: 'event_id', op: 'in', value: eventIds }],
        purpose,
      }),
      ctx.vault.read({
        entity: 'core.attachment',
        where: [
          { column: 'subject_type', op: 'eq', value: 'core.event' },
          { column: 'subject_id', op: 'in', value: eventIds },
        ],
        purpose,
      }),
      ctx.vault.read({
        entity: 'schedule.attendee',
        where: [{ column: 'event_id', op: 'in', value: eventIds }],
        purpose,
      }),
      ctx.vault.read({ entity: 'core.vault', purpose }),
    ]);
    const attendeeRows = attendeesRes.rows ?? [];
    const mePartyId = (vaultRes.rows ?? [])[0]?.owner_party_id ?? null;
    // One bounded pull resolves only the guests' display names.
    const attendeePartyIds = [...new Set(attendeeRows.map((a) => a.party_id))].filter(Boolean);
    const partiesRes =
      attendeePartyIds.length > 0
        ? await ctx.vault.read({
            entity: 'core.party',
            where: [{ column: 'party_id', op: 'in', value: attendeePartyIds }],
            purpose,
          })
        : { rows: [] };
    const partyNameById = new Map((partiesRes.rows ?? []).map((p) => [p.party_id, p.display_name]));
    const guestsByEvent = attendeesByEvent(attendeeRows, partyNameById, mePartyId);
    // One bounded pull covers only the bytes those attachments reference.
    const contentIds = [...new Set((attachments.rows ?? []).map((a) => a.content_id))].filter(
      Boolean,
    );
    const contents =
      contentIds.length > 0
        ? await ctx.vault.read({
            entity: 'core.content_item',
            where: [{ column: 'content_id', op: 'in', value: contentIds }],
            purpose,
          })
        : { rows: [] };
    const contentById = new Map((contents.rows ?? []).map((c) => [c.content_id, c]));
    const attByEvent = attachmentsBySubject('core.event', attachments.rows ?? [], contentById);
    const calByEvent = new Map((exts.rows ?? []).map((x) => [x.event_id, x.calendar_id]));
    const rows = windowed
      .filter((e) => {
        // True lower bound: keep anything still running at `from`.
        const endMs = new Date(e.dtend ?? e.dtstart).getTime();
        return Number.isNaN(endMs) || Number.isNaN(fromMs) || endMs >= fromMs;
      })
      .map((e) => ({
        ...e,
        calendar_id: calByEvent.get(e.event_id) ?? null,
        attachments: attByEvent.get(e.event_id) ?? [],
        attendees: guestsByEvent.get(e.event_id) ?? [],
      }))
      .toSorted((a, b) => String(a.dtstart).localeCompare(String(b.dtstart)));
    return {
      events: rows,
      calendars: calendars.rows ?? [],
    };
  } catch (err) {
    return { events: [], calendars: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
