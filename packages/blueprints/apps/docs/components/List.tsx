// List view: the head row (#listHead root), each row (#list root's mapped
// children) and the truncation footer (#windowFoot root).
import type { CSSProperties, MouseEvent } from "react";

import { PendingWriteActions } from "../../_shared/PendingWriteActions.tsx";
import { displayText } from "../../_shared/untrusted.ts";
import { WINDOW_FAILED } from "../drive-copy.ts";
import {
  fmtBytes,
  fmtDate,
  isImage,
  isVideo,
  tintBg,
  typeMeta,
} from "../format.ts";
import { I } from "../icons.ts";
import type { DriveDoc } from "../types.ts";
import { RowStateSlot, rowStateFor } from "./RowStateSlot.tsx";
import { Checkbox, CustodyDot, Icon, Snippet } from "./Shared.tsx";

import styles from "./List.module.css";
import shared from "./shared.module.css";

export function ListRow({
  doc,
  index,
  selectedIds,
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
  const m = typeMeta(doc.media_type);
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
      {/* The row can't be a <button> (it holds the select / preview / title /
          actions buttons), so the "open details" gesture is a stretched overlay
          button laid under them. The old `closest('button, a, input')` guard is
          gone: every control now sits above this overlay, so their clicks never
          reach it. */}
      <button
        type="button"
        className={`kit-stretch-btn ${styles.rowOpen}`}
        aria-label={`Open ${title} details`}
        onClick={() => onOpenDetails(doc.document_id)}
      />
      <Checkbox
        cls={styles.check!}
        selected={selected}
        onClick={(e: MouseEvent<HTMLButtonElement>) => {
          e.stopPropagation();
          onToggleSelect(doc.document_id, index, e.shiftKey);
        }}
        label={`Select ${title}`}
      />
      <button
        type="button"
        className={styles.badge}
        style={{ background: tintBg(m.cv, 12) }}
        aria-label={`Preview ${title}`}
        onClick={(e) => {
          e.stopPropagation();
          onOpenQuick(doc.document_id);
        }}
      >
        {isImage(doc) ? (
          <img src={doc.content_uri} alt="" loading="lazy" />
        ) : isVideo(doc) && doc.poster_uri ? (
          <>
            <img
              src={doc.poster_uri}
              alt=""
              loading="lazy"
              onError={(e) => e.currentTarget.remove()}
            />
            <span
              className={`${shared.mediaPlay} ${shared.small}`}
              aria-hidden="true"
            >
              ▶
            </span>
          </>
        ) : (
          <span style={{ color: `var(${m.cv})` }}>{m.label}</span>
        )}
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
        {/* At most one mark, and never a sentence — the caption under the set
            carries the prose, once (§4.1). On the compact form factor the
            trailing columns are folded away, so the slot travels here with
            them; on pointer it stands in the trailing cell instead. Exactly
            one of the two renders. */}
        {narrow ? (
          <RowStateSlot
            input={rowState}
            fallback={<CustodyDot state={doc.custody_state} />}
          />
        ) : null}
        {search.trim() && doc.snippet ? (
          <Snippet snippet={doc.snippet} />
        ) : null}
        {narrow ? (
          <div className={styles.rowMeta}>
            {trashed
              ? `from ${where}`
              : search.trim()
                ? `in ${where}`
                : `${fmtBytes(doc.byte_size)} · ${fmtDate(doc.created_at)}`}
          </div>
        ) : null}
        <PendingWriteActions
          row={doc as unknown as Record<string, unknown>}
          onEdit={() => onOpenDetails(doc.document_id)}
        />
      </div>
      <span className={`${styles.cell} ${styles.where}`}>
        {trashed ? `from ${where}` : where}
      </span>
      <span className={`${styles.cell} ${styles.size}`}>
        {fmtBytes(doc.byte_size)}
      </span>
      <span
        className={`${styles.cell} ${styles.added}${trashed ? ` ${styles.purge}` : ""}`}
      >
        {/* In trash the slot below carries the purge date (§4.1 rung 3), so
            the column says when the document was added and nothing else — the
            countdown is not printed twice in one row. */}
        {trashed ? null : fmtDate(doc.created_at)}
        {/* The custody dot only ever stands in the ladder's SILENCE now
            (RowStateSlot's `fallback`), so a row can never carry both. */}
        <RowStateSlot
          input={rowState}
          fallback={<CustodyDot state={doc.custody_state} />}
        />
      </span>
      <div className={styles.rowEnd}>
        {trashed ? (
          <button
            type="button"
            className="kit-btn"
            onClick={(e) => {
              e.stopPropagation();
              onRestore(doc);
            }}
          >
            Restore
          </button>
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

export function ListHead({
  rows,
  selectedIds,
  onToggleAll,
}: {
  rows: DriveDoc[];
  selectedIds: Set<string>;
  onToggleAll: (rows: DriveDoc[], allSelected: boolean) => void;
}) {
  const allSel =
    rows.length > 0 && rows.every((d) => selectedIds.has(d.document_id));
  return (
    <>
      <Checkbox
        cls={styles.check!}
        selected={allSel}
        onClick={() => onToggleAll(rows, allSel)}
        label={allSel ? "Deselect all" : "Select all"}
      />
      {/* Column spacer aligning the head with each row's kind badge, which is
          exactly one control tall and wide (`--h-control`). */}
      <span style={{ width: "var(--h-control)" }} />
      <span className={`${styles.col} ${styles.name}`}>Name</span>
      <span className={`${styles.col} ${styles.where}`}>Where</span>
      <span className={`${styles.col} ${styles.size}`}>Size</span>
      <span className={`${styles.col} ${styles.added}`}>Added</span>
      <span className={`${styles.col} ${styles.end}`} />
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
      <button
        type="button"
        className="kit-btn"
        onClick={async (e) => {
          e.currentTarget.disabled = true;
          await onShowMore();
        }}
      >
        Show more
      </button>
    </>
  );
}
