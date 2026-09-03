import { useCallback } from "react";
import type { JSX, MouseEvent } from "react";

import type { IconName } from "@centraid/design";
import { docSnipLine } from "@centraid/design/blocks";

import type { CtxItem } from "../shell/contextMenu.js";
import { openMenu } from "../shell/contextMenu.js";
import { useCompactLayout } from "../shell/useCompactLayout.js";
import { IconButton } from "./Button.js";
import { cx } from "./cx.js";
import Icon from "./Icon.js";

import styles from "./DocTable.module.css";

export interface DocTableRow {
  id: string;
  title: string;
  kind: string;
  written: string;
  icon?: IconName;
}

export interface DocTableProps {
  rows: readonly DocTableRow[];
  headers: { record: string; kind: string; written: string };
  caption?: string;
  menu?: readonly (CtxItem | "sep")[];
  onMenuPick?: (rowId: string, itemId: string) => void;
  menuLabel?: string;
  ariaLabel: string;
  className?: string;
}

export default function DocTable({
  rows,
  headers,
  caption,
  menu,
  onMenuPick,
  menuLabel = "More for",
  ariaLabel,
  className,
}: DocTableProps): JSX.Element {
  const compact = useCompactLayout();
  const openRowMenu = useCallback(
    (rowId: string, event: MouseEvent<HTMLButtonElement>) => {
      if (!menu || menu.length === 0) return;
      openMenu(
        menu,
        { kind: "rect", rect: event.currentTarget.getBoundingClientRect() },
        (picked) => onMenuPick?.(rowId, picked)
      );
    },
    [menu, onMenuPick]
  );

  return (
    <fieldset
      aria-label={ariaLabel}
      className={cx(styles.table, className)}
      data-compact={compact ? "true" : undefined}
    >
      {compact ? null : (
        <div className={styles.head}>
          <span className={cx(styles.headCell, styles.record)}>
            {headers.record}
          </span>
          <span className={cx(styles.headCell, styles.kind)}>
            {headers.kind}
          </span>
          <span className={cx(styles.headCell, styles.written)}>
            {headers.written}
          </span>
          {/* A SPACER, not a control: it reserves exactly the width of the
              row's overflow button so the fixed columns line up. */}
          <span aria-hidden="true" className={styles.menuSlot} />
        </div>
      )}
      {rows.map((row) => (
        <div className={styles.row} key={row.id}>
          {row.icon ? (
            <span aria-hidden="true" className={styles.glyph}>
              <Icon name={row.icon} size={16} />
            </span>
          ) : null}
          <div className={cx(styles.cell, styles.record)}>
            <span className={styles.title}>{row.title}</span>
            {compact ? (
              <span className={styles.snip}>
                {docSnipLine(row.kind, row.written)}
              </span>
            ) : null}
          </div>
          <span className={cx(styles.cell, styles.kind)}>{row.kind}</span>
          <span className={cx(styles.cell, styles.written)}>{row.written}</span>
          {menu && menu.length > 0 ? (
            <IconButton
              ariaLabel={`${menuLabel} ${row.title}`}
              className={styles.menuSlot}
              icon="MoreHoriz"
              onClick={(event) => openRowMenu(row.id, event)}
            />
          ) : (
            <span aria-hidden="true" className={styles.menuSlot} />
          )}
        </div>
      ))}
      {caption ? <p className={styles.caption}>{caption}</p> : null}
    </fieldset>
  );
}
