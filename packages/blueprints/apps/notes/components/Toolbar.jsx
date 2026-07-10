// The non-scrolling toolbar above the card wall: the active scope's title +
// count, and — only while browsing a notebook — its rename/delete controls.
// Rename swaps the title for an inline input (Enter/blur commits, Escape
// cancels); delete arms on first click (kit armConfirm) like every other
// blueprint delete control.
import { useState } from '../react-core.min.js';
import { I } from '../icons.js';
import { Icon } from './Shared.jsx';

// kit.js's armConfirm swaps a button's textContent for the armed label —
// fine for text buttons, but it would wipe this icon-only button's SVG
// (textContent of an <i data-svg> wrapper is empty) and never restore it.
// A local, remount-reset armed flag (keyed by notebookId at the call site)
// gets the same "first click arms, second confirms, 3s auto-disarm" feel
// without mutating the icon's DOM.
function DeleteButton({ notebookId, onDelete }) {
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
      {armed ? <span className="nt-armed-label">Sure?</span> : <Icon svg={I.trash} />}
    </button>
  );
}

function RenameField({ notebookId, name, onCommit, onCancel }) {
  const [value, setValue] = useState(name);
  return (
    <input
      type="text"
      className="nt-title-input"
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
}) {
  return (
    <div className="nt-toolbar">
      <div className="nt-toolbar-title-row">
        {renaming ? (
          <RenameField
            notebookId={notebookId}
            name={notebookName}
            onCommit={onCommitRename}
            onCancel={onCancelRename}
          />
        ) : (
          <div className="nt-title">{title}</div>
        )}
        {showNotebookTools && !renaming ? (
          <div className="nt-toolbar-tools">
            <button
              type="button"
              className="kit-icon-btn"
              aria-label="Rename notebook"
              onClick={onStartRename}
            >
              <Icon svg={I.rename} />
            </button>
            <DeleteButton key={notebookId} notebookId={notebookId} onDelete={onDelete} />
          </div>
        ) : null}
      </div>
      <div className="nt-sub">{sub}</div>
    </div>
  );
}
