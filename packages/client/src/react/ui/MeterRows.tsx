import type { CSSProperties, JSX } from "react";

import Button from "../ui/Button.js";

import styles from "./MeterRows.module.css";

// The meter row — a row list where every row also draws its own share.
//
// A list where every row is the same shape as its neighbour answers "what is in
// here" one name at a time; a member reading forty of them still cannot say
// which two hold the vault. So the row grows a bar, and the bar is a SHARE OF
// THE LARGEST ROW rather than of the total — a total-share bar on a long tail
// is forty invisible slivers, which is a picture of nothing.
//
// A SHARED KIT BLOCK (#814), used wherever several things share one measure
// and the ordering is the finding — the Atlas census and System's Capacity.
// `RowsBlock` cannot carry it: a row there is title/sub/meta/one verb, and a
// proportional bar is none of those. Do not fold this into `RowsBlock`, and do
// not re-implement it per surface.
//
// A row with nothing behind it keeps its place — "we hold nothing of that
// sort" is an answer these pages owe — and its trailing cell is INERT TEXT,
// never a disabled button. A verb that does nothing is worse than a stated
// fact.

export interface MeterRowDef {
  id: string;
  /** The row's curated name — "Documents", not `core.document`. */
  name: string;
  /** What it belongs to — its pack, its owner, its host. It leads the row's
   *  second line because it is the one thing that says WHOSE this is, and forty
   *  rows with no owner beside them are forty rows to recognise by name alone. */
  pack: string;
  /** Bar length, 0–100, as a share of the largest row. */
  share: number;
  /** `1,908 records · 1.2 GB`, in the numeric register. */
  count: string;
  /** When it was last touched. Omitted when the source cannot say. */
  when?: string | undefined;
  /** Absent for a row with nothing behind it: the row then states its inert
   *  cell instead of drawing a control. */
  onOpen?: () => void;
}

export interface MeterRowsProps {
  rows: readonly MeterRowDef[];
  /** Names the list for assistive tech beneath its section head. */
  ariaLabel: string;
  /** The line under the block — what is shown, and what the bar means. */
  caption?: string;
  /** The trailing verb's word. "Browse" on the census, "Open" elsewhere. */
  actionLabel?: string;
  /** What a row with no verb says instead. */
  inertLabel?: string;
}

/** The list, one thing a row, each with a proportional bar. */
export default function MeterRows({
  rows,
  ariaLabel,
  caption,
  actionLabel = "Browse",
  inertLabel = "Nothing to browse",
}: MeterRowsProps): JSX.Element {
  return (
    <fieldset aria-label={ariaLabel} className={styles.meter}>
      {rows.map((row) => (
        <div className={styles.row} key={row.id}>
          <span className={styles.text}>
            <span
              className={styles.name}
              data-empty={row.onOpen ? undefined : "true"}
            >
              {row.name}
            </span>
            <span className={styles.pack}>{row.pack}</span>
          </span>
          {/* The bar is a MARK, not a meter control: it reports a share the
              row already states in words beside it, so it carries no value
              semantics of its own and nothing announces it twice. */}
          <span aria-hidden="true" className={styles.track}>
            <span
              className={styles.fill}
              data-empty={row.onOpen ? undefined : "true"}
              style={{ "--meter-share": row.share } as CSSProperties}
            />
          </span>
          <span className={styles.count}>{row.count}</span>
          {row.when ? <span className={styles.when}>{row.when}</span> : null}
          {row.onOpen ? (
            <Button
              className={styles.action}
              commit={false}
              label={actionLabel}
              onClick={() => row.onOpen?.()}
              size="sm"
              title={`${actionLabel} ${row.name}`}
              variant="secondary"
            />
          ) : (
            <span className={styles.inert}>{inertLabel}</span>
          )}
        </div>
      ))}
      {caption ? <p className={styles.caption}>{caption}</p> : null}
    </fieldset>
  );
}
