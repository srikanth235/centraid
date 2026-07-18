// Sidebar region: the smart-section nav (All notes / Pinned with live
// counts), the notebooks list (colored dot + count, click to navigate — a
// notebook's own rename/delete controls live in the main toolbar once it's
// the active scope, not here) with its inline "new notebook" form, and the
// footer (library summary + the trust line). Three React roots — #sidebarNav,
// #sidebarFoot — the brand row and "New note" button around them are static
// HTML in index.html (stable, no per-render data), wired once in chrome.ts.
import { useRef, useState } from '../react-core.min.js';
import { I } from '../icons.ts';
import { notebookColorVar } from '../format.ts';
import { Icon } from './Shared.tsx';
import type { Nav, Notebook, SidebarCounts, SidebarTag } from '../types.ts';
import styles from './Sidebar.module.css';
import shared from './shared.module.css';

function NewNotebookForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <form
      className={styles.nbForm}
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
      <div className={styles.nbFormActions}>
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
}: {
  nav: Nav;
  counts: SidebarCounts;
  notebooks: Notebook[];
  notebookCounts: Map<string, number>;
  tags: SidebarTag[];
  tagCounts: Map<string, number>;
  creatingNotebook: boolean;
  pendingNotebookIds: Set<string>;
  onSelect: (nav: Nav) => void;
  onStartCreate: () => void;
  onCancelCreate: () => void;
  onSubmitCreate: (name: string) => void;
}) {
  return (
    <>
      <nav className={styles.nav} aria-label="Smart sections">
        <button
          type="button"
          className={styles.navItem}
          aria-current={nav.kind === 'all'}
          onClick={() => onSelect({ kind: 'all' })}
        >
          <Icon svg={I.allNotes} />
          <span className={styles.navLabel}>All notes</span>
          <span className={styles.navCount}>{counts.all}</span>
        </button>
        <button
          type="button"
          className={styles.navItem}
          aria-current={nav.kind === 'pinned'}
          onClick={() => onSelect({ kind: 'pinned' })}
        >
          <Icon svg={I.pinnedOutline} />
          <span className={styles.navLabel}>Pinned</span>
          <span className={styles.navCount}>{counts.pinned}</span>
        </button>
      </nav>

      <div className={styles.nbHead}>
        <span className={shared.eyebrowLabel}>Notebooks</span>
        <button
          type="button"
          className={styles.nbAdd}
          onClick={onStartCreate}
          aria-label="New notebook"
        >
          <Icon svg={I.plusSm} />
        </button>
      </div>
      <div className={styles.nav}>
        {notebooks.map((nb) => (
          <button
            key={nb.notebook_id}
            type="button"
            className={
              pendingNotebookIds.has(nb.notebook_id)
                ? `${styles.navItem} kit-pending`
                : styles.navItem
            }
            aria-current={nav.kind === 'notebook' && nav.notebookId === nb.notebook_id}
            onClick={() => onSelect({ kind: 'notebook', notebookId: nb.notebook_id })}
          >
            <span
              className={shared.nbDot}
              style={{ background: notebookColorVar(nb.notebook_id) }}
            />
            <span className={styles.nbName}>{nb.name ?? 'Notebook'}</span>
            <span className={styles.navCount}>{notebookCounts.get(nb.notebook_id) ?? 0}</span>
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
          <div className={styles.nbHead}>
            <span className={shared.eyebrowLabel}>Tags</span>
          </div>
          <div className={styles.nav}>
            {tags.map((t) => (
              <button
                key={t.concept_id}
                type="button"
                className={styles.navItem}
                aria-current={nav.kind === 'tag' && nav.conceptId === t.concept_id}
                onClick={() => onSelect({ kind: 'tag', conceptId: t.concept_id })}
              >
                <span className={styles.nbName}>#{t.label}</span>
                <span className={styles.navCount}>{tagCounts.get(t.concept_id) ?? 0}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

export function SidebarFoot({ counts }: { counts: SidebarCounts }) {
  return (
    <div className="nt-side-foot">
      <div className={styles.summary}>
        <div className={shared.eyebrowLabel}>This library</div>
        <div className={styles.summaryLine}>
          {counts.all} {counts.all === 1 ? 'note' : 'notes'} · {counts.notebooks}{' '}
          {counts.notebooks === 1 ? 'notebook' : 'notebooks'}
        </div>
        <div className={styles.summarySub}>
          {counts.checks} open checklist item{counts.checks === 1 ? '' : 's'}
        </div>
      </div>
      <div className={styles.consentLine}>
        <Icon svg={I.shield} />
        <span>Every edit is consent-checked &amp; receipted</span>
      </div>
    </div>
  );
}
