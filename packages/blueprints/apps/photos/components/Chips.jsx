// Album chips: All / Favorites / one per album / the "+ New album" control /
// Trash. Pure view — every interaction is a callback prop; the new-album
// submit/cancel/select handlers all touch app.jsx's module state
// (selectedAlbum, newAlbumOpen) so they stay owned by app.jsx.
import { FAVORITES, TRASH } from '../constants.js';
import { InlineInput } from './InlineInput.jsx';

function Chip({ label, active, onClick, extraClass }) {
  return (
    <button
      type="button"
      className={extraClass ? `kit-chip ${extraClass}` : 'kit-chip'}
      data-active={active ? 'true' : 'false'}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export function ChipsView({
  albums: albumList,
  selectedAlbum: selected,
  trashCount,
  newAlbumOpen: editing,
  onSelect,
  onStartNewAlbum,
  onSubmitNewAlbum,
  onCancelNewAlbum,
}) {
  return (
    <>
      <Chip label="All" active={selected === null} onClick={() => onSelect(null)} />
      <Chip
        label="♥ Favorites"
        active={selected === FAVORITES}
        onClick={() => onSelect(FAVORITES)}
      />
      {albumList.map((album) => (
        <Chip
          key={album.album_id}
          label={album.title ?? 'Album'}
          active={selected === album.album_id}
          onClick={() => onSelect(album.album_id)}
        />
      ))}
      {editing ? (
        <InlineInput
          key="new-album"
          className="chip-input"
          placeholder="Album name"
          label="New album name"
          onSubmit={onSubmitNewAlbum}
          onCancel={onCancelNewAlbum}
        />
      ) : (
        <button type="button" className="kit-chip chip-new" onClick={onStartNewAlbum}>
          ＋ New album
        </button>
      )}
      {trashCount > 0 ? (
        <Chip
          label={`Trash (${trashCount})`}
          active={selected === TRASH}
          onClick={() => onSelect(TRASH)}
          extraClass="chip-trash"
        />
      ) : null}
    </>
  );
}
