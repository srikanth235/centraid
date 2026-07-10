// The "Take a note…" quick-add card — a self-contained, stateful leaf (its
// own useState for the in-progress draft), so typing here re-renders only
// this subtree, not the whole wall. It only calls up to `onSubmit` with the
// assembled {title, body}; it never touches `state`/`data` directly. Mirrors
// tasks/components/Capture.jsx's shape.
import { useEffect, useRef, useState } from '../react-core.min.js';

export function QuickAdd({ targetLabel, onSubmit, registerFocus }) {
  const inputRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    registerFocus?.(() => {
      inputRef.current?.focus();
      setOpen(true);
    });
  }, [registerFocus]);

  const cancel = () => {
    setOpen(false);
    setTitle('');
    setBody('');
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await onSubmit({ title, body });
    setBusy(false);
    if (ok) {
      setTitle('');
      setBody('');
      setOpen(false);
    }
  };

  return (
    <div className="nt-quickadd">
      <input
        ref={inputRef}
        type="text"
        className="nt-qa-title"
        placeholder="Take a note…"
        aria-label="Note title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !open) {
            e.preventDefault();
            submit();
          }
        }}
      />
      {open ? (
        <div className="nt-qa-more">
          <textarea
            className="nt-qa-body"
            placeholder="Write something. Use - [ ] for a checklist."
            aria-label="Note body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="nt-qa-actions">
            <span className="nt-qa-target">{targetLabel}</span>
            <button type="button" className="kit-btn" onClick={cancel} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="kit-btn primary"
              disabled={busy || (!title.trim() && !body.trim())}
              onClick={submit}
            >
              Add note
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
