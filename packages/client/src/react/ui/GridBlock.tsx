// The records GRID (#775) — a kind as the store holds it.
//
// The block vocabulary already had a records block, `DocTable`, and it reads
// the same rows as DOCUMENTS: a title and two facts. That is the right block
// for a drive and the wrong one for the vault census, where the question is
// what is actually in each column of each record. This is the other reading,
// and it is a block rather than screen code for the usual reason: the column
// declarations, the cell registers and the sort model are a vocabulary, not
// one route's markup.
//
// It composes from recipes the system already has — the sunken header band and
// hairline rows of `DocTable`, the badge of `KindBadge`, the toggle semantics
// of the chips row — and invents no visual language of its own. What it adds
// is the one thing a three-column summary cannot say: which cells the store
// has no value for, which hold the empty string, and which it will not print
// at all.
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

/** `key` + `label` + the declarations, documented once in the shared contract.
 *  This kit adds no column fields of its own. */
export type GridColumn = GridColumnData;

/** One record. `values` is the record as the store returned it; the grid reads
 *  it through the declared columns and never through its own key order. */
export interface GridRowDef {
  /** Stable identity — the record's id, never the array index. */
  id: string;
  /** What names this record in a control's accessible name ("More for …").
   *  Rows repeat verbs; a name is what tells a thousand of them apart. */
  name: string;
  values: Readonly<Record<string, unknown>>;
}

export interface GridBlockProps {
  columns: readonly GridColumn[];
  rows: readonly GridRowDef[];
  /** Which column the ROWS ARE ALREADY ordered by. The grid does not sort —
   *  the store does, over the whole kind rather than the page in hand. */
  sort?: GridSortData | null;
  /** Asked for a new order. Omit for a grid whose store cannot reorder. */
  onSort?: (next: GridSortData) => void;
  /** The line under the grid — how much of the whole this page is showing. */
  caption?: string;
  /** The per-row overflow menu. Omit for a grid with no row actions. */
  menu?: readonly (CtxItem | "sep")[];
  onMenuPick?: (rowId: string, itemId: string) => void;
  /** Prefix for each row's overflow-button accessible name ("More for …"). */
  menuLabel?: string;
  ariaLabel: string;
  className?: string;
}

/** The copy for the two cells that have no value to print. Stated here because
 *  they are not content — they are the grid naming its own two absences, the
 *  same way a null glyph in a database client is the client's word. */
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

/** Records grid — declared columns, sortable headers, one register per column. */
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
  // Which long cells a member has opened. The grid's own state: an expansion
  // is a reading position, not a fact about the record, so pushing it at the
  // caller would make every screen carry a Set it never reasons about.
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
    // The grid scrolls in the inline axis rather than dropping columns: a
    // census whose columns disappeared on a narrower canvas would answer the
    // page's own question differently depending on the window.
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
            {/* A SPACER, not a header: it reserves exactly the width of the
                row's overflow button so the last column lines up. A `<td>` in
                the head row is the corner-cell idiom — "no header here" — and
                it carries no word because each row's own control is named by
                `menuLabel` plus the record. */}
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
