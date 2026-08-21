// The FOLDERS shelf (Docs spec §4.3 `folders`) — the shelf that replaced the
// folder-tree rail, drawn in THE DRIVE'S OWN IDIOM.
//
// "Cut: a folder tree in a rail. Two navigation columns in one window is what
// invariant 1 refuses. Folders are a breadcrumb and a shelf." (spec §14,
// verbatim.) This is the shelf half of that sentence — and a shelf in this app
// has a shape, which this screen used to ignore.
//
// WHAT IT WAS: a bordered card of its own, with its own padding inside a
// region that already pads, no breadcrumb, no column heads, no sort, a
// hand-rolled row, and a closing sentence in a bespoke class. Every one of
// those is something the drive already decides — and a shelf that decides them
// again, differently, is a second app inside the first. Six tabs across the
// strip, and pressing one of them changed the furniture.
//
// WHAT IT IS NOW: the drive's block sequence, breadcrumb → set → caption, and
// the drive's ACTUAL stylesheet classes (`Chrome.module.css` `.listwrap` /
// `.listHead`, `List.module.css` `.row` / `.badge` / `.rowMain` / `.rowTitle`
// / `.cell` / `.rowEnd`, `DriveRoute.module.css` `.caption`). Not a lookalike
// re-authored here — the same rules, so the two screens cannot drift apart the
// next time one of them is touched. What is local to this file is only what is
// genuinely folder-shaped: the two columns and their widths.
//
// THE BREADCRUMB IS NOT DECORATION HERE. Its trailing crumb carries the place
// menu, which at a desk is the ONLY door to the seven off-strip destinations
// (Storage, What Docs may read, Add, Scan, and the three boundary screens).
// Without it, standing on Folders shut every one of them.
//
// "A folder is a label on the document, not a place it sits" (§2 row 3) —
// which is why the last row is UNFILED and is not a folder. A document that
// carries no folder label is not lost and is not an error; it simply never had
// one put on it, and a shelf that hid it would be hiding the majority of most
// drives.
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

/** The two facts a folder has. The drive's heads ARE its sort control, so
 *  these are too — a head row that looked identical and did nothing when
 *  pressed would be the same divergence one layer down. */
type FolderSort = "name" | "count";

const COLUMNS: readonly { key: FolderSort; label: string; cls: string }[] = [
  { key: "name", label: "Name", cls: "colName" },
  { key: "count", label: "Documents", cls: "colCount" },
];

interface CountedFolder {
  folder: Folder;
  count: number;
}

/**
 * One folder as a CARD — the grid arrangement of the same set.
 *
 * The drive's own card rules (`Grid.module.css`), because this is the same
 * furniture holding a different noun: hairline sheet, 104px preview, clamped
 * title, meta line under it. What differs is the preview, and only because a
 * folder has no bytes to show — where a document card puts its kind mark on a
 * kind tint, this puts the folder mark on the APP's own hue. A folder is not a
 * file kind and must not borrow one of the six kind colours.
 *
 * `onOpen` is absent on Unfiled, which is not a folder and has nowhere to go.
 * The card then draws no overlay and no glyph rather than a dead target.
 */
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
  /** Every untrashed document, so each row counts its own without a
   *  second read. */
  activeDocs: DriveDoc[];
  /** The member was just moved here because the folder they were on no longer
   *  exists (view-state.ts rule 2). The shelf owes them the reason. */
  goneFolder: boolean;
  /** The compact form factor. The head row is pointer-only, exactly as the
   *  drive's is (§13) — on touch there is nothing to press it with. */
  narrow: boolean;
  /** The arrangement, from the same `AppState.view` the drive reads and the
   *  same toggle sets. Two arrangements of ONE set — never two sets. */
  view: "grid" | "list";
  /** The chain, from `crumbsFor` — this screen does not derive its own, for
   *  the same reason no other screen does. */
  crumbs: readonly Crumb[];
  onSelectShelf: (shelf: ShelfId) => void;
}): ReactNode {
  // Local, and deliberately so: a folder order is not a fact about the drive
  // that another surface reads, and nothing persists it. The drive's own sort
  // lives in `AppState` because the app bar, the sort menu and the heads all
  // have to agree about it; here the heads are the only reader.
  const [sortKey, setSortKey] = useState<FolderSort>("name");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const sortBy = (key: FolderSort): void => {
    if (key === sortKey) {
      setSortDir((dir) => (dir === 1 ? -1 : 1));
      return;
    }
    setSortKey(key);
    // A fresh column opens in the direction that column is usually read: names
    // from A, counts from the biggest.
    setSortDir(key === "name" ? 1 : -1);
  };

  // Both numbers come from `folder-counts.ts`, which the NAVIGATION RAIL reads
  // too (v16 §3: a count that disagrees with its shelf header is a defect).
  // This screen owned the expression while it was the only surface drawing a
  // folder's count; two surfaces deriving it separately is how they come to
  // disagree the first time either is edited.
  const unfiled = unfiledCount(activeDocs);
  const rows = useMemo<CountedFolder[]>(() => {
    const perFolder = folderCounts(folders, activeDocs);
    const counted = folders.map((folder) => ({
      folder,
      count: perFolder.get(folder.folder_id) ?? 0,
    }));
    // Ties break on the name, so an order is never arbitrary: two folders
    // holding three documents each sit A before B, both ways round.
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
        // Not a toast and not an error strip: the member navigated, and this
        // is the destination explaining why it is the destination.
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
              {/* The badge column's spacer — the same `--h-control` the drive's
                  head leaves for a kind mark, so the two screens' names start
                  on one vertical line. */}
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
                    {/* The mark is decoration; the direction is announced as
                        real text, so a screen reader is told the order rather
                        than an arrow glyph's name. */}
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
              {/* The trailing cell stands empty and keeps its width. A folder
                  has no verbs yet — no rename, no delete, nothing the drive's
                  kebab would open — and 40px of nothing is what keeps this
                  row's columns on the drive's columns. A menu with no items in
                  it would be the worse answer. */}
              <span className={`${list.col} ${list.end}`} />
            </div>
          )}
          <div>
            {rows.map(({ folder, count }) => {
              const name = displayText(folder.name);
              const noun = count === 1 ? "document" : "documents";
              return (
                <div key={folder.folder_id} className={list.row}>
                  {/* ONE CLICK OPENS. A folder is not selectable — there is no
                      bulk verb that acts on one — so this is the drive's
                      stretch overlay wired to open rather than to pick, and the
                      row has no second gesture to learn. */}
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
            {/* Unfiled is a fact about the drive, not a folder — so it has no
                folder id, no way in, and NO FOLDER GLYPH: wearing the mark
                would contradict the caption's own sentence one line below. The
                empty badge keeps the column. */}
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
      {/* The drive's caption class, not a second one that looks like it —
          same measure, same rung, same distance under the set. */}
      <p className={drive.caption}>{foldersCaption(unfiled)}</p>
    </>
  );
}
