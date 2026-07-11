/**
 * Event search as a vault projection: the FTS5 index inside the vault does
 * the matching (summary + description), so the app never pulls the whole
 * core.event table to grep it — vault data has no upper bound. Only the
 * matched rows are joined with their calendar edge and attachments,
 * mirroring the upcoming projection's shape row-for-row so the list view
 * renders either set with the same code. Cancelled events are dropped after
 * the FTS hit — the index knows text, not status, and the agenda never
 * shows cancellations.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */

/** The shared attachment projection — see upcoming.js for the shape's home. */
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

/** The shared guest projection — see upcoming.js for the shape's home. */
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

export default async ({ input, ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  const term = String(input?.term ?? '').trim();
  if (!term) return { events: [] };
  try {
    const matches = await ctx.vault.search({
      entity: 'core.event',
      query: term,
      limit: 100,
      purpose,
    });
    // Same semantics as upcoming: cancelled events never reach the agenda.
    const hits = (matches.rows ?? []).filter((e) => e.status !== 'cancelled');
    if (hits.length === 0) return { events: [] };
    const eventIds = hits.map((e) => e.event_id);
    // Joins are `in`-bounded by the matched ids — the event→calendar edge
    // in schedule.event_ext, the attachment edges, and the guest list
    // (schedule.attendee, joined to core.party for names below); the owner's
    // own party (core.vault) drives the `is_you` RSVP row (issue #337).
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
    // Vault order is rank order (best match first) — keep it. The UI already
    // holds the calendars from `upcoming`, so none ride along here.
    const events = hits.map(({ _snippet, ...e }) => ({
      ...e,
      calendar_id: calByEvent.get(e.event_id) ?? null,
      attachments: attByEvent.get(e.event_id) ?? [],
      attendees: guestsByEvent.get(e.event_id) ?? [],
      snippet: typeof _snippet === 'string' ? _snippet : '',
    }));
    return { events };
  } catch (err) {
    return { events: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
