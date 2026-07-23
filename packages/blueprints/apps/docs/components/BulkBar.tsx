// Bulk-selection action bar (#bulkBar root).
import { armConfirm } from '../kit.ts';
import styles from './BulkBar.module.css';

export function BulkBar({
  n,
  inTrash,
  onRestore,
  onMoveTo,
  onTrashSelected,
  onClear,
}: {
  n: number;
  inTrash: boolean;
  onRestore: () => void;
  onMoveTo: (anchor: HTMLElement) => void;
  onTrashSelected: () => void;
  onClear: () => void;
}) {
  return (
    <>
      <span className={styles.bulkCount}>{n} selected</span>
      <div className={styles.bulkActions}>
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
