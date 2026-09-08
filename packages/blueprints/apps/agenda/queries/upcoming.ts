import { inList, readPages } from "../../_shared/paged-reads.ts";
import {
  ownerKey,
  readRepresentations,
} from "../../_shared/representation-reads.ts";
import type { RepresentationIndex } from "../../_shared/representation-reads.ts";
// `{ from, to }` optional (default: today forward); events fetched from
// BEFORE `from` so multi-day spans arrive — the filter below re-applies the
// true lower bound.

/** One `core.event` row, as both of this handler's windows project it. */
const EVENT_COLUMNS =
  "event_id, ical_uid, summary, description, dtstart, dtend, start_tz, " +
  "end_tz, recurrence_semantics, rrule, rrule_support, status, " +
  "location_place_id, organizer_party_id, sequence, created_at, updated_at";

interface RawEvent {
  event_id: string;
  status?: string;
  dtstart: string;
  dtend?: string | null;
  start_tz?: string | null;
  end_tz?: string | null;
  recurrence_semantics?: RecurrenceSemantics;
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
  /** Bytes have no title of their own since #996 (R20(b)); an attachment is
   *  not a wrapper, so there is nothing here to carry one. */
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
/**
 * The stored rows, UNREAD by this file (#996, ruling R21; drift ONT-25). They
 * used to be picked apart here under a name that is not what the column is
 * called — so every lookup missed and a skipped occurrence
 * came back onto the agenda. `ctx.time.occurrenceExceptionsOf` is the one
 * adapter that knows the spelling.
 */
type StoredRecurrenceException = Record<string, unknown>;
interface RecurrenceOverride {
  scope?: "occurrence" | "future";
  start?: string;
  end?: string;
  summary?: string;
  description?: string;
  recurrence_semantics?: RecurrenceSemantics;
  calendar_id?: string;
  conferencing_uri?: string;
  reminders?: { minutes_before: number }[];
  attendee_party_ids?: string[];
}
interface EventRow extends RawEvent {
  calendar_id?: string | null;
  conferencing_uri?: string | null;
  reminders_json?: string | null;
  attachments?: DecoratedAttachment[];
  attendees?: DecoratedAttendee[];
  is_recurrence_instance?: boolean;
  instance_key?: string;
  /** The ONE member-facing recurrence sentence; never the rule (#834). */
  recurrence_summary?: string | null;
}
function attachmentsBySubject(
  subjectType: string,
  attachments: RawAttachment[],
  contentById: Map<string, RawContent>,
  representations: RepresentationIndex
): Map<string, DecoratedAttachment[]> {
  // Blob-backed bytes serve as same-origin URLs (#296).
  const srcOf = (c: RawContent | undefined): string | undefined =>
    typeof c?.content_uri === "string" && c.content_uri.startsWith("blob:")
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
      // The ATTACHMENT's own reading of the bytes (#996, R20(b)); bytes
      // carry neither a media type nor a title of their own.
      media_type:
        representations.byOwner.get(
          ownerKey("core.attachment", a.attachment_id)
        ) ??
        representations.byContent.get(a.content_id) ??
        "application/octet-stream",
      content_uri: srcOf(content) ?? "",
      byte_size: content?.byte_size ?? 0,
    });
  }
  for (const list of bySubject.values()) {
    list.sort((x, y) => (y.is_primary ?? 0) - (x.is_primary ?? 0));
  }
  return bySubject;
}

// "You" sorts FIRST so RSVP controls lead; mePartyId must be the owner party.
function attendeesByEvent(
  attendees: RawAttendee[],
  nameById: Map<string, unknown>,
  mePartyId: string | null
): Map<string, DecoratedAttendee[]> {
  const byEvent = new Map<string, DecoratedAttendee[]>();
  for (const a of attendees) {
    if (!byEvent.has(a.event_id)) byEvent.set(a.event_id, []);
    byEvent.get(a.event_id)!.push({
      attendee_id: a.attendee_id,
      party_id: a.party_id,
      name: (nameById.get(a.party_id) as string | undefined) ?? "Guest",
      partstat: a.partstat,
      role: a.role,
      is_you: mePartyId != null && a.party_id === mePartyId,
    });
  }
  for (const list of byEvent.values()) {
    list.sort(
      (x, y) =>
        (y.is_you ? 1 : 0) - (x.is_you ? 1 : 0) ||
        String(x.name).localeCompare(String(y.name))
    );
  }
  return byEvent;
}

// Reach back past `from` so still-running multi-day events are not cut off.
const SPAN_BUFFER_MS = 31 * 24 * 60 * 60 * 1000;

// Ceiling for the open-ended view (no `to`): stops a series expanding a full
// YEAR per load/nav/doorbell (#404). Month/week views pass their own `to`.
const DEFAULT_EXPAND_MS = 120 * 24 * 60 * 60 * 1000;

// Series anchors live in the past; cap rows instead of walking unbounded.
const RECURRING_ANCHOR_CAP = 1000;
/** One visible range must not make first paint read an unbounded table. */
const EVENT_WINDOW_CAP = 2000;

// Across ALL series per read.
const MAX_TOTAL_INSTANCES = 1500;

// Bounded LRU reused across navs/doorbells.
const EXPANSION_CACHE = new Map<string, RecurrenceInstance[]>();
const EXPANSION_CACHE_MAX = 500;

// Preserves floating/all-day wall clocks: `Date.parse` on bare wall strings is
// host-TZ dependent and MUST NOT be used for non-zoned series.
function eventDurationMs(ev: RawEvent): number {
  if (!ev.dtend) return 0;
  const semantics = ev.recurrence_semantics ?? "zoned";
  if (semantics === "zoned") {
    const delta = Date.parse(ev.dtend) - Date.parse(ev.dtstart);
    return Number.isFinite(delta) ? delta : 0;
  }
  // Parse wall strings as UTC components so the delta is TZ-independent.
  const start = Date.parse(
    ev.dtstart.includes("T") ? `${ev.dtstart}Z` : `${ev.dtstart}T00:00:00Z`
  );
  const end = Date.parse(
    ev.dtend.includes("T") ? `${ev.dtend}Z` : `${ev.dtend}T00:00:00Z`
  );
  const delta = end - start;
  return Number.isFinite(delta) ? delta : 0;
}

function cachedInstances(
  ev: RawEvent,
  rangeFrom: Date,
  rangeTo: Date,
  time: TimeApi
): RecurrenceInstance[] {
  const key = `${ev.event_id}|${ev.updated_at}|${ev.dtstart}|${ev.rrule}|${ev.start_tz}|${ev.recurrence_semantics}|${rangeFrom.getTime()}|${rangeTo.getTime()}`;
  const hit = EXPANSION_CACHE.get(key);
  if (hit) {
    EXPANSION_CACHE.delete(key); // refresh recency
    EXPANSION_CACHE.set(key, hit);
    return hit;
  }
  const instances = time.expandRecurrence({
    rrule: ev.rrule ?? "",
    start: ev.dtstart,
    rangeFrom: rangeFrom.toISOString(),
    rangeTo: rangeTo.toISOString(),
    timeZone: ev.start_tz ?? "Etc/UTC",
    semantics: ev.recurrence_semantics ?? "zoned",
    maxInstances: 200,
  });
  EXPANSION_CACHE.set(key, instances);
  if (EXPANSION_CACHE.size > EXPANSION_CACHE_MAX) {
    EXPANSION_CACHE.delete(EXPANSION_CACHE.keys().next().value!);
  }
  return instances;
}

// Instance rows keep `event_id` UNCHANGED — reschedule/cancel/RSVP/attach still
// target the one canonical series row; the UI keys on `instance_key`.
function expandRecurringEvents(
  rows: EventRow[],
  rangeFrom: string | Date,
  rangeTo: string | Date,
  time: TimeApi,
  exceptions: StoredRecurrenceException[]
): EventRow[] {
  // Normalize to Date once: expandRrule and the memo key compare via
  // `.getTime()`, and raw strings throw into the outer catch, which silently
  // becomes an empty agenda whenever a recurring series exists (#404).
  const fromDate = rangeFrom instanceof Date ? rangeFrom : new Date(rangeFrom);
  const toDate = rangeTo instanceof Date ? rangeTo : new Date(rangeTo);
  const out: EventRow[] = [];
  for (const ev of rows) {
    if (!ev.rrule) {
      out.push({
        ...ev,
        is_recurrence_instance: false,
        instance_key: ev.event_id,
      });
      continue;
    }
    // Unsupported FREQ keeps the anchor: a free-text RRULE mistake must not
    // erase the event from the agenda.
    const durationMs = eventDurationMs(ev);
    const eventExceptions = time.occurrenceExceptionsOf<RecurrenceOverride>(
      exceptions,
      { seriesType: "core.event", seriesId: ev.event_id }
    );
    const recurrenceExceptions = time.recurrenceExceptionsOf(eventExceptions);
    const expanded = cachedInstances(ev, fromDate, toDate, time);
    const instances = time.applyRecurrenceExceptions(
      expanded.length > 0
        ? expanded
        : [
            {
              originalStart: ev.dtstart,
              start: ev.dtstart,
              wallStart: ev.dtstart,
              overlap: false,
            },
          ],
      recurrenceExceptions
    );
    if (instances.length === 0) continue;
    for (const instance of instances) {
      if (out.length >= MAX_TOTAL_INSTANCES) return out;
      const startIso = instance.start;
      // The occurrence key is the SERIES-LOCAL WALL CLOCK (#996, R21 /
      // ONT-25) — `originalStart` is the resolved instant for a zoned series,
      // and keying on it is what made a stored skip match nothing.
      const occurrenceKey = instance.wallStart;
      const isAnchor = instance.start === ev.dtstart;
      const override =
        time.overrideAt(eventExceptions, occurrenceKey) ?? undefined;
      out.push({
        ...ev,
        ...(override?.summary === undefined
          ? {}
          : { summary: override.summary }),
        ...(override?.description === undefined
          ? {}
          : { description: override.description }),
        ...(override?.recurrence_semantics === undefined
          ? {}
          : { recurrence_semantics: override.recurrence_semantics }),
        ...(override?.calendar_id === undefined
          ? {}
          : { calendar_id: override.calendar_id }),
        ...(override?.conferencing_uri === undefined
          ? {}
          : { conferencing_uri: override.conferencing_uri }),
        ...(override?.reminders === undefined
          ? {}
          : { reminders_json: JSON.stringify(override.reminders) }),
        ...(override?.attendee_party_ids === undefined
          ? {}
          : {
              attendees: override.attendee_party_ids.map((partyId) => {
                const existing = ev.attendees?.find(
                  (guest) => guest.party_id === partyId
                );
                return (
                  existing ?? {
                    attendee_id: partyId,
                    party_id: partyId,
                    name: "Guest",
                    partstat: "needs-action",
                    is_you: false,
                  }
                );
              }),
            }),
        dtstart: startIso,
        dtend:
          override?.end ??
          (ev.dtend && Number.isFinite(durationMs)
            ? time.shiftTemporal(startIso, durationMs)
            : ev.dtend),
        is_recurrence_instance: !isAnchor,
        instance_key: `${ev.event_id}:${occurrenceKey}`,
        original_start_local: occurrenceKey,
        recurrence_overlap: instance.overlap,
      });
    }
  }
  return out;
}

// Two-line call through `ctx.time` on purpose: grammar shared with Tasks;
// anything more is the second summariser the product forbids. Older gateway
// reads as "no summary", never the rule.
function recurrenceSummary(
  ctx: HandlerArgs["ctx"],
  rrule: string | null | undefined
): string | null {
  const time = ctx.time as TimeApi | undefined;
  if (!rrule || !time?.describeRecurrence) return null;
  return time.describeRecurrence(rrule);
}

export default async function upcomingHandler({ query, ctx }: HandlerArgs) {
  try {
    const from =
      typeof query?.from === "string" && query.from
        ? query.from
        : `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
    const to = typeof query?.to === "string" && query.to ? query.to : null;
    const fromMs = new Date(from).getTime();
    const fromLower = Number.isNaN(fromMs)
      ? from
      : new Date(fromMs - SPAN_BUFFER_MS).toISOString();
    // A recurring series anchors years in the past, so the dtstart>=fromLower
    // filter would drop it; fetch separately, merge before the range check.
    // THE TWO WINDOWS ARE PAGES (#996 wave 4, R8), and the range predicate is
    // spliced into the statement rather than built as clause objects.
    const rangeWhere = to
      ? "status <> ? AND dtstart >= ? AND dtstart < ?"
      : "status <> ? AND dtstart >= ?";
    const rangeBind = to
      ? ["cancelled", fromLower, to]
      : ["cancelled", fromLower];
    const [events, recurring, calendarRows] = await Promise.all([
      ctx.vault.page<RawEvent>({
        query: {
          name: "agenda.upcoming.window",
          select: EVENT_COLUMNS,
          from: "core_event",
          where: rangeWhere,
          bind: rangeBind,
          order: {
            sortColumn: "dtstart",
            pkColumn: "event_id",
            descending: false,
          },
        },
        limit: EVENT_WINDOW_CAP,
      }),
      ctx.vault.page<RawEvent>({
        query: {
          name: "agenda.upcoming.recurringAnchors",
          select: EVENT_COLUMNS,
          from: "core_event",
          where: "status <> ? AND rrule IS NOT NULL",
          bind: ["cancelled"],
          order: {
            sortColumn: "dtstart",
            pkColumn: "event_id",
            descending: true,
          },
        },
        limit: RECURRING_ANCHOR_CAP,
      }),
      // The member's own calendars: owner-curated and small.
      readPages<Record<string, unknown>>(ctx, {
        name: "agenda.upcoming.calendars",
        select:
          "calendar_id, owner_party_id, name, color, default_tz, visibility",
        from: "schedule_calendar",
        order: {
          sortColumn: "calendar_id",
          pkColumn: "calendar_id",
          descending: false,
        },
      }),
    ]);
    const windowedById = new Map<string, RawEvent>(
      events.rows.map((e) => [e.event_id, e])
    );
    for (const e of recurring.rows) windowedById.set(e.event_id, e);
    const windowed = [...windowedById.values()];
    if (windowed.length === 0) {
      return { events: [], calendars: calendarRows };
    }
    const eventIds = windowed.map((e) => e.event_id);
    // Every join is `in`-bounded by the windowed events (#264). The owner's own
    // party comes from core.vault so a guest that IS you gets RSVP controls (#337).
    const eventIn = inList("event_id", eventIds);
    const targetIn = inList("target_id", eventIds);
    const [extRows, attachmentRows, attendeeRows, vaultRows, exceptionRows] =
      await Promise.all([
        readPages<Record<string, unknown>>(ctx, {
          name: "agenda.upcoming.eventExt",
          select:
            "event_ext_id, event_id, calendar_id, busy, conferencing_uri, reminders_json, travel_buffer_min",
          from: "schedule_event_ext",
          where: eventIn.sql,
          bind: eventIn.bind,
          order: {
            sortColumn: "event_ext_id",
            pkColumn: "event_ext_id",
            descending: false,
          },
        }),
        readPages<RawAttachment>(ctx, {
          name: "agenda.upcoming.attachments",
          select:
            "attachment_id, target_type, target_id, content_id, role, is_primary",
          from: "core_attachment",
          where: `target_type = ? AND ${targetIn.sql}`,
          bind: ["core.event", ...targetIn.bind],
          order: {
            sortColumn: "attachment_id",
            pkColumn: "attachment_id",
            descending: false,
          },
        }),
        readPages<RawAttendee>(ctx, {
          name: "agenda.upcoming.attendees",
          select: "attendee_id, event_id, party_id, partstat, role",
          from: "schedule_attendee",
          where: eventIn.sql,
          bind: eventIn.bind,
          order: {
            sortColumn: "attendee_id",
            pkColumn: "attendee_id",
            descending: false,
          },
        }),
        readPages<{ vault_id: string; self_party_id?: string | null }>(ctx, {
          name: "agenda.upcoming.vault",
          select: "vault_id, self_party_id",
          from: "core_vault",
          order: {
            sortColumn: "vault_id",
            pkColumn: "vault_id",
            descending: false,
          },
        }),
        // The occurrence key is stored as the series-local wall clock (R21);
        // `occurrenceExceptionsOf` reads the column, no handler names it.
        readPages<StoredRecurrenceException>(ctx, {
          name: "agenda.upcoming.exceptions",
          select:
            "exception_id, target_type, target_id, original_start_local, recurrence_semantics, scope, action, override_json",
          from: "schedule_recurrence_exception",
          where: `target_type = ? AND ${targetIn.sql}`,
          bind: ["core.event", ...targetIn.bind],
          order: {
            sortColumn: "exception_id",
            pkColumn: "exception_id",
            descending: false,
          },
        }),
      ]);
    const mePartyId = vaultRows[0]?.self_party_id ?? null;
    const attendeePartyIds = [
      ...new Set(attendeeRows.map((a) => a.party_id)),
    ].filter(Boolean);
    const partyIn =
      attendeePartyIds.length > 0 ? inList("party_id", attendeePartyIds) : null;
    const partyRows = partyIn
      ? await readPages<{ party_id: string; display_name?: string | null }>(
          ctx,
          {
            name: "agenda.upcoming.parties",
            select: "party_id, display_name",
            from: "core_party",
            where: partyIn.sql,
            bind: partyIn.bind,
            order: {
              sortColumn: "party_id",
              pkColumn: "party_id",
              descending: false,
            },
          }
        )
      : [];
    const partyNameById = new Map<string, unknown>(
      partyRows.map((p) => [p.party_id, p.display_name])
    );
    const guestsByEvent = attendeesByEvent(
      attendeeRows,
      partyNameById,
      mePartyId
    );
    const contentIds = [
      ...new Set(attachmentRows.map((a) => a.content_id)),
    ].filter(Boolean);
    const contentIn =
      contentIds.length > 0 ? inList("content_id", contentIds) : null;
    const contentRows = contentIn
      ? await readPages<RawContent>(ctx, {
          name: "agenda.upcoming.contents",
          select: "content_id, content_uri, byte_size",
          from: "core_content_item",
          where: contentIn.sql,
          bind: contentIn.bind,
          order: {
            sortColumn: "content_id",
            pkColumn: "content_id",
            descending: false,
          },
        })
      : [];
    // Bytes carry no media type since #996 (R20(b)) — the attachment's own
    // representation says what it reads them as.
    const representations = await readRepresentations({ ctx, contentIds });
    const contentById = new Map<string, RawContent>(
      contentRows.map((c) => [c.content_id, c])
    );
    const attByEvent = attachmentsBySubject(
      "core.event",
      attachmentRows,
      contentById,
      representations
    );
    const extByEvent = new Map<string, Record<string, unknown>>(
      extRows.map((x) => [x.event_id as string, x])
    );
    const enriched: EventRow[] = windowed.map((e) => {
      const ext = extByEvent.get(e.event_id);
      return {
        ...e,
        calendar_id: (ext?.calendar_id as string | null | undefined) ?? null,
        conferencing_uri:
          (ext?.conferencing_uri as string | null | undefined) ?? null,
        reminders_json:
          (ext?.reminders_json as string | null | undefined) ?? null,
        attachments: attByEvent.get(e.event_id) ?? [],
        attendees: guestsByEvent.get(e.event_id) ?? [],
        // THE ONE SUMMARISER, RESOLVED SERVER-SIDE (#834): the row carries the
        // sentence and never the raw rule.
        recurrence_summary: recurrenceSummary(ctx, e.rrule),
      };
    });
    // Open-ended "upcoming" still needs a ceiling to expand against, or a
    // doorbell re-expands a year of a DAILY series (#404).
    const expandTo = to ?? new Date(fromMs + DEFAULT_EXPAND_MS).toISOString();
    // An older gateway lacks the time helper: keep ordinary events visible and
    // the anchor intact rather than fail the whole agenda.
    const timeApi = ctx.time as TimeApi | undefined;
    const rows = (
      timeApi
        ? expandRecurringEvents(
            enriched,
            fromLower,
            expandTo,
            timeApi,
            exceptionRows
          )
        : enriched.map((event) => ({
            ...event,
            is_recurrence_instance: false,
            instance_key: event.event_id,
          }))
    )
      .filter((e) => {
        // True lower bound: keep anything still running at `from`; recurrence
        // instances are already in-range by construction.
        if (e.is_recurrence_instance || e.rrule) return true;
        const endMs = new Date(e.dtend ?? e.dtstart).getTime();
        return Number.isNaN(endMs) || Number.isNaN(fromMs) || endMs >= fromMs;
      })
      .toSorted((a, b) => String(a.dtstart).localeCompare(String(b.dtstart)));
    return {
      events: rows,
      calendars: calendarRows,
    };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return {
      events: [],
      calendars: [],
      vaultDenied: { code: e.code, message: e.message },
    };
  }
}
