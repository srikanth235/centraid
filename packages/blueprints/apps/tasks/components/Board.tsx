// The list every board route paints: groups, their headers, the families kept
// whole inside them, and the honest end of the window (spec §5, §4).
//
// A GROUP HEADER CARRIES UP TO TWO QUIET VERBS, one on touch. Overdue is the
// only group that has two — *Move all to today* beside *Catch up* — and neither
// is filled: the one filled control in any view is capture, and a bulk gesture
// offered as the loudest thing on screen would read as the thing to do.
//
// FAMILIES ARE NEVER SPLIT BY A FILTER. A parent renders with its children
// underneath it or with a twist collapsing them, and the children come from the
// row itself rather than a second pass over the board — which is what keeps a
// windowed parent from appearing to have lost its work.
import type { ReactNode } from "react";

import { displayText } from "../../_shared/untrusted.ts";
import type { Task, TaskGroup } from "../types.ts";
import { GROUPS, windowEndBoard } from "../view-copy.ts";
import { TaskRow } from "./TaskRow.tsx";

import styles from "./Board.module.css";

export interface RowContext {
  now: string;
  projectName: (id: string | null | undefined) => string | null;
  projectHue: (id: string | null | undefined) => string | null;
  isShared: (task: Task) => boolean;
  collapsed: (taskId: string) => boolean;
  cursorId: string | null;
  onToggleFamily: (taskId: string) => void;
  onOpen: (taskId: string) => void;
  onComplete: (task: Task) => void;
  onReopen?: (task: Task) => void;
}

/** One task and, unless the member folded them away, its one level of
 *  children. One level only — a subtask cannot have a subtask (§3). */
export function TaskFamily({
  task,
  ctx,
  log,
}: {
  task: Task;
  ctx: RowContext;
  log?: boolean;
}): ReactNode {
  const children = task.children ?? [];
  const folded = ctx.collapsed(task.task_id);
  return (
    <>
      <TaskRow
        task={task}
        now={ctx.now}
        projectName={ctx.projectName(task.project_id)}
        projectHue={ctx.projectHue(task.project_id)}
        shared={ctx.isShared(task)}
        focused={ctx.cursorId === task.task_id}
        collapsed={folded}
        {...(log ? { log: true } : {})}
        {...(children.length > 0
          ? { onToggleFamily: () => ctx.onToggleFamily(task.task_id) }
          : {})}
        {...(ctx.onReopen ? { onReopen: () => ctx.onReopen?.(task) } : {})}
        onOpen={() => ctx.onOpen(task.task_id)}
        onComplete={() => ctx.onComplete(task)}
        onEditPending={() => ctx.onOpen(task.task_id)}
      />
      {folded
        ? null
        : children.map((child) => (
            <TaskRow
              key={child.task_id}
              task={child}
              now={ctx.now}
              child
              projectName={null}
              projectHue={null}
              shared={ctx.isShared(child)}
              focused={ctx.cursorId === child.task_id}
              onOpen={() => ctx.onOpen(child.task_id)}
              onComplete={() => ctx.onComplete(child)}
            />
          ))}
    </>
  );
}

export interface GroupHeaderProps {
  group: TaskGroup;
  /** At most two, and the second is withheld on touch (§5). */
  verbs?: readonly { label: string; run: () => void }[];
  narrow: boolean;
}

export function GroupHeader({
  group,
  verbs = [],
  narrow,
}: GroupHeaderProps): ReactNode {
  const offered = narrow ? verbs.slice(0, 1) : verbs.slice(0, 2);
  return (
    <div
      className={styles.groupHead}
      data-attention={group.attention ? "true" : undefined}
    >
      <span className={styles.groupLabel}>{displayText(group.label)}</span>
      {group.meta ? (
        <span className={`${styles.groupMeta} ${styles.num}`}>
          {displayText(group.meta)}
        </span>
      ) : null}
      <span className={styles.groupVerbs}>
        {offered.map((verb) => (
          <button
            key={verb.label}
            type="button"
            className="kit-plain-btn"
            onClick={verb.run}
          >
            {verb.label}
          </button>
        ))}
      </span>
    </div>
  );
}

export interface BoardProps {
  groups: readonly TaskGroup[];
  ctx: RowContext;
  narrow: boolean;
  /** The overdue group's two verbs, supplied by the route that has them. */
  overdueVerbs?: readonly { label: string; run: () => void }[];
  /** `60 of 214 · this is a window, not everything open`, or null when the
   *  vault answered with everything it holds. */
  windowEnd?: { shown: number; total: number } | null;
  onShowMore?: () => void;
  /** What stands here when there is nothing to stand — supplied by the route,
   *  because every screen is empty ON ITS OWN TERMS. */
  empty?: ReactNode;
  log?: boolean;
}

export function Board(props: BoardProps): ReactNode {
  if (props.groups.length === 0) return <>{props.empty}</>;
  return (
    <div className={styles.board}>
      {props.groups.map((group) => (
        <section key={group.key} className={styles.group}>
          <GroupHeader
            group={group}
            narrow={props.narrow}
            {...(group.attention && props.overdueVerbs
              ? { verbs: props.overdueVerbs }
              : {})}
          />
          {group.rows.map((task) => (
            <TaskFamily
              key={task.task_id}
              task={task}
              ctx={props.ctx}
              {...(props.log ? { log: true } : {})}
            />
          ))}
        </section>
      ))}
      {props.windowEnd ? (
        <div className={styles.windowEnd}>
          <span className={styles.num}>
            {windowEndBoard(props.windowEnd.shown, props.windowEnd.total)}
          </span>
          {props.onShowMore ? (
            <button
              type="button"
              className="kit-plain-btn"
              onClick={props.onShowMore}
            >
              {GROUPS.showMore}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
