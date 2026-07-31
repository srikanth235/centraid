import { useState } from "react";
import type { JSX } from "react";

import type { GatewayVaultGrant } from "../../gateway-client.js";
import { cx } from "../ui/cx.js";
import Icon from "../ui/Icon.js";
import type { GroupedDevice } from "./device-groups.js";
import { lastAdminVault, roleLabel } from "./device-roles.js";
import DeviceRow, { ageLabel } from "./DeviceRow.js";

import controlsCss from "../styles/controls.module.css";
import buttonCss from "../ui/Button.module.css";
import styles from "./DevicesCard.module.css";

/*
 * One person and the devices acting as them (issue #599 L2 / Decision 10).
 *
 * The header carries the two things authored on the PERSON — their access,
 * in ownership words, and the wide removal verb. "Remove <person>" is one
 * atomic act: their roles and every device they own go together, which is
 * exactly what "she moved out" means and what a loop over device rows could
 * never guarantee.
 */

export interface DeviceMemberGroupProps {
  label: string;
  /** The person's (vault, role) grants — devices only inherit these. */
  roles: readonly GatewayVaultGrant[];
  /** Live bindings. */
  devices: readonly GroupedDevice[];
  /** Tombstoned bindings, kept so past attribution still resolves. */
  revoked: readonly GroupedDevice[];
  /** True for the group holding the device making this request. */
  isSelf: boolean;
  now: number;
  /** Absent when the viewer may not revoke anything on this installation. */
  onRevokeDevice?: (
    device: GroupedDevice,
    confirmLastAdmin?: string
  ) => Promise<void>;
  onRenameDevice?: (device: GroupedDevice, label: string) => Promise<void>;
  onUpdateCompute?: (device: GroupedDevice, enabled: boolean) => Promise<void>;
  /** Absent when the gateway exposes no roster surface to remove people with. */
  onRemoveMember?: (confirmLastAdmin?: string) => Promise<void>;
  /**
   * False for a member who owns no vault: the household verbs are hidden
   * rather than rendered dead (onboarding run B11). Signing THIS device out
   * stays available — it is the viewer's own hardware, not someone else's.
   */
  canAdminister?: boolean;
}

export default function DeviceMemberGroup({
  label,
  roles,
  devices,
  revoked,
  isSelf,
  now,
  onRevokeDevice,
  onRenameDevice,
  onUpdateCompute,
  onRemoveMember,
  canAdminister = true,
}: DeviceMemberGroupProps): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [strandedVault, setStrandedVault] = useState<string | null>(null);

  const remove = async (confirmLastAdmin?: string): Promise<void> => {
    if (!onRemoveMember) return;
    setBusy(true);
    setError(null);
    try {
      await onRemoveMember(confirmLastAdmin);
    } catch (caughtError) {
      const stranded = lastAdminVault(caughtError);
      if (stranded !== undefined && confirmLastAdmin === undefined) {
        setStrandedVault(stranded);
      } else {
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : String(caughtError)
        );
        setConfirming(false);
        setStrandedVault(null);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.group} data-self={isSelf || undefined}>
      <header className={styles.groupHead}>
        <span className={styles.groupGlyph} aria-hidden="true">
          <Icon name="User" size={16} />
        </span>
        <div className={styles.groupMain}>
          <div className={styles.nameLine}>
            <h3 className={styles.groupName}>{label}</h3>
            {isSelf ? <span className={styles.currentChip}>You</span> : null}
          </div>
          <div className={styles.meta}>
            {roles.length > 0 ? (
              roles.map((grant) => (
                <span key={grant.vaultId} className={styles.roleChip}>
                  {roleLabel(grant.role)} · {grant.vaultName ?? grant.vaultId}
                </span>
              ))
            ) : (
              <span data-quiet="true">no access yet</span>
            )}
            <span data-quiet="true">
              {devices.length} device{devices.length === 1 ? "" : "s"}
            </span>
          </div>
          {strandedVault ? (
            <div className={styles.rowWarn}>
              {label} is the last owner of {strandedVault}. Getting back in
              would need the gateway machine and its command line.
            </div>
          ) : null}
          {error ? <div className={styles.rowError}>{error}</div> : null}
        </div>
        {onRemoveMember && canAdminister ? (
          <div className={styles.rowAction}>
            {confirming ? (
              <div className={styles.confirm}>
                <span className={styles.confirmAsk}>
                  Remove {label} and their {devices.length} device
                  {devices.length === 1 ? "" : "s"}?
                </span>
                <button
                  type="button"
                  className={cx(buttonCss.btn, buttonCss.sm, styles.confirmYes)}
                  disabled={busy}
                  onClick={() => void remove(strandedVault ?? undefined)}
                >
                  {busy ? (
                    <span className={styles.spin}>
                      <Icon name="Loader" size={13} />
                    </span>
                  ) : strandedVault ? (
                    "Remove anyway"
                  ) : (
                    "Remove"
                  )}
                </button>
                <button
                  type="button"
                  className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
                  disabled={busy}
                  onClick={() => {
                    setConfirming(false);
                    setStrandedVault(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                className={cx(
                  buttonCss.btn,
                  buttonCss.sm,
                  controlsCss.soft,
                  styles.revokeBtn
                )}
                onClick={() => setConfirming(true)}
              >
                <Icon name="Trash" size={13} />
                <span>Remove {label}</span>
              </button>
            )}
          </div>
        ) : null}
      </header>

      {devices.length > 0 ? (
        <div className={styles.list}>
          {devices.map((device) => (
            <DeviceRow
              key={device.deviceId}
              device={device}
              now={now}
              {...(onRevokeDevice && (canAdminister || device.current)
                ? { onRevoke: onRevokeDevice }
                : {})}
              {...(onRenameDevice && (canAdminister || device.current)
                ? { onRename: onRenameDevice }
                : {})}
              {...(onUpdateCompute && (canAdminister || device.current)
                ? { onUpdateCompute }
                : {})}
            />
          ))}
        </div>
      ) : (
        <p className={styles.groupEmpty}>No devices paired for {label} yet.</p>
      )}

      {/* Tombstones stay out of the way but never disappear: a revoked row is
          how a past write still resolves to the device that made it. */}
      {revoked.length > 0 ? (
        <details className={styles.tombstones}>
          <summary>
            {revoked.length} revoked device{revoked.length === 1 ? "" : "s"}
          </summary>
          <ul>
            {revoked.map((device) => (
              <li key={device.deviceId}>
                <span>{device.label}</span>
                <span data-quiet="true">
                  {device.vaultName ?? device.vaultId}
                  {device.addedAt
                    ? ` · paired ${ageLabel(device.addedAt, now)}`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
