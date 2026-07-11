// The schedule domain's task commands — the pack that turns task
// projections from a window into a pen. Same posture as events (§11):
// consent-checked, contract-checked, receipted end to end. Tasks follow
// iCalendar VTODO vocabulary: status is the CHECK-constrained lifecycle
// (needs-action → in-process → completed | cancelled), priority 0 means
// unset and 1 is highest (RFC 5545 §3.8.1.9).

import type { Gateway } from '../gateway/gateway.js';
import type { CommandDefinition, HandlerCtx } from '../gateway/types.js';
import { nextOccurrence } from '../recurrence/rrule.js';

const ADD_TASK: CommandDefinition = {
  name: 'schedule.add_task',
  ownerSchema: 'schedule',
  inputSchema: {
    type: 'object',
    required: ['title'],
    additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 1 },
      description: { type: 'string', minLength: 1 },
      due_at: { type: 'string', minLength: 1 },
      priority: { type: 'integer', minimum: 0, maximum: 9 },
      effort_min: { type: 'integer', minimum: 1 },
      parent_task_id: { type: 'string', minLength: 1 },
      rrule: { type: 'string', minLength: 1 },
      // Minutes before due_at the reminder scheduler should fire — meaningless
      // without a due_at, same posture as rrule.
      remind_before_min: { type: 'integer', minimum: 0 },
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
    {
      // A recurring task needs an anchor date — rrule advances due_at on
      // completion, so a rule with nothing to advance is refused up front
      // rather than silently never recurring.
      name: 'rrule_requires_due_at',
      sql: 'SELECT (:rrule IS NULL OR :due_at IS NOT NULL) AS n',
      column: 'n',
      op: 'eq',
      value: 1,
      message: 'A repeating task needs a due date to repeat from.',
    },
    {
      name: 'reminder_requires_due_at',
      sql: 'SELECT (:remind_before_min IS NULL OR :due_at IS NOT NULL) AS n',
      column: 'n',
      op: 'eq',
      value: 1,
      message: 'A reminder needs a due date to count back from.',
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
    description?: string;
    due_at?: string;
    priority?: number;
    effort_min?: number;
    parent_task_id?: string;
    rrule?: string;
    remind_before_min?: number;
  };
  const owner = ctx.db.prepare('SELECT owner_party_id FROM core_vault LIMIT 1').get() as
    | { owner_party_id: string | null }
    | undefined;
  if (!owner?.owner_party_id) throw new Error('vault has no owner');
  const taskId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO schedule_task
         (task_id, owner_party_id, title, description, status, priority, due_at, completed_at, effort_min, parent_task_id, rrule, remind_before_min)
       VALUES (?, ?, ?, ?, 'needs-action', ?, ?, NULL, ?, ?, ?, ?)`,
    )
    .run(
      taskId,
      owner.owner_party_id,
      input.title,
      input.description ?? null,
      input.priority ?? 0,
      input.due_at ?? null,
      input.effort_min ?? null,
      input.parent_task_id ?? null,
      input.rrule ?? null,
      input.remind_before_min ?? null,
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
    properties: {
      task_id: { type: 'string' },
      status: { type: 'string' },
      // Only present when completing a task whose rrule still has a next
      // hit — the freshly spawned sibling occurrence.
      next_task_id: { type: 'string' },
      next_due_at: { type: 'string' },
    },
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
    {
      // Optional binding, same idiom as edit_task: wasn't asked for (no
      // next occurrence spawned) passes trivially; asked for means the
      // sibling really exists, open, due exactly where the rule put it.
      name: 'next_occurrence_spawned_open',
      sql: `SELECT CASE WHEN :next_task_id IS NULL THEN 1
                   ELSE (SELECT count(*) FROM schedule_task
                          WHERE task_id = :next_task_id AND status = 'needs-action'
                            AND completed_at IS NULL AND due_at = :next_due_at)
              END AS n`,
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
    .prepare(
      'SELECT status, owner_party_id, title, description, priority, due_at, effort_min, parent_task_id, rrule, remind_before_min FROM schedule_task WHERE task_id = ?',
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
      }
    | undefined;
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
  const output: Record<string, unknown> = { task_id: input.task_id, status: input.status };
  // Completing a repeating task spawns its next occurrence in the same
  // motion — Things/Todoist behavior: the series never needs a second
  // "add" from the owner. A non-completion move (reopen, cancel) never
  // spawns; only the completed→next edge does.
  if (input.status === 'completed' && previous.rrule && previous.due_at) {
    const nextDue = nextOccurrence(previous.rrule, previous.due_at, previous.due_at);
    if (nextDue) {
      const nextTaskId = ctx.newId();
      ctx.db
        .prepare(
          `INSERT INTO schedule_task
             (task_id, owner_party_id, title, description, status, priority, due_at, completed_at, effort_min, parent_task_id, rrule, remind_before_min)
           VALUES (?, ?, ?, ?, 'needs-action', ?, ?, NULL, ?, ?, ?, ?)`,
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
        );
      ctx.wrote('schedule.task', nextTaskId);
      ctx.cite({
        claim: `next occurrence of "${previous.title}" spawned at ${nextDue} (${previous.rrule})`,
        entityType: 'schedule.task',
        entityId: nextTaskId,
      });
      output.next_task_id = nextTaskId;
      output.next_due_at = nextDue;
    }
  }
  return output;
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
      description: { type: 'string', minLength: 1 },
      // Clearing a note is an explicit intent, not a magic empty string —
      // description sets, clear_description removes; sending both is refused.
      clear_description: { type: 'boolean', const: true },
      due_at: { type: 'string', minLength: 1 },
      // Clearing a due date is an explicit intent, not a magic empty
      // string — due_at sets, clear_due removes; sending both is refused.
      clear_due: { type: 'boolean', const: true },
      priority: { type: 'integer', minimum: 0, maximum: 9 },
      effort_min: { type: 'integer', minimum: 1 },
      remind_before_min: { type: 'integer', minimum: 0 },
      // Same set/clear-are-exclusive idiom as due_at.
      clear_remind: { type: 'boolean', const: true },
      rrule: { type: 'string', minLength: 1 },
      // Same idiom again: rrule sets, clear_rrule stops the series.
      clear_rrule: { type: 'boolean', const: true },
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
    {
      name: 'description_set_and_clear_are_exclusive',
      sql: 'SELECT (:description IS NULL OR :clear_description IS NULL) AS n',
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      name: 'remind_set_and_clear_are_exclusive',
      sql: 'SELECT (:remind_before_min IS NULL OR :clear_remind IS NULL) AS n',
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      name: 'rrule_set_and_clear_are_exclusive',
      sql: 'SELECT (:rrule IS NULL OR :clear_rrule IS NULL) AS n',
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      // A repeating task still needs its due_at once the edit lands — either
      // it already had one, or this same call is setting one (or clearing
      // the reminder that would otherwise depend on it too).
      name: 'rrule_edit_keeps_a_due_at',
      sql: `SELECT CASE WHEN :rrule IS NULL THEN 1
                   ELSE (SELECT CASE WHEN :due_at IS NOT NULL THEN 1
                              ELSE (SELECT count(*) FROM schedule_task
                                     WHERE task_id = :task_id AND due_at IS NOT NULL) END)
              END AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
      message: 'A repeating task needs a due date to repeat from.',
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
              AND (SELECT CASE WHEN :description IS NULL THEN 1
                           ELSE EXISTS(SELECT 1 FROM schedule_task WHERE task_id = :task_id AND description = :description) END)
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
    sets.push('title = ?');
    values.push(input.title);
  }
  if (input.description !== undefined) {
    sets.push('description = ?');
    values.push(input.description);
  }
  if (input.clear_description) {
    sets.push('description = ?');
    values.push(null);
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
  if (input.remind_before_min !== undefined) {
    sets.push('remind_before_min = ?');
    values.push(input.remind_before_min);
  }
  if (input.clear_remind) {
    sets.push('remind_before_min = ?');
    values.push(null);
  }
  if (input.rrule !== undefined) {
    sets.push('rrule = ?');
    values.push(input.rrule);
  }
  if (input.clear_rrule) {
    sets.push('rrule = ?');
    values.push(null);
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
