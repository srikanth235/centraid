import { canonicalizeRrule, expandRecurrence } from "@centraid/core/time";
import type { RecurrenceSemantics } from "@centraid/core/time";

import type { Gateway } from "../gateway/gateway.js";
import type { CommandDefinition, HandlerCtx } from "../gateway/types.js";
import { queueProviderWriteback } from "./provider-writeback.js";
import {
  ORGANIZE_TASK,
  SAVE_PROJECT,
  SAVE_SECTION,
} from "./schedule-projects.js";

const STRING = { type: "string", minLength: 1 } as const;

interface EventEditInput {
  event_id: string;
  summary?: string;
  description?: string;
  clear_description?: boolean;
  dtstart?: string;
  dtend?: string;
  start_tz?: string;
  end_tz?: string;
  recurrence_semantics?: string;
  rrule?: string;
  clear_rrule?: boolean;
  calendar_id?: string;
  location_place_id?: string;
  clear_location?: boolean;
  conferencing_uri?: string;
  clear_conferencing?: boolean;
  reminders?: { minutes_before: number }[];
  attendee_party_ids?: string[];
}

const EDIT_EVENT: CommandDefinition = {
  name: "schedule.edit_event",
  ownerSchema: "schedule",
  inputSchema: {
    type: "object",
    required: ["event_id"],
    additionalProperties: false,
    properties: {
      event_id: STRING,
      summary: STRING,
      description: { type: "string" },
      clear_description: { type: "boolean", const: true },
      dtstart: STRING,
      dtend: STRING,
      start_tz: STRING,
      end_tz: STRING,
      recurrence_semantics: {
        type: "string",
        enum: ["zoned", "floating", "all-day"],
      },
      rrule: STRING,
      clear_rrule: { type: "boolean", const: true },
      calendar_id: STRING,
      location_place_id: STRING,
      clear_location: { type: "boolean", const: true },
      conferencing_uri: STRING,
      clear_conferencing: { type: "boolean", const: true },
      reminders: {
        type: "array",
        items: {
          type: "object",
          required: ["minutes_before"],
          additionalProperties: false,
          properties: { minutes_before: { type: "integer", minimum: 0 } },
        },
      },
      attendee_party_ids: { type: "array", items: STRING },
    },
  },
  outputSchema: {
    type: "object",
    required: ["event_id", "sequence"],
    properties: { event_id: STRING, sequence: { type: "integer" } },
  },
  preconditions: [
    {
      name: "event_exists",
      sql: "SELECT count(*) AS n FROM core_event WHERE event_id = :event_id",
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      name: "event_end_after_start",
      sql: `SELECT CASE WHEN :dtend IS NULL THEN 1
                   WHEN :dtstart IS NOT NULL THEN (:dtend > :dtstart)
                   ELSE (:dtend > (SELECT dtstart FROM core_event WHERE event_id = :event_id))
              END AS n`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "event_revision_advanced",
      sql: "SELECT count(*) AS n FROM core_event WHERE event_id = :event_id AND sequence = :sequence",
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "idempotent",
  risk: "medium",
  confirm: true,
  handler: editEvent,
};

function eventSeries(
  ctx: HandlerCtx,
  eventId: string
): {
  rrule: string | null;
  dtstart: string;
  startTz: string | null;
  semantics: RecurrenceSemantics;
} {
  const row = ctx.db
    .prepare(
      "SELECT rrule, dtstart, start_tz, recurrence_semantics FROM core_event WHERE event_id = ?"
    )
    .get(eventId) as
    | {
        rrule: string | null;
        dtstart: string;
        start_tz: string | null;
        recurrence_semantics: string | null;
      }
    | undefined;
  if (!row) throw new Error(`no event ${eventId}`);
  return {
    rrule: row.rrule,
    dtstart: row.dtstart,
    startTz: row.start_tz,
    semantics: (row.recurrence_semantics ?? "zoned") as RecurrenceSemantics,
  };
}

function occurrenceWallStart(
  ctx: HandlerCtx,
  eventId: string,
  instant: string
): string | null {
  const series = eventSeries(ctx, eventId);
  if (!series.rrule) return null;
  const at = Date.parse(instant);
  if (Number.isNaN(at)) return null;
  return (
    expandRecurrence({
      rrule: series.rrule,
      start: series.dtstart,
      rangeFrom: instant,
      rangeTo: new Date(at + 86_400_000).toISOString(),
      ...(series.startTz === null ? {} : { timeZone: series.startTz }),
      semantics: series.semantics,
      maxInstances: 4,
    }).find(
      (item) => item.originalStart === instant || item.wallStart === instant
    )?.wallStart ?? null
  );
}

function strandedExceptions(ctx: HandlerCtx, eventId: string): number {
  const rows = ctx.db
    .prepare(
      `SELECT original_start_local FROM schedule_recurrence_exception
        WHERE target_type = 'core.event' AND target_id = ? AND scope = 'occurrence'`
    )
    .all(eventId) as { original_start_local: string }[];
  if (rows.length === 0) return 0;
  const series = eventSeries(ctx, eventId);
  if (!series.rrule) return rows.length;
  const stamps = rows.map((row) => row.original_start_local).sort();
  const live = new Set(
    expandRecurrence({
      rrule: series.rrule,
      start: series.dtstart,
      rangeFrom: stamps[0] as string,
      rangeTo: new Date(
        Date.parse(stamps.at(-1) as string) + 86_400_000
      ).toISOString(),
      ...(series.startTz === null ? {} : { timeZone: series.startTz }),
      semantics: series.semantics,
      maxInstances: 1000,
    }).map((item) => item.wallStart)
  );
  return stamps.filter((stamp) => !live.has(stamp)).length;
}

function assertNoStrandedExceptions(ctx: HandlerCtx, eventId: string): void {
  const stranded = strandedExceptions(ctx, eventId);
  if (stranded > 0)
    throw new Error(
      `this change to the series leaves ${stranded} occurrence exception(s) matching nothing: remove or re-anchor them first`
    );
}

function editEvent(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as unknown as EventEditInput;
  const previous = ctx.db
    .prepare("SELECT sequence FROM core_event WHERE event_id = ?")
    .get(input.event_id) as { sequence: number };
  const coreColumns = new Map<string, string | null | undefined>([
    ["summary", input.summary],
    ["dtstart", input.dtstart],
    ["dtend", input.dtend],
    ["start_tz", input.start_tz],
    ["end_tz", input.end_tz],
    ["recurrence_semantics", input.recurrence_semantics],
    [
      "rrule",
      input.clear_rrule
        ? null
        : input.rrule === undefined
          ? undefined
          : canonicalizeRrule(input.rrule),
    ],
    ["description", input.clear_description ? null : input.description],
    [
      "location_place_id",
      input.clear_location ? null : input.location_place_id,
    ],
  ]);
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [column, value] of coreColumns) {
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(value);
  }
  const sequence = previous.sequence + 1;
  sets.push("sequence = ?", "updated_at = ?");
  values.push(sequence, ctx.now, input.event_id);
  if (input.clear_rrule) {
    const orphaned = ctx.db
      .prepare(
        `SELECT count(*) AS n FROM schedule_recurrence_exception
          WHERE target_type = 'core.event' AND target_id = ?`
      )
      .get(input.event_id) as { n: number };
    if (orphaned.n > 0)
      throw new Error(
        `this event has ${orphaned.n} occurrence exception(s): remove them before dropping its recurrence`
      );
  }
  ctx.db
    .prepare(`UPDATE core_event SET ${sets.join(", ")} WHERE event_id = ?`)
    .run(...values);
  ctx.wrote("core.event", input.event_id);
  assertNoStrandedExceptions(ctx, input.event_id);

  updateEventExtension(ctx, input);
  replaceAttendees(ctx, input);
  queueProviderWriteback(
    ctx,
    "core.event",
    input.event_id,
    [
      input.summary === undefined ? null : "summary",
      input.description === undefined && !input.clear_description
        ? null
        : "description",
      input.dtstart === undefined ? null : "start",
      input.dtend === undefined ? null : "end",
      input.rrule === undefined && !input.clear_rrule ? null : "recurrence",
    ].filter((field): field is string => field !== null)
  );
  return { event_id: input.event_id, sequence };
}

function updateEventExtension(ctx: HandlerCtx, input: EventEditInput): void {
  const updates = new Map<string, string | null | undefined>([
    ["calendar_id", input.calendar_id],
    [
      "conferencing_uri",
      input.clear_conferencing ? null : input.conferencing_uri,
    ],
    [
      "reminders_json",
      input.reminders === undefined
        ? undefined
        : JSON.stringify(input.reminders),
    ],
  ]);
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [column, value] of updates) {
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(value);
  }
  if (sets.length === 0) return;
  values.push(input.event_id);
  ctx.db
    .prepare(
      `UPDATE schedule_event_ext SET ${sets.join(", ")} WHERE event_id = ?`
    )
    .run(...values);
  ctx.wrote("schedule.event_ext", input.event_id);
}

function replaceAttendees(ctx: HandlerCtx, input: EventEditInput): void {
  if (!input.attendee_party_ids) return;
  ctx.db
    .prepare(
      "DELETE FROM schedule_attendee WHERE event_id = ? AND role != 'chair'"
    )
    .run(input.event_id);
  for (const partyId of input.attendee_party_ids) {
    const attendeeId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO schedule_attendee
          (attendee_id, event_id, party_id, role, partstat, responded_at)
         VALUES (?, ?, ?, 'required', 'needs-action', NULL)`
      )
      .run(attendeeId, input.event_id, partyId);
    ctx.wrote("schedule.attendee", attendeeId);
  }
}

const EDIT_OCCURRENCE: CommandDefinition = {
  name: "schedule.edit_event_occurrence",
  ownerSchema: "schedule",
  inputSchema: {
    type: "object",
    required: ["event_id", "original_start", "scope", "action"],
    additionalProperties: false,
    properties: {
      event_id: STRING,
      original_start: STRING,
      scope: { type: "string", enum: ["occurrence", "future", "series"] },
      action: { type: "string", enum: ["skip", "override"] },
      dtstart: STRING,
      dtend: STRING,
      summary: STRING,
      description: { type: "string" },
      recurrence_semantics: {
        type: "string",
        enum: ["zoned", "floating", "all-day"],
      },
      calendar_id: STRING,
      reminders: {
        type: "array",
        items: {
          type: "object",
          required: ["minutes_before"],
          additionalProperties: false,
          properties: { minutes_before: { type: "integer", minimum: 0 } },
        },
      },
      conferencing_uri: { type: "string" },
      attendee_party_ids: { type: "array", items: STRING },
    },
  },
  outputSchema: {
    type: "object",
    required: ["event_id", "scope"],
    properties: { event_id: STRING, scope: { type: "string" } },
  },
  preconditions: [
    {
      name: "recurring_event_exists",
      sql: "SELECT count(*) AS n FROM core_event WHERE event_id = :event_id AND rrule IS NOT NULL",
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [],
  idempotency: "idempotent",
  risk: "medium",
  confirm: true,
  handler: editOccurrence,
};

function occurrenceOverrideJson(input: {
  scope: "occurrence" | "future" | "series";
  action: "skip" | "override";
  dtstart?: string;
  dtend?: string;
  summary?: string;
  description?: string;
  recurrence_semantics?: string;
  calendar_id?: string;
  reminders?: { minutes_before: number }[];
  conferencing_uri?: string;
  attendee_party_ids?: string[];
}): string | null {
  if (input.action === "skip") return null;
  const override: Record<string, unknown> = { scope: input.scope };
  if (input.dtstart !== undefined) override.start = input.dtstart;
  if (input.dtend !== undefined) override.end = input.dtend;
  if (input.summary !== undefined) override.summary = input.summary;
  if (input.description !== undefined) override.description = input.description;
  if (input.recurrence_semantics !== undefined)
    override.recurrence_semantics = input.recurrence_semantics;
  if (input.calendar_id !== undefined) override.calendar_id = input.calendar_id;
  if (input.reminders !== undefined) override.reminders = input.reminders;
  if (input.conferencing_uri !== undefined)
    override.conferencing_uri = input.conferencing_uri;
  if (input.attendee_party_ids !== undefined)
    override.attendee_party_ids = input.attendee_party_ids;
  return JSON.stringify(override);
}

function editOccurrence(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    event_id: string;
    original_start: string;
    scope: "occurrence" | "future" | "series";
    action: "skip" | "override";
    dtstart?: string;
    dtend?: string;
    summary?: string;
    description?: string;
    recurrence_semantics?: string;
    calendar_id?: string;
    reminders?: { minutes_before: number }[];
    conferencing_uri?: string;
    attendee_party_ids?: string[];
  };
  if (input.scope === "series") {
    if (input.action === "skip") {
      const current = ctx.db
        .prepare("SELECT sequence, status FROM core_event WHERE event_id = ?")
        .get(input.event_id) as { sequence: number; status: string };
      if (current.status === "cancelled") {
        return { event_id: input.event_id, scope: input.scope };
      }
      const sequence = current.sequence + 1;
      ctx.db
        .prepare(
          `UPDATE core_event
              SET status = 'cancelled', sequence = ?, updated_at = ?
            WHERE event_id = ?`
        )
        .run(sequence, ctx.now, input.event_id);
      ctx.wrote("core.event", input.event_id);
      queueProviderWriteback(ctx, "core.event", input.event_id, ["status"]);
      ctx.cite({
        claim: `cancelled series as revision ${sequence}`,
        entityType: "core.event",
        entityId: input.event_id,
      });
      return { event_id: input.event_id, scope: input.scope, sequence };
    }
    const updates = [
      ["dtstart", input.dtstart],
      ["dtend", input.dtend],
      ["summary", input.summary],
      ["description", input.description],
    ].filter((entry): entry is [string, string] => entry[1] !== undefined);
    if (updates.length > 0) {
      ctx.db
        .prepare(
          `UPDATE core_event SET ${updates.map(([column]) => `${column} = ?`).join(", ")},
             sequence = sequence + 1, updated_at = ? WHERE event_id = ?`
        )
        .run(...updates.map(([, value]) => value), ctx.now, input.event_id);
      ctx.wrote("core.event", input.event_id);
      assertNoStrandedExceptions(ctx, input.event_id);
      queueProviderWriteback(
        ctx,
        "core.event",
        input.event_id,
        updates.map(([column]) =>
          column === "dtstart"
            ? "start"
            : column === "dtend"
              ? "end"
              : column === "rrule"
                ? "recurrence"
                : column
        )
      );
    }
    return { event_id: input.event_id, scope: input.scope };
  }
  const wallStart = occurrenceWallStart(
    ctx,
    input.event_id,
    input.original_start
  );
  if (wallStart === null)
    throw new Error("original_start is not an occurrence of this series");
  const override = occurrenceOverrideJson(input);
  const exceptionId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO schedule_recurrence_exception
        (exception_id, target_type, target_id, original_start_local,
         recurrence_semantics, scope, action,
         override_json, created_at, updated_at)
       VALUES (?, 'core.event', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(target_type, target_id, original_start_local, scope) DO UPDATE SET
         action = excluded.action, override_json = excluded.override_json,
         updated_at = excluded.updated_at`
    )
    .run(
      exceptionId,
      input.event_id,
      wallStart,
      eventSeries(ctx, input.event_id).semantics,
      input.scope,
      input.action,
      override,
      ctx.now,
      ctx.now
    );
  ctx.wrote("schedule.recurrence_exception", exceptionId);
  return { event_id: input.event_id, scope: input.scope };
}

export function registerScheduleOrganizeCommands(gateway: Gateway): void {
  for (const command of [
    EDIT_EVENT,
    EDIT_OCCURRENCE,
    SAVE_PROJECT,
    SAVE_SECTION,
    ORGANIZE_TASK,
  ]) {
    gateway.registerCommand(command);
  }
}
