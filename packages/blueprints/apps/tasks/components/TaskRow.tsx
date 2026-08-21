// One task, as every list in this room draws it (spec §5's "Task row").
//
// THE ROW IS ONE COMPONENT because it appears in eight places — Today, Upcoming,
// Anytime, All, the Inbox, a project, Catch up and the Logbook — and a row that
// were re-drawn per screen would be eight chances for a due date to read
// differently. What varies between those places is passed in; nothing is
// branched on which screen is asking.
//
// NOTHING COUNTS AT THE MEMBER. There is no badge, no dot, no red: overdue is
// the attention tone on the due phrase and nothing else, and a family's
// progress is the words `2 of 5` in the meta line.
//
// EVERY STRING FROM THE VAULT GOES THROUGH `displayText`. A title, a tag label
// and a project name can all arrive from an import, a share or another member,
// and React escaping alone leaves invisible control characters able to spoof a
// label (apps/_shared/untrusted.ts).
import type { ReactNode } from "react";

import { PendingWriteActions } from "../../_shared/PendingWriteActions.tsx";
import { readPendingOverlay } from "../../_shared/pending-overlay.ts";
import { displayText } from "../../_shared/untrusted.ts";
import { metaParts, priorityLevel } from "../format.ts";
import type { Task } from "../types.ts";
import { PENDING_ROW, PRIORITY_CHIPS, VAULT_MARKER } from "../view-copy.ts";

import styles from "./Board.module.css";

export interface TaskRowProps {
  task: Task;
  now: string;
  /** The row's project, already resolved — a row never reads the project table
   *  for itself, so one lookup answers a whole list. */
  projectName?: string | null;
  /** The hue slot for the project dot: a CONTENT marker, never a control. */
  projectHue?: string | null;
  /** This row lives in a vault that is not the member's own, so it carries the
   *  read-only marker. Personal is silence — the default needs no marker. */
  shared?: boolean;
  /** A subtask: the pill box, the indent, and no family twist of its own. */
  child?: boolean;
  /** The logbook's rendering — done glyph or `–`, and Reopen as the row act. */
  log?: boolean;
  /** The keyboard is on this row (§7's `j/k`). */
  focused?: boolean;
  /** The family twist, on a parent that has children. */
  collapsed?: boolean;
  onToggleFamily?: () => void;
  onOpen: () => void;
  onComplete: () => void;
  onReopen?: () => void;
  /** Retry/discard for a write that has not settled — the shared chip. */
  onEditPending?: () => void;
}

/** The box's glyph. In-process is `–`, not a half-tick: a task being worked on
 *  is not a task half-done, and the two states must not look like degrees of
 *  the same thing. */
function boxGlyph(task: Task, log: boolean): string {
  if (log) return task.status === "cancelled" ? "–" : "✓";
  if (task.status === "completed") return "✓";
  return task.status === "in-process" ? "–" : "";
}

export function TaskRow(props: TaskRowProps): ReactNode {
  const { task } = props;
  const pending = readPendingOverlay(task as unknown as Record<string, unknown>);
  const done = task.status === "completed" || task.status === "cancelled";
  const level = priorityLevel(task.priority);
  const parts = metaParts({
    task,
    now: props.now,
    ...(props.projectName ? { projectName: props.projectName } : {}),
  });
  const children = task.children ?? [];

  return (
    <div
      className={styles.rowWrap}
      data-pending={pending ? "true" : undefined}
      data-child={props.child ? "true" : undefined}
      data-scope={task.scope_id ? task.scope_id : undefined}
      data-task-id={task.task_id}
    >
      <div
        className={styles.row}
        data-focused={props.focused ? "true" : undefined}
      >
        <button
          type="button"
          className={styles.box}
          data-child={props.child ? "true" : undefined}
          data-done={done ? "true" : undefined}
          aria-pressed={done}
          aria-label={displayText(task.title)}
          onClick={props.log ? props.onReopen : props.onComplete}
        >
          <span aria-hidden="true">{boxGlyph(task, props.log === true)}</span>
        </button>

        <button type="button" className={styles.open} onClick={props.onOpen}>
          <span className={styles.title} data-done={done ? "true" : undefined}>
            {displayText(task.title)}
          </span>
          <span className={styles.meta}>
            {props.projectHue ? (
              <span
                aria-hidden="true"
                className={styles.dot}
                style={{ background: `var(--c-${props.projectHue}-text)` }}
              />
            ) : null}
            {parts.map((part) => (
              <span
                key={part.text}
                className={part.numeric ? styles.num : undefined}
                data-attention={part.attention ? "true" : undefined}
              >
                {displayText(part.text)}
              </span>
            ))}
            {pending ? <span>{PENDING_ROW}</span> : null}
          </span>
        </button>

        {children.length > 0 && props.onToggleFamily ? (
          <button
            type="button"
            className={styles.twist}
            aria-expanded={props.collapsed !== true}
            aria-label={displayText(task.title)}
            onClick={props.onToggleFamily}
          >
            <span aria-hidden="true">{props.collapsed ? "▸" : "▾"}</span>
          </button>
        ) : null}

        {/* Priority as a trailing micro-caps word on a pointer surface. It is
            absent by default and no layout reserves room for it (ruling 5) —
            this cell simply is not drawn when the task carries no level. */}
        {level > 0 ? (
          <span className={styles.priority}>{PRIORITY_CHIPS[level]}</span>
        ) : null}

        {/* The vault marker: a READ-ONLY status chip, never a control colour. */}
        {props.shared ? (
          <span className={styles.vault}>{VAULT_MARKER}</span>
        ) : null}
      </div>

      {pending ? (
        <div className={styles.pendingActions}>
          <PendingWriteActions
            row={task as unknown as Record<string, unknown>}
            {...(props.onEditPending ? { onEdit: props.onEditPending } : {})}
          />
        </div>
      ) : null}
    </div>
  );
}
