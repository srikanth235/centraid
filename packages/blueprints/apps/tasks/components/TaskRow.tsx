// One task row for every list in this room (spec §5); one component because
// it appears in eight places. NOTHING COUNTS AT THE MEMBER: no badge/dot/red.
// EVERY STRING FROM THE VAULT GOES THROUGH `displayText` (untrusted.ts).
import type { ReactNode } from "react";

import {
  pendingSidecarOf,
  readPendingOverlay,
} from "../../_shared/pending-overlay.ts";
import { PendingWriteActions } from "../../_shared/PendingWriteActions.tsx";
import { displayText } from "../../_shared/untrusted.ts";
import { metaParts, priorityLevel } from "../format.ts";
import type { Task } from "../types.ts";
import { PENDING_ROW, PRIORITY_CHIPS, VAULT_MARKER } from "../view-copy.ts";

import styles from "./Board.module.css";

export interface TaskRowProps {
  task: Task;
  now: string;
  /** Pre-resolved project name — one lookup answers a whole list. */
  projectName?: string | null;
  /** Hue slot for the project dot: CONTENT, never a control. */
  projectHue?: string | null;
  /** Non-member vault: carries the read-only marker. */
  shared?: boolean;
  /** A subtask: pill box + indent. */
  child?: boolean;
  log?: boolean;
  focused?: boolean;
  collapsed?: boolean;
  onToggleFamily?: () => void;
  onOpen: () => void;
  onComplete: () => void;
  onReopen?: () => void;
  /** Retry/discard chip for an unsettled write. */
  onEditPending?: () => void;
}

/** In-process is `–`, not a half-tick: worked-on is not half-done. */
function boxGlyph(task: Task, log: boolean): string {
  if (log) return task.status === "cancelled" ? "–" : "✓";
  if (task.status === "completed") return "✓";
  return task.status === "in-process" ? "–" : "";
}

export function TaskRow(props: TaskRowProps): ReactNode {
  const { task } = props;
  const taskRecord = task as unknown as Record<string, unknown>;
  const pending = readPendingOverlay(taskRecord, pendingSidecarOf(taskRecord));
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

        {/* Trailing micro-caps priority word; absent by default, no reserved
            room (ruling 5). */}
        {level > 0 ? (
          <span className={styles.priority}>{PRIORITY_CHIPS[level]}</span>
        ) : null}

        {/* Vault marker: a READ-ONLY status chip, never a control colour. */}
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
