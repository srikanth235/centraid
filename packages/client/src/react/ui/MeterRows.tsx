import type { CSSProperties, JSX } from "react";

import Button from "../ui/Button.js";

import styles from "./MeterRows.module.css";

// Share-of-largest bar (#814). Do not fold into `RowsBlock`. Empty rows keep
// their place; trailing cell is inert text, never a disabled button.

export interface MeterRowDef {
  id: string;
  name: string;
  pack: string;
  /** 0–100, share of the largest row — not of the total. */
  share: number;
  count: string;
  when?: string | undefined;
  onOpen?: () => void;
}

export interface MeterRowsProps {
  rows: readonly MeterRowDef[];
  ariaLabel: string;
  caption?: string;
  actionLabel?: string;
  inertLabel?: string;
}

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
          {/* Mark, not a meter control — the row already states the share. */}
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
