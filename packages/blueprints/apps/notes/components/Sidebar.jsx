// Sidebar region: the smart-section nav (All notes / Pinned with live
// counts), the notebooks list (colored dot + count, click to navigate — a
// notebook's own rename/delete controls live in the main toolbar once it's
// the active scope, not here) with its inline "new notebook" form, and the
// footer (library summary + the trust line). Three React roots — #sidebarNav,
// #sidebarFoot — the brand row and "New note" button around them are static
// HTML in index.html (stable, no per-render data), wired once in chrome.js.
import { useRef, useState } from '../react-core.min.js';
import { I } from '../icons.js';
import { notebookColorVar } from '../format.js';
import { Icon } from './Shared.jsx';

function NewNotebookForm({ onSubmit, onCancel }) {
  const [name, setName] = useState('');
  const inputRef = useRef(null);
  return (
    <form
      className="nt-nb-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(name);
      }}
    >
      <input
        ref={(el) => {
          inputRef.current = el;
          el?.focus();
        }}
        type="text"
        className="kit-input"
        placeholder="Notebook name…"
        aria-label="Notebook name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="nt-nb-form-actions">
        <button type="button" className="kit-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="kit-btn primary" disabled={!name.trim()}>
          Create
        </button>
      </div>
    </form>
  );
}

export function SidebarNav({
  nav,
  counts,
  notebooks,
  notebookCounts,
  tags,
  tagCounts,
  creatingNotebook,
  pendingNotebookIds,
  onSelect,
  onStartCreate,
  onCancelCreate,
  onSubmitCreate,
}) {
  return (
    <>
      <nav className="nt-nav" aria-label="Smart sections">
        <button
          type="button"
          className="nt-nav-item"
          aria-current={String(nav.kind === 'all')}
          onClick={() => onSelect({ kind: 'all' })}
        >
          <Icon svg={I.allNotes} />
          <span className="nt-nav-label">All notes</span>
          <span className="nt-nav-count">{counts.all}</span>
        </button>
        <button
          type="button"
          className="nt-nav-item"
          aria-current={String(nav.kind === 'pinned')}
          onClick={() => onSelect({ kind: 'pinned' })}
        >
          <Icon svg={I.pinnedOutline} />
          <span className="nt-nav-label">Pinned</span>
          <span className="nt-nav-count">{counts.pinned}</span>
        </button>
      </nav>

      <div className="nt-nb-head">
        <span className="nt-eyebrow-label">Notebooks</span>
        <button
          type="button"
          className="nt-nb-add"
          onClick={onStartCreate}
          aria-label="New notebook"
        >
          <Icon svg={I.plusSm} />
        </button>
      </div>
      <div className="nt-nav">
        {notebooks.map((nb) => (
          <button
            key={nb.notebook_id}
            type="button"
            className={
              pendingNotebookIds.has(nb.notebook_id) ? 'nt-nav-item kit-pending' : 'nt-nav-item'
            }
            aria-current={String(nav.kind === 'notebook' && nav.notebookId === nb.notebook_id)}
            onClick={() => onSelect({ kind: 'notebook', notebookId: nb.notebook_id })}
          >
            <span className="nt-nb-dot" style={{ background: notebookColorVar(nb.notebook_id) }} />
            <span className="nt-nb-name">{nb.name ?? 'Notebook'}</span>
            <span className="nt-nav-count">{notebookCounts.get(nb.notebook_id) ?? 0}</span>
            {pendingNotebookIds.has(nb.notebook_id) ? (
              <span className="kit-pending-chip">pending</span>
            ) : null}
          </button>
        ))}
        {creatingNotebook ? (
          <NewNotebookForm onSubmit={onSubmitCreate} onCancel={onCancelCreate} />
        ) : null}
      </div>

      {tags?.length ? (
        <>
          <div className="nt-nb-head">
            <span className="nt-eyebrow-label">Tags</span>
          </div>
          <div className="nt-nav">
            {tags.map((t) => (
              <button
                key={t.concept_id}
                type="button"
                className="nt-nav-item"
                aria-current={String(nav.kind === 'tag' && nav.conceptId === t.concept_id)}
                onClick={() => onSelect({ kind: 'tag', conceptId: t.concept_id })}
              >
                <span className="nt-nb-name">#{t.label}</span>
                <span className="nt-nav-count">{tagCounts.get(t.concept_id) ?? 0}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

export function SidebarFoot({ counts }) {
  return (
    <div className="nt-side-foot">
      <div className="nt-summary">
        <div className="nt-eyebrow-label">This library</div>
        <div className="nt-summary-line">
          {counts.all} {counts.all === 1 ? 'note' : 'notes'} · {counts.notebooks}{' '}
          {counts.notebooks === 1 ? 'notebook' : 'notebooks'}
        </div>
        <div className="nt-summary-sub">
          {counts.checks} open checklist item{counts.checks === 1 ? '' : 's'}
        </div>
      </div>
      <div className="nt-consent-line">
        <Icon svg={I.shield} />
        <span>Every edit is consent-checked &amp; receipted</span>
      </div>
    </div>
  );
}
