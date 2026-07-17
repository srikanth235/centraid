import { type JSX } from 'react';
import Icon from '../ui/Icon.js';
import { cx } from '../ui/cx.js';
import styles from './AtlasBrowseTab.module.css';
import { mechanismLabel, type DeleteState } from './atlasBrowseData.js';

// The delete-confirmation dialog (issue #441 B3), split out of AtlasBrowseTab.
// Lists the rows that depend on the target (engine FK + polymorphic), badges
// each mechanism, and blocks the delete outright when an engine FK still points
// at the row — the database would refuse it anyway.
export function DeleteDialog({
  state,
  onCancel,
  onConfirm,
}: {
  state: DeleteState;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const polyOnly =
    state.dependents.length > 0 && state.dependents.every((d) => d.mechanism === 'poly');
  const blocked = state.hasEngineDependents || state.blockedReason !== null;

  return (
    <div className={styles.dialogScrim}>
      <div className={styles.dialogBackdrop} role="presentation" onClick={onCancel} />
      <div
        className={styles.dialog}
        role="alertdialog"
        aria-label="Confirm delete"
        data-testid="atlas-delete-dialog"
      >
        <header className={styles.dialogHead}>
          <span className={styles.dialogIcon}>
            <Icon name="Trash" size={16} />
          </span>
          <h3 className={styles.dialogTitle}>Delete this row?</h3>
        </header>

        {state.loading ? (
          <p className={styles.dialogBody}>Checking what depends on this row…</p>
        ) : (
          <>
            <p className={styles.dialogSummary} data-testid="atlas-delete-summary">
              {state.dependents.length === 0
                ? 'Nothing else references this row.'
                : `${state.dependents.length} ${
                    state.dependents.length === 1 ? 'table references' : 'tables reference'
                  } this row (${state.totalRows.toLocaleString()} ${
                    state.totalRows === 1 ? 'row' : 'rows'
                  }).`}
            </p>

            {state.dependents.length > 0 ? (
              <ul className={styles.depList}>
                {state.dependents.map((d) => (
                  <li
                    key={`${d.table}:${d.via}`}
                    className={styles.depRow}
                    data-testid="atlas-dependent"
                    data-mechanism={d.mechanism}
                  >
                    <span className={styles.depTable}>{d.table}</span>
                    <span className={styles.depVia}>via {d.via}</span>
                    <span
                      className={cx(
                        styles.depBadge,
                        d.mechanism === 'fk' ? styles.depBadgeFk : styles.depBadgePoly,
                      )}
                    >
                      {mechanismLabel(d.mechanism)}
                    </span>
                    <span className={styles.depCount}>{d.count.toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            {blocked ? (
              <p className={styles.dialogBlocked} data-testid="atlas-delete-blocked">
                {state.blockedReason ??
                  'Engine foreign keys still point at this row — clear them first.'}
              </p>
            ) : polyOnly ? (
              <p className={styles.dialogWarn} data-testid="atlas-delete-warn">
                These are authored/polymorphic references — they will be swept when the row is
                purged, but they are not enforced by the database.
              </p>
            ) : null}

            {state.error ? (
              <p className={styles.dialogBlocked} data-testid="atlas-delete-error">
                {state.error}
              </p>
            ) : null}
          </>
        )}

        <footer className={styles.dialogFoot}>
          <button type="button" className={styles.ghostBtn} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.dangerBtn}
            onClick={onConfirm}
            disabled={state.loading || blocked}
            data-testid="atlas-delete-confirm"
          >
            Delete row
          </button>
        </footer>
      </div>
    </div>
  );
}
