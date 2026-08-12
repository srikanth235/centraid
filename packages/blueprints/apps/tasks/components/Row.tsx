// One task row on the board or in the logbook. Top-level tasks only — v2
// keeps subtasks out of the board (they live inside the detail drawer's own
// subtask list, Things-style); a row only ever carries a "1/3" badge for
// them. Local `completing` state gives the circle an optimistic fill the
// instant it's clicked, reverting if the write didn't execute.
import { useState } from "react";

import { readPendingOverlay } from "../../_shared/pending-overlay.ts";
import { PendingWriteActions } from "../../_shared/PendingWriteActions.tsx";
import { displayText } from "../../_shared/untrusted.ts";
import {
  flagLevel,
  fmtDay,
  fmtEffort,
  highlightSegments,
  todayStr,
} from "../format.ts";
import { I } from "../icons.ts";
import type { Task } from "../types.ts";
import { Icon, Snippet } from "./Shared.tsx";

import styles from "./Row.module.css";
import shared from "./shared.module.css";

const FLAG_MOD: Record<"high" | "medium" | "low", string> = {
  high: styles.high!,
  medium: styles.medium!,
  low: styles.low!,
};

function Highlighted({ text, term }: { text: string; term: string }) {
  const segments = highlightSegments(displayText(text), displayText(term));
  return segments.map((s, i) =>
    s.hit ? <mark key={i}>{s.text}</mark> : s.text
  );
}

export function Row({
  task,
  closed = false,
  search = "",
  snippet,
  onOpen,
  onToggle,
}: {
  task: Task;
  closed?: boolean;
  search?: string;
  snippet?: string;
  onOpen: (id: string) => void;
  onToggle: (task: Task) => Promise<boolean>;
}) {
  const [completing, setCompleting] = useState(false);
  const pending = readPendingOverlay(
    task as unknown as Record<string, unknown>
  );
  const isOpen = task.status === "needs-action" || task.status === "in-process";
  const cancelled = task.status === "cancelled";
  const isDone = task.status === "completed" || completing;
  const level = flagLevel(task.priority);
  const title = displayText(task.title);
  const note = displayText(task.description).trim();
  const overdue = Boolean(
    isOpen && task.due_at && String(task.due_at).slice(0, 10) < todayStr()
  );

  // No `stopPropagation` any more: the row's own click handler is gone (the
  // "open" button below is a sibling laid under this circle), so there is
  // nothing above to stop.
  const handleToggle = async () => {
    if (closed) return;
    if (!isOpen) {
      void onToggle(task);
      return;
    }
    setCompleting(true);
    const ok = await onToggle(task);
    if (!ok) setCompleting(false);
  };

  return (
    <div
      className={pending ? `${shared.row} kit-pending` : shared.row}
      data-status={task.status}
    >
      {/* "Open the task" used to be a click handler on the row <div>, which no
          keyboard could reach. It is a real button now, stretched across the row
          and laid UNDER the completion circle (`.circle` is already
          `position: relative`), so a row that contains its own control never
          nests one button inside another. Closed rows had no handler at all —
          they still get no button. */}
      {closed ? null : (
        <button
          type="button"
          className="kit-stretch-btn"
          aria-label={`Open ${title}`}
          onClick={() => onOpen(task.task_id)}
        />
      )}
      <button
        type="button"
        className={shared.circle}
        data-on={String(task.status === "completed" || completing)}
        data-cancelled={String(cancelled)}
        aria-label={isDone ? "Reopen task" : "Complete task"}
        onClick={handleToggle}
      >
        {isDone ? (
          <Icon svg={I.check} />
        ) : cancelled ? (
          <Icon svg={I.cancelMark} />
        ) : null}
      </button>

      <div className={shared.rowMain}>
        <div className={shared.rowTitleLine}>
          <span
            className={
              isDone ? `${shared.rowTitle} ${shared.done}` : shared.rowTitle
            }
          >
            <Highlighted text={title} term={search} />
          </span>
          {task.status === "in-process" ? (
            <span className={`${styles.badge} ${styles.doing}`}>
              in progress
            </span>
          ) : null}
          {task.rrule ? (
            <span className={styles.recur} aria-hidden="true">
              ↻
            </span>
          ) : null}
          {pending ? (
            <PendingWriteActions
              row={task as unknown as Record<string, unknown>}
              onEdit={() => onOpen(task.task_id)}
            />
          ) : null}
        </div>
        {snippet ? (
          <Snippet snippet={snippet} className={styles.rowNote} />
        ) : note ? (
          <div className={styles.rowNote}>{note.split("\n")[0]}</div>
        ) : null}
        {task.tags?.length ? (
          <div className={styles.rowTags}>
            {task.tags.map((t) => (
              <span
                className={`${shared.tagChip} ${styles.tagChipStatic}`}
                key={t.tag_id}
              >
                #{displayText(t.label)}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {!closed && task.children?.length ? (
        <span className={styles.meta}>
          {task.done_children}/{task.children.length}
        </span>
      ) : null}
      {task.effort_min ? (
        <span className={styles.meta}>{fmtEffort(task.effort_min)}</span>
      ) : null}
      {level ? (
        <span
          className={`${styles.flag} ${FLAG_MOD[level]}`}
          aria-hidden="true"
        >
          ⚑
        </span>
      ) : null}
      {!closed && task.due_at ? (
        <span
          className={overdue ? `${shared.due} ${shared.overdue}` : shared.due}
        >
          {fmtDay(task.due_at)}
        </span>
      ) : null}
      {closed && (task.completed_at || task.due_at) ? (
        <span className={shared.due}>
          {fmtDay(task.completed_at ?? task.due_at)}
        </span>
      ) : null}
    </div>
  );
}
