// Sidebar region: the folder list (with inline create/rename editors) and the
// storage footprint.
//
// SMART NAV (All / Recent / Starred) AND THE TRASH ROW ARE GONE. The shelf
// strip (components/ShelfStrip.tsx) carries all six shelves — including the
// three the sidebar used to duplicate — and a second navigation for the same
// destinations is exactly what the Docs restructure retires (spec §1.7). What
// remains here is the folder list, whose rename / share / delete affordances
// have no other home yet, and the footprint.
import { useEffect, useRef } from "react";

import { PendingWriteActions } from "../../_shared/PendingWriteActions.tsx";
import { fmtBytes } from "../format.ts";
import { DELETE_ICON, I, RENAME_ICON, SHARE_ICON } from "../icons.ts";
import { armConfirm } from "../kit.ts";
import { folderIdFrom, folderShelf } from "../shelves.ts";
import type { ShelfId } from "../shelves.ts";
import type { DriveDoc, Folder } from "../types.ts";
import { Icon } from "./Shared.tsx";

import styles from "./Sidebar.module.css";

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
    <button
      type="button"
      className={styles.navItem}
      aria-current={active}
      onClick={onClick}
    >
      <Icon svg={icon} />
      <span>{label}</span>
      {count == null ? null : <span className={styles.navCount}>{count}</span>}
    </button>
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
    const name = inputRef.current?.value.trim() ?? "";
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
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
          if (e.key === "Escape") onCancel();
        }}
      />
      <button type="button" className="kit-btn" onClick={commit}>
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
    const name = inputRef.current?.value.trim() ?? "";
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
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
          if (e.key === "Escape") onCancel();
        }}
      />
      <button type="button" className="kit-btn" onClick={commit}>
        Save
      </button>
    </div>
  );
}

function FolderRow({
  f,
  activeDocs,
  shelf,
  renamingFolderId,
  onSelectShelf,
  onShareFolder,
  residentFolderIds,
  onSaveFolder,
  onStartRename,
  onDeleteFolder,
  onRenameCommit,
  onRenameCancel,
}: {
  f: Folder;
  activeDocs: DriveDoc[];
  shelf: ShelfId;
  renamingFolderId: string | null;
  onSelectShelf: (shelf: ShelfId) => void;
  onShareFolder: (folder: Folder) => void;
  residentFolderIds: ReadonlySet<string>;
  onSaveFolder: (folder: Folder) => Promise<void>;
  onStartRename: (folderId: string) => void;
  onDeleteFolder: (folder: Folder) => void;
  onRenameCommit: (folderId: string, name: string) => void;
  onRenameCancel: () => void;
}) {
  if (renamingFolderId === f.folder_id)
    return (
      <FolderRenameEdit
        f={f}
        onCommit={onRenameCommit}
        onCancel={onRenameCancel}
      />
    );
  const count = activeDocs.filter(
    (d) => (d.folder_id ?? null) === f.folder_id
  ).length;
  const active = folderIdFrom(shelf) === f.folder_id;
  return (
    <div className={styles.folder}>
      <NavItem
        icon={I.folder!}
        label={f.name}
        active={active}
        count={count || ""}
        onClick={() => onSelectShelf(folderShelf(f.folder_id))}
      />
      <PendingWriteActions
        row={f as unknown as Record<string, unknown>}
        onEdit={() => onStartRename(f.folder_id)}
      />
      <span className={styles.folderTools}>
        <button
          type="button"
          className="kit-icon-btn"
          aria-label={
            residentFolderIds.has(f.folder_id)
              ? "Save to my vault"
              : `Share ${f.name}`
          }
          title={
            residentFolderIds.has(f.folder_id)
              ? "Save to my vault"
              : `Share ${f.name}`
          }
          onClick={(e) => {
            e.stopPropagation();
            if (residentFolderIds.has(f.folder_id)) void onSaveFolder(f);
            else onShareFolder(f);
          }}
        >
          <Icon svg={SHARE_ICON} />
        </button>
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
            if (
              !armConfirm(e.currentTarget, {
                armedLabel: `Delete ${f.name}?`,
              })
            )
              return;
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
  shelf,
  renamingFolderId,
  creatingFolder,
  onSelectShelf,
  onShareFolder,
  residentFolderIds,
  onSaveFolder,
  onStartRename,
  onDeleteFolder,
  onRenameCommit,
  onRenameCancel,
  onCreateCommit,
  onCreateCancel,
}: {
  folders: Folder[];
  activeDocs: DriveDoc[];
  shelf: ShelfId;
  renamingFolderId: string | null;
  creatingFolder: boolean;
  onSelectShelf: (shelf: ShelfId) => void;
  onShareFolder: (folder: Folder) => void;
  residentFolderIds: ReadonlySet<string>;
  onSaveFolder: (folder: Folder) => Promise<void>;
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
          shelf={shelf}
          renamingFolderId={renamingFolderId}
          onSelectShelf={onSelectShelf}
          onShareFolder={onShareFolder}
          residentFolderIds={residentFolderIds}
          onSaveFolder={onSaveFolder}
          onStartRename={onStartRename}
          onDeleteFolder={onDeleteFolder}
          onRenameCommit={onRenameCommit}
          onRenameCancel={onRenameCancel}
        />
      ))}
    </>
  );
}

// Storage → an honest footprint of what the drive is holding right now. The
// vault gives no account-wide total, so we report real bytes + count over the
// loaded window instead of a fabricated "used / total".
export function Storage({
  docs,
  truncated,
}: {
  docs: DriveDoc[];
  truncated: boolean;
}) {
  const bytes = docs.reduce((s, f) => s + (f.byte_size ?? 0), 0);
  return (
    <>
      <div className={styles.storageTop}>
        <span className={styles.lbl}>Footprint</span>
        <span className={styles.val}>{docs.length}</span>
      </div>
      <div className={styles.storageLabel}>
        {fmtBytes(bytes)} across {docs.length} document
        {docs.length === 1 ? "" : "s"}
        {truncated ? " — newest in view" : ""}
      </div>
    </>
  );
}
