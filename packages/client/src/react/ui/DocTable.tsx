// The records table (v9 §9, #765) — the Data route's document rows.
//
// Three columns: a flexible Record column and two fixed ones. The header is a
// 32px sunken band whose Record label is inset past the row's leading glyph,
// so the head aligns with the row's TEXT rather than with its padding edge.
// On the compact form factor the header goes away entirely and the two fixed
// columns fold into one snip line under the title.
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
  /** The record's own name. Truncates rather than wrapping — a table row is
   *  one line. */
  title: string;
  /** The Kind column, and the first half of the compact snip line. */
  kind: string;
  /** The Written column, and the second half of the snip line. Numeric. */
  written: string;
  /** The leading glyph the header's inset steps past. */
  icon?: IconName;
}

export interface DocTableProps {
  rows: readonly DocTableRow[];
  /** Column headers. Copy is the caller's, like every other string in the kit. */
  headers: { record: string; kind: string; written: string };
  /** The line under the table — how much of the whole this page is showing. */
  caption?: string;
  /** The per-row overflow menu. Omit for a table with no row actions. */
  menu?: readonly (CtxItem | "sep")[];
  onMenuPick?: (rowId: string, itemId: string) => void;
  /** Prefix for each row's overflow-button accessible name ("More for …"). */
  menuLabel?: string;
  ariaLabel: string;
  className?: string;
}

/** The records table — one implementation, header inset and trailing spacer
 *  included, so the row menu and the header's trailing slot line up. */
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
    // `<fieldset>` is the native element behind `role="group"` (a11y profile:
    // the element, not the role); its UA box is reset in styles.css.
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
