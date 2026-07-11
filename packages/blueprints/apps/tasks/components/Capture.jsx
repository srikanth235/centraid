// The capture bar — a self-contained, stateful leaf (its own useState for
// the in-progress draft), so typing here re-renders only this subtree, not
// the whole board. It only calls up to `onSubmit` with the assembled add
// payload; it never touches `state`/`data` directly. Subtasks are captured
// only from inside the open task's own detail drawer (Things-style) — this
// bar always adds a top-level task.
import { useEffect, useRef, useState } from '../react-core.min.js';
import { fmtDay, parseNlDue } from '../format.js';

const DUE_CHIPS = [
  { key: 'none', label: 'None' },
  { key: 'today', label: 'Today' },
  { key: 'tomorrow', label: 'Tmrw' },
  { key: 'week', label: 'Wk' },
];
const PRIO_CHIPS = [
  { key: 0, label: '—' },
  { key: 1, label: 'High' },
  { key: 5, label: 'Med' },
  { key: 9, label: 'Low' },
];

export function Capture({ onSubmit, registerFocus }) {
  const inputRef = useRef(null);
  const [title, setTitle] = useState('');
  const [dueChoice, setDueChoice] = useState('none');
  const [priority, setPriority] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    registerFocus?.(() => inputRef.current?.focus());
  }, [registerFocus]);

  const nl = dueChoice === 'none' ? parseNlDue(title) : null;

  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    const ok = await onSubmit({ title, dueChoice, priority });
    setBusy(false);
    if (ok) {
      setTitle('');
      setDueChoice('none');
      setPriority(0);
      inputRef.current?.focus();
    }
  };

  return (
    <div className="tk-capture">
      <div className="tk-capture-row">
        <span className="tk-capture-dot" aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          className="tk-capture-input"
          placeholder="Add a task — try “Email Dana fri” or “Pay rent +3d”"
          aria-label="Task title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="button"
          className="kit-btn primary tk-capture-add"
          disabled={!title.trim() || busy}
          onClick={submit}
        >
          Add
        </button>
      </div>
      <div className="tk-capture-meta">
        <span className="tk-eyebrow-label">When</span>
        <div className="kit-seg tk-capture-seg">
          {DUE_CHIPS.map((c) => (
            <button
              key={c.key}
              type="button"
              className={dueChoice === c.key ? 'on' : ''}
              aria-pressed={String(dueChoice === c.key)}
              onClick={() => setDueChoice(c.key)}
            >
              {c.label}
            </button>
          ))}
        </div>
        <span className="tk-capture-div" aria-hidden="true" />
        <span className="tk-eyebrow-label">Flag</span>
        <div className="kit-seg tk-capture-seg">
          {PRIO_CHIPS.map((c) => (
            <button
              key={c.key}
              type="button"
              className={priority === c.key ? 'on' : ''}
              aria-pressed={String(priority === c.key)}
              onClick={() => setPriority(c.key)}
            >
              {c.label}
            </button>
          ))}
        </div>
        {nl ? (
          <span className="tk-nl-hint">
            → due {fmtDay(nl.due)} (“{nl.token}” leaves the title)
          </span>
        ) : null}
      </div>
    </div>
  );
}
