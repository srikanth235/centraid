// The per-album toolbar: rename input, "Add photos", Rename, Delete album.
// `armConfirm`'s static-text-child invariant (see app.jsx's boot-gate note)
// is preserved exactly — the Delete button's text node never changes shape
// across the armed/unarmed toggle.
import { armConfirm } from '../kit.js';
import { InlineInput } from './InlineInput.jsx';

export function AlbumToolsView({
  album,
  count,
  renaming,
  onAdd,
  onStartRename,
  onRenameSubmit,
  onRenameCancel,
  onDelete,
}) {
  if (renaming) {
    return (
      <InlineInput
        key={album.album_id}
        value={album.title ?? ''}
        placeholder="Album name"
        label="Rename album"
        autoSelect
        onSubmit={(title) => onRenameSubmit(album, title)}
        onCancel={onRenameCancel}
      />
    );
  }
  return (
    <>
      <span className="album-tools-label">
        {count} {count === 1 ? 'photo' : 'photos'} in this album
      </span>
      <button type="button" className="kit-btn" onClick={onAdd}>
        Add photos
      </button>
      <button type="button" className="kit-btn" onClick={() => onStartRename(album)}>
        Rename
      </button>
      <button
        type="button"
        className="kit-btn danger"
        onClick={(e) => {
          if (!armConfirm(e.currentTarget, { armedLabel: 'Delete album?' })) return;
          onDelete(album);
        }}
      >
        Delete album
      </button>
    </>
  );
}
