// Grid view row (#grid root's mapped children).
import type { MouseEvent } from "react";

import { PendingWriteActions } from "../../_shared/PendingWriteActions.tsx";
import {
  fillVar,
  fmtBytes,
  fmtDate,
  inlineText,
  textExcerpt,
  tintBg,
  typeMeta,
} from "../format.ts";
import { KIND_ICONS_LG } from "../icons.ts";
import type { DriveDoc } from "../types.ts";
import { sharedFromLine } from "../view-copy.ts";
import { RowStateSlot, rowStateFor } from "./RowStateSlot.tsx";
import { Checkbox, CustodyDot, Icon } from "./Shared.tsx";

import styles from "./Grid.module.css";
import shared from "./shared.module.css";

export function GridCard({
  doc,
  index,
  offline,
  trashed,
  selectedIds,
  selecting,
  onOpenDetails,
  onOpenQuick,
  onToggleSelect,
  showSender = false,
}: {
  doc: DriveDoc;
  index: number;
  /** The gateway is out of reach — rung 4 of the row state ladder (§4.1). */
  offline: boolean;
  /** This card is in Trash, where the slot carries the purge date. */
  trashed: boolean;
  selectedIds: Set<string>;
  /** Selection is a MODE, entered by the app bar's Select (§4.1). */
  selecting: boolean;
  onOpenDetails: (id: string) => void;
  onOpenQuick: (id: string) => void;
  onToggleSelect: (id: string, index: number, shift: boolean) => void;
  /** A card is the same row in another layout (`ListRow`). */
  showSender?: boolean;
}) {
  const m = typeMeta(doc.media_type, doc.title);
  const selected = selectedIds.has(doc.document_id);
  // The document's real first words, when its bytes rode along inline. A
  // decorative mock of a page is only honest when there is nothing to show.
  const rowState = rowStateFor(doc, { trashed, offline });
  const body = inlineText(doc);
  const excerpt = body ? textExcerpt(body) : "";
  return (
    <div className={styles.card} data-selected={String(selected)}>
      {/* ONE CLICK SELECTS, TWO OPENS — the handoff wires its own doc card's
          whole surface to `dtapRow` (the picker), not to `dopenRow`, because a
          card has no "space around the name" the way a row does: the card IS
          the name. The thumb button above this overlay still previews on one
          click, which is the card's own way in.

          The card can't be a <button> (it holds the select + thumb buttons),
          so this is a stretched overlay under them; every control sits above
          it, so their clicks never reach here. */}
      <button
        type="button"
        className={`kit-stretch-btn ${styles.cardOpen}`}
        aria-label={`Select ${doc.title ?? "Untitled"}`}
        aria-pressed={selected}
        onClick={(e) => onToggleSelect(doc.document_id, index, e.shiftKey)}
        // A DOUBLE CLICK OPENS THE DOCUMENT ON THE STAGE, not the reading
        // route. One click picks the row, two open it — the gesture pair every
        // file browser a member has already used trains them on, and the thing
        // that opens is the document itself, full-bleed, with its properties
        // beside it.
        onDoubleClick={() => onOpenQuick(doc.document_id)}
      />
      <button
        type="button"
        className={`kit-plain-btn ${styles.thumb}`}
        style={{ background: tintBg(m.cv, 12) }}
        aria-label={`Preview ${doc.title ?? "Untitled"}`}
        onClick={() => onOpenQuick(doc.document_id)}
      >
        {/* NO PICTURE PREVIEW, for a picture either. The card carried a real
            frame where the bytes were an image or a video poster; it now
            carries the kind's glyph like every other card, because a grid
            whose tiles are half photographs and half marks reads as two
            grids. (This is a deliberate step past the handoff, whose own
            `docGridBlock` tones the preview for `img`.) */}
        {excerpt ? (
          <span className={styles.thumbExcerpt}>{excerpt}</span>
        ) : (
          <>
            {/* THE KIND GLYPH, not three capital letters. `DOC` / `PDF` /
                `XLS` set large on a tint is a filename extension wearing a
                badge: it repeats the Kind field one line below, it cannot be
                read at a glance the way a shape can, and the rows stopped
                drawing it — a drive that says "page" one way in a list and
                another way in a grid is two drives. */}
            <span className={styles.thumbGlyph}>
              <Icon svg={KIND_ICONS_LG[m.glyph]} />
            </span>
            {/* <span>, not <div>: this subtree is inside a <button> now, whose
                content model is phrasing content. `.thumbLines` already sets
                `display: flex`, so the box is unchanged. */}
            <span className={styles.thumbLines}>
              <i
                style={{
                  width: "70%",
                  background: `var(${fillVar(m.cv)})`,
                  opacity: 0.18,
                }}
              />
              <i
                style={{
                  width: "90%",
                  background: `var(${fillVar(m.cv)})`,
                  opacity: 0.14,
                }}
              />
              <i
                style={{
                  width: "55%",
                  background: `var(${fillVar(m.cv)})`,
                  opacity: 0.14,
                }}
              />
            </span>
          </>
        )}
      </button>
      {/* Selection is a mode here too (§4.1): the card is a different layout
          of the same row, so it cannot disagree with the list about whether
          anybody is selecting. */}
      {selecting ? (
        <Checkbox
          cls={styles.cardSelect!}
          selected={selected}
          onClick={(e: MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation();
            onToggleSelect(doc.document_id, index, e.shiftKey);
          }}
          label={`Select ${doc.title ?? "document"}`}
        />
      ) : null}
      <div className={styles.cardBody}>
        <div className={styles.cardTitle}>
          {doc.title ?? "Untitled"}
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
        </div>
        <div className={styles.cardMeta}>
          <span>
            {showSender && doc.shared_from
              ? sharedFromLine(doc.shared_from)
              : `${fmtBytes(doc.byte_size)} · ${fmtDate(doc.created_at)}`}
          </span>
          {/* The same one-mark slot the list row carries (§4.1): the card is
              a different layout of the same row, not a different set of
              facts about it. */}
          <RowStateSlot
            input={rowState}
            fallback={<CustodyDot state={doc.custody_state} />}
          />
        </div>
        <PendingWriteActions
          row={doc as unknown as Record<string, unknown>}
          onEdit={() => onOpenDetails(doc.document_id)}
        />
      </div>
    </div>
  );
}
