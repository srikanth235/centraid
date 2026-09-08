// COMPLETION IS ONE OPERATION (#996, ruling R21; drift ONT-27).
//
// People and Tasks completed the same `schedule_task` row with different SQL.
// `people.toggle_task` flipped the status in a CASE expression — so which app
// the member happened to be looking at decided whether a repeating task got
// its next occurrence, and a double tap silently reopened a task the other
// screen had just closed. Tasks' own recurrence copied the columns of the
// completed row into a fresh one with no series identity and without the
// `about` link, so the successor of a recurring "call Mum" was no longer about
// Mum: the reminder survived and the person it was for did not.
//
// Three things this module makes true for every caller:
//
//   1. `complete` and `reopen` are separate, named, idempotent operations.
//      Never a toggle: a toggle's outcome depends on a state the caller did
//      not read, which is the whole of ONT-27's "which app completed it
//      decides what happens".
//   2. A recurring task has a STABLE SERIES IDENTITY (`series_id`), and each
//      occurrence keeps its own `task_id`. The series is what the successor
//      belongs to; the occurrence is what was completed.
//   3. The relationships that belong to the SERIES are inherited. A live
//      `core_link` from the completed occurrence is re-asserted from the
//      successor, so "about Mum" survives the roll-over.

import type { DatabaseSync } from "node:sqlite";

import { nextOccurrence } from "@centraid/core/time";

import { assertTaskWrite } from "./task-write.js";
import { OperationRefusalError } from "./types.js";

/**
 * A successor carries at least as many live links as the occurrence it came
 * from (#996, ONT-27) — the postcondition People and Tasks both assert after a
 * completion, in one spelling so the two apps cannot check different things.
 */
export const SUCCESSOR_INHERITS_SERIES_LINKS_SQL = `SELECT (CASE WHEN :next_task_id IS NULL THEN 1
                    ELSE ((SELECT count(*) FROM core_link
                            WHERE from_type = 'schedule.task' AND from_id = :next_task_id
                              AND valid_to IS NULL)
                          >= (SELECT count(*) FROM core_link
                               WHERE from_type = 'schedule.task' AND from_id = :task_id
                                 AND valid_to IS NULL)) END) AS n`;

export interface TaskLifecycleContext {
  readonly db: DatabaseSync;
  readonly now: string;
  readonly newId: () => string;
  readonly wrote: (entityType: string, entityId: string) => void;
  readonly cite?: (citation: {
    claim: string;
    entityType: string;
    entityId: string;
  }) => void;
}

export interface TaskLifecycleResult {
  readonly task_id: string;
  readonly status: string;
  readonly series_id: string | null;
  readonly next_task_id?: string;
  readonly next_due_at?: string;
}

interface TaskRow {
  task_id: string;
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
  series_id: string | null;
}

const TASK_COLUMNS = `task_id, status, owner_party_id, title, description, priority,
       due_at, effort_min, parent_task_id, rrule, remind_before_min, project_id,
       section_id, sort_order, recurrence_anchor, tz, series_id`;

function taskRow(vault: DatabaseSync, taskId: string): TaskRow | undefined {
  return vault
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM schedule_task WHERE task_id = ? AND deleted_at IS NULL`
    )
    .get(taskId) as TaskRow | undefined;
}

/**
 * The series a task belongs to. A task that repeats and has never been given
 * one becomes the head of its own series — the identity is minted once and
 * then never moves, so every occurrence of "call Mum" answers the same
 * question with the same id.
 */
function seriesIdOf(
  vault: DatabaseSync,
  row: TaskRow,
  wrote: TaskLifecycleContext["wrote"]
): string | null {
  if (row.series_id !== null) return row.series_id;
  if (row.rrule === null) return null;
  vault
    .prepare("UPDATE schedule_task SET series_id = ? WHERE task_id = ?")
    .run(row.task_id, row.task_id);
  wrote("schedule.task", row.task_id);
  return row.task_id;
}

/**
 * Re-assert the completed occurrence's live links from the successor. Copied,
 * not moved: the completed occurrence keeps its own history, and the `about`
 * edge is a fact about both rows.
 */
function inheritSeriesLinks(
  ctx: TaskLifecycleContext,
  fromTaskId: string,
  toTaskId: string
): void {
  const links = ctx.db
    .prepare(
      `SELECT to_type, to_id, relation_concept_id, asserted_by
         FROM core_link
        WHERE from_type = 'schedule.task' AND from_id = ? AND valid_to IS NULL`
    )
    .all(fromTaskId) as {
    to_type: string;
    to_id: string;
    relation_concept_id: string;
    asserted_by: string;
  }[];
  for (const link of links) {
    const linkId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO core_link
           (link_id, from_type, from_id, to_type, to_id, relation_concept_id,
            valid_from, valid_to, asserted_by, provenance_id)
         VALUES (?, 'schedule.task', ?, ?, ?, ?, ?, NULL, ?, NULL)
         ON CONFLICT DO NOTHING`
      )
      .run(
        linkId,
        toTaskId,
        link.to_type,
        link.to_id,
        link.relation_concept_id,
        ctx.now,
        link.asserted_by
      );
    ctx.wrote("core.link", linkId);
  }
}

function refuse(condition: string, message: string): never {
  throw new OperationRefusalError("schedule.task.complete", condition, message);
}

/**
 * Complete a task. Idempotent: completing an already-completed task is the
 * same answer, and never spawns a second successor.
 */
export function completeTask(
  ctx: TaskLifecycleContext,
  taskId: string
): TaskLifecycleResult {
  const row = taskRow(ctx.db, taskId);
  if (!row) refuse("task_exists", "That task is not here to complete.");
  if (row.status === "completed") {
    return {
      task_id: taskId,
      status: "completed",
      series_id: row.series_id,
    };
  }
  const seriesId = seriesIdOf(ctx.db, row, ctx.wrote);
  ctx.db
    .prepare(
      "UPDATE schedule_task SET status = 'completed', completed_at = ? WHERE task_id = ?"
    )
    .run(ctx.now, taskId);
  ctx.wrote("schedule.task", taskId);
  ctx.cite?.({
    claim: `task completed (${row.status} → completed)`,
    entityType: "schedule.task",
    entityId: taskId,
  });
  const result: {
    task_id: string;
    status: string;
    series_id: string | null;
    next_task_id?: string;
    next_due_at?: string;
  } = { task_id: taskId, status: "completed", series_id: seriesId };
  if (row.rrule === null || row.due_at === null) return result;
  const nextDue = nextOccurrence({
    rrule: row.rrule,
    scheduledStart: row.due_at,
    after: row.recurrence_anchor === "completion" ? ctx.now : row.due_at,
    timeZone: row.tz ?? "Etc/UTC",
    anchor: row.recurrence_anchor,
  });
  if (nextDue === null) return result;
  const nextTaskId = ctx.newId();
  const refusal = assertTaskWrite(ctx.db, {
    taskId: null,
    parentTaskId: row.parent_task_id,
    projectId: row.project_id,
    sectionId: row.section_id,
    dueAt: nextDue,
    rrule: row.rrule,
    status: "needs-action",
  });
  // The successor is a canonical write like any other; a series whose next
  // occurrence would be invalid stops rather than writing a row no reader can
  // make sense of.
  if (refusal !== null) {
    throw new OperationRefusalError(
      "schedule.task.complete",
      refusal.condition,
      refusal.message
    );
  }
  ctx.db
    .prepare(
      `INSERT INTO schedule_task
         (task_id, owner_party_id, title, description, status, priority,
          due_at, completed_at, effort_min, parent_task_id, rrule,
          remind_before_min, project_id, section_id, sort_order,
          recurrence_anchor, tz, series_id)
       VALUES (?, ?, ?, ?, 'needs-action', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      nextTaskId,
      row.owner_party_id,
      row.title,
      row.description,
      row.priority,
      nextDue,
      row.effort_min,
      row.parent_task_id,
      row.rrule,
      row.remind_before_min,
      row.project_id,
      row.section_id,
      row.sort_order,
      row.recurrence_anchor,
      row.tz,
      seriesId
    );
  ctx.wrote("schedule.task", nextTaskId);
  // ONT-27: the successor of a recurring "call Mum" is still about Mum.
  inheritSeriesLinks(ctx, taskId, nextTaskId);
  ctx.cite?.({
    claim: `next occurrence of "${row.title}" spawned at ${nextDue} (${row.rrule})`,
    entityType: "schedule.task",
    entityId: nextTaskId,
  });
  result.next_task_id = nextTaskId;
  result.next_due_at = nextDue;
  return result;
}

/** Reopen a task. Idempotent, and never spawns anything. */
export function reopenTask(
  ctx: TaskLifecycleContext,
  taskId: string,
  status: "needs-action" | "in-process" = "needs-action"
): TaskLifecycleResult {
  const row = taskRow(ctx.db, taskId);
  if (!row) refuse("task_exists", "That task is not here to reopen.");
  if (row.status === status) {
    return { task_id: taskId, status, series_id: row.series_id };
  }
  ctx.db
    .prepare(
      "UPDATE schedule_task SET status = ?, completed_at = NULL WHERE task_id = ?"
    )
    .run(status, taskId);
  ctx.wrote("schedule.task", taskId);
  ctx.cite?.({
    claim: `task reopened (${row.status} → ${status})`,
    entityType: "schedule.task",
    entityId: taskId,
  });
  return { task_id: taskId, status, series_id: row.series_id };
}

/** Cancelling is neither: it ends the occurrence without a successor. */
export function cancelTask(
  ctx: TaskLifecycleContext,
  taskId: string
): TaskLifecycleResult {
  const row = taskRow(ctx.db, taskId);
  if (!row) refuse("task_exists", "That task is not here to cancel.");
  ctx.db
    .prepare(
      "UPDATE schedule_task SET status = 'cancelled', completed_at = NULL WHERE task_id = ?"
    )
    .run(taskId);
  ctx.wrote("schedule.task", taskId);
  return { task_id: taskId, status: "cancelled", series_id: row.series_id };
}
