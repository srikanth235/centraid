// governance: allow-repo-hygiene file-size-limit cohesive agenda projection query; the event/calendar/proposal SELECTs and their row shaping are one read path against the vault
// Agenda projection: non-cancelled canonical events plus candidate calendars.
// `{ from, to }` optional (default: today forward); events fetched from
// BEFORE `from` so multi-day spans arrive — the filter below re-applies the
// true lower bound.

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
interface StoredRecurrenceException {
  target_id: string;
  original_start: string;
  scope?: "occurrence" | "future";
  action: "skip" | "override";
  override_json?: string | null;
}
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
  contentById: Map<string, RawContent>
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
      media_type: content?.media_type ?? "application/octet-stream",
      title: content?.title ?? null,
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
    const eventExceptions = exceptions.filter(
      (exception) => exception.target_id === ev.event_id
    );
    const overrides = new Map<string, RecurrenceOverride>();
    const recurrenceExceptions = eventExceptions.map((exception) => {
      const override = exception.override_json
        ? (JSON.parse(exception.override_json) as RecurrenceOverride)
        : {};
      overrides.set(exception.original_start, override);
      return {
        originalStart: exception.original_start,
        action: exception.action,
        scope: exception.scope ?? override.scope ?? "occurrence",
        ...(override.start === undefined ? {} : { start: override.start }),
      };
    });
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
      const isAnchor = instance.originalStart === ev.dtstart;
      const occurrenceOverride = overrides.get(instance.originalStart);
      const futureOverride = eventExceptions
        .filter((exception) => {
          if (exception.original_start > instance.originalStart) return false;
          const override = overrides.get(exception.original_start);
          return override?.scope === "future";
        })
        .toSorted((left, right) =>
          right.original_start.localeCompare(left.original_start)
        )[0];
      const override =
        occurrenceOverride ??
        (futureOverride
          ? overrides.get(futureOverride.original_start)
          : undefined);
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
        instance_key: `${ev.event_id}:${instance.originalStart}`,
        original_start: instance.originalStart,
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
  const purpose = "dpv:ServiceProvision";
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
    const where: VaultWhere[] = [
      { column: "status", op: "ne", value: "cancelled" },
      { column: "dtstart", op: "gte", value: fromLower },
    ];
    if (to) where.push({ column: "dtstart", op: "lt", value: to });
    const [events, recurring, calendars] = await Promise.all([
      ctx.vault.read({
        entity: "core.event",
        where,
        orderBy: { column: "dtstart", dir: "asc" },
        limit: EVENT_WINDOW_CAP,
        purpose,
      }),
      ctx.vault.read({
        entity: "core.event",
        where: [
          { column: "status", op: "ne", value: "cancelled" },
          { column: "rrule", op: "not-null" },
        ],
        orderBy: { column: "dtstart", dir: "desc" },
        limit: RECURRING_ANCHOR_CAP,
        purpose,
      }),
      ctx.vault.read({ entity: "schedule.calendar", purpose }),
    ]);
    const windowedById = new Map<string, RawEvent>(
      ((events.rows ?? []) as unknown as RawEvent[]).map((e) => [e.event_id, e])
    );
    for (const e of (recurring.rows ?? []) as unknown as RawEvent[])
      windowedById.set(e.event_id, e);
    const windowed = [...windowedById.values()];
    if (windowed.length === 0) {
      return { events: [], calendars: calendars.rows ?? [] };
    }
    const eventIds = windowed.map((e) => e.event_id);
    // Every join is `in`-bounded by the windowed events (#264). The owner's own
    // party comes from core.vault so a guest that IS you gets RSVP controls (#337).
    const [exts, attachments, attendeesRes, vaultRes, exceptionsRes] =
      await Promise.all([
        ctx.vault.read({
          entity: "schedule.event_ext",
          where: [{ column: "event_id", op: "in", value: eventIds }],
          purpose,
        }),
        ctx.vault.read({
          entity: "core.attachment",
          where: [
            { column: "target_type", op: "eq", value: "core.event" },
            { column: "target_id", op: "in", value: eventIds },
          ],
          purpose,
        }),
        ctx.vault.read({
          entity: "schedule.attendee",
          where: [{ column: "event_id", op: "in", value: eventIds }],
          purpose,
        }),
        ctx.vault.read({ entity: "core.vault", purpose }),
        ctx.vault.read({
          entity: "schedule.recurrence_exception",
          where: [
            { column: "target_type", op: "eq", value: "core.event" },
            { column: "target_id", op: "in", value: eventIds },
          ],
          purpose,
        }),
      ]);
    const attendeeRows = (attendeesRes.rows ?? []) as unknown as RawAttendee[];
    const mePartyId =
      ((vaultRes.rows ?? [])[0]?.self_party_id as string | undefined) ?? null;
    const attendeePartyIds = [
      ...new Set(attendeeRows.map((a) => a.party_id)),
    ].filter(Boolean);
    const partiesRes =
      attendeePartyIds.length > 0
        ? await ctx.vault.read({
            entity: "core.party",
            where: [{ column: "party_id", op: "in", value: attendeePartyIds }],
            purpose,
          })
        : { rows: [] };
    const partyNameById = new Map<string, unknown>(
      (partiesRes.rows ?? []).map((p) => [p.party_id as string, p.display_name])
    );
    const guestsByEvent = attendeesByEvent(
      attendeeRows,
      partyNameById,
      mePartyId
    );
    const attachmentRows = (attachments.rows ??
      []) as unknown as RawAttachment[];
    const contentIds = [
      ...new Set(attachmentRows.map((a) => a.content_id)),
    ].filter(Boolean);
    const contents =
      contentIds.length > 0
        ? await ctx.vault.read({
            entity: "core.content_item",
            where: [{ column: "content_id", op: "in", value: contentIds }],
            purpose,
          })
        : { rows: [] };
    const contentById = new Map<string, RawContent>(
      ((contents.rows ?? []) as unknown as RawContent[]).map((c) => [
        c.content_id,
        c,
      ])
    );
    const attByEvent = attachmentsBySubject(
      "core.event",
      attachmentRows,
      contentById
    );
    const extByEvent = new Map<string, Record<string, unknown>>(
      (exts.rows ?? []).map((x) => [x.event_id as string, x])
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
            (exceptionsRes.rows ?? []) as unknown as StoredRecurrenceException[]
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
      calendars: calendars.rows ?? [],
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
