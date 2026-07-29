import type { Gateway } from "../gateway/gateway.js";
import type { CommandDefinition, HandlerCtx } from "../gateway/types.js";

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
  handler: editEvent,
};

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
    ["rrule", input.clear_rrule ? null : input.rrule],
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
  ctx.db
    .prepare(`UPDATE core_event SET ${sets.join(", ")} WHERE event_id = ?`)
    .run(...values);
  ctx.wrote("core.event", input.event_id);

  updateEventExtension(ctx, input);
  replaceAttendees(ctx, input);
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
  risk: "low",
  handler: editOccurrence,
};

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
  };
  if (input.scope === "series") {
    const updates = [
      ["dtstart", input.dtstart],
      ["dtend", input.dtend],
      ["summary", input.summary],
      ["description", input.description],
    ].filter((entry): entry is [string, string] => entry[1] !== undefined);
    if (input.action === "skip") updates.push(["status", "cancelled"]);
    if (updates.length > 0) {
      ctx.db
        .prepare(
          `UPDATE core_event SET ${updates.map(([column]) => `${column} = ?`).join(", ")},
             sequence = sequence + 1, updated_at = ? WHERE event_id = ?`
        )
        .run(...updates.map(([, value]) => value), ctx.now, input.event_id);
      ctx.wrote("core.event", input.event_id);
    }
    return { event_id: input.event_id, scope: input.scope };
  }
  const override =
    input.action === "skip"
      ? null
      : JSON.stringify({
          scope: input.scope,
          start: input.dtstart,
          end: input.dtend,
          summary: input.summary,
          description: input.description,
        });
  const exceptionId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO schedule_recurrence_exception
        (exception_id, target_type, target_id, original_start, action,
         override_json, created_at, updated_at)
       VALUES (?, 'core.event', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(target_type, target_id, original_start) DO UPDATE SET
         action = excluded.action, override_json = excluded.override_json,
         updated_at = excluded.updated_at`
    )
    .run(
      exceptionId,
      input.event_id,
      input.original_start,
      input.action,
      override,
      ctx.now,
      ctx.now
    );
  ctx.wrote("schedule.recurrence_exception", exceptionId);
  return { event_id: input.event_id, scope: input.scope };
}

const SAVE_PROJECT: CommandDefinition = {
  name: "schedule.save_project",
  ownerSchema: "schedule",
  inputSchema: {
    type: "object",
    required: ["name"],
    additionalProperties: false,
    properties: {
      project_id: STRING,
      name: STRING,
      area: { type: "string" },
      color: { type: "string" },
      sort_order: { type: "integer" },
    },
  },
  outputSchema: {
    type: "object",
    required: ["project_id"],
    properties: { project_id: STRING },
  },
  preconditions: [],
  postconditions: [],
  idempotency: "idempotent",
  risk: "low",
  handler: saveProject,
};

function saveProject(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    project_id?: string;
    name: string;
    area?: string;
    color?: string;
    sort_order?: number;
  };
  const owner = ctx.db
    .prepare("SELECT owner_party_id FROM core_vault LIMIT 1")
    .get() as { owner_party_id: string };
  const projectId = input.project_id ?? ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO schedule_project
        (project_id, owner_party_id, name, area, color, sort_order,
         archived_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET name = excluded.name,
         area = excluded.area, color = excluded.color,
         sort_order = excluded.sort_order, updated_at = excluded.updated_at`
    )
    .run(
      projectId,
      owner.owner_party_id,
      input.name,
      input.area ?? null,
      input.color ?? null,
      input.sort_order ?? 0,
      ctx.now,
      ctx.now
    );
  ctx.wrote("schedule.project", projectId);
  return { project_id: projectId };
}

const SAVE_SECTION: CommandDefinition = {
  name: "schedule.save_section",
  ownerSchema: "schedule",
  inputSchema: {
    type: "object",
    required: ["project_id", "name"],
    additionalProperties: false,
    properties: {
      section_id: STRING,
      project_id: STRING,
      name: STRING,
      sort_order: { type: "integer" },
    },
  },
  outputSchema: {
    type: "object",
    required: ["section_id"],
    properties: { section_id: STRING },
  },
  preconditions: [],
  postconditions: [],
  idempotency: "idempotent",
  risk: "low",
  handler: saveSection,
};

function saveSection(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    section_id?: string;
    project_id: string;
    name: string;
    sort_order?: number;
  };
  const sectionId = input.section_id ?? ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO schedule_section
        (section_id, project_id, name, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(section_id) DO UPDATE SET project_id = excluded.project_id,
         name = excluded.name, sort_order = excluded.sort_order,
         updated_at = excluded.updated_at`
    )
    .run(
      sectionId,
      input.project_id,
      input.name,
      input.sort_order ?? 0,
      ctx.now,
      ctx.now
    );
  ctx.wrote("schedule.section", sectionId);
  return { section_id: sectionId };
}

const ORGANIZE_TASK: CommandDefinition = {
  name: "schedule.organize_task",
  ownerSchema: "schedule",
  inputSchema: {
    type: "object",
    required: ["task_id", "sort_order"],
    additionalProperties: false,
    properties: {
      task_id: STRING,
      project_id: STRING,
      section_id: STRING,
      clear_project: { type: "boolean", const: true },
      sort_order: { type: "integer" },
      recurrence_anchor: {
        type: "string",
        enum: ["scheduled", "completion"],
      },
      recurrence_tz: STRING,
    },
  },
  outputSchema: {
    type: "object",
    required: ["task_id"],
    properties: { task_id: STRING },
  },
  preconditions: [],
  postconditions: [],
  idempotency: "idempotent",
  risk: "low",
  handler: organizeTask,
};

function organizeTask(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    task_id: string;
    project_id?: string;
    section_id?: string;
    clear_project?: boolean;
    sort_order: number;
    recurrence_anchor?: string;
    recurrence_tz?: string;
  };
  ctx.db
    .prepare(
      `UPDATE schedule_task
          SET project_id = ?, section_id = ?, sort_order = ?,
              recurrence_anchor = COALESCE(?, recurrence_anchor),
              recurrence_tz = COALESCE(?, recurrence_tz)
        WHERE task_id = ?`
    )
    .run(
      input.clear_project ? null : (input.project_id ?? null),
      input.clear_project ? null : (input.section_id ?? null),
      input.sort_order,
      input.recurrence_anchor ?? null,
      input.recurrence_tz ?? null,
      input.task_id
    );
  ctx.wrote("schedule.task", input.task_id);
  return { task_id: input.task_id };
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
