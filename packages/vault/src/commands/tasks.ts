import { nextOccurrence } from "@centraid/core/time";

import type { Gateway } from "../gateway/gateway.js";
import type { CommandDefinition, HandlerCtx } from "../gateway/types.js";

const ADD_TASK: CommandDefinition = {
  name: "schedule.add_task",
  ownerSchema: "schedule",
  inputSchema: {
    type: "object",
    required: ["title"],
    additionalProperties: false,
    properties: {
      title: { type: "string", minLength: 1 },
      description: { type: "string", minLength: 1 },
      due_at: { type: "string", minLength: 1 },
      priority: { type: "integer", minimum: 0, maximum: 9 },
      effort_min: { type: "integer", minimum: 1 },
      parent_task_id: { type: "string", minLength: 1 },
      rrule: { type: "string", minLength: 1 },
      remind_before_min: { type: "integer", minimum: 0 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["task_id"],
    properties: { task_id: { type: "string" } },
  },
  preconditions: [
    {
      name: "parent_open_and_top_level",
      sql: `SELECT CASE WHEN :parent_task_id IS NULL THEN 1
                   ELSE (SELECT count(*) FROM schedule_task
                          WHERE task_id = :parent_task_id
                            AND parent_task_id IS NULL
                            AND deleted_at IS NULL
                            AND status IN ('needs-action','in-process'))
              END AS n`,
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      name: "rrule_requires_due_at",
      sql: "SELECT (:rrule IS NULL OR :due_at IS NOT NULL) AS n",
      column: "n",
      op: "eq",
      value: 1,
      message: "A repeating task needs a due date to repeat from.",
    },
    {
      name: "reminder_requires_due_at",
      sql: "SELECT (:remind_before_min IS NULL OR :due_at IS NOT NULL) AS n",
      column: "n",
      op: "eq",
      value: 1,
      message: "A reminder needs a due date to count back from.",
    },
  ],
  postconditions: [
    {
      name: "task_created_open",
      sql: `SELECT count(*) AS n FROM schedule_task
             WHERE task_id = :task_id AND status = 'needs-action' AND completed_at IS NULL`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "once",
  risk: "low",
  handler: addTask,
};

function addTask(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    title: string;
    description?: string;
    due_at?: string;
    priority?: number;
    effort_min?: number;
    parent_task_id?: string;
    rrule?: string;
    remind_before_min?: number;
  };
  const owner = ctx.db
    .prepare("SELECT self_party_id FROM core_vault LIMIT 1")
    .get() as { self_party_id: string | null } | undefined;
  if (!owner?.self_party_id) throw new Error("vault has no owner");
  const taskId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO schedule_task
         (task_id, owner_party_id, title, description, status, priority, due_at, completed_at, effort_min, parent_task_id, rrule, remind_before_min)
       VALUES (?, ?, ?, ?, 'needs-action', ?, ?, NULL, ?, ?, ?, ?)`
    )
    .run(
      taskId,
      owner.self_party_id,
      input.title,
      input.description ?? null,
      input.priority ?? 0,
      input.due_at ?? null,
      input.effort_min ?? null,
      input.parent_task_id ?? null,
      input.rrule ?? null,
      input.remind_before_min ?? null
    );
  ctx.wrote("schedule.task", taskId);
  return { task_id: taskId };
}

const SET_TASK_STATUS: CommandDefinition = {
  name: "schedule.set_task_status",
  ownerSchema: "schedule",
  inputSchema: {
    type: "object",
    required: ["task_id", "status"],
    additionalProperties: false,
    properties: {
      task_id: { type: "string", minLength: 1 },
      status: {
        type: "string",
        enum: ["needs-action", "in-process", "completed", "cancelled"],
      },
    },
  },
  outputSchema: {
    type: "object",
    required: ["task_id", "status"],
    properties: {
      task_id: { type: "string" },
      status: { type: "string" },
      next_task_id: { type: "string" },
      next_due_at: { type: "string" },
    },
  },
  preconditions: [
    {
      name: "task_exists",
      sql: `SELECT count(*) AS n FROM schedule_task
             WHERE task_id = :task_id AND deleted_at IS NULL`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "status_and_completion_stamp_agree",
      sql: `SELECT count(*) AS n FROM schedule_task
             WHERE task_id = :task_id AND status = :status
               AND ((status = 'completed') = (completed_at IS NOT NULL))`,
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      name: "next_occurrence_spawned_open",
      sql: `SELECT CASE WHEN :next_task_id IS NULL THEN 1
                   ELSE (SELECT count(*) FROM schedule_task
                          WHERE task_id = :next_task_id AND status = 'needs-action'
                            AND completed_at IS NULL AND due_at = :next_due_at)
              END AS n`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "idempotent",
  risk: "low",
  handler: setTaskStatus,
};

function setTaskStatus(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { task_id: string; status: string };
  const previous = ctx.db
    .prepare(
      `SELECT status, owner_party_id, title, description, priority, due_at,
              effort_min, parent_task_id, rrule, remind_before_min, project_id,
              section_id, sort_order, recurrence_anchor, tz
         FROM schedule_task WHERE task_id = ?`
    )
    .get(input.task_id) as
    | {
        status: string;
        owner_party_id: string;
        title: string;
        description: string | null;
        priority: number;
        due_at: string | null;
        effort_min: number | null;
        parent_task_id: string | null;
        rrule: string | null;
        remind_before_min: number | null;
        project_id: string | null;
        section_id: string | null;
        sort_order: number;
        recurrence_anchor: "scheduled" | "completion";
        tz: string | null;
      }
    | undefined;
  if (!previous) throw new Error("task vanished between check and execute");
  ctx.db
    .prepare(
      "UPDATE schedule_task SET status = ?, completed_at = ? WHERE task_id = ?"
    )
    .run(
      input.status,
      input.status === "completed" ? ctx.now : null,
      input.task_id
    );
  ctx.wrote("schedule.task", input.task_id);
  ctx.cite({
    claim: `task moved ${previous.status} → ${input.status}`,
    entityType: "schedule.task",
    entityId: input.task_id,
  });
  const output: Record<string, unknown> = {
    task_id: input.task_id,
    status: input.status,
  };
  if (input.status === "completed" && previous.rrule && previous.due_at) {
    const nextDue = nextOccurrence({
      rrule: previous.rrule,
      scheduledStart: previous.due_at,
      after:
        previous.recurrence_anchor === "completion" ? ctx.now : previous.due_at,
      timeZone: previous.tz ?? "Etc/UTC",
      anchor: previous.recurrence_anchor,
    });
    if (nextDue) {
      const nextTaskId = ctx.newId();
      ctx.db
        .prepare(
          `INSERT INTO schedule_task
             (task_id, owner_party_id, title, description, status, priority,
              due_at, completed_at, effort_min, parent_task_id, rrule,
              remind_before_min, project_id, section_id, sort_order,
              recurrence_anchor, tz)
           VALUES (?, ?, ?, ?, 'needs-action', ?, ?, NULL, ?, ?, ?, ?,
                   ?, ?, ?, ?, ?)`
        )
        .run(
          nextTaskId,
          previous.owner_party_id,
          previous.title,
          previous.description,
          previous.priority,
          nextDue,
          previous.effort_min,
          previous.parent_task_id,
          previous.rrule,
          previous.remind_before_min,
          previous.project_id,
          previous.section_id,
          previous.sort_order,
          previous.recurrence_anchor,
          previous.tz
        );
      ctx.wrote("schedule.task", nextTaskId);
      ctx.cite({
        claim: `next occurrence of "${previous.title}" spawned at ${nextDue} (${previous.rrule})`,
        entityType: "schedule.task",
        entityId: nextTaskId,
      });
      output.next_task_id = nextTaskId;
      output.next_due_at = nextDue;
    }
  }
  return output;
}

const EDIT_TASK: CommandDefinition = {
  name: "schedule.edit_task",
  ownerSchema: "schedule",
  inputSchema: {
    type: "object",
    required: ["task_id"],
    additionalProperties: false,
    properties: {
      task_id: { type: "string", minLength: 1 },
      title: { type: "string", minLength: 1 },
      description: { type: "string", minLength: 1 },
      clear_description: { type: "boolean", const: true },
      due_at: { type: "string", minLength: 1 },
      clear_due: { type: "boolean", const: true },
      priority: { type: "integer", minimum: 0, maximum: 9 },
      effort_min: { type: "integer", minimum: 1 },
      remind_before_min: { type: "integer", minimum: 0 },
      clear_remind: { type: "boolean", const: true },
      rrule: { type: "string", minLength: 1 },
      clear_rrule: { type: "boolean", const: true },
    },
  },
  outputSchema: {
    type: "object",
    required: ["task_id"],
    properties: { task_id: { type: "string" } },
  },
  preconditions: [
    {
      name: "task_exists",
      sql: `SELECT count(*) AS n FROM schedule_task
             WHERE task_id = :task_id AND deleted_at IS NULL`,
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      name: "due_set_and_clear_are_exclusive",
      sql: "SELECT (:due_at IS NULL OR :clear_due IS NULL) AS n",
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      name: "description_set_and_clear_are_exclusive",
      sql: "SELECT (:description IS NULL OR :clear_description IS NULL) AS n",
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      name: "remind_set_and_clear_are_exclusive",
      sql: "SELECT (:remind_before_min IS NULL OR :clear_remind IS NULL) AS n",
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      name: "rrule_set_and_clear_are_exclusive",
      sql: "SELECT (:rrule IS NULL OR :clear_rrule IS NULL) AS n",
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      name: "rrule_edit_keeps_a_due_at",
      sql: `SELECT CASE WHEN :rrule IS NULL THEN 1
                   ELSE (SELECT CASE WHEN :due_at IS NOT NULL THEN 1
                              ELSE (SELECT count(*) FROM schedule_task
                                     WHERE task_id = :task_id AND due_at IS NOT NULL) END)
              END AS n`,
      column: "n",
      op: "eq",
      value: 1,
      message: "A repeating task needs a due date to repeat from.",
    },
  ],
  postconditions: [
    {
      name: "edits_applied",
      sql: `SELECT (
              (SELECT CASE WHEN :title IS NULL THEN 1
                           ELSE EXISTS(SELECT 1 FROM schedule_task WHERE task_id = :task_id AND title = :title) END)
              AND (SELECT CASE WHEN :description IS NULL THEN 1
                           ELSE EXISTS(SELECT 1 FROM schedule_task WHERE task_id = :task_id AND description = :description) END)
              AND (SELECT CASE WHEN :due_at IS NULL THEN 1
                           ELSE EXISTS(SELECT 1 FROM schedule_task WHERE task_id = :task_id AND due_at = :due_at) END)
              AND (SELECT CASE WHEN :priority IS NULL THEN 1
                           ELSE EXISTS(SELECT 1 FROM schedule_task WHERE task_id = :task_id AND priority = :priority) END)
            ) AS n`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "idempotent",
  risk: "low",
  handler: editTask,
};

function editTask(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    task_id: string;
    title?: string;
    description?: string;
    clear_description?: boolean;
    due_at?: string;
    clear_due?: boolean;
    priority?: number;
    effort_min?: number;
    remind_before_min?: number;
    clear_remind?: boolean;
    rrule?: string;
    clear_rrule?: boolean;
  };
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (input.title !== undefined) {
    sets.push("title = ?");
    values.push(input.title);
  }
  if (input.description !== undefined) {
    sets.push("description = ?");
    values.push(input.description);
  }
  if (input.clear_description) {
    sets.push("description = ?");
    values.push(null);
  }
  if (input.due_at !== undefined) {
    sets.push("due_at = ?");
    values.push(input.due_at);
  }
  if (input.clear_due) {
    sets.push("due_at = ?");
    values.push(null);
  }
  if (input.priority !== undefined) {
    sets.push("priority = ?");
    values.push(input.priority);
  }
  if (input.effort_min !== undefined) {
    sets.push("effort_min = ?");
    values.push(input.effort_min);
  }
  if (input.remind_before_min !== undefined) {
    sets.push("remind_before_min = ?");
    values.push(input.remind_before_min);
  }
  if (input.clear_remind) {
    sets.push("remind_before_min = ?");
    values.push(null);
  }
  if (input.rrule !== undefined) {
    sets.push("rrule = ?");
    values.push(input.rrule);
  }
  if (input.clear_rrule) {
    sets.push("rrule = ?");
    values.push(null);
  }
  if (sets.length > 0) {
    ctx.db
      .prepare(`UPDATE schedule_task SET ${sets.join(", ")} WHERE task_id = ?`)
      .run(...values, input.task_id);
  }
  ctx.wrote("schedule.task", input.task_id);
  return { task_id: input.task_id };
}

const DELETE_TASK: CommandDefinition = {
  name: "schedule.delete_task",
  ownerSchema: "schedule",
  inputSchema: {
    type: "object",
    required: ["task_id"],
    additionalProperties: false,
    properties: { task_id: { type: "string", minLength: 1 } },
  },
  outputSchema: {
    type: "object",
    required: ["task_id", "removed"],
    properties: {
      task_id: { type: "string" },
      removed: { type: "integer" },
    },
  },
  preconditions: [
    {
      name: "task_exists",
      sql: `SELECT count(*) AS n FROM schedule_task
             WHERE task_id = :task_id AND deleted_at IS NULL`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "task_and_subtasks_trashed",
      sql: `SELECT count(*) AS n FROM schedule_task
             WHERE (task_id = :task_id OR parent_task_id = :task_id)
               AND deleted_at IS NULL`,
      column: "n",
      op: "eq",
      value: 0,
    },
  ],
  idempotency: "once",
  risk: "medium",
  handler: deleteTask,
};

const TASK_PURGE_DAYS = 30;

export function taskPurgeAt(now: string): string {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() + TASK_PURGE_DAYS);
  return date.toISOString();
}

function trashTask(ctx: HandlerCtx, taskId: string): void {
  ctx.db
    .prepare(
      `UPDATE schedule_task SET deleted_at = ?, purge_at = ?
        WHERE task_id = ? AND deleted_at IS NULL`
    )
    .run(ctx.now, taskPurgeAt(ctx.now), taskId);
  ctx.wrote("schedule.task", taskId);
}

function deleteTask(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { task_id: string };
  const children = ctx.db
    .prepare(
      "SELECT task_id FROM schedule_task WHERE parent_task_id = ? AND deleted_at IS NULL"
    )
    .all(input.task_id) as { task_id: string }[];
  for (const child of children) trashTask(ctx, child.task_id);
  trashTask(ctx, input.task_id);
  ctx.cite({
    claim: `task ${input.task_id} moved to trash with ${children.length} subtasks`,
    entityType: "schedule.task",
    entityId: input.task_id,
  });
  return { task_id: input.task_id, removed: 1 + children.length };
}

const RESTORE_TASK: CommandDefinition = {
  name: "schedule.restore_task",
  ownerSchema: "schedule",
  inputSchema: {
    type: "object",
    required: ["task_id"],
    additionalProperties: false,
    properties: { task_id: { type: "string", minLength: 1 } },
  },
  outputSchema: {
    type: "object",
    required: ["task_id", "restored"],
    properties: {
      task_id: { type: "string" },
      restored: { type: "integer" },
    },
  },
  preconditions: [
    {
      name: "task_trashed",
      sql: `SELECT count(*) AS n FROM schedule_task
             WHERE task_id = :task_id AND deleted_at IS NOT NULL
               AND (purge_at IS NULL OR purge_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "task_live_again",
      sql: `SELECT count(*) AS n FROM schedule_task
             WHERE task_id = :task_id AND deleted_at IS NULL`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "idempotent",
  risk: "low",
  handler: (ctx) => {
    const input = ctx.input as { task_id: string };
    const restored = ctx.db
      .prepare(
        `UPDATE schedule_task SET deleted_at = NULL, purge_at = NULL
          WHERE (task_id = ? OR parent_task_id = ?) AND deleted_at IS NOT NULL`
      )
      .run(input.task_id, input.task_id);
    ctx.wrote("schedule.task", input.task_id);
    return { task_id: input.task_id, restored: Number(restored.changes) };
  },
};

export function registerTaskCommands(gateway: Gateway): void {
  gateway.registerCommand(ADD_TASK);
  gateway.registerCommand(SET_TASK_STATUS);
  gateway.registerCommand(EDIT_TASK);
  gateway.registerCommand(DELETE_TASK);
  gateway.registerCommand(RESTORE_TASK);
}
