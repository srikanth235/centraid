// List view: the head row (#listHead root), each row (#list root's mapped
// children) and the truncation footer (#windowFoot root).
import type { CSSProperties, MouseEvent } from "react";

import { PendingWriteActions } from "../../_shared/PendingWriteActions.tsx";
import { displayText } from "../../_shared/untrusted.ts";
import { WINDOW_FAILED } from "../drive-copy.ts";
import { fmtBytes, fmtDate, typeMeta } from "../format.ts";
import { I, KIND_ICONS } from "../icons.ts";
import type { DriveDoc, SortKey } from "../types.ts";
import { RowStateSlot, rowStateFor } from "./RowStateSlot.tsx";
import { ActionBtn, Checkbox, CustodyDot, Icon, Snippet } from "./Shared.tsx";

import styles from "./List.module.css";
import shared from "./shared.module.css";

/** Who a row belongs to: a display name and the initial its disc carries. */
export interface DriveOwner {
  name: string;
  initial: string;
}

export function ListRow({
  doc,
  index,
  selectedIds,
  selecting,
  owner,
  narrow,
  search,
  trashed,
  offline,
  folderName,
  onOpenDetails,
  onOpenQuick,
  onToggleSelect,
  onOpenMenu,
  onRestore,
}: {
  doc: DriveDoc;
  index: number;
  selectedIds: Set<string>;
  /** Selection is a MODE (§4.1). Off, the row draws no box at all. */
  selecting: boolean;
  /** Who this document belongs to, as the drive can answer it. */
  owner: DriveOwner;
  narrow: boolean;
  search: string;
  trashed: boolean;
  /** The gateway is out of reach — rung 4 of the state ladder (§4.1). */
  offline: boolean;
  folderName: (id: string | null | undefined) => string;
  onOpenDetails: (id: string) => void;
  onOpenQuick: (id: string) => void;
  onToggleSelect: (id: string, index: number, shift: boolean) => void;
  onOpenMenu: (anchor: HTMLElement, doc: DriveDoc) => void;
  onRestore: (doc: DriveDoc) => void;
}) {
  const m = typeMeta(doc.media_type, doc.title);
  const selected = selectedIds.has(doc.document_id);
  const title = displayText(doc.title || "Untitled");
  const where = displayText(folderName(doc.folder_id));
  // The row's ONE state slot (§4.1). The ladder decides which of the five
  // things it may say; this row only supplies what it has read.
  const rowState = rowStateFor(doc, { trashed, offline });
  return (
    <div
      className={styles.row}
      data-selected={String(selected)}
      data-narrow={String(narrow)}
    >
      {/* THE ROW BODY SELECTS ON ONE CLICK AND OPENS ON TWO. That is the
          handoff's rule, verbatim: "A single click SELECTS and raises the
          action bar; a double click opens. Drive's behaviour, and the reason
          the bar can be a bar rather than a mode you enter." The bar is what
          makes it work — picking a row puts five verbs on screen immediately,
          so a member never has to know that a mode exists before they can act
          on something.

          THE NAME STILL OPENS ON ONE CLICK (`.rowTitle` below), the same way
          the handoff's own row does — its `openCss` column carries `open:
          dopenRow`. So the two gestures do not compete: the words open the
          document, the space around them picks it.

          The row can't be a <button> (it holds the select / preview / title /
          actions buttons), so this is a stretched overlay laid under them;
          every control sits above it, so their clicks never reach here. */}
      <button
        type="button"
        className={`kit-stretch-btn ${styles.rowOpen}`}
        aria-label={`Select ${title}`}
        aria-pressed={selected}
        onClick={(e) => onToggleSelect(doc.document_id, index, e.shiftKey)}
        // A DOUBLE CLICK OPENS THE DOCUMENT ON THE STAGE, not the reading
        // route. One click picks the row, two open it — the gesture pair every
        // file browser a member has already used trains them on, and the thing
        // that opens is the document itself, full-bleed, with its properties
        // beside it.
        onDoubleClick={() => onOpenQuick(doc.document_id)}
      />
      {/* The box appears once something IS selected, never before (the
          handoff's `showBox: !!sel`). It used to stand on every row of every
          drive whether or not anybody was selecting anything — a permanent
          empty control at the leading edge of the one thing the member came to
          read, and a column of them down the whole set. */}
      {selecting ? (
        <Checkbox
          cls={styles.check!}
          selected={selected}
          onClick={(e: MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation();
            onToggleSelect(doc.document_id, index, e.shiftKey);
          }}
          label={`Select ${title}`}
        />
      ) : null}
      {/* THE KIND MARK — THE KIND'S GLYPH, FOR EVERY KIND, WITH NO EXCEPTION
          FOR PICTURES. This slot used to fork: a real thumbnail where the
          bytes were an image or a video poster, the kind's line glyph
          everywhere else. That made the leading edge of the drive two
          different things at once — a column of ink marks with photographs cut
          into it — and the mark stopped being readable as a mark. It is a
          KIND mark; a kind is what it says. The document itself is one double
          click away on the stage, at the size a picture is worth looking at.

          Drawn on nothing at all, the way the handoff draws its row icons
          (`docRowsBlock`'s `iconCss` is a colour and a display mode — no
          background, no radius). Before either of those it was a tinted square
          with `DOC`/`PDF`/`XLS` stamped in it: a filename extension in a
          badge, repeating the Kind column that then stood two fields to the
          right. That column is gone as well now, and this mark is what
          carries the kind on the row. */}
      <button
        type="button"
        className={styles.badge}
        aria-label={`Preview ${title}`}
        onClick={(e) => {
          e.stopPropagation();
          onOpenQuick(doc.document_id);
        }}
      >
        <Icon svg={KIND_ICONS[m.glyph]} />
      </button>
      <div className={styles.rowMain}>
        <button
          type="button"
          className={`kit-plain-btn ${styles.rowTitle}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpenQuick(doc.document_id);
          }}
        >
          {title}
          {/* The star's label is real (visually hidden) TEXT rather than an
              `aria-label` on a faked `role="img"` — same announcement, no
              invented role, and the same pattern Shared.tsx's CustodyDot
              already uses. */}
          {doc.starred ? (
            <span className={shared.starInd}>
              <span aria-hidden="true">★</span>
              <span className="kit-sr-only">Starred</span>
            </span>
          ) : null}
        </button>
        {/* AT MOST ONE MARK, AND IT LIVES UNDER THE NAME — on every form
            factor, not only the compact one. It used to stand inside the
            trailing Changed cell on pointer, which is 88px wide and already
            holds a date: a rung that returns a phrase rather than a glyph
            ("cannot be shown", "purged in 30 days", "could not be fetched")
            left the date no width at all and wrapped `Aug 18` down the column
            one character per line. The name's own column is the one place on
            the row with slack, and putting the mark there means the two form
            factors say the same thing in the same place. */}
        <RowStateSlot
          input={rowState}
          fallback={<CustodyDot state={doc.custody_state} />}
        />
        {search.trim() && doc.snippet ? (
          <Snippet snippet={doc.snippet} />
        ) : null}
        {/* The compact row folds the trailing columns into one line, in the
            same order the head lists them: size · changed (§4.1). No kind
            here either, for the reason the column went — and it counts double
            on this form factor, where the title it would repeat is on the
            line directly above. In trash and in a search result the FOLDER is
            the more useful fact, so it takes the line instead — the columns
            are not on screen to contradict it either way. */}
        {narrow ? (
          <div className={styles.rowMeta}>
            {trashed
              ? `from ${where}`
              : search.trim()
                ? `in ${where}`
                : `${fmtBytes(doc.byte_size)} · ${fmtDate(doc.updated_at)}`}
          </div>
        ) : null}
        <PendingWriteActions
          row={doc as unknown as Record<string, unknown>}
          onEdit={() => onOpenDetails(doc.document_id)}
        />
      </div>
      {/* NO KIND COLUMN. The handoff's row set is Name · Owner · Kind · Size ·
          Changed; ours drops the Kind cell, and it is the one column removal
          on this row.

          The kind is already on the row TWICE before that cell is reached —
          the glyph at the leading edge, and the extension the member typed at
          the end of the title. `Lease agreement.pdf` followed by `PDF` is the
          filename read back, and 96px is a wide thing to spend saying it. The
          FACT is not gone: the mark carries it at a glance, the Type pill
          filters on it, and Kind is still a named order in the sort menu — a
          set ordered by kind reads as a run of like marks down the leading
          edge, which is how a member sees the grouping anyway.

          The folder was never in this cell either, and for its own reason: it
          is a LABEL on the document with three homes already (the Folders
          shelf, the breadcrumb, the details rail). It still leads the compact
          line for trash and search, where it answers "from where". */}
      {/* OWNER. A disc and a word, because on a drive that holds somebody
          else's documents the first question about a row is whose it is —
          and the answer has to be legible before the eye reaches the kind. */}
      <span className={`${styles.cell} ${styles.owner}`}>
        <span className={styles.ownerDisc} aria-hidden="true">
          {owner.initial}
        </span>
        <span className={styles.ownerName}>{owner.name}</span>
      </span>
      <span className={`${styles.cell} ${styles.size}`}>
        {fmtBytes(doc.byte_size)}
      </span>
      <span
        className={`${styles.cell} ${styles.changed}${trashed ? ` ${styles.purge}` : ""}`}
      >
        {/* CHANGED, not added: the drive is ordered by last change, newest
            first, and a column that sorted on one date while printing another
            is the sort lying about itself. In trash the slot below carries the
            purge date (§4.1 rung 3), so the column stands empty rather than
            printing a countdown twice in one row. */}
        {trashed ? null : fmtDate(doc.updated_at)}
      </span>
      <div className={styles.rowEnd}>
        {trashed ? (
          <ActionBtn
            icon="restore"
            label="Restore"
            onClick={(e) => {
              e.stopPropagation();
              onRestore(doc);
            }}
          />
        ) : (
          <button
            type="button"
            className="kit-icon-btn"
            style={{ "--icon-button-size": "1.875rem" } as CSSProperties}
            aria-label={`Actions for ${title}`}
            aria-haspopup="menu"
            onClick={(e) => {
              e.stopPropagation();
              onOpenMenu(e.currentTarget, doc);
            }}
          >
            <Icon svg={I.dots!} />
          </button>
        )}
      </div>
    </div>
  );
}

/** The sortable columns, in the order the head lists them. */
const COLUMNS: readonly { key: SortKey; label: string; cls: string }[] = [
  { key: "name", label: "Name", cls: "name" },
  { key: "owner", label: "Owner", cls: "owner" },
  { key: "size", label: "Size", cls: "size" },
  { key: "changed", label: "Changed", cls: "changed" },
];

/**
 * The head row — and the drive's SORT CONTROL, which is the same thing.
 *
 * The sort is not a button up in the toolbar, three regions away from the
 * columns it orders. A member who wants this set by size looks at the word
 * "Size" and presses it; that is the whole
 * interaction, and it is the one the handoff draws. The arrow rides the active
 * column, so where the order comes from and what it is are one reading.
 */
export function ListHead({
  rows,
  selectedIds,
  selecting,
  onToggleAll,
  sortKey,
  sortDir,
  onSortBy,
  onOpenSortMenu,
}: {
  rows: DriveDoc[];
  selectedIds: Set<string>;
  /** Selection mode — the select-all box exists only inside it. */
  selecting: boolean;
  onToggleAll: (rows: DriveDoc[], allSelected: boolean) => void;
  sortKey: SortKey;
  /** 1 ascending, -1 descending — the arrow the active column carries. */
  sortDir: 1 | -1;
  /** Sort by this column; pressing the active one reverses it. */
  onSortBy: (key: SortKey) => void;
  /** Open the named-orders menu, anchored to its own trailing button. */
  onOpenSortMenu: (anchor: HTMLElement) => void;
}) {
  const allSel =
    rows.length > 0 && rows.every((d) => selectedIds.has(d.document_id));
  return (
    <>
      {selecting ? (
        <Checkbox
          cls={styles.check!}
          selected={allSel}
          onClick={() => onToggleAll(rows, allSel)}
          label={allSel ? "Deselect all" : "Select all"}
        />
      ) : null}
      {/* Column spacer aligning the head with each row's kind badge, which is
          exactly one control tall and wide (`--h-control`). */}
      <span style={{ width: "var(--h-control)" }} />
      {COLUMNS.map((col) => {
        const active = sortKey === col.key;
        const dir = sortDir === 1 ? "ascending" : "descending";
        return (
          <button
            key={col.key}
            type="button"
            className={`kit-plain-btn ${styles.col} ${styles[col.cls]}`}
            data-active={String(active)}
            onClick={() => onSortBy(col.key)}
          >
            {col.label}
            {/* The mark is decoration; the direction is announced as real
                text, so a screen reader is told the order rather than an
                arrow glyph's name. */}
            {active ? (
              <>
                <span aria-hidden="true">{sortDir === 1 ? " ↑" : " ↓"}</span>
                <span className="kit-sr-only">, sorted {dir}</span>
              </>
            ) : null}
          </button>
        );
      })}
      {/* The named orders, in the head's trailing cell — the same slot each
          row's kebab occupies, because both answer "what else can I do to
          what is under me". */}
      <span className={`${styles.col} ${styles.end}`}>
        <button
          type="button"
          className={`kit-plain-btn ${styles.sortMenu}`}
          aria-label="Sort the drive"
          aria-haspopup="menu"
          onClick={(e) => onOpenSortMenu(e.currentTarget)}
        >
          <span aria-hidden="true">≡</span>
        </button>
      </span>
    </>
  );
}

export function WindowFoot({
  driveWindow,
  failed = false,
  onShowMore,
}: {
  driveWindow: number;
  /**
   * The read for the rows BEYOND the fetched window came back failed (§4.1
   * rung 1). Only then may the window say so: a window still in flight says
   * nothing at all, because "could not be fetched" about a read that is still
   * running is a sentence the app would have had to invent.
   */
  failed?: boolean;
  onShowMore: () => Promise<void> | void;
}) {
  return (
    <>
      <span>
        Showing your latest {driveWindow} documents — older ones are a search
        away.
      </span>
      {failed ? (
        <span className={styles.windowFailed}>{WINDOW_FAILED}</span>
      ) : null}
      <ActionBtn
        icon="more"
        label="Show more"
        onClick={async (e) => {
          (e.currentTarget as HTMLButtonElement).disabled = true;
          await onShowMore();
        }}
      />
    </>
  );
}
