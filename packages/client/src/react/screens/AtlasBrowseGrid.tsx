import { type JSX } from 'react';
import type { BrowseColumn, BrowseColumnsResult } from '../../gateway-client.js';
import Icon from '../ui/Icon.js';
import { cx } from '../ui/cx.js';
import styles from './AtlasBrowseTab.module.css';
import { cellText, isSealedValue, rowIdOf } from './atlasBrowseData.js';

// The machinery lock bar and the keyset-paginated grid (issue #441 B3), split
// out of AtlasBrowseTab. Machinery bands are read-only until an explicit unlock;
// sealed columns render as chips and never print plaintext; long text cells
// truncate to a click-to-expand button. All presentational — the tab owns state.

// ── Machinery lock bar ───────────────────────────────────────────────────────
export function MachineryBar({
  unlocked,
  onToggle,
}: {
  unlocked: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <div className={cx(styles.machineryBar, unlocked && styles.machineryBarOpen)}>
      <Icon name="AlertTriangle" size={14} />
      <p className={styles.machineryNote} data-testid="atlas-machinery-locked">
        {unlocked
          ? 'Machinery edits unlocked — hand-editing plumbing rows can break vault invariants.'
          : 'This is a machinery band — browsing only. Editing plumbing rows can brick invariants.'}
      </p>
      <button
        type="button"
        className={styles.unlockBtn}
        role="switch"
        aria-checked={unlocked}
        onClick={onToggle}
        data-testid="atlas-machinery-unlock"
      >
        {unlocked ? 'Lock' : 'Unlock machinery edits'}
      </button>
    </div>
  );
}

// ── Grid ─────────────────────────────────────────────────────────────────────
const TRUNCATE_AT = 48;

export function Grid({
  cols,
  rows,
  orderBy,
  dir,
  loading,
  expanded,
  onSort,
  onToggleExpand,
  writesLocked,
  onEdit,
  onDelete,
}: {
  cols: BrowseColumnsResult;
  rows: Record<string, unknown>[];
  orderBy: string | null;
  dir: 'asc' | 'desc';
  loading: boolean;
  expanded: Set<string>;
  onSort: (col: string) => void;
  onToggleExpand: (key: string) => void;
  writesLocked: boolean;
  onEdit: (row: Record<string, unknown>) => void;
  onDelete: (row: Record<string, unknown>) => void;
}): JSX.Element {
  const fkByName = new Map(cols.columns.filter((c) => c.fkTable).map((c) => [c.name, c]));
  const colOrder = cols.columns.map((c) => c.name);

  if (!loading && rows.length === 0) {
    return (
      <div className={styles.gridEmpty} data-testid="atlas-browse-no-rows">
        This table has no rows yet.
      </div>
    );
  }

  return (
    <div className={styles.gridWrap}>
      <table className={styles.grid} data-testid="atlas-browse-grid">
        <thead>
          <tr>
            {cols.columns.map((c) => (
              <th key={c.name} className={styles.gridHead}>
                <button
                  type="button"
                  className={styles.sortBtn}
                  onClick={() => onSort(c.name)}
                  data-testid="atlas-browse-col"
                  data-col={c.name}
                  data-sorted={orderBy === c.name ? dir : undefined}
                >
                  <span className={styles.colName}>{c.name}</span>
                  {c.pk > 0 ? <span className={styles.colBadge}>pk</span> : null}
                  {c.fkTable ? <span className={styles.colBadge}>fk</span> : null}
                  {orderBy === c.name ? (
                    <span className={styles.sortArrow}>{dir === 'asc' ? '▲' : '▼'}</span>
                  ) : null}
                </button>
              </th>
            ))}
            <th className={styles.gridHeadActions} aria-label="Row actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const id = rowIdOf(row, cols.columns);
            return (
              <tr key={id} className={styles.gridRow} data-testid="atlas-browse-row" data-id={id}>
                {colOrder.map((name) => {
                  const value = row[name];
                  const key = `${id}::${name}`;
                  return (
                    <td key={name} className={styles.gridCell} data-col={name}>
                      <Cell
                        value={value}
                        fk={fkByName.get(name)}
                        expanded={expanded.has(key)}
                        onToggle={() => onToggleExpand(key)}
                      />
                    </td>
                  );
                })}
                <td className={styles.gridActions}>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    onClick={() => onEdit(row)}
                    disabled={writesLocked}
                    aria-label="Edit row"
                    data-testid="atlas-row-edit"
                  >
                    <Icon name="Pencil" size={13} />
                  </button>
                  <button
                    type="button"
                    className={styles.iconBtnDanger}
                    onClick={() => onDelete(row)}
                    disabled={writesLocked}
                    aria-label="Delete row"
                    data-testid="atlas-row-delete"
                  >
                    <Icon name="Trash" size={13} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Cell({
  value,
  fk,
  expanded,
  onToggle,
}: {
  value: unknown;
  fk: BrowseColumn | undefined;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  if (isSealedValue(value)) {
    return (
      <span className={styles.sealedChip} data-testid="atlas-sealed-chip">
        <Icon name="Key" size={10} />
        sealed
      </span>
    );
  }
  const text = cellText(value);
  if (text === '') return <span className={styles.nullCell}>null</span>;

  if (fk) {
    return (
      <span className={styles.fkCell} title={`→ ${fk.fkLogical ?? fk.fkTable}`}>
        {text}
      </span>
    );
  }

  const long = text.length > TRUNCATE_AT;
  if (!long) return <span>{text}</span>;
  return (
    <button
      type="button"
      className={styles.expandCell}
      onClick={onToggle}
      data-testid="atlas-cell-expand"
      title={expanded ? 'Collapse' : 'Expand'}
    >
      {expanded ? text : `${text.slice(0, TRUNCATE_AT)}…`}
    </button>
  );
}
