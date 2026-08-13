// The workhorse row list (v9 §9, issue #765).
//
// A bordered container on raised paper, rows at the 44px row rung, internal
// hairlines only, and ONE trailing action per row that is always outlined —
// never filled, dangerous or not. The filled control is the view's single
// commit, and it lives in the app bar.
import type { JSX, ReactNode } from "react";

import type { ActionData, RowData } from "@centraid/design/blocks";

import Button from "./Button.js";
import { cx } from "./cx.js";

import styles from "./RowsBlock.module.css";

/** A row's trailing verb: the shared data plus this kit's click handler. */
export interface RowAction extends ActionData {
  onClick: () => void;
}

/**
 * `RowData` says what a row IS — title, sub, meta, and the `net` / `dangerous`
 * / `off` flags, all documented once in the contract. This adds only what the
 * DOM needs on top.
 */
export interface RowDef extends RowData {
  /** Stable identity. Never the array index: rows reorder as data lands. */
  id: string;
  action?: RowAction;
  /**
   * Per-row escape hatch — content rendered UNDER the row, inside the same
   * container, sharing its hairline. Notifications' outbox editor expands
   * here rather than forking a second row component (plan-client.md §1b).
   * Everything else in the kit stays props-only; this one slot exists because
   * an expanded editor is genuinely the row's own detail, not a peer block.
   */
  children?: ReactNode;
}

export interface RowsBlockProps {
  rows: readonly RowDef[];
  /** Names the list for assistive tech when it is not already introduced by a
   *  `SectionBlock` heading above it. */
  ariaLabel?: string;
  className?: string;
}

/** Bordered row list — the block every ops page is mostly made of. */
export default function RowsBlock({
  rows,
  ariaLabel,
  className,
}: RowsBlockProps): JSX.Element {
  // A NAMED list is a real group, and `<fieldset>` is the native element
  // behind `role="group"` (the a11y profile prefers the element to the role;
  // its UA box is reset in styles.css). An unnamed one stays a plain
  // container — a nameless group is a stop with nothing to announce.
  const Frame = ariaLabel ? "fieldset" : "div";
  return (
    <Frame aria-label={ariaLabel} className={cx(styles.rows, className)}>
      {rows.map((row) => (
        <div className={styles.rowShell} key={row.id}>
          <div
            className={styles.row}
            data-net={row.net ? "true" : undefined}
            data-off={row.off ? "true" : undefined}
          >
            <div className={styles.text}>
              <span className={styles.title}>{row.title}</span>
              {row.sub ? <span className={styles.sub}>{row.sub}</span> : null}
            </div>
            {row.meta ? <span className={styles.meta}>{row.meta}</span> : null}
            {row.action ? (
              <Button
                className={styles.action}
                commit={false}
                disabled={row.off}
                label={row.action.label}
                onClick={() => row.action?.onClick()}
                size="sm"
                title={row.action.hint}
                variant={row.dangerous ? "destructive" : "secondary"}
              />
            ) : null}
          </div>
          {row.children ? (
            <div className={styles.detail}>{row.children}</div>
          ) : null}
        </div>
      ))}
    </Frame>
  );
}
