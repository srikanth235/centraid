// THE ONE ROW SHAPE, AND THE ONE SECTION HEAD (README-Locker §5).
//
// Every list in Locker — Items, Review, Search, Trash, the Companion's
// candidates — is this row under a different filter. That is why it lives in
// one file: a title that rendered one way in the list and another in the
// review is exactly the drift the shared row grammar exists to prevent.
//
// The row is: type chip · title · meta sentence · star · verdict · ONE quiet
// verb. One, not two: a row with a menu of acts is a row asking the member to
// choose before they have opened the thing.
import type { ReactNode } from "react";

import {
  readPendingOverlay,
  pendingOverlayCopy,
} from "../../_shared/pending-overlay.ts";
import { displayText } from "../../_shared/untrusted.ts";
import { metaSentence, typeChip, verdictOf } from "../format.ts";
import type { LockerRow } from "../types.ts";

import styles from "./Rows.module.css";

export interface RowVerb {
  label: string;
  run: () => void;
}

export interface ItemRowProps {
  row: LockerRow;
  /** Opening an item is a per-item gesture — it opens the permit gate, not
   *  the item's secrets. Absent where a row is a fact rather than a door. */
  onOpen?: (itemId: string) => void;
  /** The row's ONE quiet verb, or none. */
  verb?: RowVerb;
  /** Extra words for this list's own reason for showing the row — a purge
   *  date in Trash, "matched the title" in Search. */
  meta?: string;
  /** A verdict this list asserts over the row's own (Review names the check
   *  it grouped by). */
  status?: { label: string; tone: "net" | "seam" } | null;
}

export function ItemRow(props: ItemRowProps): ReactNode {
  const { row } = props;
  const pending = readPendingOverlay(row as unknown as Record<string, unknown>);
  const verdict = props.status === undefined ? verdictOf(row) : props.status;
  const meta = [metaSentence(row), props.meta].filter(Boolean).join("  ·  ");
  const body = (
    <>
      <span className={styles.title}>{displayText(row.title)}</span>
      <span className={styles.meta}>{meta}</span>
    </>
  );
  return (
    <div
      className={styles.rowWrap}
      data-item-id={row.item_id}
      {...(pending ? { "data-pending": "true" } : {})}
    >
      <div className={styles.row}>
        <span className={styles.chip} aria-hidden="true">
          {typeChip(row.type)}
        </span>
        {props.onOpen ? (
          <button
            type="button"
            className={styles.open}
            onClick={() => props.onOpen?.(row.item_id)}
          >
            {body}
          </button>
        ) : (
          <span className={styles.open}>{body}</span>
        )}
        {row.favorite ? (
          // The one product-wide star, as a mark. Its accessible name is the
          // word, because a glyph alone is not a name.
          <>
            <span className={styles.star} aria-hidden="true">
              ★
            </span>
            <span className="kit-sr-only">Starred</span>
          </>
        ) : null}
        {verdict ? (
          <span className={styles.status} data-tone={verdict.tone}>
            {verdict.label}
          </span>
        ) : null}
        {props.verb ? (
          <button
            type="button"
            className="kit-btn quiet"
            onClick={() => props.verb?.run()}
          >
            {props.verb.label}
          </button>
        ) : null}
      </div>
      {pending ? (
        <p className={`${styles.meta} ${styles.num}`}>
          {pendingOverlayCopy(pending)}
        </p>
      ) : null}
    </div>
  );
}

export interface SectionProps {
  label: string;
  /** The count and what it counts, in this section's own words. */
  meta?: string;
  /** The section's own text verb, at the end of the head. */
  verb?: RowVerb;
  /** What stands here when the section has nothing — on ITS OWN terms, never
   *  on the list's. Absent means the section is simply not drawn. */
  empty?: ReactNode;
  children?: ReactNode;
  /** Has a read landed? Nothing is empty until one has. */
  loaded?: boolean;
  count: number;
}

export function Section(props: SectionProps): ReactNode {
  const showsEmpty = props.loaded !== false && props.count === 0;
  return (
    <section className={styles.section}>
      <header className={styles.sectionHead}>
        <span className={styles.sectionLabel}>{props.label}</span>
        {props.meta ? (
          <span className={`${styles.sectionMeta} ${styles.num}`}>
            {props.meta}
          </span>
        ) : null}
        {props.verb ? (
          <button
            type="button"
            className="kit-plain-btn kit-small"
            onClick={() => props.verb?.run()}
          >
            {props.verb.label}
          </button>
        ) : null}
      </header>
      {showsEmpty ? props.empty : props.children}
    </section>
  );
}
