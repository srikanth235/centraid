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
/** An event enriched with its calendar edge, guests, attachments and the
 *  recurrence-instance markers the projection layers on. */
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
/**
 * Group the owner's attachments for one subject type into a map keyed by
 * target_id, each value a UI-ready list joined to its content item. This is
 * the shared attachment-projection shape every app copies — polymorphic edges
 * in core.attachment, bytes in core.content_item.
 */
function attachmentsBySubject(
  subjectType: string,
  attachments: RawAttachment[],
  contentById: Map<string, RawContent>
): Map<string, DecoratedAttachment[]> {
  // Blob-backed bytes serve as same-origin URLs (issue #296).
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
/** One visible range cannot make first paint read an unbounded event table. */
const EVENT_WINDOW_CAP = 2000;

// Global ceiling on materialized instances across ALL series for one read —
// keeps a handful of dense rules from ballooning the payload.
const MAX_TOTAL_INSTANCES = 1500;

// Memoize each series' occurrence starts across navs/doorbells, keyed by the
// series identity + range. A nav back to a month already visited, or a
// doorbell that touched an unrelated table, then reuses the expansion instead
// of re-walking the rule. Bounded LRU so it can't grow without limit.
const EXPANSION_CACHE = new Map<string, RecurrenceInstance[]>();
const EXPANSION_CACHE_MAX = 500;

/**
 * Duration between dtstart and dtend preserving floating/all-day wall clocks.
 * `Date.parse` on bare wall strings is host-TZ dependent and must not be used
 * for non-zoned series when deriving instance ends.
 */
function eventDurationMs(ev: RawEvent): number {
  if (!ev.dtend) return 0;
  const semantics = ev.recurrence_semantics ?? "zoned";
  if (semantics === "zoned") {
    const delta = Date.parse(ev.dtend) - Date.parse(ev.dtstart);
    return Number.isFinite(delta) ? delta : 0;
  }
  // Wall strings share a comparable lexicographic / civil-time layout; parse
  // as UTC components so the delta is timezone-independent.
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
  time: TimeApi,
  exceptions: StoredRecurrenceException[]
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
      out.push({
        ...ev,
        is_recurrence_instance: false,
        instance_key: ev.event_id,
      });
      continue;
    }
    // Unsupported FREQ (parseRrule → null → empty expand) keeps the anchor so
    // a free-text RRULE mistake does not erase the event from the agenda.
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

/**
 * The member-facing recurrence sentence for a series, or `null` for a one-off.
 *
 * It is a two-line call through `ctx.time` rather than a module of its own on
 * purpose: the grammar lives in `@centraid/core/time` and is shared with
 * Tasks, so anything more here would be the second summariser the product
 * forbids. An older gateway exposes the vault surface without the time helper
 * (see the `timeApi` note below); there the field is simply absent, which the
 * UI reads as "no summary to show" rather than falling back to the rule.
 */
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
    // A recurring series is one row anchored (maybe years) in the past — the
    // dtstart>=fromLower filter below would drop it even though its next
    // occurrence lands inside the visible window. It is fetched separately,
    // unbounded by date, and merged before the range check happens on
    // per-instance dtstarts instead of the anchor's.
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
        // Cannot date-bound (a series anchors in the past); cap the row count.
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
    // Joins are `in`-bounded by the windowed events (issue #264) — the
    // event→calendar edge in schedule.event_ext (the UI colors and filters
    // by calendar, so each event carries its calendar_id), the attachment
    // edges, and the guest list (schedule.attendee, joined to core.party for
    // names below). The owner's own party comes from core.vault so a guest
    // that IS you gets the RSVP controls (issue #337).
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
      ((vaultRes.rows ?? [])[0]?.owner_party_id as string | undefined) ?? null;
    // One bounded pull resolves only the guests' display names.
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
    // One bounded pull covers only the bytes those attachments reference.
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
        // THE ONE SUMMARISER, RESOLVED SERVER-SIDE (#834). A raw RRULE is a
        // machine string; the member-facing sentence is `ctx.time`'s and is
        // shared with Tasks, so neither app can grow a second grammar. The
        // row carries the sentence and never the rule, which is what makes
        // "no raw rule reaches a surface" checkable at the boundary rather
        // than trusted in every renderer.
        recurrence_summary: recurrenceSummary(ctx, e.rrule),
      };
    });
    // Open-ended "upcoming" (no `to`) still needs a real ceiling to expand
    // against — a bounded forward window (issue #404) keeps a doorbell from
    // re-expanding a year of a DAILY series; the month/week views pass their
    // own tighter `to`. expandRrule's own maxInstances backstops it regardless.
    const expandTo = to ?? new Date(fromMs + DEFAULT_EXPAND_MS).toISOString();
    // A desktop can temporarily be attached to an older gateway while the
    // host upgrades. Those gateways expose the vault read surface but not the
    // shared time helper yet. Keep ordinary events visible and leave a
    // recurring anchor intact instead of turning the whole agenda into the
    // misleading "No vault access" error.
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
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return {
      events: [],
      calendars: [],
      vaultDenied: { code: e.code, message: e.message },
    };
  }
}
