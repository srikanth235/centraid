// The main pane's toolbar row: active-view title + subtitle, a back
// affordance inside an album, "Add photos"/"New album" on the views that
// want them, and the Select toggle. Pure view — app.jsx computes every
// derived string/flag and passes it straight through.
import { ChevronLeftIcon, PlusIcon } from '../icons.jsx';

export function ToolbarView({
  title,
  subtitle,
  showBack,
  onBack,
  showNewAlbum,
  onNewAlbum,
  showAddPhotos,
  onAddPhotos,
  showSelect,
  selectMode,
  onToggleSelect,
}) {
  return (
    <div className="ph-toolbar">
      {showBack ? (
        <button
          type="button"
          className="kit-icon-btn ph-back-btn"
          aria-label="Back to albums"
          onClick={onBack}
        >
          <ChevronLeftIcon />
        </button>
      ) : null}
      <div className="ph-toolbar-title">
        <div className="ph-toolbar-h1">{title}</div>
        <div className="ph-toolbar-sub">{subtitle}</div>
      </div>
      <div className="ph-toolbar-actions">
        {showAddPhotos ? (
          <button type="button" className="kit-btn ph-pill-btn" onClick={onAddPhotos}>
            Add photos
          </button>
        ) : null}
        {showNewAlbum ? (
          <button type="button" className="kit-btn ph-pill-btn" onClick={onNewAlbum}>
            <PlusIcon size={15} />
            New album
          </button>
        ) : null}
        {showSelect ? (
          <button
            type="button"
            className="kit-btn ph-pill-btn"
            data-active={selectMode ? 'true' : 'false'}
            onClick={onToggleSelect}
          >
            {selectMode ? 'Cancel' : 'Select'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
