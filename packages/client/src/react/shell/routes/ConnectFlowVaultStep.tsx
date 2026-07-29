import type { Dispatch, JSX } from "react";

import { cx } from "../../ui/cx.js";
import Icon from "../../ui/Icon.js";
import { canCommitConnectFlow, vaultCapability } from "./connectFlow-core.js";
import type { ConnectFlowEvent, ConnectFlowState } from "./connectFlow-core.js";
import { PROFILE_COLORS } from "./SpaceModal.js";

import a11y from "../../styles/a11y.module.css";
import controlsCss from "../../styles/controls.module.css";
import buttonCss from "../../ui/Button.module.css";
import styles from "./ConnectFlow.module.css";

// The 'vault' step — split out of ConnectFlow.tsx (issue #382) purely to
// keep that file under the repo's file-size cap.

export function VaultStep({
  state,
  dispatch,
  context,
}: {
  state: ConnectFlowState;
  dispatch: Dispatch<ConnectFlowEvent>;
  context: "onboarding" | "switcher";
}): JSX.Element {
  const cap = vaultCapability(state);
  const loading = !state.report;
  return (
    <div className={styles.panel}>
      {loading ? (
        <div className={styles.centerText}>
          <span className={styles.spinner} data-spin="true" data-inline="true">
            <Icon name="Loader" size={16} strokeWidth={2} />
          </span>
          Loading spaces…
        </div>
      ) : state.vaultsError ? (
        // Honest unreachable (issue #603 W4). A failed read is NOT an empty
        // registry: offering "create a space" here would commit against a
        // gateway we could not even talk to.
        <div className={styles.errorBanner} role="alert">
          {state.vaultsError}
        </div>
      ) : cap.locked ? (
        <div className={styles.lockedVault}>
          <span className={styles.lockedIcon}>
            <Icon name="Check" size={14} strokeWidth={2.4} />
          </span>
          <span className={styles.lockedName}>{cap.locked.vaultName}</span>
          <p className={styles.hint}>
            Fixed by the pairing ticket — connecting to a different space on
            this gateway needs a new ticket.
          </p>
        </div>
      ) : (
        <div className={styles.vaultList} role="radiogroup" aria-label="Space">
          {cap.options.map((v) => (
            <label
              key={v.vaultId}
              data-selected={
                state.vaultChoice?.kind === "existing" &&
                state.vaultChoice.vaultId === v.vaultId
              }
              className={styles.vaultRow}
            >
              <input
                type="radio"
                className={a11y.srControl}
                name="connect-flow-vault"
                checked={
                  state.vaultChoice?.kind === "existing" &&
                  state.vaultChoice.vaultId === v.vaultId
                }
                onChange={() =>
                  dispatch({
                    choice: { kind: "existing", vaultId: v.vaultId },
                    type: "selectVault",
                  })
                }
              />
              <span
                className={styles.vaultDot}
                style={{ background: v.color ?? PROFILE_COLORS[0] }}
                aria-hidden="true"
              />
              <span>{v.name}</span>
              {state.vaultChoice?.kind === "existing" &&
              state.vaultChoice.vaultId === v.vaultId ? (
                <Icon name="Check" size={14} strokeWidth={2.4} />
              ) : null}
            </label>
          ))}
          {cap.canCreate ? (
            <div className={styles.createRow}>
              <label
                data-selected={state.vaultChoice?.kind === "create"}
                className={styles.vaultRow}
              >
                <input
                  type="radio"
                  className={a11y.srControl}
                  name="connect-flow-vault"
                  checked={state.vaultChoice?.kind === "create"}
                  onChange={() =>
                    dispatch({
                      choice: { kind: "create" },
                      type: "selectVault",
                    })
                  }
                />
                <span
                  className={cx(styles.vaultDot, styles.vaultDotAdd)}
                  aria-hidden="true"
                >
                  <Icon name="Plus" size={12} strokeWidth={2.4} />
                </span>
                <span>Create new space</span>
              </label>
              {state.vaultChoice?.kind === "create" ? (
                <input
                  className={styles.input}
                  type="text"
                  placeholder="Space name"
                  autoFocus
                  value={state.newVaultName}
                  onChange={(e) =>
                    dispatch({
                      field: "newVaultName",
                      type: "setField",
                      value: e.target.value,
                    })
                  }
                />
              ) : null}
            </div>
          ) : cap.options.length > 0 ? (
            <p className={styles.hint}>
              Creating a new space here needs the gateway host's CLI.
            </p>
          ) : null}
        </div>
      )}
      <div className={styles.foot}>
        <button
          type="button"
          className={controlsCss.chip}
          onClick={() => dispatch({ type: "back" })}
        >
          Back
        </button>
        <span className={styles.spacer} />
        <button
          type="button"
          className={cx(buttonCss.btn, buttonCss.primary, buttonCss.sm)}
          disabled={!canCommitConnectFlow(state)}
          onClick={() => dispatch({ type: "commit" })}
        >
          {context === "onboarding" ? "Enter Centraid" : "Connect"}
        </button>
      </div>
    </div>
  );
}
