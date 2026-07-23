// One task row on the board or in the logbook. Top-level tasks only — v2
// keeps subtasks out of the board (they live inside the detail drawer's own
// subtask list, Things-style); a row only ever carries a "1/3" badge for
// them. Local `completing` state gives the circle an optimistic fill the
// instant it's clicked, reverting if the write didn't execute.
import { useState } from 'react';
import type { MouseEvent } from 'react';
import { flagLevel, fmtDay, fmtEffort, highlightSegments, todayStr } from '../format.ts';
import type { Task } from '../types.ts';
import { Icon, Snippet } from './Shared.tsx';
import { I } from '../icons.ts';
import styles from './Row.module.css';
import shared from './shared.module.css';

const FLAG_MOD: Record<'high' | 'medium' | 'low', string> = {
  high: styles.high!,
  medium: styles.medium!,
  low: styles.low!,
};

function Highlighted({ text, term }: { text: string; term: string }) {
  const segments = highlightSegments(text, term);
  return segments.map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : s.text));
}

export function Row({
  task,
  closed = false,
  pending = false,
  search = '',
  snippet,
  onOpen,
  onToggle,
}: {
  task: Task;
  closed?: boolean;
  pending?: boolean;
  search?: string;
  snippet?: string;
  onOpen: (id: string) => void;
  onToggle: (task: Task) => Promise<boolean>;
}) {
  const [completing, setCompleting] = useState(false);
  const isOpen = task.status === 'needs-action' || task.status === 'in-process';
  const cancelled = task.status === 'cancelled';
  const isDone = task.status === 'completed' || completing;
  const level = flagLevel(task.priority);
  const note = String(task.description ?? '').trim();
  const overdue = Boolean(isOpen && task.due_at && String(task.due_at).slice(0, 10) < todayStr());

  const handleToggle = async (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (closed) return;
    if (!isOpen) {
      onToggle(task);
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
      onClick={closed ? undefined : () => onOpen(task.task_id)}
    >
      <button
        type="button"
        className={shared.circle}
        data-on={String(task.status === 'completed' || completing)}
        data-cancelled={String(cancelled)}
        aria-label={isDone ? 'Reopen task' : 'Complete task'}
        onClick={handleToggle}
      >
        {isDone ? <Icon svg={I.check} /> : cancelled ? <Icon svg={I.cancelMark} /> : null}
      </button>

      <div className={shared.rowMain}>
        <div className={shared.rowTitleLine}>
          <span className={isDone ? `${shared.rowTitle} ${shared.done}` : shared.rowTitle}>
            <Highlighted text={task.title} term={search} />
          </span>
          {task.status === 'in-process' ? (
            <span className={`${styles.badge} ${styles.doing}`}>in progress</span>
          ) : null}
          {task.rrule ? (
            <span className={styles.recur} aria-hidden="true">
              ↻
            </span>
          ) : null}
          {pending ? <span className="kit-pending-chip">pending</span> : null}
        </div>
        {snippet ? (
          <Snippet snippet={snippet} className={styles.rowNote} />
        ) : note ? (
          <div className={styles.rowNote}>{note.split('\n')[0]}</div>
        ) : null}
        {task.tags?.length ? (
          <div className={styles.rowTags}>
            {task.tags.map((t) => (
              <span className={`${shared.tagChip} ${styles.tagChipStatic}`} key={t.tag_id}>
                #{t.label}
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
      {task.effort_min ? <span className={styles.meta}>{fmtEffort(task.effort_min)}</span> : null}
      {level ? (
        <span className={`${styles.flag} ${FLAG_MOD[level]}`} aria-hidden="true">
          ⚑
        </span>
      ) : null}
      {!closed && task.due_at ? (
        <span className={overdue ? `${shared.due} ${shared.overdue}` : shared.due}>
          {fmtDay(task.due_at)}
        </span>
      ) : null}
      {closed && (task.completed_at || task.due_at) ? (
        <span className={shared.due}>{fmtDay(task.completed_at ?? task.due_at)}</span>
      ) : null}
    </div>
  );
}
