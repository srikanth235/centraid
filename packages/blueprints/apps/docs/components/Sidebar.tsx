// Sidebar region: smart nav (all/recent/starred), the folder list (with
// inline create/rename editors), the trash entry, and the storage footprint —
// three separate React roots in app.tsx (#smartNav / #folderList / #storage),
// so this file exports three top-level components rather than one.
import { useEffect, useRef } from 'react';
import { armConfirm } from '../kit.ts';
import { DELETE_ICON, I, RENAME_ICON } from '../icons.ts';
import { fmtBytes } from '../format.ts';
import type { DriveDoc, Folder, Nav } from '../types.ts';
import { Icon } from './Shared.tsx';
import styles from './Sidebar.module.css';

function NavItem({
  icon,
  label,
  active,
  count,
  onClick,
}: {
  icon: string;
  label: string;
  active: boolean;
  count?: number | string;
  onClick: () => void;
}) {
  return (
    <button type="button" className={styles.navItem} aria-current={active} onClick={onClick}>
      <Icon svg={icon} />
      <span>{label}</span>
      {count != null ? <span className={styles.navCount}>{count}</span> : null}
    </button>
  );
}

export function SmartNav({
  navKind,
  counts,
  onSelectNav,
}: {
  navKind: string;
  counts: { all: number; starred: number; trash: number };
  onSelectNav: (nav: Nav) => void;
}) {
  return (
    <>
      <NavItem
        icon={I.allDocs!}
        label="All documents"
        active={navKind === 'all'}
        count={counts.all}
        onClick={() => onSelectNav({ kind: 'all' })}
      />
      <NavItem
        icon={I.clock!}
        label="Recent"
        active={navKind === 'recent'}
        onClick={() => onSelectNav({ kind: 'recent' })}
      />
      <NavItem
        icon={I.star!}
        label="Starred"
        active={navKind === 'starred'}
        count={counts.starred}
        onClick={() => onSelectNav({ kind: 'starred' })}
      />
    </>
  );
}

// The new-folder editor row: an uncontrolled input, focused once on mount —
// the React analogue of the old Lit `ref()` callback, which ran synchronously
// during commit (well before `commit()` could be invoked by a later
// click/keydown). React preserves this same host `<input>` node across
// re-renders of the same tree shape, so typed text and focus both survive
// unrelated re-renders exactly as they did under Lit.
function FolderCreateEdit({
  onCommit,
  onCancel,
}: {
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const commit = () => {
    const name = inputRef.current?.value.trim() ?? '';
    if (name) onCommit(name);
    else onCancel();
  };
  return (
    <div className={styles.folderEdit}>
      <input
        type="text"
        className="kit-input bare"
        placeholder="Folder name…"
        aria-label="New folder name"
        ref={inputRef}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
          if (e.key === 'Escape') onCancel();
        }}
      />
      <button type="button" onClick={commit}>
        Create
      </button>
    </div>
  );
}

function FolderRenameEdit({
  f,
  onCommit,
  onCancel,
}: {
  f: Folder;
  onCommit: (folderId: string, name: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const node = inputRef.current;
    if (node) {
      node.focus();
      node.select();
    }
  }, []);
  const commit = () => {
    const name = inputRef.current?.value.trim() ?? '';
    if (name && name !== f.name) onCommit(f.folder_id, name);
    else onCancel();
  };
  return (
    <div className={styles.folderEdit}>
      <input
        type="text"
        className="kit-input bare"
        aria-label="Folder name"
        defaultValue={f.name}
        ref={inputRef}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
          if (e.key === 'Escape') onCancel();
        }}
      />
      <button type="button" onClick={commit}>
        Save
      </button>
    </div>
  );
}

function FolderRow({
  f,
  activeDocs,
  navKind,
  navFolderId,
  renamingFolderId,
  onSelectNav,
  onStartRename,
  onDeleteFolder,
  onRenameCommit,
  onRenameCancel,
}: {
  f: Folder;
  activeDocs: DriveDoc[];
  navKind: string;
  navFolderId: string | undefined;
  renamingFolderId: string | null;
  onSelectNav: (nav: Nav) => void;
  onStartRename: (folderId: string) => void;
  onDeleteFolder: (folder: Folder) => void;
  onRenameCommit: (folderId: string, name: string) => void;
  onRenameCancel: () => void;
}) {
  if (renamingFolderId === f.folder_id)
    return <FolderRenameEdit f={f} onCommit={onRenameCommit} onCancel={onRenameCancel} />;
  const count = activeDocs.filter((d) => (d.folder_id ?? null) === f.folder_id).length;
  const active = navKind === 'folder' && navFolderId === f.folder_id;
  return (
    <div className={styles.folder}>
      <NavItem
        icon={I.folder!}
        label={f.name}
        active={active}
        count={count || ''}
        onClick={() => onSelectNav({ kind: 'folder', folderId: f.folder_id })}
      />
      <span className={styles.folderTools}>
        <button
          type="button"
          className="kit-icon-btn"
          aria-label={`Rename ${f.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onStartRename(f.folder_id);
          }}
        >
          <Icon svg={RENAME_ICON} />
        </button>
        <button
          type="button"
          className="kit-icon-btn danger"
          aria-label={`Delete ${f.name}`}
          onClick={(e) => {
            e.stopPropagation();
            if (!armConfirm(e.currentTarget, { armedLabel: '×?' })) return;
            onDeleteFolder(f);
          }}
        >
          <Icon svg={DELETE_ICON} />
        </button>
      </span>
    </div>
  );
}

export function FolderList({
  folders,
  activeDocs,
  navKind,
  navFolderId,
  renamingFolderId,
  creatingFolder,
  trashCount,
  onSelectNav,
  onStartRename,
  onDeleteFolder,
  onRenameCommit,
  onRenameCancel,
  onCreateCommit,
  onCreateCancel,
}: {
  folders: Folder[];
  activeDocs: DriveDoc[];
  navKind: string;
  navFolderId: string | undefined;
  renamingFolderId: string | null;
  creatingFolder: boolean;
  trashCount: number;
  onSelectNav: (nav: Nav) => void;
  onStartRename: (folderId: string) => void;
  onDeleteFolder: (folder: Folder) => void;
  onRenameCommit: (folderId: string, name: string) => void;
  onRenameCancel: () => void;
  onCreateCommit: (name: string) => void;
  onCreateCancel: () => void;
}) {
  return (
    <>
      {creatingFolder ? (
        <FolderCreateEdit onCommit={onCreateCommit} onCancel={onCreateCancel} />
      ) : null}
      {folders.map((f) => (
        <FolderRow
          key={f.folder_id}
          f={f}
          activeDocs={activeDocs}
          navKind={navKind}
          navFolderId={navFolderId}
          renamingFolderId={renamingFolderId}
          onSelectNav={onSelectNav}
          onStartRename={onStartRename}
          onDeleteFolder={onDeleteFolder}
          onRenameCommit={onRenameCommit}
          onRenameCancel={onRenameCancel}
        />
      ))}
      <NavItem
        icon={I.trash!}
        label="Trash"
        active={navKind === 'trash'}
        count={trashCount || ''}
        onClick={() => onSelectNav({ kind: 'trash' })}
      />
    </>
  );
}

// Storage → an honest footprint of what the drive is holding right now. The
// vault gives no account-wide total, so we report real bytes + count over the
// loaded window instead of a fabricated "used / total".
export function Storage({ docs, truncated }: { docs: DriveDoc[]; truncated: boolean }) {
  const bytes = docs.reduce((s, f) => s + (f.byte_size ?? 0), 0);
  return (
    <>
      <div className={styles.storageTop}>
        <span className={styles.lbl}>Footprint</span>
        <span className={styles.val}>{docs.length}</span>
      </div>
      <div className={styles.storageLabel}>
        {fmtBytes(bytes)} across {docs.length} document
        {docs.length === 1 ? '' : 's'}
        {truncated ? ' — newest in view' : ''}
      </div>
    </>
  );
}
