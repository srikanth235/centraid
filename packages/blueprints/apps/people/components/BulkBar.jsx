// Bulk-selection action bar (#bulkBar root).

export function BulkBar({ n, onFavorite, onClear }) {
  return (
    <>
      <span className="d-bulk-count">{n} selected</span>
      <div className="d-bulk-actions">
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
