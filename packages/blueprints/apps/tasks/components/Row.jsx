// One task row on the board or in the logbook. Top-level tasks only — v2
// keeps subtasks out of the board (they live inside the detail drawer's own
// subtask list, Things-style); a row only ever carries a "1/3" badge for
// them. Local `completing` state gives the circle an optimistic fill the
// instant it's clicked, reverting if the write didn't execute.
import { useState } from '../react-core.min.js';
import { flagLevel, fmtDay, fmtEffort, highlightSegments, todayStr } from '../format.js';
import { I } from '../icons.js';
import { Icon, Snippet } from './Shared.jsx';

function Highlighted({ text, term }) {
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
}) {
  const [completing, setCompleting] = useState(false);
  const isOpen = task.status === 'needs-action' || task.status === 'in-process';
  const cancelled = task.status === 'cancelled';
  const isDone = task.status === 'completed' || completing;
  const level = flagLevel(task.priority);
  const note = String(task.description ?? '').trim();
  const overdue = Boolean(isOpen && task.due_at && String(task.due_at).slice(0, 10) < todayStr());

  const handleToggle = async (e) => {
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
      className={pending ? 'tk-row kit-pending' : 'tk-row'}
      data-status={task.status}
      onClick={closed ? undefined : () => onOpen(task.task_id)}
    >
      <button
        type="button"
        className="tk-circle"
        data-on={String(task.status === 'completed' || completing)}
        data-cancelled={String(cancelled)}
        aria-label={isDone ? 'Reopen task' : 'Complete task'}
        onClick={handleToggle}
      >
        {isDone ? <Icon svg={I.check} /> : cancelled ? <Icon svg={I.cancelMark} /> : null}
      </button>

      <div className="tk-row-main">
        <div className="tk-row-title-line">
          <span className={isDone ? 'tk-row-title done' : 'tk-row-title'}>
            <Highlighted text={task.title} term={search} />
          </span>
          {task.status === 'in-process' ? (
            <span className="tk-badge doing">in progress</span>
          ) : null}
          {task.rrule ? (
            <span className="tk-recur" aria-hidden="true">
              ↻
            </span>
          ) : null}
          {pending ? <span className="kit-pending-chip">pending</span> : null}
        </div>
        {snippet ? (
          <Snippet snippet={snippet} className="tk-row-note" />
        ) : note ? (
          <div className="tk-row-note">{note.split('\n')[0]}</div>
        ) : null}
        {task.tags?.length ? (
          <div className="tk-row-tags">
            {task.tags.map((t) => (
              <span className="tk-tag-chip tk-tag-chip-static" key={t.tag_id}>
                #{t.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {!closed && task.children?.length ? (
        <span className="tk-meta">
          {task.done_children}/{task.children.length}
        </span>
      ) : null}
      {task.effort_min ? <span className="tk-meta">{fmtEffort(task.effort_min)}</span> : null}
      {level ? (
        <span className={`tk-flag ${level}`} aria-hidden="true">
          ⚑
        </span>
      ) : null}
      {!closed && task.due_at ? (
        <span className={overdue ? 'tk-due overdue' : 'tk-due'}>{fmtDay(task.due_at)}</span>
      ) : null}
      {closed && (task.completed_at || task.due_at) ? (
        <span className="tk-due">{fmtDay(task.completed_at ?? task.due_at)}</span>
      ) : null}
    </div>
  );
}
