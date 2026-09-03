import type { CommandDefinition, HandlerCtx } from "../gateway/types.js";

const STRING = { type: "string", minLength: 1 } as const;

export const SAVE_PROJECT: CommandDefinition = {
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
    .prepare("SELECT self_party_id FROM core_vault LIMIT 1")
    .get() as { self_party_id: string };
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
      owner.self_party_id,
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

export const SAVE_SECTION: CommandDefinition = {
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

export const ORGANIZE_TASK: CommandDefinition = {
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
      clear_section: { type: "boolean", const: true },
      sort_order: { type: "integer" },
      recurrence_anchor: {
        type: "string",
        enum: ["scheduled", "completion"],
      },
      tz: STRING,
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
    clear_section?: boolean;
    sort_order: number;
    recurrence_anchor?: string;
    tz?: string;
  };
  const clearProject = input.clear_project === true;
  const clearSection = clearProject || input.clear_section === true;
  ctx.db
    .prepare(
      `UPDATE schedule_task
          SET project_id = CASE
                WHEN ? THEN NULL
                ELSE COALESCE(?, project_id)
              END,
              section_id = CASE
                WHEN ? THEN NULL
                ELSE COALESCE(?, section_id)
              END,
              sort_order = ?,
              recurrence_anchor = COALESCE(?, recurrence_anchor),
              tz = COALESCE(?, tz)
        WHERE task_id = ?`
    )
    .run(
      clearProject ? 1 : 0,
      input.project_id ?? null,
      clearSection ? 1 : 0,
      input.section_id ?? null,
      input.sort_order,
      input.recurrence_anchor ?? null,
      input.tz ?? null,
      input.task_id
    );
  ctx.wrote("schedule.task", input.task_id);
  return { task_id: input.task_id };
}
