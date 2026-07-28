import { useState, type JSX } from 'react';

import type { CentraidGatewayDevice, GatewayVaultGrant } from '../../gateway-client.js';
import { cx } from '../ui/cx.js';
import Icon from '../ui/Icon.js';
import { lastAdminSpace, roleLabel } from './device-roles.js';
import DeviceRow, { ageLabel } from './DeviceRow.js';

import controlsCss from '../styles/controls.module.css';
import buttonCss from '../ui/Button.module.css';
import styles from './DevicesCard.module.css';

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
  /** The person's (space, role) grants — devices only inherit these. */
  roles: readonly GatewayVaultGrant[];
  /** Live bindings. */
  devices: readonly CentraidGatewayDevice[];
  /** Tombstoned bindings, kept so past attribution still resolves. */
  revoked: readonly CentraidGatewayDevice[];
  /** True for the group holding the device making this request. */
  isSelf: boolean;
  now: number;
  onRevokeDevice: (device: CentraidGatewayDevice, confirmLastAdmin?: string) => Promise<void>;
  onUpdateCompute?: (device: CentraidGatewayDevice, enabled: boolean) => Promise<void>;
  /** Absent when the gateway exposes no roster surface to remove people with. */
  onRemoveMember?: (confirmLastAdmin?: string) => Promise<void>;
}

export default function DeviceMemberGroup({
  label,
  roles,
  devices,
  revoked,
  isSelf,
  now,
  onRevokeDevice,
  onUpdateCompute,
  onRemoveMember,
}: DeviceMemberGroupProps): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [strandedSpace, setStrandedSpace] = useState<string | null>(null);

  const remove = async (confirmLastAdmin?: string): Promise<void> => {
    if (!onRemoveMember) return;
    setBusy(true);
    setError(null);
    try {
      await onRemoveMember(confirmLastAdmin);
    } catch (err) {
      const stranded = lastAdminSpace(err);
      if (stranded !== undefined && confirmLastAdmin === undefined) {
        setStrandedSpace(stranded);
      } else {
        setError(err instanceof Error ? err.message : String(err));
        setConfirming(false);
        setStrandedSpace(null);
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
              {devices.length} device{devices.length === 1 ? '' : 's'}
            </span>
          </div>
          {strandedSpace ? (
            <div className={styles.rowWarn}>
              {label} is the last owner of {strandedSpace}. Getting back in would need the gateway
              machine and its command line.
            </div>
          ) : null}
          {error ? <div className={styles.rowError}>{error}</div> : null}
        </div>
        {onRemoveMember ? (
          <div className={styles.rowAction}>
            {confirming ? (
              <div className={styles.confirm}>
                <span className={styles.confirmAsk}>
                  Remove {label} and their {devices.length} device
                  {devices.length === 1 ? '' : 's'}?
                </span>
                <button
                  type="button"
                  className={cx(buttonCss.btn, buttonCss.sm, styles.confirmYes)}
                  disabled={busy}
                  onClick={() => void remove(strandedSpace ?? undefined)}
                >
                  {busy ? (
                    <span className={styles.spin}>
                      <Icon name="Loader" size={13} />
                    </span>
                  ) : strandedSpace ? (
                    'Remove anyway'
                  ) : (
                    'Remove'
                  )}
                </button>
                <button
                  type="button"
                  className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
                  disabled={busy}
                  onClick={() => {
                    setConfirming(false);
                    setStrandedSpace(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft, styles.revokeBtn)}
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
              onRevoke={onRevokeDevice}
              {...(onUpdateCompute ? { onUpdateCompute } : {})}
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
            {revoked.length} revoked device{revoked.length === 1 ? '' : 's'}
          </summary>
          <ul>
            {revoked.map((device) => (
              <li key={device.deviceId}>
                <span>{device.label}</span>
                <span data-quiet="true">
                  {device.vaultName ?? device.vaultId}
                  {device.addedAt ? ` · paired ${ageLabel(device.addedAt, now)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
