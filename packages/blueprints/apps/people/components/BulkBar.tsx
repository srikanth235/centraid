// Bulk-selection action bar (#bulkBar root).
import styles from './BulkBar.module.css';

export function BulkBar({
  n,
  onFavorite,
  onClear,
}: {
  n: number;
  onFavorite: () => void;
  onClear: () => void;
}) {
  return (
    <>
      <span className={styles.bulkCount}>{n} selected</span>
      <div className={styles.bulkActions}>
        <button type="button" className="kit-btn" onClick={onFavorite}>
          Favorite
        </button>
        <button type="button" className="kit-btn" onClick={onClear}>
          Clear
        </button>
      </div>
    </>
  );
}
