// Bulk-selection action bar (#bulkBar root).
import { armConfirm } from '../kit.js';

export function BulkBar({ n, inTrash, onRestore, onMoveTo, onTrashSelected, onClear }) {
  return (
    <>
      <span className="d-bulk-count">{n} selected</span>
      <div className="d-bulk-actions">
        {inTrash ? (
          <button type="button" className="kit-btn" onClick={onRestore}>
            Restore
          </button>
        ) : (
          <>
            <button type="button" className="kit-btn" onClick={(e) => onMoveTo(e.currentTarget)}>
              Move to…
            </button>
            <button
              type="button"
              className="kit-btn danger"
              onClick={(e) => {
                if (!armConfirm(e.currentTarget, { armedLabel: `Trash ${n} — sure?` })) return;
                onTrashSelected();
              }}
            >
              Trash
            </button>
          </>
        )}
        <button type="button" className="kit-btn" onClick={onClear}>
          Clear
        </button>
      </div>
    </>
  );
}
