// The right slide-over detail drawer. Mounted keyed by task_id at the call
// site (app.tsx) so switching tasks remounts this component fresh — local
// title/notes/subtask-draft state always starts from the newly opened task,
// no stale-buffer bugs, no defaultValue tricks. Edits commit on blur/Enter
// (never per keystroke) so typing never spams the vault with writes.
import { useEffect, useRef, useState } from '../react-core.min.js';
import type { ChangeEvent, FormEvent, KeyboardEvent, MouseEvent } from '../react-core.min.js';
import { renderAttachments } from '../kit.js';
import { flagLevel, fmtDay, plusDays, todayStr } from '../format.ts';
import type { ActivityEntry, EditPatch, Task } from '../types.ts';
import { I } from '../icons.ts';
import { Icon } from './Shared.tsx';
import styles from './Detail.module.css';
import shared from './shared.module.css';

const PRIORITY_CHIPS: Array<{ value: number; label: string }> = [
  { value: 0, label: '—' },
  { value: 1, label: 'High' },
  { value: 5, label: 'Med' },
  { value: 9, label: 'Low' },
];
// Effort has no "clear" affordance: actions/edit.ts only forwards
// `effort_min` when it's truthy (`if (raw.effort_min) …`), so a value of 0
// can never reach the vault — there is no clearing chip here, only the set.
const EFFORT_CHIPS: Array<{ value: number; label: string }> = [
  { value: 15, label: '15m' },
  { value: 30, label: '30m' },
  { value: 60, label: '1h' },
];
const REPEAT_CHIPS: Array<{ value: string | null; label: string }> = [
  { value: null, label: '—' },
  { value: 'FREQ=DAILY', label: 'Daily' },
  { value: 'FREQ=WEEKLY', label: 'Weekly' },
  { value: 'FREQ=MONTHLY', label: 'Monthly' },
];
const REMIND_CHIPS: Array<{ value: number | null; label: string }> = [
  { value: null, label: '—' },
  { value: 0, label: 'At time' },
  { value: 15, label: '15m' },
  { value: 60, label: '1h' },
  { value: 1440, label: '1 day' },
];

function TagStrip({
  task,
  onAddTag,
  onRemoveTag,
}: {
  task: Task;
  onAddTag: (taskId: string, label: string) => void;
  onRemoveTag: (tagId: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const label = draft.trim();
    if (!label) return;
    onAddTag(task.task_id, label);
    setDraft('');
  };
  return (
    <div className={styles.tagStrip}>
      {(task.tags ?? []).map((t) => (
        <span className={shared.tagChip} key={t.tag_id}>
          #{t.label}
          <button
            type="button"
            className={styles.tagRemove}
            aria-label={`Remove tag ${t.label}`}
            onClick={() => onRemoveTag(t.tag_id)}
          >
            <Icon svg={I.close} />
          </button>
        </span>
      ))}
      <form className={styles.tagAdd} onSubmit={submit}>
        <input
          type="text"
          className={styles.tagInput}
          placeholder="Add a tag…"
          aria-label="Add a tag"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      </form>
    </div>
  );
}

function AttachStrip({
  task,
  onRemove,
}: {
  task: Task;
  onRemove: (attachmentId: string) => Promise<VaultOutcome | undefined>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) renderAttachments(ref.current, task.attachments ?? [], onRemove);
  }, [task.attachments, onRemove]);
  if (!task.attachments?.length) return null;
  return <div className={`kit-attach-strip ${styles.detailAttach}`} ref={ref} />;
}

interface DetailProps {
  task: Task;
  pending: boolean;
  activity: ActivityEntry[];
  onClose: () => void;
  onToggleStatus: (t: Task) => void;
  onTitleCommit: (id: string, title: string) => void;
  onNotesCommit: (id: string, patch: EditPatch) => void;
  onPickDue: (id: string, patch: EditPatch) => void;
  onPickPriority: (id: string, value: number) => void;
  onPickEffort: (id: string, value: number) => void;
  onPickRepeat: (id: string, patch: EditPatch) => void;
  onPickRemind: (id: string, patch: EditPatch) => void;
  onToggleSubtask: (sub: Task) => void;
  onAddSubtask: (parentId: string, title: string) => void;
  onAttach: (taskId: string) => void;
  onRemoveAttachment: (attachmentId: string) => Promise<VaultOutcome | undefined>;
  onAddTag: (taskId: string, label: string) => void;
  onRemoveTag: (tagId: string) => void;
  onToggleProcess: (t: Task) => void;
  onCancel: (t: Task) => void;
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
  onPickRepeat,
  onPickRemind,
  onToggleSubtask,
  onAddSubtask,
  onAttach,
  onRemoveAttachment,
  onAddTag,
  onRemoveTag,
  onToggleProcess,
  onCancel,
}: DetailProps) {
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
      className={styles.detailBackdrop}
      onClick={(e: MouseEvent<HTMLDivElement>) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={pending ? `${styles.detail} kit-pending` : styles.detail}>
        <div className={styles.detailHead}>
          <button
            type="button"
            className={`${shared.circle} ${shared.lg}`}
            data-on={String(isDone)}
            data-cancelled={String(cancelled)}
            aria-label={isDone ? 'Reopen task' : 'Complete task'}
            onClick={() => onToggleStatus(task)}
          >
            {isDone ? <Icon svg={I.check} /> : null}
          </button>
          <span className={shared.eyebrowLabel}>{statusLabel}</span>
          {pending ? <span className="kit-pending-chip">pending</span> : null}
          <button
            type="button"
            className={`kit-icon-btn ${styles.detailClose}`}
            aria-label="Close"
            onClick={onClose}
          >
            <Icon svg={I.close} />
          </button>
        </div>

        <div className={styles.detailBody}>
          <input
            type="text"
            className={styles.detailTitle}
            placeholder="Task title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
          <textarea
            className={styles.detailNotes}
            placeholder="Notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={commitNotes}
          />

          <div className={shared.eyebrowLabel}>When</div>
          <div className={`kit-seg ${styles.detailSeg}`}>
            {duePresets.map((c) => {
              const active = c.due
                ? task.due_at && String(task.due_at).slice(0, 10) === c.due
                : !task.due_at;
              return (
                <button
                  key={c.key}
                  type="button"
                  className={active ? 'on' : ''}
                  aria-pressed={Boolean(active)}
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
            className={`kit-input ${styles.detailDate}`}
            aria-label="Due date"
            value={task.due_at ? String(task.due_at).slice(0, 10) : ''}
            onChange={(e) => {
              if (e.target.value) onPickDue(task.task_id, { due_at: e.target.value });
            }}
          />

          <div className={styles.detailCols}>
            <div>
              <div className={shared.eyebrowLabel}>Priority</div>
              <div className={`kit-seg ${styles.detailSeg}`}>
                {PRIORITY_CHIPS.map((c) => {
                  const active =
                    c.value === 0
                      ? !task.priority
                      : flagLevel(task.priority) === flagLevel(c.value);
                  return (
                    <button
                      key={c.value}
                      type="button"
                      className={active ? 'on' : ''}
                      aria-pressed={Boolean(active)}
                      onClick={() => onPickPriority(task.task_id, c.value)}
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <div className={shared.eyebrowLabel}>Effort</div>
              <div className={`kit-seg ${styles.detailSeg}`}>
                {EFFORT_CHIPS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    className={task.effort_min === c.value ? 'on' : ''}
                    aria-pressed={task.effort_min === c.value}
                    onClick={() => onPickEffort(task.task_id, c.value)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className={styles.detailCols}>
            <div>
              <div className={shared.eyebrowLabel}>Repeat</div>
              <div className={`kit-seg ${styles.detailSeg}`}>
                {REPEAT_CHIPS.map((c) => (
                  <button
                    key={c.label}
                    type="button"
                    className={task.rrule === c.value ? 'on' : ''}
                    aria-pressed={task.rrule === c.value}
                    disabled={!task.due_at}
                    onClick={() =>
                      onPickRepeat(
                        task.task_id,
                        c.value ? { rrule: c.value } : { clear_rrule: true },
                      )
                    }
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className={shared.eyebrowLabel}>Remind</div>
              <div className={`kit-seg ${styles.detailSeg}`}>
                {REMIND_CHIPS.map((c) => {
                  const active =
                    c.value === null
                      ? task.remind_before_min == null
                      : task.remind_before_min === c.value;
                  return (
                    <button
                      key={c.label}
                      type="button"
                      className={active ? 'on' : ''}
                      aria-pressed={active}
                      disabled={!task.due_at}
                      onClick={() =>
                        onPickRemind(
                          task.task_id,
                          c.value == null ? { clear_remind: true } : { remind_before_min: c.value },
                        )
                      }
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          {!task.due_at ? (
            <p className={`muted small ${styles.detailHint}`}>
              Set a due date to repeat or remind on this task.
            </p>
          ) : null}

          <div className={shared.eyebrowLabel}>Tags</div>
          <TagStrip task={task} onAddTag={onAddTag} onRemoveTag={onRemoveTag} />

          <div className={shared.eyebrowLabel}>
            Subtasks{children.length ? ` · ${doneChildren}/${children.length}` : ''}
          </div>
          <div className={styles.subtasks}>
            {children.map((s) => (
              <div className={styles.subtaskRow} key={s.task_id}>
                <button
                  type="button"
                  className={`${shared.circle} ${shared.sm}`}
                  data-on={String(s.status === 'completed')}
                  aria-label={s.status === 'completed' ? 'Reopen subtask' : 'Complete subtask'}
                  onClick={() => onToggleSubtask(s)}
                >
                  {s.status === 'completed' ? <Icon svg={I.check} /> : null}
                </button>
                <span
                  className={
                    s.status === 'completed'
                      ? `${styles.subtaskTitle} ${styles.done}`
                      : styles.subtaskTitle
                  }
                >
                  {s.title}
                </span>
              </div>
            ))}
            <div className={`${styles.subtaskRow} ${styles.subtaskAdd}`}>
              <span className={styles.subtaskDot} aria-hidden="true" />
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

          <div className={shared.eyebrowLabel}>Activity</div>
          <div className={styles.activity}>
            {activity.length === 0 ? (
              <p className={`${styles.activityEmpty} muted small`}>No activity yet this session.</p>
            ) : (
              activity.map((a, i) => (
                <div className={styles.activityItem} key={i}>
                  <span className={styles.activityRail} aria-hidden="true" />
                  <div>
                    <div className={styles.activityText}>{a.text}</div>
                    <div className={styles.activityMeta}>
                      <span className={styles.activityDate}>{a.when}</span>
                      {a.receiptId ? <span className={styles.receiptChip}>receipt</span> : null}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className={shared.eyebrowLabel}>Attachments</div>
          <AttachStrip task={task} onRemove={onRemoveAttachment} />
          <button
            type="button"
            className={`kit-btn ${styles.attachBtn}`}
            onClick={() => onAttach(task.task_id)}
          >
            Attach a file
          </button>
        </div>

        <div className={styles.detailFoot}>
          <button
            type="button"
            className={`kit-btn ${styles.flex}`}
            onClick={() => onToggleProcess(task)}
          >
            {task.status === 'in-process' ? 'Pause' : 'Start'}
          </button>
          <button
            type="button"
            className={`kit-btn danger ${styles.flex}`}
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
