// THE BAND'S SIXTH SLOT (README-Locker §1).
//
// Four of Locker's destinations are PLACES and hold band slots of their own —
// Items, Review, Generate, Search. The five behind this sheet are SURFACES: an
// act you go and do, then leave. That is the whole of why they are here rather
// than in the band, and the sheet's foot says so instead of leaving a member
// to work out the difference.
//
// Each row carries the one line that says what the surface is for, so the
// sheet is a choice with reasons rather than five words to guess between.
import type { ReactNode } from "react";

import {
  MORE_CLOSE,
  MORE_FOOT,
  MORE_TITLE,
  SURFACE_META,
  SURFACE_TITLE,
} from "../route-copy.ts";
import type { ShelfId } from "../shelves.ts";

import styles from "./Rows.module.css";

export interface MoreSheetProps {
  shelves: readonly ShelfId[];
  onSelect: (shelf: ShelfId) => void;
  onClose: () => void;
}

export function MoreSheet(props: MoreSheetProps): ReactNode {
  return (
    <div className={styles.overlay}>
      <dialog open className={styles.panel} aria-label={MORE_TITLE}>
        <p className={styles.panelTitle}>{MORE_TITLE}</p>
        {props.shelves.map((shelf) => (
          <button
            key={String(shelf)}
            type="button"
            className={styles.moreRow}
            onClick={() => props.onSelect(shelf)}
          >
            <span className={styles.title}>
              {SURFACE_TITLE[String(shelf)] ?? String(shelf)}
            </span>
            <span className={styles.meta}>{SURFACE_META[String(shelf)]}</span>
          </button>
        ))}
        <p className={styles.panelBody}>{MORE_FOOT}</p>
        <div className={styles.panelActs}>
          <button type="button" className="kit-btn" onClick={props.onClose}>
            {MORE_CLOSE}
          </button>
        </div>
      </dialog>
    </div>
  );
}
