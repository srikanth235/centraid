// The album picker ("Add photos" from inside an album). `onCancel`/`onSubmit`
// are app.jsx's `closePicker`/`submitPicker` — both touch app.jsx-owned
// picker state (`pickerAlbum`/`pickerPicked`), so they stay there and are
// passed straight through.
import { mountMedia } from '../media.js';

export function PickerTile({ asset, picked, onToggle }) {
  return (
    <button
      type="button"
      className="picker-tile"
      aria-pressed={picked ? 'true' : 'false'}
      aria-label={asset.title ?? 'Photo'}
      ref={(el) => mountMedia(el, asset)}
      onClick={onToggle}
    ></button>
  );
}

// The picker's own `.kit-modal` rides the shared modal shell as a compound
// class (`kit-modal picker-panel`) — app.css keys its photo-grid shape off
// that pair, so both classes must stay on the one panel element.
export function PickerView({ album, candidates, picked, onToggle, onCancel, onSubmit }) {
  const n = picked.size;
  return (
    <div className="kit-modal picker-panel" onClick={(e) => e.stopPropagation()}>
      <h2 className="picker-head">Add to “{album.title ?? 'Album'}”</h2>
      <div className="picker-grid">
        {candidates.length === 0 ? (
          <p className="picker-empty muted">Everything in your library is already in this album.</p>
        ) : (
          candidates.map((asset) => (
            <PickerTile
              key={asset.asset_id}
              asset={asset}
              picked={picked.has(asset.asset_id)}
              onToggle={() => onToggle(asset.asset_id)}
            />
          ))
        )}
      </div>
      <div className="picker-foot">
        <span className="picker-count">{n === 0 ? 'Pick photos to add' : `${n} selected`}</span>
        <button type="button" className="kit-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="kit-btn primary" disabled={n === 0} onClick={onSubmit}>
          {n === 0 ? 'Add' : `Add ${n}`}
        </button>
      </div>
    </div>
  );
}
