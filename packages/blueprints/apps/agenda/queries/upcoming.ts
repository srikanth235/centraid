// governance: allow-repo-hygiene file-size-limit cohesive agenda projection query; the event/calendar/proposal SELECTs and their row shaping are one read path against the vault
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
 * A consent denial is a first-class outcome, not an error: the UI renders it
 * as the "ask the owner for access" state, receipt id included.
 *
 * The fleet's ONE `({ query, ctx })` handler: the range arrives as URL params
 * under the legacy `query` name (not `input`).
 */

/** Raw core.event row shape as the vault projects it (the fields this query
 *  reads; unread columns ride the index signature). */
interface RawEvent {
  event_id: string;
  status?: string;
  dtstart: string;
  dtend?: string | null;
  rrule?: string | null;
  updated_at?: string;
  summary?: string;
  [k: string]: unknown;
}
interface RawAttachment {
  attachment_id: string;
  target_type: string;
  target_id: string;
  content_id: string;
  role?: string;
  is_primary?: number;
  [k: string]: unknown;
}
interface RawContent {
  content_id: string;
  content_uri?: string;
  media_type?: string;
  title?: string | null;
  byte_size?: number;
  [k: string]: unknown;
}
interface RawAttendee {
  attendee_id: string;
  event_id: string;
  party_id: string;
  partstat: string;
  role?: string;
  [k: string]: unknown;
}
interface DecoratedAttachment {
  attachment_id: string;
  content_id: string;
  role?: string;
  is_primary?: number;
  media_type: string;
  title: string | null;
  content_uri: string;
  byte_size: number;
}
interface DecoratedAttendee {
  attendee_id: string;
  party_id: string;
  name: string;
  partstat: string;
  role?: string;
  is_you: boolean;
}
/** An event enriched with its calendar edge, guests, attachments and the
 *  recurrence-instance markers the projection layers on. */
interface EventRow extends RawEvent {
  calendar_id?: string | null;
  conferencing_uri?: string | null;
  attachments?: DecoratedAttachment[];
  attendees?: DecoratedAttendee[];
  is_recurrence_instance?: boolean;
  instance_key?: string;
}
interface ParsedRule {
  freq: string;
  interval: number;
  count?: number;
  until?: string;
  byDay?: string[];
}

/**
 * Group the owner's attachments for one subject type into a map keyed by
 * target_id, each value a UI-ready list joined to its content item. This is
 * the shared attachment-projection shape every app copies — polymorphic edges
 * in core.attachment, bytes in core.content_item.
 */
function attachmentsBySubject(
  subjectType: string,
  attachments: RawAttachment[],
  contentById: Map<string, RawContent>,
): Map<string, DecoratedAttachment[]> {
  // Blob-backed bytes serve as same-origin URLs (issue #296).
  const srcOf = (c: RawContent | undefined): string | undefined =>
    typeof c?.content_uri === 'string' && c.content_uri.startsWith('blob:')
      ? `/centraid/_vault/blobs/${c.content_id}`
      : c?.content_uri;
  const bySubject = new Map<string, DecoratedAttachment[]>();
  for (const a of attachments) {
    if (a.target_type !== subjectType) continue;
    const content = contentById.get(a.content_id);
    if (!bySubject.has(a.target_id)) bySubject.set(a.target_id, []);
    bySubject.get(a.target_id)!.push({
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
function attendeesByEvent(
  attendees: RawAttendee[],
  nameById: Map<string, unknown>,
  mePartyId: string | null,
): Map<string, DecoratedAttendee[]> {
  const byEvent = new Map<string, DecoratedAttendee[]>();
  for (const a of attendees) {
    if (!byEvent.has(a.event_id)) byEvent.set(a.event_id, []);
    byEvent.get(a.event_id)!.push({
      attendee_id: a.attendee_id,
      party_id: a.party_id,
      name: (nameById.get(a.party_id) as string | undefined) ?? 'Guest',
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

// The open-ended "upcoming" (schedule) view has no `to`, so recurring series
// were expanded a full YEAR out on every load, nav and doorbell (issue #404).
// A quarter is generous forward runway for a list; the month/week views pass
// their own bounded `to` and are unaffected. expandRrule's per-series
// maxInstances still backstops a runaway DAILY rule regardless.
const DEFAULT_EXPAND_MS = 120 * 24 * 60 * 60 * 1000;

// Hard ceiling on the recurring anchors pulled — a vault has no upper bound,
// and this read cannot be date-bounded (a series anchors in the past), so cap
// the row count rather than walk the whole table.
const RECURRING_ANCHOR_CAP = 1000;

// Global ceiling on materialized instances across ALL series for one read —
// keeps a handful of dense rules from ballooning the payload.
const MAX_TOTAL_INSTANCES = 1500;

// Memoize each series' occurrence starts across navs/doorbells, keyed by the
// series identity + range. A nav back to a month already visited, or a
// doorbell that touched an unrelated table, then reuses the expansion instead
// of re-walking the rule. Bounded LRU so it can't grow without limit.
const EXPANSION_CACHE = new Map<string, string[]>();
const EXPANSION_CACHE_MAX = 500;

function cachedStarts(ev: RawEvent, rangeFrom: Date, rangeTo: Date): string[] {
  const key = `${ev.event_id}|${ev.updated_at}|${ev.dtstart}|${ev.rrule}|${rangeFrom.getTime()}|${rangeTo.getTime()}`;
  const hit = EXPANSION_CACHE.get(key);
  if (hit) {
    EXPANSION_CACHE.delete(key); // refresh recency
    EXPANSION_CACHE.set(key, hit);
    return hit;
  }
  const starts = expandRrule(ev.rrule ?? '', ev.dtstart, rangeFrom, rangeTo);
  EXPANSION_CACHE.set(key, starts);
  if (EXPANSION_CACHE.size > EXPANSION_CACHE_MAX) {
    EXPANSION_CACHE.delete(EXPANSION_CACHE.keys().next().value!);
  }
  return starts;
}

// ---------- Recurrence (RFC 5545 §3.3.10 subset, DAILY/WEEKLY/MONTHLY/YEARLY
// with INTERVAL/COUNT/UNTIL/BYDAY) ----------
//
// Self-contained on purpose: query handlers are standalone modules, so this
// mirrors (rather than imports) @centraid/vault's recurrence/rrule.ts. Keep
// the two in sync if the supported subset changes.
const DAY_TOKENS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function parseRrule(rrule: string): ParsedRule | null {
  const parts = new Map<string, string>();
  for (const seg of String(rrule).split(';')) {
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    parts.set(seg.slice(0, eq).trim().toUpperCase(), seg.slice(eq + 1).trim());
  }
  const freq = parts.get('FREQ');
  if (!freq || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null;
  const interval = Math.max(1, Number.parseInt(parts.get('INTERVAL') ?? '1', 10) || 1);
  const countRaw = parts.get('COUNT');
  const count = countRaw ? Math.max(1, Number.parseInt(countRaw, 10) || 0) || undefined : undefined;
  const until = parts.get('UNTIL') || undefined;
  const byDayRaw = parts.get('BYDAY');
  const byDay = byDayRaw
    ? byDayRaw
        .split(',')
        .map((d) => d.trim().toUpperCase())
        .filter((d) => DAY_TOKENS.includes(d))
    : undefined;
  return { freq, interval, count, until, byDay: byDay && byDay.length > 0 ? byDay : undefined };
}

// RFC 5545 UNTIL is written extended (2026-07-03T00:00:00Z) or basic
// (20260703T000000Z, the form ICS ingest stores verbatim). Date.parse accepts
// only the former, so a basic UNTIL silently degraded to unbounded. Normalize
// both; a bare date (20260703) is treated as UTC midnight.
function parseIcalInstant(value: string): Date | null {
  const direct = Date.parse(value);
  if (!Number.isNaN(direct)) return new Date(direct);
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?Z?$/.exec(String(value).trim());
  if (!match) return null;
  const [, y, mo, d, hh = '00', mm = '00', ss = '00'] = match;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss));
  return Number.isNaN(ms) ? null : new Date(ms);
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d.getTime());
  next.setUTCDate(next.getUTCDate() + n);
  return next;
}

function addMonths(d: Date, n: number): Date {
  const next = new Date(d.getTime());
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + n);
  const daysInMonth = new Date(
    Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
  ).getUTCDate();
  next.setUTCDate(Math.min(day, daysInMonth));
  return next;
}

/** Occurrence starts of `rrule` (anchored at `dtstartIso`) inside `[rangeFrom, rangeTo)`. */
function expandRrule(
  rrule: string,
  dtstartIso: string,
  rangeFrom: Date,
  rangeTo: Date,
  maxInstances = 200,
): string[] {
  const parsed = parseRrule(rrule);
  const dtstart = new Date(dtstartIso);
  if (!parsed || Number.isNaN(dtstart.getTime())) return [];
  const until = parsed.until ? parseIcalInstant(parsed.until) : null;
  const out: string[] = [];
  let occurrenceIndex = 0;

  const cursorAt = (k: number): Date => {
    if (parsed.freq === 'DAILY') return addDays(dtstart, k * parsed.interval);
    if (parsed.freq === 'WEEKLY') return addDays(dtstart, k * 7 * parsed.interval);
    if (parsed.freq === 'MONTHLY') return addMonths(dtstart, k * parsed.interval);
    return addMonths(dtstart, k * 12 * parsed.interval);
  };

  if (parsed.freq === 'WEEKLY' && parsed.byDay) {
    const weekStart = addDays(dtstart, -dtstart.getUTCDay());
    let week = weekStart;
    let guard = 0;
    while (guard < maxInstances * 8) {
      guard += 1;
      for (const token of parsed.byDay) {
        const d = addDays(week, DAY_TOKENS.indexOf(token));
        if (d.getTime() < dtstart.getTime()) continue;
        if (until && d.getTime() > until.getTime()) continue;
        if (parsed.count !== undefined && occurrenceIndex >= parsed.count) continue;
        occurrenceIndex += 1;
        if (d.getTime() >= rangeFrom.getTime() && d.getTime() < rangeTo.getTime())
          out.push(d.toISOString());
      }
      if (
        (parsed.count !== undefined && occurrenceIndex >= parsed.count) ||
        (until && week.getTime() > until.getTime()) ||
        week.getTime() > rangeTo.getTime() ||
        out.length >= maxInstances
      ) {
        break;
      }
      week = addDays(week, 7 * parsed.interval);
    }
    return out.slice(0, maxInstances).sort();
  }

  let k = 0;
  let guard = 0;
  while (out.length < maxInstances && guard < maxInstances * 4) {
    guard += 1;
    const cursor = cursorAt(k);
    if (cursor.getTime() >= rangeTo.getTime()) break;
    if (until && cursor.getTime() > until.getTime()) break;
    if (parsed.count !== undefined && occurrenceIndex >= parsed.count) break;
    occurrenceIndex += 1;
    if (cursor.getTime() >= rangeFrom.getTime()) out.push(cursor.toISOString());
    k += 1;
  }
  return out;
}

/**
 * Materialize each recurring event's occurrences inside `[rangeFrom,
 * rangeTo)` into instance rows — same shape as the anchor, dtstart/dtend
 * shifted, `event_id` UNCHANGED (reschedule/cancel/RSVP/attach all still
 * target the one canonical series row; there is no per-instance identity
 * yet, only per-instance rendering) plus `is_recurrence_instance` and
 * `instance_key` for the UI to key list rendering on since several
 * instances now share one `event_id`.
 */
function expandRecurringEvents(
  rows: EventRow[],
  rangeFrom: string | Date,
  rangeTo: string | Date,
): EventRow[] {
  // `rangeFrom`/`rangeTo` arrive as ISO strings from the caller; expandRrule
  // (and the memo key) compare via `.getTime()`, so normalize to Date once
  // here. (Passing the raw strings threw `String.getTime is not a function`,
  // which the outer catch silently turned into an empty agenda whenever a
  // recurring series existed — issue #404.)
  const fromDate = rangeFrom instanceof Date ? rangeFrom : new Date(rangeFrom);
  const toDate = rangeTo instanceof Date ? rangeTo : new Date(rangeTo);
  const out: EventRow[] = [];
  for (const ev of rows) {
    if (!ev.rrule) {
      out.push({ ...ev, is_recurrence_instance: false, instance_key: ev.event_id });
      continue;
    }
    const durationMs = ev.dtend ? new Date(ev.dtend).getTime() - new Date(ev.dtstart).getTime() : 0;
    const starts = cachedStarts(ev, fromDate, toDate);
    if (starts.length === 0) continue;
    for (const startIso of starts) {
      if (out.length >= MAX_TOTAL_INSTANCES) return out;
      const isAnchor = startIso === new Date(ev.dtstart).toISOString();
      out.push({
        ...ev,
        dtstart: startIso,
        dtend:
          ev.dtend && Number.isFinite(durationMs)
            ? new Date(new Date(startIso).getTime() + durationMs).toISOString()
            : ev.dtend,
        is_recurrence_instance: !isAnchor,
        instance_key: `${ev.event_id}:${startIso}`,
      });
    }
  }
  return out;
}

export default async ({ query, ctx }: HandlerArgs) => {
  const purpose = 'dpv:ServiceProvision';
  try {
    const from =
      typeof query?.from === 'string' && query.from
        ? query.from
        : `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
    const to = typeof query?.to === 'string' && query.to ? query.to : null;
    const fromMs = new Date(from).getTime();
    const fromLower = Number.isNaN(fromMs) ? from : new Date(fromMs - SPAN_BUFFER_MS).toISOString();
    // A recurring series is one row anchored (maybe years) in the past — the
    // dtstart>=fromLower filter below would drop it even though its next
    // occurrence lands inside the visible window. It is fetched separately,
    // unbounded by date, and merged before the range check happens on
    // per-instance dtstarts instead of the anchor's.
    const where: VaultWhere[] = [
      { column: 'status', op: 'ne', value: 'cancelled' },
      { column: 'dtstart', op: 'gte', value: fromLower },
    ];
    if (to) where.push({ column: 'dtstart', op: 'lt', value: to });
    const [events, recurring, calendars] = await Promise.all([
      ctx.vault.read({ entity: 'core.event', where, purpose }),
      ctx.vault.read({
        entity: 'core.event',
        where: [
          { column: 'status', op: 'ne', value: 'cancelled' },
          { column: 'rrule', op: 'not-null' },
        ],
        // Cannot date-bound (a series anchors in the past); cap the row count.
        orderBy: { column: 'dtstart', dir: 'desc' },
        limit: RECURRING_ANCHOR_CAP,
        purpose,
      }),
      ctx.vault.read({ entity: 'schedule.calendar', purpose }),
    ]);
    const windowedById = new Map<string, RawEvent>(
      ((events.rows ?? []) as unknown as RawEvent[]).map((e) => [e.event_id, e]),
    );
    for (const e of (recurring.rows ?? []) as unknown as RawEvent[])
      windowedById.set(e.event_id, e);
    const windowed = [...windowedById.values()];
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
          { column: 'target_type', op: 'eq', value: 'core.event' },
          { column: 'target_id', op: 'in', value: eventIds },
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
    const attendeeRows = (attendeesRes.rows ?? []) as unknown as RawAttendee[];
    const mePartyId = ((vaultRes.rows ?? [])[0]?.owner_party_id as string | undefined) ?? null;
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
    const partyNameById = new Map<string, unknown>(
      (partiesRes.rows ?? []).map((p) => [p.party_id as string, p.display_name]),
    );
    const guestsByEvent = attendeesByEvent(attendeeRows, partyNameById, mePartyId);
    // One bounded pull covers only the bytes those attachments reference.
    const attachmentRows = (attachments.rows ?? []) as unknown as RawAttachment[];
    const contentIds = [...new Set(attachmentRows.map((a) => a.content_id))].filter(Boolean);
    const contents =
      contentIds.length > 0
        ? await ctx.vault.read({
            entity: 'core.content_item',
            where: [{ column: 'content_id', op: 'in', value: contentIds }],
            purpose,
          })
        : { rows: [] };
    const contentById = new Map<string, RawContent>(
      ((contents.rows ?? []) as unknown as RawContent[]).map((c) => [c.content_id, c]),
    );
    const attByEvent = attachmentsBySubject('core.event', attachmentRows, contentById);
    const extByEvent = new Map<string, Record<string, unknown>>(
      (exts.rows ?? []).map((x) => [x.event_id as string, x]),
    );
    const enriched: EventRow[] = windowed.map((e) => {
      const ext = extByEvent.get(e.event_id);
      return {
        ...e,
        calendar_id: (ext?.calendar_id as string | null | undefined) ?? null,
        conferencing_uri: (ext?.conferencing_uri as string | null | undefined) ?? null,
        attachments: attByEvent.get(e.event_id) ?? [],
        attendees: guestsByEvent.get(e.event_id) ?? [],
      };
    });
    // Open-ended "upcoming" (no `to`) still needs a real ceiling to expand
    // against — a bounded forward window (issue #404) keeps a doorbell from
    // re-expanding a year of a DAILY series; the month/week views pass their
    // own tighter `to`. expandRrule's own maxInstances backstops it regardless.
    const expandTo = to ?? new Date(fromMs + DEFAULT_EXPAND_MS).toISOString();
    const rows = expandRecurringEvents(enriched, fromLower, expandTo)
      .filter((e) => {
        // True lower bound: keep anything still running at `from`. Only
        // meaningful for the non-recurring set — a recurrence instance's
        // dtstart already sits inside [fromLower, expandTo) by construction.
        if (e.is_recurrence_instance || e.rrule) return true;
        const endMs = new Date(e.dtend ?? e.dtstart).getTime();
        return Number.isNaN(endMs) || Number.isNaN(fromMs) || endMs >= fromMs;
      })
      .toSorted((a, b) => String(a.dtstart).localeCompare(String(b.dtstart)));
    return {
      events: rows,
      calendars: calendars.rows ?? [],
    };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { events: [], calendars: [], vaultDenied: { code: e.code, message: e.message } };
  }
};
