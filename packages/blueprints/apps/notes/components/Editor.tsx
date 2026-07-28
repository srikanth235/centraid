// governance: allow-repo-hygiene file-size-limit cohesive immersive editor overlay; the draft buffer, toolbar, and autosave lifecycle are one keyed component and share local editing state
// The immersive editor overlay. Mounted keyed by note_id at the call site
// (app.tsx) so opening a different note remounts this component fresh — the
// draft always starts from the newly opened note, no stale-buffer bugs.
// Title/body live as local state (mirrored into refs so the debounce timer
// always reads the latest keystroke, not a stale closure) and autosave
// through `onAutosave`, same continuous-debounce feel as the pre-React
// app.js's own performSave/scheduleSave. `registerFlush` lets app.tsx await
// an in-flight or pending save before it unmounts this component (closing
// the overlay, switching notes) — the same registerFocus idiom
// tasks/components/Capture.jsx uses, inverted for teardown instead of setup.
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, KeyboardEvent } from 'react';

import { deriveTitle, parseBlocks, stripInline } from '../format.ts';
import { I } from '../icons.ts';
import { relTime, renderAttachments } from '../kit.ts';
import type { Note, NotePatch, Notebook } from '../types.ts';
import { Icon } from './Shared.tsx';

import styles from './Editor.module.css';
import shared from './shared.module.css';

type SaveState = '' | 'saving' | 'saved' | 'pending' | 'error';

function AttachStrip({
  note,
  onRemove,
}: {
  note: Note;
  onRemove: (attachmentId: string) => Promise<VaultOutcome | undefined>;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (ref.current) renderAttachments(ref.current, note.attachments ?? [], onRemove);
  }, [note.attachments, onRemove]);
  if (!note.attachments?.length) return null;
  return <div className={`kit-attach-strip ${styles.editorAttach}`} ref={ref} />;
}

function TagStrip({
  note,
  onAddTag,
  onRemoveTag,
}: {
  note: Note;
  onAddTag: (noteId: string, label: string) => void;
  onRemoveTag: (tagId: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const label = draft.trim();
    if (!label) return;
    onAddTag(note.note_id, label);
    setDraft('');
  };
  return (
    <div className={styles.tagStrip}>
      {(note.tags ?? []).map((t) => (
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

function DeleteButton({ onDelete }: { onDelete: () => void }) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      className="kit-icon-btn danger"
      aria-label={armed ? 'Confirm delete note' : 'Delete note'}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          setTimeout(() => setArmed(false), 3000);
          return;
        }
        onDelete();
      }}
    >
      {armed ? <span className={shared.armedLabel}>Sure?</span> : <Icon svg={I.trashLg} />}
    </button>
  );
}

const MD_H_CLASS: Record<number, string | undefined> = {
  1: styles.mdH1,
  2: styles.mdH2,
  3: styles.mdH3,
};

function Blocks({
  body,
  onToggleCheck,
  onEnter,
}: {
  body: string;
  onToggleCheck: (line: number) => void;
  onEnter: (pos: number | null) => void;
}) {
  const blocks = parseBlocks(body);
  const lineOffsets: number[] = [];
  {
    let acc = 0;
    for (const line of body.split('\n')) {
      lineOffsets.push(acc);
      acc += line.length + 1;
    }
  }
  // Caret offset for the END of a rendered line — what clicking that line has
  // always placed the caret at.
  const caretAt = (idx: number) => (lineOffsets[idx] ?? 0) + (body.split('\n')[idx] ?? '').length;
  const lineLabel = (text: string) => `Edit ${stripInline(text).trim() || 'this line'}`;

  // This preview is a rendered projection of the body, not a textbox: the
  // container's fake `role="textbox"` is gone and every line is a real
  // <button> carrying that line's caret offset, so the per-line click-to-edit
  // survives. Those line buttons are deliberately `tabIndex={-1}` — the
  // container used to be ONE tab stop whose Enter opened the editor at the end,
  // and `.bodyTail` below is that same single tab stop. Turning each of a
  // note's lines into its own tab stop would be a keyboard regression, not a
  // fix; a keyboard user edits in the real <textarea>.
  return (
    <div className={styles.bodyRender}>
      {/* Clicking anywhere the lines don't cover edits at the end of the note —
          the old `blocks.length - 1` fallback — and, as the one tab stop here,
          it carries the Enter-to-edit affordance the container's onKeyDown had. */}
      <button
        type="button"
        className={`kit-stretch-btn ${styles.bodyTail}`}
        aria-label="Edit note body"
        onClick={() => onEnter(null)}
      />
      {blocks.length === 0 ? <p className={styles.mdGap} /> : null}
      {blocks.map((b) => {
        if (b.kind === 'gap')
          return (
            <button
              key={b.line}
              type="button"
              className={`kit-plain-btn ${styles.mdGap} ${styles.blockLine}`}
              data-line={b.line}
              tabIndex={-1}
              aria-label="Edit blank line"
              onClick={() => onEnter(caretAt(b.line))}
            />
          );
        if (b.kind === 'h') {
          const Tag = `h${b.level + 2}` as 'h3' | 'h4' | 'h5';
          // The heading element stays (its role is real); the click target is a
          // full-bleed button inside it.
          return (
            <Tag key={b.line} className={MD_H_CLASS[b.level]} data-line={b.line}>
              <button
                type="button"
                className={`kit-plain-btn ${styles.blockLine}`}
                tabIndex={-1}
                onClick={() => onEnter(caretAt(b.line))}
              >
                {stripInline(b.text)}
              </button>
            </Tag>
          );
        }
        if (b.kind === 'check') {
          // A <button> can't contain the checkbox <button>, so the line keeps
          // its box and the edit target is a stretched overlay under it.
          return (
            <div
              key={b.line}
              className={b.checked ? `${styles.checkLine} ${styles.done}` : styles.checkLine}
              data-line={b.line}
            >
              <button
                type="button"
                className={`kit-stretch-btn ${styles.lineOverlay}`}
                tabIndex={-1}
                aria-label={lineLabel(b.text)}
                onClick={() => onEnter(caretAt(b.line))}
              />
              <button
                type="button"
                className={styles.checkBox}
                aria-label={b.checked ? 'Mark item not done' : 'Mark item done'}
                aria-pressed={b.checked}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleCheck(b.line);
                }}
              >
                {b.checked ? <Icon svg={I.check} /> : null}
              </button>
              <span className={styles.checkText}>{stripInline(b.text)}</span>
            </div>
          );
        }
        if (b.kind === 'li') {
          return (
            <button
              key={b.line}
              type="button"
              className={`kit-plain-btn ${styles.mdLi} ${styles.blockLine}`}
              data-line={b.line}
              tabIndex={-1}
              onClick={() => onEnter(caretAt(b.line))}
            >
              <span className={styles.mdBullet} aria-hidden="true">
                •
              </span>
              <span>{stripInline(b.text)}</span>
            </button>
          );
        }
        return (
          <button
            key={b.line}
            type="button"
            className={`kit-plain-btn ${styles.mdP} ${styles.blockLine}`}
            data-line={b.line}
            tabIndex={-1}
            onClick={() => onEnter(caretAt(b.line))}
          >
            {stripInline(b.text)}
          </button>
        );
      })}
    </div>
  );
}

export function Editor({
  note,
  notebooks,
  pending,
  registerFlush,
  onClose,
  onAutosave,
  onTogglePin,
  onMove,
  onDelete,
  onAttach,
  onRemoveAttachment,
  onAddTag,
  onRemoveTag,
}: {
  note: Note;
  notebooks: Notebook[];
  pending: boolean;
  registerFlush: (fn: () => Promise<void>) => void;
  onClose: () => void;
  onAutosave: (noteId: string, patch: NotePatch) => Promise<VaultOutcome | undefined>;
  onTogglePin: (note: Note) => void;
  onMove: (noteId: string, notebookId: string | null) => void;
  onDelete: (note: Note) => void;
  onAttach: (noteId: string) => void;
  onRemoveAttachment: (attachmentId: string) => Promise<VaultOutcome | undefined>;
  onAddTag: (noteId: string, label: string) => void;
  onRemoveTag: (tagId: string) => void;
}) {
  const [title, setTitle] = useState(note.title ?? '');
  const [body, setBody] = useState(note.body ?? '');
  const [bodyEditing, setBodyEditing] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('');
  const titleRef = useRef(title);
  const bodyRef = useRef(body);
  const lastSavedRef = useRef({
    title: note.title ?? '',
    body: note.body ?? '',
  });
  const saveTimerRef = useRef(0);
  const savingRef = useRef<Promise<void> | null>(null);
  const caretRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // The editor's callbacks are consts declared in dependency order: `function`
  // declarations that reference each other are hoisted, and the React compiler
  // bails out of the whole component when it must rewrite a hoisted reference
  // (#573).
  const performSave = async (): Promise<void> => {
    if (savingRef.current) return savingRef.current;
    const p = (async () => {
      const snapTitle = titleRef.current;
      const snapBody = bodyRef.current;
      const prev = lastSavedRef.current;
      if (snapTitle === prev.title && snapBody === prev.body) return;
      const nextDerived = deriveTitle(snapTitle, snapBody);
      const patch: NotePatch = {};
      if (nextDerived && nextDerived !== deriveTitle(prev.title, prev.body))
        patch.title = nextDerived;
      if (snapBody.trim() && snapBody !== prev.body) patch.body_text = snapBody;
      if (!patch.title && !patch.body_text) {
        lastSavedRef.current = { title: snapTitle, body: snapBody };
        setSaveState('');
        return;
      }
      setSaveState('saving');
      const outcome = await onAutosave(note.note_id, patch);
      lastSavedRef.current = { title: snapTitle, body: snapBody };
      const stillDirty = titleRef.current !== snapTitle || bodyRef.current !== snapBody;
      if (outcome?.status === 'executed') {
        setSaveState(stillDirty ? 'saving' : 'saved');
        // Re-armed inline instead of through scheduleSave(): referring forward
        // to it would reintroduce the hoisted-reference bail-out.
        if (stillDirty) {
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = window.setTimeout(performSave, 700);
        }
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
  };

  const scheduleSave = (): void => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(performSave, 700);
  };

  const flush = async (): Promise<void> => {
    clearTimeout(saveTimerRef.current);
    await performSave();
  };

  useEffect(() => {
    registerFlush?.(flush);
    return () => clearTimeout(saveTimerRef.current);
    // (#336) mount-once flush registration, deliberately []
  }, [flush, registerFlush]);

  useEffect(() => {
    if (bodyEditing && textareaRef.current) {
      const el = textareaRef.current;
      el.focus();
      const pos = caretRef.current ?? el.value.length;
      el.setSelectionRange(pos, pos);
      caretRef.current = null;
    }
  }, [bodyEditing]);

  const updateTitle = (v: string): void => {
    titleRef.current = v;
    setTitle(v);
    scheduleSave();
  };
  const updateBody = (v: string): void => {
    bodyRef.current = v;
    setBody(v);
    scheduleSave();
  };
  const saveBodyNow = (v: string): void => {
    bodyRef.current = v;
    setBody(v);
    clearTimeout(saveTimerRef.current);
    performSave();
  };

  const toggleCheck = (lineIndex: number): void => {
    const lines = bodyRef.current.split('\n');
    if (lines[lineIndex] == null) return;
    lines[lineIndex] = lines[lineIndex]!.replace(/\[(?: |x|X)\]/u, (m) =>
      /x/iu.test(m) ? '[ ]' : '[x]',
    );
    saveBodyNow(lines.join('\n'));
  };

  const enterEdit = (pos: number | null): void => {
    caretRef.current = pos;
    setBodyEditing(true);
  };
  const exitEdit = (): void => {
    setBodyEditing(false);
  };

  const insertChecklist = (): void => {
    if (!bodyEditing) {
      const cur = bodyRef.current;
      const base = cur.length > 0 && !cur.endsWith('\n') ? `${cur}\n` : cur;
      const next = `${base}- [ ] `;
      updateBody(next);
      enterEdit(next.length);
      return;
    }
    const el = textareaRef.current;
    if (!el) return;
    const value = el.value;
    const pos = el.selectionStart ?? value.length;
    const lineStart = value.slice(0, pos).lastIndexOf('\n') + 1;
    const nl = value.indexOf('\n', pos);
    const lineEnd = nl === -1 ? value.length : nl;
    let next: string;
    let caret: number;
    if (value.slice(lineStart, lineEnd).trim() === '') {
      next = `${value.slice(0, lineStart)}- [ ] ${value.slice(lineStart)}`;
      caret = lineStart + 6;
    } else {
      next = `${value.slice(0, lineEnd)}\n- [ ] ${value.slice(lineEnd)}`;
      caret = lineEnd + 7;
    }
    caretRef.current = caret;
    updateBody(next);
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(caret, caret);
    });
  };

  const handleBodyKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const el = e.currentTarget;
    const pos = el.selectionStart;
    if (pos !== el.selectionEnd) return;
    const before = el.value.slice(0, pos);
    const lineStart = before.lastIndexOf('\n') + 1;
    const m = /^(?<marker>\s*[-*] \[[ xX]\] )(?<text>.*)$/u.exec(before.slice(lineStart));
    if (!m) return;
    e.preventDefault();
    if (m.groups?.text === '') {
      const next = el.value.slice(0, lineStart) + el.value.slice(pos);
      caretRef.current = lineStart;
      updateBody(next);
      return;
    }
    const insertion = `\n${(m.groups?.marker ?? '').replace(/\[[xX]\]/u, '[ ]')}`;
    const next = el.value.slice(0, pos) + insertion + el.value.slice(pos);
    caretRef.current = pos + insertion.length;
    updateBody(next);
  };

  const notebookId = note.notebook_ids?.[0] ?? '';
  const notebookLabel = note.notebook_names?.[0];
  const activity: string[] = [];
  if (notebookLabel) activity.push(`Filed in “${notebookLabel}”`);
  if (note.pinned === 1) activity.push('Pinned');
  activity.push(`Edited ${relTime(note.updated_at ?? '')}`);

  const saveLabel =
    saveState === 'saving'
      ? 'Saving…'
      : saveState === 'saved'
        ? 'Saved · receipt'
        : saveState === 'pending'
          ? 'Pending approval'
          : saveState === 'error'
            ? 'Not saved'
            : `Edited ${relTime(note.updated_at ?? '')}`;

  return (
    <div className={styles.editorBackdrop}>
      {/* The backdrop's dismiss-on-outside-click is a real button laid under the
          panel (the panel is `position: relative`), so it has a keyboard
          equivalent — this replaces the old `e.target === e.currentTarget`
          guard on the backdrop div. */}
      <button type="button" className="kit-modal-scrim" aria-label="Close" onClick={onClose} />
      <div className={pending ? `${styles.editor} kit-pending` : styles.editor}>
        <div className={styles.editorTop}>
          <button type="button" className="kit-icon-btn" aria-label="Back" onClick={onClose}>
            <Icon svg={I.back} />
          </button>
          <span className={styles.saveLabel}>{saveLabel}</span>
          <div className={styles.editorTools}>
            <select
              className={styles.nbSelect}
              aria-label="Notebook"
              value={notebookId}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                // Best-effort: let any in-flight/pending title-body autosave
                // land before the discrete move write fires. The two never
                // collide on a field (autosave only ever sends title/
                // body_text; a move only ever sends notebook_id), so this
                // is a courtesy ordering, not a correctness requirement.
                flush();
                onMove(note.note_id, e.target.value || null);
              }}
            >
              <option value="">Unfiled</option>
              {notebooks.map((nb) => (
                <option key={nb.notebook_id} value={nb.notebook_id}>
                  {nb.name ?? 'Notebook'}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="kit-icon-btn"
              aria-label="Add checklist item"
              onClick={insertChecklist}
            >
              <Icon svg={I.checklistAdd} />
            </button>
            <button
              type="button"
              className={note.pinned === 1 ? 'kit-icon-btn on' : 'kit-icon-btn'}
              aria-label={note.pinned === 1 ? 'Unpin note' : 'Pin note'}
              aria-pressed={note.pinned === 1}
              onClick={() => {
                flush();
                onTogglePin(note);
              }}
            >
              <Icon svg={I.pinEditor} />
            </button>
            <DeleteButton onDelete={() => onDelete(note)} />
          </div>
        </div>

        <div className={styles.editorBody}>
          <input
            type="text"
            className={styles.editorTitle}
            placeholder="Title"
            aria-label="Note title"
            value={title}
            onChange={(e) => updateTitle(e.target.value)}
          />

          {bodyEditing ? (
            <textarea
              ref={textareaRef}
              className={styles.editorTextarea}
              placeholder="Start writing. Markdown and - [ ] checklists work."
              aria-label="Note body"
              value={body}
              onChange={(e) => updateBody(e.target.value)}
              onKeyDown={handleBodyKeyDown}
              onBlur={() => {
                setTimeout(() => {
                  if (document.activeElement === textareaRef.current) return;
                  flush();
                  exitEdit();
                }, 120);
              }}
            />
          ) : (
            <Blocks body={body} onToggleCheck={toggleCheck} onEnter={enterEdit} />
          )}

          <div className={shared.eyebrowLabel}>Tags</div>
          <TagStrip note={note} onAddTag={onAddTag} onRemoveTag={onRemoveTag} />

          <div className={shared.eyebrowLabel}>Attachments</div>
          <AttachStrip note={note} onRemove={onRemoveAttachment} />
          <button
            type="button"
            className={`kit-btn ${styles.attachBtn}`}
            onClick={() => onAttach(note.note_id)}
          >
            Attach a file
          </button>
        </div>

        <div className={styles.editorFoot}>
          <span className={styles.receiptChip}>receipt</span>
          <span className={styles.activityLine}>{activity.join('  ·  ')}</span>
        </div>
      </div>
    </div>
  );
}
