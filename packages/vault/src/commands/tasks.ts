// The schedule domain's task commands — the pack that turns task
// projections from a window into a pen. Same posture as events (§11):
// consent-checked, contract-checked, receipted end to end. Tasks follow
// iCalendar VTODO vocabulary: status is the CHECK-constrained lifecycle
// (needs-action → in-process → completed | cancelled), priority 0 means
// unset and 1 is highest (RFC 5545 §3.8.1.9).

import type { Gateway } from '../gateway/gateway.js';
import type { CommandDefinition, HandlerCtx } from '../gateway/types.js';

const ADD_TASK: CommandDefinition = {
  name: 'schedule.add_task',
  ownerSchema: 'schedule',
  inputSchema: {
    type: 'object',
    required: ['title'],
    additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 1 },
      due_at: { type: 'string', minLength: 1 },
      priority: { type: 'integer', minimum: 0, maximum: 9 },
      effort_min: { type: 'integer', minimum: 1 },
      parent_task_id: { type: 'string', minLength: 1 },
      rrule: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['task_id'],
    properties: { task_id: { type: 'string' } },
  },
  preconditions: [
    {
      // One level of nesting, Things-style: a subtask's parent must exist,
      // still be open, and itself be top-level. Optional inputs bind as
      // NULL, so a plain top-level add passes trivially.
      name: 'parent_open_and_top_level',
      sql: `SELECT CASE WHEN :parent_task_id IS NULL THEN 1
                   ELSE (SELECT count(*) FROM schedule_task
                          WHERE task_id = :parent_task_id
                            AND parent_task_id IS NULL
                            AND status IN ('needs-action','in-process'))
              END AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'task_created_open',
      sql: `SELECT count(*) AS n FROM schedule_task
             WHERE task_id = :task_id AND status = 'needs-action' AND completed_at IS NULL`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: addTask,
};

function addTask(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    title: string;
    due_at?: string;
    priority?: number;
    effort_min?: number;
    parent_task_id?: string;
    rrule?: string;
  };
  const owner = ctx.db.prepare('SELECT owner_party_id FROM core_vault LIMIT 1').get() as
    | { owner_party_id: string | null }
    | undefined;
  if (!owner?.owner_party_id) throw new Error('vault has no owner');
  const taskId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO schedule_task
         (task_id, owner_party_id, title, status, priority, due_at, completed_at, effort_min, parent_task_id, rrule)
       VALUES (?, ?, ?, 'needs-action', ?, ?, NULL, ?, ?, ?)`,
    )
    .run(
      taskId,
      owner.owner_party_id,
      input.title,
      input.priority ?? 0,
      input.due_at ?? null,
      input.effort_min ?? null,
      input.parent_task_id ?? null,
      input.rrule ?? null,
    );
  ctx.wrote('schedule.task', taskId);
  return { task_id: taskId };
}

const SET_TASK_STATUS: CommandDefinition = {
  name: 'schedule.set_task_status',
  ownerSchema: 'schedule',
  inputSchema: {
    type: 'object',
    required: ['task_id', 'status'],
    additionalProperties: false,
    properties: {
      task_id: { type: 'string', minLength: 1 },
      // The full VTODO lifecycle — reopening a completed task is a status
      // move like any other; history stays in provenance, not the row.
      status: {
        type: 'string',
        enum: ['needs-action', 'in-process', 'completed', 'cancelled'],
      },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['task_id', 'status'],
    properties: { task_id: { type: 'string' }, status: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'task_exists',
      sql: 'SELECT count(*) AS n FROM schedule_task WHERE task_id = :task_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      // completed_at is not an independent fact: it exists iff the status
      // says completed. Anything else rolls back.
      name: 'status_and_completion_stamp_agree',
      sql: `SELECT count(*) AS n FROM schedule_task
             WHERE task_id = :task_id AND status = :status
               AND ((status = 'completed') = (completed_at IS NOT NULL))`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: setTaskStatus,
};

function setTaskStatus(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { task_id: string; status: string };
  const previous = ctx.db
    .prepare('SELECT status FROM schedule_task WHERE task_id = ?')
    .get(input.task_id) as { status: string } | undefined;
  if (!previous) throw new Error('task vanished between check and execute');
  ctx.db
    .prepare('UPDATE schedule_task SET status = ?, completed_at = ? WHERE task_id = ?')
    .run(input.status, input.status === 'completed' ? ctx.now : null, input.task_id);
  ctx.wrote('schedule.task', input.task_id);
  ctx.cite({
    claim: `task moved ${previous.status} → ${input.status}`,
    entityType: 'schedule.task',
    entityId: input.task_id,
  });
  return { task_id: input.task_id, status: input.status };
}

const EDIT_TASK: CommandDefinition = {
  name: 'schedule.edit_task',
  ownerSchema: 'schedule',
  inputSchema: {
    type: 'object',
    required: ['task_id'],
    additionalProperties: false,
    properties: {
      task_id: { type: 'string', minLength: 1 },
      title: { type: 'string', minLength: 1 },
      due_at: { type: 'string', minLength: 1 },
      // Clearing a due date is an explicit intent, not a magic empty
      // string — due_at sets, clear_due removes; sending both is refused.
      clear_due: { type: 'boolean', const: true },
      priority: { type: 'integer', minimum: 0, maximum: 9 },
      effort_min: { type: 'integer', minimum: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['task_id'],
    properties: { task_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'task_exists',
      sql: 'SELECT count(*) AS n FROM schedule_task WHERE task_id = :task_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      name: 'due_set_and_clear_are_exclusive',
      sql: 'SELECT (:due_at IS NULL OR :clear_due IS NULL) AS n',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      // Each field either wasn't asked for, or now reads back exactly as
      // sent. Optional inputs bind as NULL so untouched fields pass.
      name: 'edits_applied',
      sql: `SELECT (
              (SELECT CASE WHEN :title IS NULL THEN 1
                           ELSE EXISTS(SELECT 1 FROM schedule_task WHERE task_id = :task_id AND title = :title) END)
              AND (SELECT CASE WHEN :due_at IS NULL THEN 1
                           ELSE EXISTS(SELECT 1 FROM schedule_task WHERE task_id = :task_id AND due_at = :due_at) END)
              AND (SELECT CASE WHEN :priority IS NULL THEN 1
                           ELSE EXISTS(SELECT 1 FROM schedule_task WHERE task_id = :task_id AND priority = :priority) END)
            ) AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: editTask,
};

function editTask(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    task_id: string;
    title?: string;
    due_at?: string;
    clear_due?: boolean;
    priority?: number;
    effort_min?: number;
  };
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (input.title !== undefined) {
    sets.push('title = ?');
    values.push(input.title);
  }
  if (input.due_at !== undefined) {
    sets.push('due_at = ?');
    values.push(input.due_at);
  }
  if (input.clear_due) {
    sets.push('due_at = ?');
    values.push(null);
  }
  if (input.priority !== undefined) {
    sets.push('priority = ?');
    values.push(input.priority);
  }
  if (input.effort_min !== undefined) {
    sets.push('effort_min = ?');
    values.push(input.effort_min);
  }
  if (sets.length > 0) {
    ctx.db
      .prepare(`UPDATE schedule_task SET ${sets.join(', ')} WHERE task_id = ?`)
      .run(...values, input.task_id);
  }
  ctx.wrote('schedule.task', input.task_id);
  return { task_id: input.task_id };
}

/** Register the schedule domain's task commands on a gateway. */
export function registerTaskCommands(gateway: Gateway): void {
  gateway.registerCommand(ADD_TASK);
  gateway.registerCommand(SET_TASK_STATUS);
  gateway.registerCommand(EDIT_TASK);
}
