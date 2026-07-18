// The non-scrolling toolbar above the card wall: the active scope's title +
// count, and — only while browsing a notebook — its rename/delete controls.
// Rename swaps the title for an inline input (Enter/blur commits, Escape
// cancels); delete arms on first click (kit armConfirm) like every other
// blueprint delete control.
import { useState } from '../react-core.min.js';
import { I } from '../icons.ts';
import { Icon } from './Shared.tsx';
import styles from './Toolbar.module.css';
import shared from './shared.module.css';

// kit.js's armConfirm swaps a button's textContent for the armed label —
// fine for text buttons, but it would wipe this icon-only button's SVG
// (textContent of an <i data-svg> wrapper is empty) and never restore it.
// A local, remount-reset armed flag (keyed by notebookId at the call site)
// gets the same "first click arms, second confirms, 3s auto-disarm" feel
// without mutating the icon's DOM.
function DeleteButton({
  notebookId,
  onDelete,
}: {
  notebookId: string;
  onDelete: (notebookId: string) => void;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      className="kit-icon-btn danger"
      aria-label={armed ? 'Confirm delete notebook' : 'Delete notebook'}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          setTimeout(() => setArmed(false), 3000);
          return;
        }
        onDelete(notebookId);
      }}
    >
      {armed ? <span className={shared.armedLabel}>Sure?</span> : <Icon svg={I.trash} />}
    </button>
  );
}

function RenameField({
  notebookId,
  name,
  onCommit,
  onCancel,
}: {
  notebookId: string;
  name: string;
  onCommit: (notebookId: string, name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(name);
  return (
    <input
      type="text"
      className={styles.titleInput}
      autoFocus
      value={value}
      aria-label={`Rename notebook ${name}`}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      onBlur={() => {
        const next = value.trim();
        if (!next || next === name) onCancel();
        else onCommit(notebookId, next);
      }}
    />
  );
}

export function Toolbar({
  title,
  sub,
  showNotebookTools,
  renaming,
  notebookId,
  notebookName,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onDelete,
}: {
  title: string;
  sub: string;
  showNotebookTools: boolean;
  renaming: boolean;
  notebookId: string | null;
  notebookName: string;
  onStartRename: () => void;
  onCommitRename: (notebookId: string, name: string) => void;
  onCancelRename: () => void;
  onDelete: (notebookId: string) => void;
}) {
  return (
    <div className={styles.toolbar}>
      <div className={styles.toolbarTitleRow}>
        {renaming ? (
          <RenameField
            notebookId={notebookId!}
            name={notebookName}
            onCommit={onCommitRename}
            onCancel={onCancelRename}
          />
        ) : (
          <div className={styles.title}>{title}</div>
        )}
        {showNotebookTools && !renaming ? (
          <div className={styles.toolbarTools}>
            <button
              type="button"
              className="kit-icon-btn"
              aria-label="Rename notebook"
              onClick={onStartRename}
            >
              <Icon svg={I.rename} />
            </button>
            <DeleteButton key={notebookId!} notebookId={notebookId!} onDelete={onDelete} />
          </div>
        ) : null}
      </div>
      <div className={styles.sub}>{sub}</div>
    </div>
  );
}
