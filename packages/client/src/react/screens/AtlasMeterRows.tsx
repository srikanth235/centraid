import type { CSSProperties, JSX } from "react";

import Button from "../ui/Button.js";

import styles from "./AtlasMeterRows.module.css";

// The census meter row (v11 "What it holds").
//
// A kind list where every row is the same shape as its neighbour answers "what
// is in here" one name at a time; a member reading forty of them still cannot
// say which two hold the vault. So the row grows a bar, and the bar is the
// SHARE OF THE LARGEST KIND — see `meterShare` for why not the total.
//
// It lives under `screens/` rather than in the shared `react/ui/` kit
// deliberately: it is the census's row, not the block vocabulary's. The kit's
// `RowsBlock` cannot carry it (a row there is title/sub/meta/one verb, and a
// proportional bar is none of those), and a fifth shared block earns its place
// only once a second surface needs it.
//
// A never-written kind keeps its row — "we hold nothing of that sort" is an
// answer this page owes — and its trailing cell is INERT TEXT, never a
// disabled button. A verb that does nothing is worse than a stated fact.

export interface MeterRowDef {
  id: string;
  /** The kind's curated name — "Documents", not `core.document`. */
  name: string;
  /** Whose pack it belongs to. It leads the row's second line because it is
   *  the one thing that says WHOSE kind this is, and forty kinds with no owner
   *  beside them are forty rows to recognise by name alone. */
  pack: string;
  /** Bar length, 0–100, as a share of the largest kind. */
  share: number;
  /** `1,908 records · 1.2 GB`, in the numeric register. */
  count: string;
  /** When it was last written. Omitted when the pulse cannot say. */
  when?: string | undefined;
  /** Absent for a kind nothing has ever written: the row then states its
   *  inert cell instead of drawing a control. */
  onBrowse?: () => void;
}

export interface AtlasMeterRowsProps {
  rows: readonly MeterRowDef[];
  /** Names the list for assistive tech beneath its section head. */
  ariaLabel: string;
  /** The line under the block — what is shown, and what the bar means. */
  caption?: string;
}

/** The words for a row with nothing behind its verb. Stated, never offered. */
const NOTHING_TO_BROWSE = "Nothing to browse";

/** The census list, one kind a row, each with a proportional bar. */
export default function AtlasMeterRows({
  rows,
  ariaLabel,
  caption,
}: AtlasMeterRowsProps): JSX.Element {
  return (
    <fieldset aria-label={ariaLabel} className={styles.meter}>
      {rows.map((row) => (
        <div className={styles.row} key={row.id}>
          <span className={styles.text}>
            <span
              className={styles.name}
              data-empty={row.onBrowse ? undefined : "true"}
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
              data-empty={row.onBrowse ? undefined : "true"}
              style={{ "--meter-share": row.share } as CSSProperties}
            />
          </span>
          <span className={styles.count}>{row.count}</span>
          {row.when ? <span className={styles.when}>{row.when}</span> : null}
          {row.onBrowse ? (
            <Button
              className={styles.action}
              commit={false}
              label="Browse"
              onClick={() => row.onBrowse?.()}
              size="sm"
              title={`Browse ${row.name}`}
              variant="secondary"
            />
          ) : (
            <span className={styles.inert}>{NOTHING_TO_BROWSE}</span>
          )}
        </div>
      ))}
      {caption ? <p className={styles.caption}>{caption}</p> : null}
    </fieldset>
  );
}
