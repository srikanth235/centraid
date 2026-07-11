// The v2 sidebar: brand row, Add photos, smart nav (Photos/Favorites/
// Albums), the owner's actual album list (mini cover + count, inline
// rename/delete on hover), a Tags filter section (issue #352's free-form
// labels), the Duplicates and Trash shelves, and a storage footer. Pure
// view — every interaction is a callback prop; `newAlbumOpen`/
// `renamingAlbumForId` are app.jsx-owned sliver state (same split the old
// Chips.jsx/AlbumTools.jsx pair used), threaded through by the orchestrator
// (sidebar.jsx, replacing toolbar.jsx).
import { armConfirm } from '../kit.js';
import { ALBUMS, DUPLICATES, FAVORITES, TRASH } from '../constants.js';
import { AlbumsIcon, CameraIcon, CloseIcon, DuplicatesIcon, GridIcon, HeartIcon, PlusIcon, RenameIcon, ShieldIcon, TrashIcon } from '../icons.jsx';
import { Fragment } from '../react-core.min.js';
import { InlineInput } from './InlineInput.jsx';

function NavItem({ icon, label, count, active, onClick }) {
  return (
    <button type="button" className="ph-nav-item" data-active={active ? 'true' : 'false'} onClick={onClick}>
      <span className="ph-nav-icon">{icon}</span>
      <span className="ph-nav-label">{label}</span>
      {count != null ? <span className="ph-nav-count">{count}</span> : null}
    </button>
  );
}

function AlbumRow({
  album,
  cover,
  active,
  renaming,
  onOpen,
  onStartRename,
  onRenameSubmit,
  onRenameCancel,
  onDelete,
}) {
  if (renaming) {
    return (
      <div className="ph-album-row ph-album-row-editing">
        <InlineInput
          value={album.title ?? ''}
          placeholder="Album name"
          label="Rename album"
          autoSelect
          onSubmit={(title) => onRenameSubmit(album, title)}
          onCancel={onRenameCancel}
        />
      </div>
    );
  }
  return (
    <div className="ph-album-row">
      <button
        type="button"
        className="ph-nav-item ph-album-item"
        data-active={active ? 'true' : 'false'}
        onClick={onOpen}
      >
        <span className="ph-album-cover" style={cover ? { backgroundImage: `url(${cover})` } : undefined} />
        <span className="ph-nav-label">{album.title ?? 'Album'}</span>
        <span className="ph-nav-count">{album.count}</span>
      </button>
      <span className="ph-album-tools">
        <button
          type="button"
          className="kit-icon-btn"
          aria-label={`Rename ${album.title ?? 'album'}`}
          onClick={(e) => {
            e.stopPropagation();
            onStartRename(album);
          }}
        >
          <RenameIcon />
        </button>
        <button
          type="button"
          className="kit-icon-btn danger"
          aria-label={`Delete ${album.title ?? 'album'}`}
          onClick={(e) => {
            e.stopPropagation();
            if (!armConfirm(e.currentTarget, { armedLabel: '×?' })) return;
            onDelete(album);
          }}
        >
          <CloseIcon size={14} />
        </button>
      </span>
    </div>
  );
}

export function SidebarView({
  open,
  onClose,
  counts,
  selectedAlbum,
  onSelect,
  albums,
  renamingAlbumForId,
  onStartRename,
  onRenameSubmit,
  onRenameCancel,
  onDeleteAlbum,
  newAlbumOpen,
  onStartNewAlbum,
  onSubmitNewAlbum,
  onCancelNewAlbum,
  tagOptions,
  storageLabel,
  onUpload,
}) {
  return (
    <Fragment>
      {open ? <div className="ph-scrim" onClick={onClose} /> : null}
      <aside className="ph-sidebar" data-open={open ? 'true' : 'false'}>
        <div className="ph-brand">
          <span className="ph-brand-mark">
            <CameraIcon size={17} />
          </span>
          <div className="ph-brand-text">
            <div className="ph-brand-name">Photos</div>
            <div className="ph-brand-tag">a projection of your vault</div>
          </div>
          <button type="button" className="kit-icon-btn ph-sidebar-close" aria-label="Close menu" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

      <button type="button" className="ph-upload-btn" id="uploadBtn" onClick={onUpload}>
        <PlusIcon />
        Add photos
      </button>

      <nav className="ph-nav" aria-label="Library">
        <NavItem
          icon={<GridIcon />}
          label="Photos"
          count={counts.all}
          active={selectedAlbum === null}
          onClick={() => onSelect(null)}
        />
        <NavItem
          icon={<HeartIcon />}
          label="Favorites"
          count={counts.favorites}
          active={selectedAlbum === FAVORITES}
          onClick={() => onSelect(FAVORITES)}
        />
        <NavItem
          icon={<AlbumsIcon />}
          label="Albums"
          count={counts.albums}
          active={selectedAlbum === ALBUMS}
          onClick={() => onSelect(ALBUMS)}
        />
      </nav>

      <div className="ph-section-label">Your albums</div>
      <div className="ph-album-list">
        {albums.map((album) => (
          <AlbumRow
            key={album.album_id}
            album={album}
            cover={album.coverUri}
            active={selectedAlbum === album.album_id}
            renaming={renamingAlbumForId === album.album_id}
            onOpen={() => onSelect(album.album_id)}
            onStartRename={onStartRename}
            onRenameSubmit={onRenameSubmit}
            onRenameCancel={onRenameCancel}
            onDelete={onDeleteAlbum}
          />
        ))}
        {newAlbumOpen ? (
          <div className="ph-album-row ph-album-row-editing">
            <InlineInput
              className="kit-input bare"
              placeholder="Album name"
              label="New album name"
              onSubmit={onSubmitNewAlbum}
              onCancel={onCancelNewAlbum}
            />
          </div>
        ) : (
          <button type="button" className="ph-new-album" onClick={onStartNewAlbum}>
            <PlusIcon size={14} />
            New album
          </button>
        )}
      </div>

      {tagOptions.length > 0 ? (
        <>
          <div className="ph-section-label">Tags</div>
          <div className="ph-tag-row">
            {tagOptions.map((tag) => (
              <button
                key={tag}
                type="button"
                className="kit-chip ph-tag-chip"
                data-active={selectedAlbum === `tag:${tag}` ? 'true' : 'false'}
                onClick={() => onSelect(selectedAlbum === `tag:${tag}` ? null : `tag:${tag}`)}
              >
                #{tag}
              </button>
            ))}
          </div>
        </>
      ) : null}

      <nav className="ph-nav ph-nav-shelves" aria-label="Shelves">
        <NavItem
          icon={<DuplicatesIcon />}
          label="Duplicates"
          active={selectedAlbum === DUPLICATES}
          onClick={() => onSelect(DUPLICATES)}
        />
        {counts.trash > 0 ? (
          <NavItem
            icon={<TrashIcon />}
            label="Trash"
            count={counts.trash}
            active={selectedAlbum === TRASH}
            onClick={() => onSelect(TRASH)}
          />
        ) : null}
      </nav>

      <div className="ph-sidebar-foot">
        <div className="ph-storage">
          <div className="ph-storage-top">Storage</div>
          <div className="ph-storage-label">{storageLabel}</div>
        </div>
        <div className="ph-trust-line">
          <ShieldIcon size={14} />
          <span>Every change is consent-checked &amp; receipted.</span>
        </div>
      </div>
      </aside>
    </Fragment>
  );
}
