// The FOLDERS shelf (spec §4.3), drawn in THE DRIVE'S OWN IDIOM: it reuses the
// drive's ACTUAL classes, never a lookalike, and no folder tree goes in a rail
// (§14). The trailing crumb's place menu is the only desk-side door to the
// off-strip destinations. "A folder is a label on the document, not a place it
// sits" (§2 row 3): the last row is UNFILED, not a folder, and is never hidden.
import { useMemo, useState } from "react";
import type { ReactNode } from "react";

import { displayText } from "../../_shared/untrusted.ts";
import { PLACE_MENU, foldersCaption } from "../drive-copy.ts";
import type { Crumb } from "../drive-copy.ts";
import { folderCounts, unfiledCount } from "../folder-counts.ts";
import { FOLDER_ICON_LG, I } from "../icons.ts";
import { folderShelf } from "../shelves.ts";
import type { ShelfId } from "../shelves.ts";
import type { DriveDoc, Folder } from "../types.ts";
import { GONE_FOLDER_NOTE } from "../view-state.ts";
import { Breadcrumb } from "./Breadcrumb.tsx";
import { Icon } from "./Shared.tsx";

import chrome from "../Chrome.module.css";
import drive from "./DriveRoute.module.css";
import styles from "./FoldersRoute.module.css";
import grid from "./Grid.module.css";
import list from "./List.module.css";

type FolderSort = "name" | "count";

const COLUMNS: readonly { key: FolderSort; label: string; cls: string }[] = [
  { key: "name", label: "Name", cls: "colName" },
  { key: "count", label: "Documents", cls: "colCount" },
];

interface CountedFolder {
  folder: Folder;
  count: number;
}

/** The drive's card rules; a folder must not borrow a kind colour. */
function FolderCard({
  name,
  count,
  onOpen,
}: {
  name: string;
  count: number;
  onOpen?: () => void;
}): ReactNode {
  const noun = count === 1 ? "document" : "documents";
  return (
    <div className={`${grid.card} ${onOpen ? "" : styles.staticCard}`}>
      {onOpen ? (
        <button
          type="button"
          className={`kit-stretch-btn ${grid.cardOpen}`}
          aria-label={`Open ${name}, ${count} ${noun}`}
          onClick={onOpen}
        />
      ) : null}
      <span
        className={`${grid.thumb} ${onOpen ? styles.folderThumb : styles.emptyThumb}`}
        aria-hidden="true"
      >
        {onOpen ? (
          <span className={grid.thumbGlyph}>
            <Icon svg={FOLDER_ICON_LG} />
          </span>
        ) : null}
      </span>
      <div className={grid.cardBody}>
        <div className={grid.cardTitle}>{name}</div>
        <div className={grid.cardMeta}>
          <span>
            {count} {noun}
          </span>
        </div>
      </div>
    </div>
  );
}

export function FoldersRoute({
  folders,
  activeDocs,
  goneFolder,
  narrow,
  view,
  crumbs,
  onSelectShelf,
}: {
  folders: Folder[];
  activeDocs: DriveDoc[];
  /** Their folder is gone (view-state.ts rule 2). */
  goneFolder: boolean;
  /** Pointer-only head row, as on the drive (§13). */
  narrow: boolean;
  /** Two arrangements of ONE set, never two sets. */
  view: "grid" | "list";
  crumbs: readonly Crumb[];
  onSelectShelf: (shelf: ShelfId) => void;
}): ReactNode {
  // Local on purpose: nothing persists a folder order.
  const [sortKey, setSortKey] = useState<FolderSort>("name");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const sortBy = (key: FolderSort): void => {
    if (key === sortKey) {
      setSortDir((dir) => (dir === 1 ? -1 : 1));
      return;
    }
    setSortKey(key);
    // Names from A, counts from the biggest.
    setSortDir(key === "name" ? 1 : -1);
  };

  // Shared with the nav rail: a count disagreeing with its shelf header is a
  // defect (v16 §3).
  const unfiled = unfiledCount(activeDocs);
  const rows = useMemo<CountedFolder[]>(() => {
    const perFolder = folderCounts(folders, activeDocs);
    const counted = folders.map((folder) => ({
      folder,
      count: perFolder.get(folder.folder_id) ?? 0,
    }));
    // Ties break on the name; no arbitrary order.
    counted.sort((a, b) =>
      sortKey === "name"
        ? sortDir * a.folder.name.localeCompare(b.folder.name)
        : sortDir * (a.count - b.count) ||
          a.folder.name.localeCompare(b.folder.name)
    );
    return counted;
  }, [folders, activeDocs, sortKey, sortDir]);

  return (
    <>
      <Breadcrumb
        crumbs={crumbs}
        menu={PLACE_MENU}
        onSelectShelf={onSelectShelf}
      />
      {goneFolder ? (
        // Not a toast: the destination explains itself.
        <p className={styles.gone}>{GONE_FOLDER_NOTE}</p>
      ) : null}
      {view === "grid" ? (
        <div className={chrome.grid}>
          {rows.map(({ folder, count }) => (
            <FolderCard
              key={folder.folder_id}
              name={displayText(folder.name)}
              count={count}
              onOpen={() => onSelectShelf(folderShelf(folder.folder_id))}
            />
          ))}
          <FolderCard name="Unfiled" count={unfiled} />
        </div>
      ) : (
        <div className={chrome.listwrap}>
          {narrow ? null : (
            <div className={chrome.listHead}>
              {/* The drive's `--h-control` spacer, so names share one line. */}
              <span style={{ width: "var(--h-control)" }} />
              {COLUMNS.map((col) => {
                const active = sortKey === col.key;
                const dir = sortDir === 1 ? "ascending" : "descending";
                return (
                  <button
                    key={col.key}
                    type="button"
                    className={`kit-plain-btn ${list.col} ${styles[col.cls]}`}
                    data-active={String(active)}
                    onClick={() => sortBy(col.key)}
                  >
                    {col.label}
                    {/* The direction is announced as real text. */}
                    {active ? (
                      <>
                        <span aria-hidden="true">
                          {sortDir === 1 ? " ↑" : " ↓"}
                        </span>
                        <span className="kit-sr-only">, sorted {dir}</span>
                      </>
                    ) : null}
                  </button>
                );
              })}
              {/* Empty but width-keeping: a folder has no verbs yet, and a
                  menu with no items would be the worse answer. */}
              <span className={`${list.col} ${list.end}`} />
            </div>
          )}
          <div>
            {rows.map(({ folder, count }) => {
              const name = displayText(folder.name);
              const noun = count === 1 ? "document" : "documents";
              return (
                <div key={folder.folder_id} className={list.row}>
                  {/* One click OPENS: no bulk verb acts on a folder, so the
                      stretch overlay opens rather than picks. */}
                  <button
                    type="button"
                    className={`kit-stretch-btn ${list.rowOpen}`}
                    aria-label={`Open ${name}, ${count} ${noun}`}
                    onClick={() => onSelectShelf(folderShelf(folder.folder_id))}
                  />
                  <span className={`${list.badge} ${styles.inert}`}>
                    <Icon svg={I.folder!} />
                  </span>
                  <div className={list.rowMain}>
                    <span className={`${list.rowTitle} ${styles.inert}`}>
                      {name}
                    </span>
                  </div>
                  <span className={`${list.cell} ${styles.count}`}>
                    {count}
                  </span>
                  <span className={`${list.rowEnd} ${styles.inert}`} />
                </div>
              );
            })}
            {/* Unfiled is not a folder: no id, no way in, NO GLYPH. The empty
                badge keeps the column. */}
            <div className={`${list.row} ${styles.staticRow}`}>
              <span className={`${list.badge} ${styles.inert}`} aria-hidden />
              <div className={list.rowMain}>
                <span className={`${list.rowTitle} ${styles.inert}`}>
                  Unfiled
                </span>
              </div>
              <span className={`${list.cell} ${styles.count}`}>{unfiled}</span>
              <span className={`${list.rowEnd} ${styles.inert}`} />
            </div>
          </div>
        </div>
      )}
      {/* The drive's caption class, never a lookalike. */}
      <p className={drive.caption}>{foldersCaption(unfiled)}</p>
    </>
  );
}
