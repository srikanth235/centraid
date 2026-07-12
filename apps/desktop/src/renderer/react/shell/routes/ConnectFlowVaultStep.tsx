import type { Dispatch, JSX, KeyboardEvent } from 'react';
import Icon from '../../ui/Icon.js';
import { cx } from '../../ui/cx.js';
import buttonCss from '../../ui/Button.module.css';
import controlsCss from '../../styles/controls.module.css';
import { PROFILE_COLORS } from './SpaceModal.js';
import {
  canCommitConnectFlow,
  vaultCapability,
  type ConnectFlowEvent,
  type ConnectFlowState,
} from './connectFlow-core.js';
import styles from './ConnectFlow.module.css';

// The 'vault' step — split out of ConnectFlow.tsx (issue #382) purely to
// keep that file under the repo's file-size cap.

function radioKeyNav(e: KeyboardEvent<HTMLElement>): void {
  if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;
  const group = (e.currentTarget.closest('[role="radiogroup"]') ??
    e.currentTarget.parentElement) as HTMLElement | null;
  const items = Array.from(group?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? []);
  const idx = items.indexOf(e.currentTarget as HTMLButtonElement);
  if (idx < 0 || items.length === 0) return;
  e.preventDefault();
  const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
  items[(idx + dir + items.length) % items.length]?.focus();
}

export function VaultStep({
  state,
  dispatch,
  context,
}: {
  state: ConnectFlowState;
  dispatch: Dispatch<ConnectFlowEvent>;
  context: 'onboarding' | 'switcher';
}): JSX.Element {
  const cap = vaultCapability(state);
  const loading = !state.report;
  // Onboarding's single-existing-vault case auto-commits before this ever
  // paints (see the effect in ConnectFlow.tsx) — this branch only ever shows
  // mid-flight or once there's a real choice to make.
  return (
    <div className={styles.panel}>
      {loading ? (
        <div className={styles.centerText}>
          <span className={styles.spinner} data-spin="true" data-inline="true">
            <Icon name="Loader" size={16} strokeWidth={2} />
          </span>
          Loading spaces…
        </div>
      ) : cap.locked ? (
        <div className={styles.lockedVault}>
          <span className={styles.lockedIcon}>
            <Icon name="Check" size={14} strokeWidth={2.4} />
          </span>
          <span className={styles.lockedName}>{cap.locked.vaultName}</span>
          <p className={styles.hint}>
            Fixed by the pairing ticket — connecting to a different space on this gateway needs a
            new ticket or an SSH connection.
          </p>
        </div>
      ) : (
        <div className={styles.vaultList} role="radiogroup" aria-label="Space">
          {cap.options.map((v) => (
            <button
              key={v.vaultId}
              type="button"
              role="radio"
              aria-checked={
                state.vaultChoice?.kind === 'existing' && state.vaultChoice.vaultId === v.vaultId
              }
              data-selected={
                state.vaultChoice?.kind === 'existing' && state.vaultChoice.vaultId === v.vaultId
              }
              className={styles.vaultRow}
              onClick={() =>
                dispatch({ choice: { kind: 'existing', vaultId: v.vaultId }, type: 'selectVault' })
              }
              onKeyDown={radioKeyNav}
            >
              <span
                className={styles.vaultDot}
                style={{ background: v.color ?? PROFILE_COLORS[0] }}
                aria-hidden="true"
              />
              <span>{v.name}</span>
              {state.vaultChoice?.kind === 'existing' && state.vaultChoice.vaultId === v.vaultId ? (
                <Icon name="Check" size={14} strokeWidth={2.4} />
              ) : null}
            </button>
          ))}
          {cap.canCreate ? (
            <div className={styles.createRow}>
              <button
                type="button"
                role="radio"
                aria-checked={state.vaultChoice?.kind === 'create'}
                data-selected={state.vaultChoice?.kind === 'create'}
                className={styles.vaultRow}
                onClick={() => dispatch({ choice: { kind: 'create' }, type: 'selectVault' })}
                onKeyDown={radioKeyNav}
              >
                <span className={cx(styles.vaultDot, styles.vaultDotAdd)} aria-hidden="true">
                  <Icon name="Plus" size={12} strokeWidth={2.4} />
                </span>
                <span>Create new space</span>
              </button>
              {state.vaultChoice?.kind === 'create' ? (
                <input
                  className={styles.input}
                  type="text"
                  placeholder="Space name"
                  autoFocus
                  value={state.newVaultName}
                  onChange={(e) =>
                    dispatch({ field: 'newVaultName', type: 'setField', value: e.target.value })
                  }
                />
              ) : null}
            </div>
          ) : cap.options.length > 0 ? (
            <p className={styles.hint}>
              Creating a new space here needs the host CLI or an SSH connection.
            </p>
          ) : null}
        </div>
      )}
      <div className={styles.foot}>
        <button
          type="button"
          className={controlsCss.chip}
          onClick={() => dispatch({ type: 'back' })}
        >
          Back
        </button>
        <span className={styles.spacer} />
        <button
          type="button"
          className={cx(buttonCss.btn, buttonCss.primary, buttonCss.sm)}
          disabled={!canCommitConnectFlow(state)}
          onClick={() => dispatch({ type: 'commit' })}
        >
          {context === 'onboarding' ? 'Enter Centraid' : 'Connect'}
        </button>
      </div>
    </div>
  );
}
