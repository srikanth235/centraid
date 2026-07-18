// The album picker ("Add photos" from inside an album). `onCancel`/`onSubmit`
// are picker.tsx's `closePicker`/`submitPicker` — both touch app-owned
// picker state (`pickerAlbum`/`pickerPicked`), so they stay there and are
// passed straight through.
import { mountMedia } from '../media.ts';
import type { MouseEvent } from '../react-core.min.js';
import type { Album, Asset } from '../types.ts';
import styles from './Picker.module.css';

function PickerTile({
  asset,
  picked,
  onToggle,
}: {
  asset: Asset;
  picked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={styles.tile}
      aria-pressed={picked ? 'true' : 'false'}
      aria-label={asset.title ?? 'Photo'}
      ref={(el) => mountMedia(el, asset)}
      onClick={onToggle}
    ></button>
  );
}

// The picker's own `.kit-modal` rides the shared modal shell as a compound
// class — app.css keys its photo-grid shape off that pair, so both classes
// must stay on the one panel element.
export function PickerView({
  album,
  candidates,
  picked,
  onToggle,
  onCancel,
  onSubmit,
}: {
  album: Album;
  candidates: Asset[];
  picked: Set<string>;
  onToggle: (id: string) => void;
  onCancel: () => void;
  onSubmit: (e: MouseEvent<HTMLButtonElement>) => void;
}) {
  const n = picked.size;
  return (
    <div className={`kit-modal ${styles.panel}`} onClick={(e) => e.stopPropagation()}>
      <h2 className={styles.head}>Add to “{album.title ?? 'Album'}”</h2>
      <div className={styles.grid}>
        {candidates.length === 0 ? (
          <p className={`${styles.empty} kit-muted`}>
            Everything in your library is already in this album.
          </p>
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
      <div className={styles.foot}>
        <span className={styles.count}>{n === 0 ? 'Pick photos to add' : `${n} selected`}</span>
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
