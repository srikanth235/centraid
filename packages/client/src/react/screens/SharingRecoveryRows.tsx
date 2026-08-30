import type { JSX } from "react";

import { DAY_MS } from "@centraid/blueprints/apps/_shared/format-kit";

import type {
  CommonsRecoveryGrant,
  CommonsRecoveryOutcome,
} from "../../gateway-client.js";
import {
  SHARING_STEWARD_PARKED,
  sharingSilentForDays,
  sharingStewardSilent,
} from "../../sharing-copy.js";
import { cx } from "../ui/cx.js";
import Icon from "../ui/Icon.js";

import controlsCss from "../styles/controls.module.css";
import buttonCss from "../ui/Button.module.css";
import deviceStyles from "./DevicesCard.module.css";
import styles from "./SharingCard.module.css";

/** Busy-row identity for one concern. Exported because the caller runs the
 *  action and therefore owns the busy state these rows read. */
export function recoveryBusyKey(entry: CommonsRecoveryGrant): string {
  return `recover:${entry.actorVaultId}:${entry.grantId}`;
}

/**
 * A commons this seat should be worried about. A grant already re-founded has
 * a live successor, and a steward this device simply cannot reach
 * (`link-down`) proves nothing about that steward — neither belongs in front
 * of the owner.
 */
export function recoveryConcerns(
  grants: readonly CommonsRecoveryGrant[]
): CommonsRecoveryGrant[] {
  return grants.filter(
    (entry) =>
      !entry.supersededBy &&
      (entry.steward.presence === "degraded" ||
        entry.steward.presence === "absent" ||
        entry.steward.presence === "parked")
  );
}

/**
 * What the owner still has to do by hand after the ceremony. A member whose
 * only link was to the vault that disappeared cannot be invited over the wire
 * at all (docs/recovery/commons-steward-loss.md), so the count is said out
 * loud rather than leaving a silently smaller circle.
 */
export function recoveryOutcomeSummary(
  outcome: CommonsRecoveryOutcome
): string {
  const reached = outcome.invitations.filter(
    (row) => row.state === "queued" || row.state === "delivered"
  ).length;
  const byHand = outcome.invitations.length - reached;
  const invited = `${reached} ${reached === 1 ? "member was" : "members were"} invited to the new shared space`;
  return byHand
    ? `Re-founded from your copy. ${invited}; ${byHand} could not be reached and must be invited by hand.`
    : `Re-founded from your copy. ${invited}.`;
}

function stewardLine(entry: CommonsRecoveryGrant): string {
  const silent = entry.steward.silentForMs;
  const days = silent === undefined ? 0 : Math.floor(silent / DAY_MS);
  return [
    entry.containerType,
    days > 0 ? sharingSilentForDays(days) : "",
    entry.steward.fault ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The steward-absence section of the People panel: the surface the recovery
 * ceremony is reachable from (#750). The button appears only for a
 * proven `absent` — a seat parked on an unverified history must never be
 * re-founded from state it could not verify, and a `degraded` steward may
 * still come back on its own.
 */
export default function SharingRecoveryRows({
  concerns,
  busyRow,
  outcome,
  onRecover,
}: {
  concerns: readonly CommonsRecoveryGrant[];
  busyRow: string | null;
  outcome: string | null;
  onRecover?: (entry: CommonsRecoveryGrant) => void;
}): JSX.Element {
  return (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>Shared-space recovery</h3>
      {outcome ? <p className={deviceStyles.meta}>{outcome}</p> : null}
      <div className={deviceStyles.list}>
        {concerns.map((entry) => {
          const busyKey = recoveryBusyKey(entry);
          return (
            <div key={busyKey} className={deviceStyles.row}>
              <Icon name="AlertTriangle" size={15} />
              <div className={deviceStyles.main}>
                <div className={deviceStyles.name}>
                  {entry.steward.presence === "parked"
                    ? SHARING_STEWARD_PARKED
                    : sharingStewardSilent(entry.steward.presence)}
                </div>
                <div className={deviceStyles.meta}>{stewardLine(entry)}</div>
              </div>
              {onRecover && entry.steward.presence === "absent" ? (
                <div className={deviceStyles.rowAction}>
                  <button
                    type="button"
                    className={cx(
                      buttonCss.btn,
                      buttonCss.sm,
                      controlsCss.soft
                    )}
                    disabled={busyRow === busyKey}
                    onClick={() => onRecover(entry)}
                  >
                    Recover from my copy
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
