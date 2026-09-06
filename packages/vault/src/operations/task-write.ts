// THE TASK WRITE OPERATION (#996, ruling R21; drift ONT-26, ONT-31).
//
// Every writer that puts a row into `schedule_task` — `schedule.add_task`,
// `schedule.edit_task`, `schedule.organize_task`, `people.add_task`, the
// completion operation, an import and `atlas.insert_row` / `atlas.update_row`
// — asks the same four questions of the same proposed row image. Before this
// they asked four different subsets: Atlas accepted a task as its own parent
// and `due_at: "banana"`; the domain command checked the parent was open and
// top-level but not that the hierarchy was acyclic; nothing checked that a
// section belonged to the task's project.
//
// The image is the row AS IT WILL BE: on an update the stored row is loaded
// and the draft's stated fields applied over it, so "move this task under its
// own child" is judged on the resulting graph rather than on the two ids in
// the request.

import type { DatabaseSync } from "node:sqlite";

import {
  classifyTemporal,
  inspectRrule,
  rruleRefusalMessage,
} from "@centraid/core/time";

/** A stated field. `undefined` means "unchanged"; `null` means "cleared". */
type Stated<T> = T | null | undefined;

/** The proposed row image, in the operation's own vocabulary. */
export interface TaskWriteDraft {
  /** The row being written; `null` for an insert that has not minted one. */
  readonly taskId: string | null;
  readonly parentTaskId?: Stated<string>;
  readonly projectId?: Stated<string>;
  readonly sectionId?: Stated<string>;
  readonly dueAt?: Stated<string>;
  readonly rrule?: Stated<string>;
  readonly status?: Stated<string>;
}

interface TaskRow {
  task_id: string;
  parent_task_id: string | null;
  project_id: string | null;
  section_id: string | null;
  due_at: string | null;
  rrule: string | null;
  status: string;
}

interface TaskImage {
  taskId: string | null;
  parentTaskId: string | null;
  projectId: string | null;
  sectionId: string | null;
  dueAt: string | null;
  rrule: string | null;
  status: string | null;
}

function stored(vault: DatabaseSync, taskId: string): TaskRow | undefined {
  return vault
    .prepare(
      `SELECT task_id, parent_task_id, project_id, section_id, due_at, rrule, status
         FROM schedule_task WHERE task_id = ?`
    )
    .get(taskId) as TaskRow | undefined;
}

function settle<T>(stated: Stated<T>, current: T | null): T | null {
  return stated === undefined ? current : (stated ?? null);
}

/** The row as it will be after the draft lands. */
export function taskImage(
  vault: DatabaseSync,
  draft: TaskWriteDraft
): TaskImage {
  const current =
    draft.taskId === null ? undefined : stored(vault, draft.taskId);
  return {
    taskId: draft.taskId,
    parentTaskId: settle(draft.parentTaskId, current?.parent_task_id ?? null),
    projectId: settle(draft.projectId, current?.project_id ?? null),
    sectionId: settle(draft.sectionId, current?.section_id ?? null),
    dueAt: settle(draft.dueAt, current?.due_at ?? null),
    rrule: settle(draft.rrule, current?.rrule ?? null),
    status: settle(draft.status, current?.status ?? null),
  };
}

export interface TaskCondition {
  readonly name: string;
  readonly assert: (vault: DatabaseSync, image: TaskImage) => string | null;
}

/** How deep a subtask chain may be walked before the walk itself is the bug. */
const MAX_HIERARCHY_DEPTH = 256;

export const TASK_WRITE_CONDITIONS: readonly TaskCondition[] = [
  {
    // ONT-31. `banana` stored, and completion then silently had no successor:
    // an unreadable due date is indistinguishable from no due date at read
    // time, so the series just stopped and nothing said why.
    name: "task_due_at_is_a_time",
    assert: (_vault, image) => {
      if (image.dueAt === null) return null;
      const kind = classifyTemporal(image.dueAt);
      if (
        kind === "instant" ||
        kind === "floating-datetime" ||
        kind === "local-date"
      ) {
        return null;
      }
      return `due_at: ${JSON.stringify(image.dueAt)} is not a time this vault can read — a task's due date is an instant (2026-03-01T09:00:00Z), a floating local time (2026-03-01T09:00) or a date (2026-03-01).`;
    },
  },
  {
    // ONT-31's other half. A rule outside the expander's subset is refused
    // here rather than stored as an executable rule that quietly expands to
    // the wrong dates — the failure mode the rrule refusal was built for.
    name: "task_rrule_is_supported",
    assert: (_vault, image) => {
      if (image.rrule === null) return null;
      const support = inspectRrule(image.rrule);
      return support.ok
        ? null
        : `rrule: ${JSON.stringify(image.rrule)} — ${rruleRefusalMessage(support)}`;
    },
  },
  {
    // A rule advances `due_at` on completion, so a rule with nothing to
    // advance never recurs. Held for every writer, not just the command whose
    // input schema happened to say so.
    name: "task_rrule_needs_a_due_at",
    assert: (_vault, image) =>
      image.rrule !== null && image.dueAt === null
        ? "A repeating task needs a due date to repeat from."
        : null,
  },
  {
    // ONT-26's headline: Atlas accepted a task as its own parent, and a longer
    // cycle was reachable through any writer. The walk climbs the PROPOSED
    // graph, so a move that would close a loop is refused before it lands.
    name: "task_hierarchy_is_acyclic",
    assert: (vault, image) => {
      if (image.parentTaskId === null) return null;
      if (image.taskId !== null && image.parentTaskId === image.taskId) {
        return "A task cannot be its own parent.";
      }
      const seen = new Set<string>(image.taskId === null ? [] : [image.taskId]);
      let cursor: string | null = image.parentTaskId;
      for (let depth = 0; cursor !== null; depth += 1) {
        if (seen.has(cursor)) {
          return "That parent is already below this task — a task hierarchy has no loops.";
        }
        if (depth >= MAX_HIERARCHY_DEPTH) {
          return "That task hierarchy is too deep to be a hierarchy.";
        }
        seen.add(cursor);
        const parent = stored(vault, cursor);
        if (!parent) return null;
        cursor = parent.parent_task_id;
      }
      return null;
    },
  },
  {
    // A section belongs to exactly one project, so a task filed in a section
    // of another project is in two places at once — the state no reader can
    // render and every writer used to be able to create.
    name: "task_section_agrees_with_project",
    assert: (vault, image) => {
      if (image.sectionId === null) return null;
      const section = vault
        .prepare("SELECT project_id FROM schedule_section WHERE section_id = ?")
        .get(image.sectionId) as { project_id: string } | undefined;
      if (!section) return "That section does not exist.";
      if (image.projectId === null) {
        return "A task in a section is in that section's project — file it in the project too.";
      }
      return section.project_id === image.projectId
        ? null
        : "That section belongs to a different project.";
    },
  },
];

/** The first failing condition, or `null`. */
export function assertTaskWrite(
  vault: DatabaseSync,
  draft: TaskWriteDraft
): { condition: string; message: string } | null {
  const image = taskImage(vault, draft);
  for (const condition of TASK_WRITE_CONDITIONS) {
    const message = condition.assert(vault, image);
    if (message !== null) return { condition: condition.name, message };
  }
  return null;
}
