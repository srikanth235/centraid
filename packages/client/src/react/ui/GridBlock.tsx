import { useCallback, useState } from "react";
import type { JSX, MouseEvent } from "react";

import {
  gridCell,
  gridColumnBadges,
  gridColumnHint,
  gridColumnSortable,
  gridSortNext,
  gridSortOf,
} from "@centraid/design/blocks";
import type { GridColumnData, GridSortData } from "@centraid/design/blocks";

import type { CtxItem } from "../shell/contextMenu.js";
import { openMenu } from "../shell/contextMenu.js";
import { IconButton } from "./Button.js";
import { cx } from "./cx.js";
import Icon from "./Icon.js";

import styles from "./GridBlock.module.css";

export type GridColumn = GridColumnData;

export interface GridRowDef {
  id: string;
  name: string;
  values: Readonly<Record<string, unknown>>;
}

export interface GridBlockProps {
  columns: readonly GridColumn[];
  rows: readonly GridRowDef[];
  sort?: GridSortData | null;
  onSort?: (next: GridSortData) => void;
  caption?: string;
  menu?: readonly (CtxItem | "sep")[];
  onMenuPick?: (rowId: string, itemId: string) => void;
  menuLabel?: string;
  ariaLabel: string;
  className?: string;
}

const NULL_WORD = "null";
const BLANK_WORD = "empty";

function Cell({
  column,
  value,
  expanded,
  onToggle,
}: {
  column: GridColumn;
  value: unknown;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  const cell = gridCell(value, { sealed: column.sealed ?? false });

  if (cell.kind === "sealed")
    return (
      <span className={styles.sealed} data-testid="grid-sealed">
        <Icon name="Key" size={10} />
        sealed
      </span>
    );

  if (cell.kind === "null")
    return (
      <span className={styles.absent} data-absent="null">
        {NULL_WORD}
      </span>
    );

  if (cell.kind === "blank")
    return (
      <span className={styles.absent} data-absent="blank">
        {BLANK_WORD}
      </span>
    );

  if (!cell.clipped) return <span>{cell.short}</span>;

  return (
    <button
      className={styles.expand}
      data-expanded={expanded ? "true" : undefined}
      onClick={onToggle}
      title={cell.text}
      type="button"
    >
      {expanded ? cell.text : cell.short}
    </button>
  );
}

export default function GridBlock({
  columns,
  rows,
  sort,
  onSort,
  caption,
  menu,
  onMenuPick,
  menuLabel = "More for",
  ariaLabel,
  className,
}: GridBlockProps): JSX.Element {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggleExpand = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

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

  const hasMenu = Boolean(menu && menu.length > 0);

  return (
    <div className={cx(styles.wrap, className)}>
      <table aria-label={ariaLabel} className={styles.grid}>
        <thead>
          <tr>
            {columns.map((column) => {
              const dir = gridSortOf(sort, column.key);
              const sortable = gridColumnSortable(column) && Boolean(onSort);
              const hint = gridColumnHint(column);
              const head = (
                <>
                  <span className={styles.colName}>{column.label}</span>
                  {gridColumnBadges(column).map((badge) => (
                    <span className={styles.badge} key={badge}>
                      {badge}
                    </span>
                  ))}
                  {dir ? (
                    <span aria-hidden="true" className={styles.arrow}>
                      {dir === "asc" ? "▲" : "▼"}
                    </span>
                  ) : null}
                </>
              );
              return (
                <th
                  aria-sort={
                    dir === "asc"
                      ? "ascending"
                      : dir === "desc"
                        ? "descending"
                        : undefined
                  }
                  className={styles.head}
                  data-col={column.key}
                  key={column.key}
                  scope="col"
                >
                  {sortable ? (
                    <button
                      className={styles.sortBtn}
                      onClick={() => onSort?.(gridSortNext(sort, column.key))}
                      title={hint}
                      type="button"
                    >
                      {head}
                    </button>
                  ) : (
                    <span className={styles.fixedHead} title={hint}>
                      {head}
                    </span>
                  )}
                </th>
              );
            })}
            {/* Spacer, not a header: width of the overflow button. */}
            <td
              aria-hidden="true"
              className={cx(styles.head, styles.menuSlot)}
            />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr className={styles.row} data-id={row.id} key={row.id}>
              {columns.map((column) => {
                const cellKey = `${row.id}::${column.key}`;
                return (
                  <td
                    className={styles.cell}
                    data-col={column.key}
                    data-register={column.register ?? "text"}
                    key={column.key}
                  >
                    <Cell
                      column={column}
                      expanded={expanded.has(cellKey)}
                      onToggle={() => toggleExpand(cellKey)}
                      value={row.values[column.key]}
                    />
                  </td>
                );
              })}
              <td className={styles.menuSlot}>
                {hasMenu ? (
                  <IconButton
                    ariaLabel={`${menuLabel} ${row.name}`}
                    icon="MoreHoriz"
                    onClick={(event) => openRowMenu(row.id, event)}
                  />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {caption ? <p className={styles.caption}>{caption}</p> : null}
    </div>
  );
}
