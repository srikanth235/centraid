// The sheet holding what the compact band could not seat — five destinations
// plus More (DESIGN.md invariant 1).
import type { ReactNode } from "react";

import { KitModal } from "./KitModal.tsx";

import styles from "./MoreSheet.module.css";

export interface MoreSheetRow {
  key: string;
  label: string;
  /** Trailing numeric column; omit rather than invent a zero. */
  meta?: string;
  /** Prose line under the label — `meta`'s tabular `--t-mono` is wrong here. */
  note?: string;
  current?: boolean;
  select: () => void;
}

export interface MoreSheetProps {
  label: string;
  title?: string;
  rows: readonly MoreSheetRow[];
  footer?: string;
  closeLabel?: string;
  onClose: () => void;
}

export function MoreSheet({
  label,
  title,
  rows,
  footer,
  closeLabel = "Close",
  onClose,
}: MoreSheetProps): ReactNode {
  return (
    <KitModal layer="inline" className={styles.sheet} label={label}>
      {/* Not a control. */}
      <div className={styles.grabber} aria-hidden="true" />
      {title === undefined ? null : <p className={styles.title}>{title}</p>}
      <nav className={styles.rows}>
        {rows.map((row) => (
          <button
            key={row.key}
            type="button"
            className={styles.row}
            {...(row.current ? { "aria-current": "page" } : {})}
            onClick={() => row.select()}
          >
            <span className={styles.rowMain}>
              <span className={styles.label}>{row.label}</span>
              {row.note === undefined ? null : (
                <span className={styles.note}>{row.note}</span>
              )}
            </span>
            {row.meta === undefined ? null : (
              <span className={styles.meta}>{row.meta}</span>
            )}
          </button>
        ))}
      </nav>
      {footer === undefined ? null : <p className={styles.footer}>{footer}</p>}
      <button
        type="button"
        className={`kit-btn ${styles.close}`}
        onClick={onClose}
      >
        {closeLabel}
      </button>
    </KitModal>
  );
}
