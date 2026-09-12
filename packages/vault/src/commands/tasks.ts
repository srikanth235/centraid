// The schedule domain's task commands — the pack that turns task
// projections from a window into a pen. Same posture as events (§11):
// consent-checked, contract-checked, receipted end to end. Tasks follow
// iCalendar VTODO vocabulary: status is the CHECK-constrained lifecycle
// (needs-action → in-process → completed | cancelled), priority 0 means
// unset and 1 is highest (RFC 5545 §3.8.1.9).

import type { Gateway } from "../gateway/gateway.js";
import type { CommandDefinition, HandlerCtx } from "../gateway/types.js";
import {
  completeTask,
  cancelTask,
  reopenTask,
  SUCCESSOR_INHERITS_SERIES_LINKS_SQL,
  taskWriteConditions,
} from "../operations/index.js";
import { MINTED_ID_PROPERTY, mintedIdIsFree } from "./minted-id.js";

/** Optional string input, in the operation draft's vocabulary. */
function stated(
  input: Readonly<Record<string, unknown>>,
  key: string
): string | null {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

const ADD_TASK: CommandDefinition = {
  name: "schedule.add_task",
  ownerSchema: "schedule",
  inputSchema: {
    type: "object",
    required: ["title"],
    additionalProperties: false,
    properties: {
      task_id: MINTED_ID_PROPERTY,
      title: { type: "string", minLength: 1 },
      description: { type: "string", minLength: 1 },
      due_at: { type: "string", minLength: 1 },
      priority: { type: "integer", minimum: 0, maximum: 9 },
      effort_min: { type: "integer", minimum: 1 },
      parent_task_id: { type: "string", minLength: 1 },
      rrule: { type: "string", minLength: 1 },
      // Meaningless without a due_at, same posture as rrule.
      remind_before_min: { type: "integer", minimum: 0 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["task_id"],
    properties: { task_id: { type: "string" } },
  },
  preconditions: [
    // THE SAME MODEL EVERY OTHER WRITER MEETS, ASKED FIRST (#996, ruling
    // R21). The conditions below are this command's own contract; these are
    // the vault's, and Atlas, an import and People's task commands run exactly
    // them. First, because when both have something to say the member should
    // read the model's sentence — "a task cannot be its own parent" — not this
    // command's narrower "that parent is not open and top-level".
    ...taskWriteConditions((input) => ({
      // The seat's minted id when it sent one (#922 G2), so a task naming
      // ITSELF as its parent meets the operation here rather than the column
      // CHECK — same refusal, same words, whichever writer asks.
      taskId: stated(input, "task_id"),
      parentTaskId: stated(input, "parent_task_id"),
      dueAt: stated(input, "due_at"),
      rrule: stated(input, "rrule"),
      status: "needs-action",
    })),
    {
      // One level of nesting: a subtask's parent must exist, be open, and be
      // top-level. Optional inputs bind as NULL, so a top-level add passes.
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
      // rrule advances due_at on completion, so a rule with nothing to
      // advance is refused rather than silently never recurring.
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
    mintedIdIsFree("schedule_task", "task_id", "task"),
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
    task_id?: string;
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
  const taskId = input.task_id ?? ctx.newId(); // The seat's, or ours (#922 G2).
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
      // Reopening is a status move like any other; history is provenance.
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
      /** The series this occurrence belongs to (#996, ONT-27); null when the
       *  task does not repeat. */
      series_id: { type: ["string", "null"] },
      // Only when completing a task whose rrule has a next hit.
      next_task_id: { type: "string" },
      next_due_at: { type: "string" },
    },
  },
  preconditions: [
    {
      // A trashed task is refused until restored, or purged (#883).
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
      // `completed_at` exists iff the status says completed.
      name: "status_and_completion_stamp_agree",
      sql: `SELECT count(*) AS n FROM schedule_task
             WHERE task_id = :task_id AND status = :status
               AND ((status = 'completed') = (completed_at IS NOT NULL))`,
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      // ONT-27: an occurrence belongs to the series it came from, and the
      // successor of a recurring "call Mum" is still about Mum.
      name: "successor_inherits_the_series",
      sql: `SELECT (CASE WHEN :next_task_id IS NULL THEN 1
                    ELSE EXISTS(SELECT 1 FROM schedule_task next
                                  JOIN schedule_task done ON done.task_id = :task_id
                                 WHERE next.task_id = :next_task_id
                                   AND next.series_id IS NOT NULL
                                   AND next.series_id = done.series_id) END) AS n`,
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      name: "successor_inherits_the_series_links",
      sql: SUCCESSOR_INHERITS_SERIES_LINKS_SQL,
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      // Not asked for passes trivially; asked for means the sibling exists,
      // open, due exactly where the rule put it.
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

/**
 * ONE OPERATION, NOT A TOGGLE (#996, ruling R21; drift ONT-27). This used to
 * be the only place a task's recurrence rolled over, with People flipping the
 * same column through a `CASE` expression of its own — so which app the member
 * happened to be looking at decided whether a repeating task got its next
 * occurrence, and the successor lost the `about` link that made it a task
 * about a person. The status move is now `complete` / `reopen` / `cancel` in
 * `operations/task-lifecycle.ts`, shared by People, Tasks and automations.
 */
function setTaskStatus(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { task_id: string; status: string };
  const operation = {
    db: ctx.db,
    now: ctx.now,
    newId: ctx.newId,
    wrote: ctx.wrote,
    cite: ctx.cite,
  };
  if (input.status === "completed")
    return { ...completeTask(operation, input.task_id) };
  if (input.status === "cancelled")
    return { ...cancelTask(operation, input.task_id) };
  return {
    ...reopenTask(
      operation,
      input.task_id,
      input.status as "needs-action" | "in-process"
    ),
  };
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
      // Explicit intent, not a magic empty string: both together is refused.
      clear_description: { type: "boolean", const: true },
      due_at: { type: "string", minLength: 1 },
      // due_at sets, clear_due removes; both together is refused.
      clear_due: { type: "boolean", const: true },
      priority: { type: "integer", minimum: 0, maximum: 9 },
      effort_min: { type: "integer", minimum: 1 },
      remind_before_min: { type: "integer", minimum: 0 },
      clear_remind: { type: "boolean", const: true },
      rrule: { type: "string", minLength: 1 },
      // rrule sets, clear_rrule stops the series.
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
      // A trashed task is refused until restored, or purged (#883).
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
      // A repeating task still needs a due_at once the edit lands: either it
      // had one, or this call sets one.
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
    ...taskWriteConditions((input) => ({
      taskId: stated(input, "task_id"),
      ...(input["clear_due"] === true
        ? { dueAt: null }
        : Object.hasOwn(input, "due_at")
          ? { dueAt: stated(input, "due_at") }
          : {}),
      ...(input["clear_rrule"] === true
        ? { rrule: null }
        : Object.hasOwn(input, "rrule")
          ? { rrule: stated(input, "rrule") }
          : {}),
    })),
  ],
  postconditions: [
    {
      // Optional inputs bind as NULL, so untouched fields pass.
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
      // A trashed task is refused until restored, or purged (#883).
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

/** The grace window Docs, Photos, Locker, People and Tally carry (#883). */
const TASK_PURGE_DAYS = 30;

export function taskPurgeAt(now: string): string {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() + TASK_PURGE_DAYS);
  return date.toISOString();
}

/**
 * Reversible for the grace window, then the sweep deletes the row and cleans
 * its poly-refs — the two-step every other app's delete is (#883). The
 * poly-ref cleanup deliberately does NOT run here: an annotation on a trashed
 * task must come back with it, or restore means nothing.
 */
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
      // RESTORE REFUSES A LAPSED WINDOW (#916, review 1.5).
      sql: `SELECT count(*) AS n FROM schedule_task
             WHERE task_id = :task_id AND deleted_at IS NOT NULL
               AND (purge_at IS NULL OR purge_at > :ctx_now)`,
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
    // Subtasks trashed WITH the parent come back with it; one trashed on its
    // own does not — restore undoes the gesture that was made.
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
