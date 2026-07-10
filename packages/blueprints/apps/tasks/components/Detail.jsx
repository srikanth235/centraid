// The right slide-over detail drawer. Mounted keyed by task_id at the call
// site (app.jsx) so switching tasks remounts this component fresh — local
// title/notes/subtask-draft state always starts from the newly opened task,
// no stale-buffer bugs, no defaultValue tricks. Edits commit on blur/Enter
// (never per keystroke) so typing never spams the vault with writes.
import { useEffect, useRef, useState } from '../react-core.min.js';
import { renderAttachments } from '../kit.js';
import { flagLevel, fmtDay, plusDays, todayStr } from '../format.js';
import { I } from '../icons.js';
import { Icon } from './Shared.jsx';

const PRIORITY_CHIPS = [
  { value: 0, label: '—' },
  { value: 1, label: 'High' },
  { value: 5, label: 'Med' },
  { value: 9, label: 'Low' },
];
// Effort has no "clear" affordance: actions/edit.js only forwards
// `effort_min` when it's truthy (`if (raw.effort_min) …`), so a value of 0
// can never reach the vault — there is no clearing chip here, only the set.
const EFFORT_CHIPS = [
  { value: 15, label: '15m' },
  { value: 30, label: '30m' },
  { value: 60, label: '1h' },
];

function AttachStrip({ task, onRemove }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) renderAttachments(ref.current, task.attachments ?? [], onRemove);
  }, [task.attachments, onRemove]);
  if (!task.attachments?.length) return null;
  return <div className="kit-attach-strip tk-detail-attach" ref={ref} />;
}

export function Detail({
  task,
  pending,
  activity,
  onClose,
  onToggleStatus,
  onTitleCommit,
  onNotesCommit,
  onPickDue,
  onPickPriority,
  onPickEffort,
  onToggleSubtask,
  onAddSubtask,
  onAttach,
  onRemoveAttachment,
  onToggleProcess,
  onCancel,
}) {
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.description ?? '');
  const [subDraft, setSubDraft] = useState('');

  const isDone = task.status === 'completed';
  const cancelled = task.status === 'cancelled';
  const statusLabel = isDone
    ? 'Completed'
    : task.status === 'in-process'
      ? 'In progress'
      : cancelled
        ? 'Cancelled'
        : 'To do';
  const children = task.children ?? [];
  const doneChildren = children.filter((c) => c.status === 'completed').length;
  const duePresets = [
    { key: 'today', label: 'Today', due: todayStr() },
    { key: 'tomorrow', label: 'Tomorrow', due: plusDays(1) },
    { key: 'week', label: 'Next wk', due: plusDays(7) },
    { key: 'none', label: 'None', due: null },
  ];

  const commitTitle = () => {
    const next = title.trim();
    if (next && next !== task.title) onTitleCommit(task.task_id, next);
    else setTitle(task.title);
  };
  const commitNotes = () => {
    const next = notes.trim();
    const prev = String(task.description ?? '');
    if (next && next !== prev) onNotesCommit(task.task_id, { description: next });
    else if (!next && prev) onNotesCommit(task.task_id, { clear_description: true });
  };
  const submitSubtask = () => {
    const t = subDraft.trim();
    if (!t) return;
    onAddSubtask(task.task_id, t);
    setSubDraft('');
  };

  return (
    <div
      className="tk-detail-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={pending ? 'tk-detail kit-pending' : 'tk-detail'}>
        <div className="tk-detail-head">
          <button
            type="button"
            className="tk-circle lg"
            data-on={String(isDone)}
            data-cancelled={String(cancelled)}
            aria-label={isDone ? 'Reopen task' : 'Complete task'}
            onClick={() => onToggleStatus(task)}
          >
            {isDone ? <Icon svg={I.check} /> : null}
          </button>
          <span className="tk-eyebrow-label">{statusLabel}</span>
          {pending ? <span className="kit-pending-chip">pending</span> : null}
          <button
            type="button"
            className="kit-icon-btn tk-detail-close"
            aria-label="Close"
            onClick={onClose}
          >
            <Icon svg={I.close} />
          </button>
        </div>

        <div className="tk-detail-body">
          <input
            type="text"
            className="tk-detail-title"
            placeholder="Task title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
          <textarea
            className="tk-detail-notes"
            placeholder="Notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={commitNotes}
          />

          <div className="tk-eyebrow-label">When</div>
          <div className="kit-seg tk-detail-seg">
            {duePresets.map((c) => {
              const active = c.due
                ? task.due_at && String(task.due_at).slice(0, 10) === c.due
                : !task.due_at;
              return (
                <button
                  key={c.key}
                  type="button"
                  className={active ? 'on' : ''}
                  aria-pressed={String(active)}
                  onClick={() =>
                    onPickDue(task.task_id, c.due ? { due_at: c.due } : { clear_due: true })
                  }
                >
                  {c.label}
                </button>
              );
            })}
          </div>
          <input
            type="date"
            className="kit-input tk-detail-date"
            aria-label="Due date"
            value={task.due_at ? String(task.due_at).slice(0, 10) : ''}
            onChange={(e) => {
              if (e.target.value) onPickDue(task.task_id, { due_at: e.target.value });
            }}
          />

          <div className="tk-detail-cols">
            <div>
              <div className="tk-eyebrow-label">Priority</div>
              <div className="kit-seg tk-detail-seg">
                {PRIORITY_CHIPS.map((c) => {
                  const active =
                    c.value === 0 ? !task.priority : flagLevel(task.priority) === flagLevel(c.value);
                  return (
                    <button
                      key={c.value}
                      type="button"
                      className={active ? 'on' : ''}
                      aria-pressed={String(active)}
                      onClick={() => onPickPriority(task.task_id, c.value)}
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <div className="tk-eyebrow-label">Effort</div>
              <div className="kit-seg tk-detail-seg">
                {EFFORT_CHIPS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    className={task.effort_min === c.value ? 'on' : ''}
                    aria-pressed={String(task.effort_min === c.value)}
                    onClick={() => onPickEffort(task.task_id, c.value)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="tk-eyebrow-label">
            Subtasks{children.length ? ` · ${doneChildren}/${children.length}` : ''}
          </div>
          <div className="tk-subtasks">
            {children.map((s) => (
              <div className="tk-subtask-row" key={s.task_id}>
                <button
                  type="button"
                  className="tk-circle sm"
                  data-on={String(s.status === 'completed')}
                  aria-label={s.status === 'completed' ? 'Reopen subtask' : 'Complete subtask'}
                  onClick={() => onToggleSubtask(s)}
                >
                  {s.status === 'completed' ? <Icon svg={I.check} /> : null}
                </button>
                <span className={s.status === 'completed' ? 'tk-subtask-title done' : 'tk-subtask-title'}>
                  {s.title}
                </span>
              </div>
            ))}
            <div className="tk-subtask-row tk-subtask-add">
              <span className="tk-subtask-dot" aria-hidden="true" />
              <input
                type="text"
                placeholder="Add subtask"
                aria-label="Add subtask"
                value={subDraft}
                onChange={(e) => setSubDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    submitSubtask();
                  }
                }}
              />
            </div>
          </div>

          <div className="tk-eyebrow-label">Activity</div>
          <div className="tk-activity">
            {activity.length === 0 ? (
              <p className="tk-activity-empty muted small">No activity yet this session.</p>
            ) : (
              activity.map((a, i) => (
                <div className="tk-activity-item" key={i}>
                  <span className="tk-activity-rail" aria-hidden="true" />
                  <div>
                    <div className="tk-activity-text">{a.text}</div>
                    <div className="tk-activity-meta">
                      <span className="tk-activity-date">{a.when}</span>
                      {a.receiptId ? <span className="tk-receipt-chip">receipt</span> : null}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="tk-eyebrow-label">Attachments</div>
          <AttachStrip task={task} onRemove={onRemoveAttachment} />
          <button
            type="button"
            className="kit-btn tk-attach-btn"
            onClick={() => onAttach(task.task_id)}
          >
            Attach a file
          </button>
        </div>

        <div className="tk-detail-foot">
          <button type="button" className="kit-btn tk-flex" onClick={() => onToggleProcess(task)}>
            {task.status === 'in-process' ? 'Pause' : 'Start'}
          </button>
          <button
            type="button"
            className="kit-btn danger tk-flex"
            disabled={cancelled}
            onClick={() => onCancel(task)}
          >
            {cancelled ? 'Cancelled' : 'Cancel task'}
          </button>
        </div>
      </div>
    </div>
  );
}
