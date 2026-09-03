import type { JSX, ReactNode } from "react";

import type { ActionData, RowData } from "@centraid/design/blocks";

import Button from "./Button.js";
import { cx } from "./cx.js";

import styles from "./RowsBlock.module.css";

export interface RowAction extends ActionData {
  onClick: () => void;
}

export interface RowDef extends RowData {
  id: string;
  action?: RowAction;
  children?: ReactNode;
}

export interface RowsBlockProps {
  rows: readonly RowDef[];
  ariaLabel?: string;
  stacked?: boolean;
  className?: string;
}

export default function RowsBlock({
  rows,
  ariaLabel,
  stacked,
  className,
}: RowsBlockProps): JSX.Element {
  const Frame = ariaLabel ? "fieldset" : "div";
  return (
    <Frame
      aria-label={ariaLabel}
      className={cx(styles.rows, className)}
      data-stacked={stacked ? "true" : undefined}
    >
      {rows.map((row) => (
        <div className={styles.rowShell} key={row.id}>
          <div
            className={styles.row}
            data-net={row.net ? "true" : undefined}
            data-off={row.off ? "true" : undefined}
            data-struck={row.struck ? "true" : undefined}
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
