// Bookings (schedule §11): the self-employed loop's missing front door.
// set_availability declares when you take work; request_booking is the
// inbound ask — and because an app can't commit your calendar unilaterally,
// it is risk=medium, so when a booking app invokes it the request PARKS for
// your confirmation. Approving the parked invocation lands a *tentative*
// hold; confirm_booking promotes it to confirmed. A confirmed booking with a
// client attendee is where this chains into Studio (log time against it,
// then invoice). Timezone handling is deliberately simple in v1: window
// times are compared against the slot's wall-clock components — good enough
// for a single-operator calendar, revisited when multi-tz sharing lands.

import type { Gateway } from '../gateway/gateway.js';
import type { CommandDefinition, HandlerCtx } from '../gateway/types.js';

const SET_AVAILABILITY: CommandDefinition = {
  name: 'schedule.set_availability',
  ownerSchema: 'schedule',
  inputSchema: {
    type: 'object',
    required: ['weekday_mask', 'window_start', 'window_end', 'tz'],
    additionalProperties: false,
    properties: {
      // 7-bit mask, Monday = bit 0 … Sunday = bit 6.
      weekday_mask: { type: 'integer', minimum: 1, maximum: 127 },
      window_start: { type: 'string', minLength: 1 },
      window_end: { type: 'string', minLength: 1 },
      kind: { type: 'string', enum: ['work', 'focus', 'personal', 'blocked'] },
      tz: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['rule_id'],
    properties: { rule_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'window_is_positive',
      sql: 'SELECT (:window_end > :window_start) AS n',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'rule_created',
      sql: 'SELECT count(*) AS n FROM schedule_availability_rule WHERE rule_id = :rule_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: setAvailability,
};

function setAvailability(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    weekday_mask: number;
    window_start: string;
    window_end: string;
    kind?: string;
    tz: string;
  };
  const owner = ctx.db.prepare('SELECT owner_party_id FROM core_vault LIMIT 1').get() as
    | { owner_party_id: string | null }
    | undefined;
  if (!owner?.owner_party_id) throw new Error('vault has no owner');
  const ruleId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO schedule_availability_rule (rule_id, owner_party_id, weekday_mask, window_start, window_end, kind, tz)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ruleId,
      owner.owner_party_id,
      input.weekday_mask,
      input.window_start,
      input.window_end,
      input.kind ?? 'work',
      input.tz,
    );
  ctx.wrote('schedule.availability_rule', ruleId);
  return { rule_id: ruleId };
}

const REMOVE_AVAILABILITY: CommandDefinition = {
  name: 'schedule.remove_availability',
  ownerSchema: 'schedule',
  inputSchema: {
    type: 'object',
    required: ['rule_id'],
    additionalProperties: false,
    properties: { rule_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['rule_id'],
    properties: { rule_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'rule_exists',
      sql: 'SELECT count(*) AS n FROM schedule_availability_rule WHERE rule_id = :rule_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'rule_removed',
      sql: 'SELECT count(*) AS n FROM schedule_availability_rule WHERE rule_id = :rule_id',
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  idempotency: 'once',
  // Like set_availability: shapes what can be *requested* going forward, but
  // destroys no existing booking — the owner pruning their own calendar rules.
  risk: 'low',
  handler: removeAvailability,
};

function removeAvailability(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { rule_id: string };
  ctx.db.prepare('DELETE FROM schedule_availability_rule WHERE rule_id = ?').run(input.rule_id);
  ctx.wrote('schedule.availability_rule', input.rule_id);
  return { rule_id: input.rule_id };
}

/** 'HH:MM' from an ISO datetime; the window comparison is wall-clock in v1. */
function wallClock(iso: string): string {
  const t = iso.indexOf('T');
  return t === -1 ? '' : iso.slice(t + 1, t + 6);
}

/** Monday-first weekday bit for an ISO datetime. */
function weekdayBit(iso: string): number {
  const day = new Date(iso).getUTCDay(); // 0 = Sunday
  return 1 << ((day + 6) % 7); // Monday = bit 0
}

const REQUEST_BOOKING: CommandDefinition = {
  name: 'schedule.request_booking',
  ownerSchema: 'schedule',
  inputSchema: {
    type: 'object',
    required: ['calendar_id', 'summary', 'dtstart', 'dtend', 'requester_party_id'],
    additionalProperties: false,
    properties: {
      calendar_id: { type: 'string', minLength: 1 },
      summary: { type: 'string', minLength: 1 },
      dtstart: { type: 'string', minLength: 1 },
      dtend: { type: 'string', minLength: 1 },
      requester_party_id: { type: 'string', minLength: 1 },
      description: { type: 'string' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['event_id', 'status'],
    properties: { event_id: { type: 'string' }, status: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'calendar_exists',
      sql: 'SELECT count(*) AS n FROM schedule_calendar WHERE calendar_id = :calendar_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      name: 'requester_exists',
      sql: 'SELECT count(*) AS n FROM core_party WHERE party_id = :requester_party_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      name: 'dtend_after_dtstart',
      sql: 'SELECT (:dtend > :dtstart) AS n',
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      // No double-booking against an existing busy hold.
      name: 'no_busy_conflict',
      sql: `SELECT count(*) AS n
              FROM core_event e JOIN schedule_event_ext x ON x.event_id = e.event_id
             WHERE x.busy = 'busy' AND e.status != 'cancelled'
               AND e.dtstart < :dtend AND (e.dtend IS NULL OR e.dtend > :dtstart)`,
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  postconditions: [
    {
      name: 'booking_held_tentative',
      sql: `SELECT count(*) AS n FROM core_event WHERE event_id = :event_id AND status = 'tentative'`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  // An app can't seize the owner's calendar for a client — the request waits.
  risk: 'medium',
  handler: requestBooking,
};

function requestBooking(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    calendar_id: string;
    summary: string;
    dtstart: string;
    dtend: string;
    requester_party_id: string;
    description?: string;
  };
  // Availability is enforced here, not in SQL: the weekday-mask bit test and
  // wall-clock window comparison are clearer (and testable) in JS.
  const bit = weekdayBit(input.dtstart);
  const start = wallClock(input.dtstart);
  const end = wallClock(input.dtend);
  const open = ctx.db
    .prepare(
      `SELECT count(*) AS n FROM schedule_availability_rule
        WHERE kind = 'work' AND (weekday_mask & ?) != 0
          AND window_start <= ? AND window_end >= ?`,
    )
    .get(bit, start, end) as { n: number };
  if (open.n === 0) throw new Error('requested slot is outside your availability');

  const owner = ctx.db.prepare('SELECT owner_party_id FROM core_vault LIMIT 1').get() as
    | { owner_party_id: string | null }
    | undefined;
  const eventId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_event
         (event_id, ical_uid, summary, description, dtstart, dtend, start_tz, rrule, status,
          location_place_id, organizer_party_id, sequence, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, ?, NULL, NULL, 'tentative', NULL, ?, 0, ?, ?)`,
    )
    .run(
      eventId,
      input.summary,
      input.description ?? null,
      input.dtstart,
      input.dtend,
      owner?.owner_party_id ?? null,
      ctx.now,
      ctx.now,
    );
  ctx.wrote('core.event', eventId);
  ctx.db
    .prepare(
      `INSERT INTO schedule_event_ext
         (event_ext_id, event_id, calendar_id, busy, conferencing_uri, reminders_json, travel_buffer_min)
       VALUES (?, ?, ?, 'busy', NULL, NULL, NULL)`,
    )
    .run(ctx.newId(), eventId, input.calendar_id);
  ctx.wrote('schedule.event_ext', eventId);
  const attendeeId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO schedule_attendee (attendee_id, event_id, party_id, role, partstat, responded_at)
       VALUES (?, ?, ?, 'required', 'accepted', ?)`,
    )
    .run(attendeeId, eventId, input.requester_party_id, ctx.now);
  ctx.wrote('schedule.attendee', attendeeId);
  ctx.cite({
    claim: `booking held tentatively for ${input.requester_party_id} in [${input.dtstart}, ${input.dtend})`,
    entityType: 'core.event',
    entityId: eventId,
  });
  return { event_id: eventId, status: 'tentative' };
}

const CONFIRM_BOOKING: CommandDefinition = {
  name: 'schedule.confirm_booking',
  ownerSchema: 'schedule',
  inputSchema: {
    type: 'object',
    required: ['event_id'],
    additionalProperties: false,
    properties: { event_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['event_id', 'status'],
    properties: { event_id: { type: 'string' }, status: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'booking_is_tentative',
      sql: `SELECT count(*) AS n FROM core_event WHERE event_id = :event_id AND status = 'tentative'`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'booking_confirmed',
      sql: `SELECT count(*) AS n FROM core_event WHERE event_id = :event_id AND status = 'confirmed'`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: confirmBooking,
};

function confirmBooking(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { event_id: string };
  ctx.db
    .prepare(`UPDATE core_event SET status = 'confirmed', updated_at = ? WHERE event_id = ?`)
    .run(ctx.now, input.event_id);
  ctx.wrote('core.event', input.event_id);
  ctx.cite({
    claim: `booking ${input.event_id} confirmed`,
    entityType: 'core.event',
    entityId: input.event_id,
  });
  return { event_id: input.event_id, status: 'confirmed' };
}

/** Register the booking commands on a gateway. */
export function registerBookingCommands(gateway: Gateway): void {
  gateway.registerCommand(SET_AVAILABILITY);
  gateway.registerCommand(REMOVE_AVAILABILITY);
  gateway.registerCommand(REQUEST_BOOKING);
  gateway.registerCommand(CONFIRM_BOOKING);
}
