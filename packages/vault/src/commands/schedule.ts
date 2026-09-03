// The two honest agent commands of the recommended first boundary (§11):
// schedule.propose_event and schedule.reschedule_event — each consent-checked
// and receipted end to end. Command implementations are domain-owned; the
// gateway hosts and checks them (§10 negative space).

import { canonicalizeRrule } from "@centraid/core/time";

import type { Gateway } from "../gateway/gateway.js";
import type { CommandDefinition, HandlerCtx } from "../gateway/types.js";
import { queueProviderWriteback } from "./provider-writeback.js";
import { registerScheduleOrganizeCommands } from "./schedule-organize.js";

const PROPOSE_EVENT: CommandDefinition = {
  name: "schedule.propose_event",
  ownerSchema: "schedule",
  inputSchema: {
    type: "object",
    required: ["summary", "dtstart", "dtend", "calendar_id"],
    additionalProperties: false,
    properties: {
      summary: { type: "string", minLength: 1 },
      description: { type: "string" },
      dtstart: { type: "string", minLength: 1 },
      dtend: { type: "string", minLength: 1 },
      start_tz: { type: "string" },
      end_tz: { type: "string" },
      recurrence_semantics: {
        type: "string",
        enum: ["zoned", "floating", "all-day"],
      },
      calendar_id: { type: "string", minLength: 1 },
      location_place_id: { type: "string" },
      attendee_party_ids: { type: "array", items: { type: "string" } },
      // RFC 5545 §3.3.10 subset (DAILY/WEEKLY/MONTHLY/YEARLY — see
      // recurrence/rrule.ts); the series repeats from this event's own
      // dtstart, so no separate anchor field.
      rrule: { type: "string", minLength: 1 },
      conferencing_uri: { type: "string", minLength: 1 },
      reminders: {
        type: "array",
        items: {
          type: "object",
          required: ["minutes_before"],
          additionalProperties: false,
          properties: { minutes_before: { type: "integer", minimum: 0 } },
        },
      },
    },
  },
  outputSchema: {
    type: "object",
    required: ["event_id"],
    properties: {
      event_id: { type: "string" },
      attendees: { type: "integer" },
    },
  },
  preconditions: [
    {
      name: "calendar_exists",
      sql: "SELECT count(*) AS n FROM schedule_calendar WHERE calendar_id = :calendar_id",
      column: "n",
      op: "eq",
      value: 1,
      message: "That calendar doesn't exist.",
    },
    {
      name: "no_busy_conflict",
      sql: `SELECT count(*) AS n
              FROM core_event e JOIN schedule_event_ext x ON x.event_id = e.event_id
             WHERE x.busy = 'busy' AND e.status != 'cancelled'
               AND e.dtstart < :dtend AND (e.dtend IS NULL OR e.dtend > :dtstart)`,
      column: "n",
      op: "eq",
      value: 0,
      message: "This time conflicts with another event on your calendar.",
    },
    {
      name: "dtend_after_dtstart",
      sql: "SELECT (:dtend > :dtstart) AS n",
      column: "n",
      op: "eq",
      message: "An event must end after it starts.",
      value: 1,
    },
    {
      // Full RFC 5545 parsing happens read-side (recurrence/rrule.ts); this
      // is only a fast, cheap reject of obvious garbage before it's stored.
      name: "rrule_looks_valid",
      // Accept bare FREQ=… and a legacy/Google RRULE:FREQ=… prefix.
      // Build the RRULE: prefix with concat so the condition param binder
      // (which scans for :name tokens case-insensitively) does not treat
      // the "FREQ" inside the string literal as a named parameter — that
      // mis-bind made every propose_event fail closed with this message.
      sql: "SELECT (:rrule IS NULL OR :rrule LIKE 'FREQ=%' OR :rrule LIKE ('RRULE:' || 'FREQ=%')) AS n",
      column: "n",
      op: "eq",
      value: 1,
      message: "That repeat rule is not recognized.",
    },
  ],
  postconditions: [
    {
      name: "event_created_tentative",
      sql: `SELECT count(*) AS n FROM core_event WHERE event_id = :event_id AND status = 'tentative'`,
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      name: "event_ext_attached",
      sql: "SELECT count(*) AS n FROM schedule_event_ext WHERE event_id = :event_id",
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "once",
  risk: "medium",
  handler: proposeEvent,
};

/**
 * WHAT `dtstart` MEANS (#916, R2 / review 3.3). 'zoned' says it is a real
 * instant expanded in `start_tz`, so both halves have to be there; an event
 * arriving with no zone is FLOATING — a wall clock — and saying 'zoned'
 * anyway is what the schema's CHECK now refuses. The default follows the
 * input rather than a constant, because the caller who omits a zone is
 * telling us which of the two this is.
 */
export function eventSemantics(input: {
  recurrence_semantics?: string;
  start_tz?: string;
  dtstart?: string;
}): string {
  if (input.recurrence_semantics !== undefined)
    return input.recurrence_semantics;
  return input.start_tz && input.dtstart?.endsWith("Z") ? "zoned" : "floating";
}

function proposeEvent(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    summary: string;
    description?: string;
    dtstart: string;
    dtend: string;
    start_tz?: string;
    end_tz?: string;
    recurrence_semantics?: "zoned" | "floating" | "all-day";
    calendar_id: string;
    location_place_id?: string;
    attendee_party_ids?: string[];
    rrule?: string;
    conferencing_uri?: string;
    reminders?: { minutes_before: number }[];
  };
  const eventId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_event
         (event_id, ical_uid, summary, description, dtstart, dtend, start_tz,
          rrule, status, location_place_id, organizer_party_id, sequence,
          created_at, updated_at, end_tz, recurrence_semantics)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'tentative', ?, ?, 0, ?, ?, ?, ?)`
    )
    .run(
      eventId,
      input.summary,
      input.description ?? null,
      input.dtstart,
      input.dtend,
      input.start_tz ?? null,
      input.rrule ? canonicalizeRrule(input.rrule) : null,
      input.location_place_id ?? null,
      ctx.identity.partyId,
      ctx.now,
      ctx.now,
      input.end_tz ?? input.start_tz ?? null,
      eventSemantics(input)
    );
  ctx.wrote("core.event", eventId);
  const remindersJson =
    input.reminders && input.reminders.length > 0
      ? JSON.stringify(input.reminders)
      : null;
  // The write is recorded under the ext row's OWN primary key, not the event
  // id: every downstream sweep (demo purge above all) deletes by the physical
  // pk, so an event-keyed registration deleted nothing and left the ext row
  // holding an FK on the event that would not die (#708).
  const eventExtId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO schedule_event_ext
         (event_ext_id, event_id, calendar_id, busy, conferencing_uri, reminders_json, travel_buffer_min)
       VALUES (?, ?, ?, 'busy', ?, ?, NULL)`
    )
    .run(
      eventExtId,
      eventId,
      input.calendar_id,
      input.conferencing_uri ?? null,
      remindersJson
    );
  ctx.wrote("schedule.event_ext", eventExtId);
  const attendees = input.attendee_party_ids ?? [];
  for (const partyId of attendees) {
    const attendeeId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO schedule_attendee (attendee_id, event_id, party_id, role, partstat, responded_at)
         VALUES (?, ?, ?, 'required', 'needs-action', NULL)`
      )
      .run(attendeeId, eventId, partyId);
    ctx.wrote("schedule.attendee", attendeeId);
  }
  ctx.cite({
    claim: `proposed against calendar ${input.calendar_id} with no busy conflict in [${input.dtstart}, ${input.dtend})`,
    entityType: "schedule.calendar",
    entityId: input.calendar_id,
  });
  return { event_id: eventId, attendees: attendees.length };
}

const RESCHEDULE_EVENT: CommandDefinition = {
  name: "schedule.reschedule_event",
  ownerSchema: "schedule",
  inputSchema: {
    type: "object",
    required: ["event_id", "dtstart", "dtend"],
    additionalProperties: false,
    properties: {
      event_id: { type: "string", minLength: 1 },
      dtstart: { type: "string", minLength: 1 },
      dtend: { type: "string", minLength: 1 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["event_id", "sequence"],
    properties: { event_id: { type: "string" }, sequence: { type: "integer" } },
  },
  preconditions: [
    {
      name: "event_exists_not_cancelled",
      sql: `SELECT count(*) AS n FROM core_event
             WHERE event_id = :event_id AND status != 'cancelled'
               AND deleted_at IS NULL`,
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      name: "dtend_after_dtstart",
      sql: "SELECT (:dtend > :dtstart) AS n",
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    // :sequence binds from the handler output — reschedules increment
    // RFC 5545 SEQUENCE on the same identity, never a new row.
    {
      name: "sequence_incremented_and_moved",
      sql: `SELECT count(*) AS n FROM core_event
             WHERE event_id = :event_id AND sequence = :sequence AND dtstart = :dtstart AND dtend = :dtend`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "retry-safe",
  risk: "medium",
  // Restates a commitment others may hold (#306 decision 1) — parks
  // for owner confirmation on every non-owner invocation. Without this the
  // manifest's and Agenda's "parks for the owner" claim was cosmetic: any
  // caller with the install-time grant moved the event immediately.
  confirm: true,
  handler: rescheduleEvent,
};

function rescheduleEvent(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    event_id: string;
    dtstart: string;
    dtend: string;
  };
  const current = ctx.db
    .prepare("SELECT sequence FROM core_event WHERE event_id = ?")
    .get(input.event_id) as { sequence: number } | undefined;
  if (!current)
    throw new Error(
      `event ${input.event_id} vanished between check and execute`
    );
  const sequence = current.sequence + 1;
  ctx.db
    .prepare(
      "UPDATE core_event SET dtstart = ?, dtend = ?, sequence = ?, updated_at = ? WHERE event_id = ?"
    )
    .run(input.dtstart, input.dtend, sequence, ctx.now, input.event_id);
  ctx.wrote("core.event", input.event_id);
  queueProviderWriteback(ctx, "core.event", input.event_id, ["start", "end"]);
  ctx.cite({
    claim: `rescheduled to [${input.dtstart}, ${input.dtend}) as revision ${sequence}`,
    entityType: "core.event",
    entityId: input.event_id,
  });
  return { event_id: input.event_id, sequence };
}

const RESPOND_RSVP: CommandDefinition = {
  name: "schedule.respond_rsvp",
  ownerSchema: "schedule",
  inputSchema: {
    type: "object",
    required: ["event_id", "party_id", "partstat"],
    additionalProperties: false,
    properties: {
      event_id: { type: "string", minLength: 1 },
      party_id: { type: "string", minLength: 1 },
      // The one real state machine of the first boundary (§11): RFC 5545
      // PARTSTAT — needs-action → accepted | declined | tentative.
      partstat: { type: "string", enum: ["accepted", "declined", "tentative"] },
    },
  },
  outputSchema: {
    type: "object",
    required: ["attendee_id", "partstat"],
    properties: {
      attendee_id: { type: "string" },
      partstat: { type: "string" },
    },
  },
  preconditions: [
    {
      name: "attendee_invited",
      sql: `SELECT count(*) AS n FROM schedule_attendee WHERE event_id = :event_id AND party_id = :party_id`,
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      name: "event_not_cancelled",
      sql: `SELECT count(*) AS n FROM core_event
             WHERE event_id = :event_id AND status != 'cancelled'
               AND deleted_at IS NULL`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "partstat_recorded",
      sql: `SELECT count(*) AS n FROM schedule_attendee
             WHERE event_id = :event_id AND party_id = :party_id
               AND partstat = :partstat AND responded_at IS NOT NULL`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "idempotent",
  risk: "low",
  handler: respondRsvp,
};

function respondRsvp(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    event_id: string;
    party_id: string;
    partstat: string;
  };
  const attendee = ctx.db
    .prepare(
      "SELECT attendee_id, partstat FROM schedule_attendee WHERE event_id = ? AND party_id = ?"
    )
    .get(input.event_id, input.party_id) as
    | { attendee_id: string; partstat: string }
    | undefined;
  if (!attendee) throw new Error("attendee vanished between check and execute");
  ctx.db
    .prepare(
      "UPDATE schedule_attendee SET partstat = ?, responded_at = ? WHERE attendee_id = ?"
    )
    .run(input.partstat, ctx.now, attendee.attendee_id);
  ctx.wrote("schedule.attendee", attendee.attendee_id);
  ctx.cite({
    claim: `RSVP moved ${attendee.partstat} → ${input.partstat} for event ${input.event_id}`,
    entityType: "schedule.attendee",
    entityId: attendee.attendee_id,
  });
  return { attendee_id: attendee.attendee_id, partstat: input.partstat };
}

const CANCEL_EVENT: CommandDefinition = {
  name: "schedule.cancel_event",
  ownerSchema: "schedule",
  inputSchema: {
    type: "object",
    required: ["event_id"],
    additionalProperties: false,
    properties: { event_id: { type: "string", minLength: 1 } },
  },
  outputSchema: {
    type: "object",
    required: ["event_id", "sequence"],
    properties: { event_id: { type: "string" }, sequence: { type: "integer" } },
  },
  preconditions: [
    {
      name: "event_exists_not_cancelled",
      sql: `SELECT count(*) AS n FROM core_event
             WHERE event_id = :event_id AND status != 'cancelled'
               AND deleted_at IS NULL`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      // RFC 5545: cancellation is a revision of the same identity, so
      // attendees' clients see a SEQUENCE bump, never a silent vanish.
      name: "cancelled_at_new_sequence",
      sql: `SELECT count(*) AS n FROM core_event
             WHERE event_id = :event_id AND status = 'cancelled' AND sequence = :sequence`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "retry-safe",
  // Like reschedule_event: restates a commitment others may hold — above
  // routine upkeep, so apps (ceiling low) park it for the owner.
  risk: "medium",
  // Parking rides `confirm` alone (see CommandDefinition.risk) — the
  // comment above always intended this command to park; without the flag
  // the cancellation executed immediately under the install-time grant.
  confirm: true,
  handler: cancelEvent,
};

function cancelEvent(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { event_id: string };
  const current = ctx.db
    .prepare("SELECT sequence FROM core_event WHERE event_id = ?")
    .get(input.event_id) as { sequence: number } | undefined;
  if (!current)
    throw new Error(
      `event ${input.event_id} vanished between check and execute`
    );
  const sequence = current.sequence + 1;
  ctx.db
    .prepare(
      `UPDATE core_event SET status = 'cancelled', sequence = ?, updated_at = ? WHERE event_id = ?`
    )
    .run(sequence, ctx.now, input.event_id);
  ctx.wrote("core.event", input.event_id);
  queueProviderWriteback(ctx, "core.event", input.event_id, ["status"]);
  ctx.cite({
    claim: `event ${input.event_id} cancelled as revision ${sequence}`,
    entityType: "core.event",
    entityId: input.event_id,
  });
  return { event_id: input.event_id, sequence };
}

/** ~30-day grace before the lifecycle sweep purges — the window every other
 *  app already carries (#883, ruling O-trash). */
const EVENT_PURGE_DAYS = 30;

export function eventPurgeAt(now: string): string {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() + EVENT_PURGE_DAYS);
  return date.toISOString();
}

/**
 * Agenda's delete, which until #883 did not exist: cancelling an event is an
 * iCalendar STATUS revision that attendees see, not a removal, so a member who
 * wanted a mistaken entry GONE had nothing to reach for. Ruling O-trash gives
 * Agenda the same reversible delete its neighbours carry rather than a second
 * law for one gesture; `cancel_event` keeps its own, different meaning.
 */
const DELETE_EVENT: CommandDefinition = {
  name: "schedule.delete_event",
  ownerSchema: "schedule",
  inputSchema: {
    type: "object",
    required: ["event_id"],
    additionalProperties: false,
    properties: { event_id: { type: "string", minLength: 1 } },
  },
  outputSchema: {
    type: "object",
    required: ["event_id", "purge_at"],
    properties: { event_id: { type: "string" }, purge_at: { type: "string" } },
  },
  preconditions: [
    {
      name: "event_live",
      sql: `SELECT count(*) AS n FROM core_event
             WHERE event_id = :event_id AND deleted_at IS NULL`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "event_trashed",
      sql: `SELECT count(*) AS n FROM core_event
             WHERE event_id = :event_id AND deleted_at IS NOT NULL
               AND purge_at IS NOT NULL`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "once",
  risk: "medium",
  handler: (ctx) => {
    const input = ctx.input as { event_id: string };
    const purgeAt = eventPurgeAt(ctx.now);
    ctx.db
      .prepare(
        `UPDATE core_event SET deleted_at = ?, purge_at = ?, updated_at = ?
          WHERE event_id = ?`
      )
      .run(ctx.now, purgeAt, ctx.now, input.event_id);
    ctx.wrote("core.event", input.event_id);
    ctx.cite({
      claim: `event ${input.event_id} moved to trash`,
      entityType: "core.event",
      entityId: input.event_id,
    });
    return { event_id: input.event_id, purge_at: purgeAt };
  },
};

const RESTORE_EVENT: CommandDefinition = {
  name: "schedule.restore_event",
  ownerSchema: "schedule",
  inputSchema: {
    type: "object",
    required: ["event_id"],
    additionalProperties: false,
    properties: { event_id: { type: "string", minLength: 1 } },
  },
  outputSchema: {
    type: "object",
    required: ["event_id"],
    properties: { event_id: { type: "string" } },
  },
  preconditions: [
    {
      name: "event_trashed",
      // RESTORE REFUSES A LAPSED WINDOW (#916, review 1.5).
      sql: `SELECT count(*) AS n FROM core_event
             WHERE event_id = :event_id AND deleted_at IS NOT NULL
               AND (purge_at IS NULL OR purge_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "event_live_again",
      sql: `SELECT count(*) AS n FROM core_event
             WHERE event_id = :event_id AND deleted_at IS NULL
               AND purge_at IS NULL`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "idempotent",
  risk: "low",
  handler: (ctx) => {
    const input = ctx.input as { event_id: string };
    ctx.db
      .prepare(
        `UPDATE core_event SET deleted_at = NULL, purge_at = NULL, updated_at = ?
          WHERE event_id = ?`
      )
      .run(ctx.now, input.event_id);
    ctx.wrote("core.event", input.event_id);
    return { event_id: input.event_id };
  },
};

export function registerScheduleCommands(gateway: Gateway): void {
  gateway.registerCommand(PROPOSE_EVENT);
  gateway.registerCommand(RESCHEDULE_EVENT);
  gateway.registerCommand(RESPOND_RSVP);
  gateway.registerCommand(CANCEL_EVENT);
  gateway.registerCommand(DELETE_EVENT);
  gateway.registerCommand(RESTORE_EVENT);
  registerScheduleOrganizeCommands(gateway);
}
