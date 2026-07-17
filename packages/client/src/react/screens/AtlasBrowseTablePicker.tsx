import { type JSX } from 'react';
import type { BrowseTableEntry } from '../../gateway-client.js';
import Icon from '../ui/Icon.js';
import { cx } from '../ui/cx.js';
import styles from './AtlasBrowseTab.module.css';
import type { BrowsePackGroup } from './atlasBrowseData.js';

// The table picker rail (issue #441 B3) — a left rail on desktop, a collapsible
// sheet on narrow. Ontology packs list first, machinery bands below a divider.
// Purely presentational: selection and filtering are owned by the tab.
export function TablePicker({
  grouped,
  selected,
  selectedEntry,
  query,
  onQuery,
  open,
  onToggleOpen,
  onPick,
}: {
  grouped: { ontology: BrowsePackGroup[]; machinery: BrowsePackGroup[] };
  selected: string | undefined;
  selectedEntry: BrowseTableEntry | undefined;
  query: string;
  onQuery: (v: string) => void;
  open: boolean;
  onToggleOpen: () => void;
  onPick: (logical: string) => void;
}): JSX.Element {
  const options = (groups: BrowsePackGroup[], kind: 'ontology' | 'machinery'): JSX.Element[] =>
    groups.map((g) => (
      <div key={g.pack} className={styles.pickGroup}>
        <div className={styles.pickPack}>{g.packLabel}</div>
        {g.tables.map((t) => (
          <button
            key={t.logical}
            type="button"
            role="option"
            className={cx(styles.pickOption, selected === t.logical && styles.pickOptionActive)}
            aria-selected={selected === t.logical}
            data-testid="atlas-browse-table-option"
            data-logical={t.logical}
            data-pack-kind={kind}
            onClick={() => onPick(t.logical)}
          >
            <span className={styles.pickLabel}>{t.label}</span>
            <span className={styles.pickCount}>{t.rows.toLocaleString()}</span>
          </button>
        ))}
      </div>
    ));

  return (
    <aside className={styles.rail}>
      <button
        type="button"
        className={styles.pickToggle}
        aria-expanded={open}
        onClick={onToggleOpen}
        data-testid="atlas-browse-picker-toggle"
      >
        <Icon name="Folder" size={14} />
        <span className={styles.pickToggleLabel}>{selectedEntry?.label ?? 'Choose a table'}</span>
        <Icon name={open ? 'ChevronDown' : 'ChevronRight'} size={14} />
      </button>

      <div className={cx(styles.pickPanel, open && styles.pickPanelOpen)}>
        <div className={styles.pickSearch}>
          <Icon name="Search" size={13} />
          <input
            type="search"
            className={styles.pickInput}
            placeholder="Filter tables…"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            aria-label="Filter tables"
          />
        </div>
        <div className={styles.pickList} role="listbox" aria-label="Vault tables">
          {options(grouped.ontology, 'ontology')}
          {grouped.machinery.length > 0 ? (
            <div className={styles.pickDivider} data-testid="atlas-browse-machinery-divider">
              Machinery
            </div>
          ) : null}
          {options(grouped.machinery, 'machinery')}
          {grouped.ontology.length === 0 && grouped.machinery.length === 0 ? (
            <div className={styles.pickEmpty}>No tables match “{query}”.</div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
