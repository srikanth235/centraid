// The "Take a note…" quick-add card — a self-contained, stateful leaf (its
// own useState for the in-progress draft), so typing here re-renders only
// this subtree, not the whole wall. It only calls up to `onSubmit` with the
// assembled {title, body}; it never touches `state`/`data` directly. Mirrors
// tasks/components/Capture.jsx's shape.
import { useEffect, useRef, useState } from 'react';
import styles from './QuickAdd.module.css';

export interface QuickAddProps {
  targetLabel: string;
  onSubmit: (payload: { title: string; body: string }) => boolean | Promise<boolean>;
  registerFocus: (fn: () => void) => void;
}

export function QuickAdd({ targetLabel, onSubmit, registerFocus }: QuickAddProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
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
    <div className={styles.quickadd}>
      <input
        ref={inputRef}
        type="text"
        className={styles.qaTitle}
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
        <div className={styles.qaMore}>
          <textarea
            className={styles.qaBody}
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
          <div className={styles.qaActions}>
            <span className={styles.qaTarget}>{targetLabel}</span>
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
