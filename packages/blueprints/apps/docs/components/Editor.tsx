// The in-place text editor overlay for text-editable documents (issue #352,
// media_type LIKE 'text/%' — format.ts's isTextEditable mirrors the vault's
// own precondition exactly, and Details.tsx only ever offers the Edit
// affordance that opens this for a doc that passes it). Mounted keyed by
// document_id at the call site (app.tsx), so opening a different document
// remounts this component fresh — same idiom notes/components/Editor uses
// for its own note_id key. The doc's content_id/content_uri changing
// underneath mid-edit (a save just minted a new version) never remounts
// this component since document_id — the key — never changes, so an
// in-flight draft is never lost to its own autosave.
//
// Body loads once from the CURRENT content_uri at open time, then lives on
// as local, continuously-autosaved state through core.edit_document, the
// same debounce/flush shape notes/components/Editor's performSave/
// scheduleSave/registerFlush established for note bodies. A same-origin
// blob: route (issue #296) fetches; an inline data: URI (small bodies never
// rewrite to a blob route) decodes directly via format.ts's decodeDataUri —
// `fetch()`-ing a data: URI is blocked by the app's own CSP (`connect-src`
// inherits `default-src 'self'`, and data: isn't 'self'), so that branch is
// load-bearing, not an optimization.
import { useEffect, useRef, useState } from 'react';
import { decodeDataUri, fmtFull } from '../format.ts';
import { I } from '../icons.ts';
import type { DriveDoc } from '../types.ts';
import { Icon } from './Shared.tsx';
import styles from './Editor.module.css';

type LoadState = 'loading' | 'ready' | 'error';
type SaveState = '' | 'saving' | 'saved' | 'pending' | 'error';

export function Editor({
  doc,
  registerFlush,
  onClose,
  onSave,
}: {
  doc: DriveDoc;
  registerFlush: (fn: () => Promise<void>) => void;
  onClose: () => void;
  onSave: (documentId: string, body: string) => Promise<VaultOutcome | undefined>;
}) {
  const [body, setBodyState] = useState('');
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [saveState, setSaveState] = useState<SaveState>('');
  const bodyRef = useRef('');
  const lastSavedRef = useRef('');
  const saveTimerRef = useRef(0);
  const savingRef = useRef<Promise<void> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    function loaded(text: string) {
      bodyRef.current = text;
      lastSavedRef.current = text;
      setBodyState(text);
      setLoadState('ready');
    }
    const uri = doc.content_uri;
    if (typeof uri === 'string' && uri.startsWith('data:')) {
      const text = decodeDataUri(uri);
      if (text == null) setLoadState('error');
      else loaded(text);
      return;
    }
    let cancelled = false;
    fetch(uri!)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.text();
      })
      .then((text) => {
        if (!cancelled) loaded(text);
      })
      .catch(() => {
        if (!cancelled) setLoadState('error');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#360) doc is read once at mount by design (see file header): app.tsx keys this component by document_id, so re-firing when doc's content_uri changes mid-edit would reload over an in-flight draft instead of leaving the autosave in control
  }, []);

  useEffect(() => {
    if (loadState === 'ready') textareaRef.current?.focus();
  }, [loadState]);

  async function performSave() {
    if (savingRef.current) return savingRef.current;
    const p = (async () => {
      const snap = bodyRef.current;
      if (snap === lastSavedRef.current) return;
      setSaveState('saving');
      const outcome = await onSave(doc.document_id, snap);
      lastSavedRef.current = snap;
      const stillDirty = bodyRef.current !== snap;
      if (outcome?.status === 'executed') {
        setSaveState(stillDirty ? 'saving' : 'saved');
        if (stillDirty) scheduleSave();
      } else if (outcome?.status === 'parked') {
        setSaveState('pending');
      } else {
        setSaveState('error');
      }
    })();
    savingRef.current = p;
    try {
      await p;
    } finally {
      savingRef.current = null;
    }
  }

  function scheduleSave() {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(performSave, 700);
  }

  async function flush() {
    clearTimeout(saveTimerRef.current);
    await performSave();
  }

  useEffect(() => {
    registerFlush?.(flush);
    return () => clearTimeout(saveTimerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#360) registered once; this component remounts on document_id change (see file header), so the closed-over doc/onSave props flush() reads can never go stale without a fresh registration
  }, []);

  function setBody(v: string) {
    bodyRef.current = v;
    setBodyState(v);
    scheduleSave();
  }

  const saveLabel =
    saveState === 'saving'
      ? 'Saving…'
      : saveState === 'saved'
        ? 'Saved · receipt'
        : saveState === 'pending'
          ? 'Pending approval'
          : saveState === 'error'
            ? 'Not saved'
            : doc.updated_at
              ? `Edited ${fmtFull(doc.updated_at)}`
              : '';

  return (
    <div
      className={styles.editorBackdrop}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={styles.editor}
        role="dialog"
        aria-modal="true"
        aria-label={`Edit ${doc.title ?? 'document'}`}
      >
        <div className={styles.editorTop}>
          <button type="button" className="kit-icon-btn" aria-label="Close" onClick={onClose}>
            <Icon svg={I.close!} />
          </button>
          <span className={styles.editorTitle}>{doc.title ?? 'Untitled'}</span>
          <span className={styles.editorSave}>{saveLabel}</span>
        </div>
        <div className={styles.editorBody}>
          {loadState === 'loading' ? (
            <div className={styles.editorStatus}>Loading…</div>
          ) : loadState === 'error' ? (
            <div className={styles.editorStatus}>Could not load this document's text.</div>
          ) : (
            <textarea
              ref={textareaRef}
              className={styles.editorTextarea}
              aria-label="Document body"
              spellCheck={true}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onBlur={flush}
            />
          )}
        </div>
      </div>
    </div>
  );
}
