// The v2 sidebar: brand row, Add photos, smart nav (Photos/Favorites/
// Albums), the owner's actual album list (mini cover + count, inline
// rename/delete on hover), a Tags filter section (issue #352's free-form
// labels), the Duplicates and Trash shelves, and a storage footer. Pure
// view — every interaction is a callback prop; `newAlbumOpen`/
// `renamingAlbumForId` are app.tsx-owned sliver state (same split the old
// Chips.jsx/AlbumTools.jsx pair used), threaded through by the orchestrator
// (sidebar.tsx, replacing toolbar.jsx).
// CSS split: own classes in Sidebar.module.css; the `.sectionLabel` eyebrow is
// shared (shared.module.css); `kit-*` classes stay global strings.
import { armConfirm } from '../kit.ts';
import { ALBUMS, DUPLICATES, FAVORITES, TRASH } from '../constants.ts';
import {
  AlbumsIcon,
  CameraIcon,
  CloseIcon,
  DuplicatesIcon,
  GridIcon,
  HeartIcon,
  PlusIcon,
  RenameIcon,
  ShieldIcon,
  TrashIcon,
} from '../icons.tsx';
import { Fragment } from 'react';
import type { ReactNode } from 'react';
import type { Album } from '../types.ts';
import { InlineInput } from './InlineInput.tsx';
import shared from './shared.module.css';
import styles from './Sidebar.module.css';

function NavItem({
  icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={styles.navItem}
      data-active={active ? 'true' : 'false'}
      onClick={onClick}
    >
      <span className={styles.navIcon}>{icon}</span>
      <span className={styles.navLabel}>{label}</span>
      {count != null ? <span className={styles.navCount}>{count}</span> : null}
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
}: {
  album: Album;
  cover: string | null | undefined;
  active: boolean;
  renaming: boolean;
  onOpen: () => void;
  onStartRename: (album: Album) => void;
  onRenameSubmit: (album: Album, title: string) => void;
  onRenameCancel: () => void;
  onDelete: (album: Album) => void;
}) {
  if (renaming) {
    return (
      <div className={`${styles.albumRow} ${styles.albumRowEditing}`}>
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
    <div className={styles.albumRow}>
      <button
        type="button"
        className={`${styles.navItem} ${styles.albumItem}`}
        data-active={active ? 'true' : 'false'}
        onClick={onOpen}
      >
        <span
          className={styles.albumCover}
          style={cover ? { backgroundImage: `url(${cover})` } : undefined}
        />
        <span className={styles.navLabel}>{album.title ?? 'Album'}</span>
        <span className={styles.navCount}>{album.count}</span>
      </button>
      <span className={styles.albumTools}>
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
}: {
  open: boolean;
  onClose: () => void;
  counts: { all: number; favorites: number; albums: number; trash: number };
  selectedAlbum: string | null;
  onSelect: (id: string | null) => void;
  albums: Album[];
  renamingAlbumForId: string | null;
  onStartRename: (album: Album) => void;
  onRenameSubmit: (album: Album, title: string) => void;
  onRenameCancel: () => void;
  onDeleteAlbum: (album: Album) => void;
  newAlbumOpen: boolean;
  onStartNewAlbum: () => void;
  onSubmitNewAlbum: (title: string) => void;
  onCancelNewAlbum: () => void;
  tagOptions: string[];
  storageLabel: string;
  onUpload: () => void;
}) {
  return (
    <Fragment>
      {open ? <div className={styles.scrim} onClick={onClose} /> : null}
      <aside className={styles.sidebar} data-open={open ? 'true' : 'false'}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>
            <CameraIcon size={17} />
          </span>
          <div className={styles.brandText}>
            <div className={styles.brandName}>Photos</div>
            <div className={styles.brandTag}>a projection of your vault</div>
          </div>
          <button
            type="button"
            className={`kit-icon-btn ${styles.sidebarClose}`}
            aria-label="Close menu"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>

        <button type="button" className={styles.uploadBtn} id="uploadBtn" onClick={onUpload}>
          <PlusIcon />
          Add photos
        </button>

        <nav className={styles.nav} aria-label="Library">
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

        <div className={shared.sectionLabel}>Your albums</div>
        <div className={styles.albumList}>
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
            <div className={`${styles.albumRow} ${styles.albumRowEditing}`}>
              <InlineInput
                className="kit-input bare"
                placeholder="Album name"
                label="New album name"
                onSubmit={onSubmitNewAlbum}
                onCancel={onCancelNewAlbum}
              />
            </div>
          ) : (
            <button type="button" className={styles.newAlbum} onClick={onStartNewAlbum}>
              <PlusIcon size={14} />
              New album
            </button>
          )}
        </div>

        {tagOptions.length > 0 ? (
          <>
            <div className={shared.sectionLabel}>Tags</div>
            <div className={styles.tagRow}>
              {tagOptions.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className={`kit-chip ${styles.tagChip}`}
                  data-active={selectedAlbum === `tag:${tag}` ? 'true' : 'false'}
                  onClick={() => onSelect(selectedAlbum === `tag:${tag}` ? null : `tag:${tag}`)}
                >
                  #{tag}
                </button>
              ))}
            </div>
          </>
        ) : null}

        <nav className={`${styles.nav} ${styles.navShelves}`} aria-label="Shelves">
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

        <div className={styles.sidebarFoot}>
          <div className={styles.storage}>
            <div className={styles.storageTop}>Storage</div>
            <div className={styles.storageLabel}>{storageLabel}</div>
          </div>
          <div className={styles.trustLine}>
            <ShieldIcon size={14} />
            <span>Every change is consent-checked &amp; receipted.</span>
          </div>
        </div>
      </aside>
    </Fragment>
  );
}
