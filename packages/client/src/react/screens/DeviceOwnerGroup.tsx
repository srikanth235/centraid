import type { JSX } from "react";

import type { GatewayOwnerVault } from "../../gateway-client.js";
import Icon from "../ui/Icon.js";
import type { GroupedDevice } from "./device-groups.js";
import DeviceRow, { ageLabel } from "./DeviceRow.js";

import styles from "./DevicesCard.module.css";

/*
 * One person and the devices acting as them (issue #726).
 *
 * A vault has exactly one owner, and a device caller sees only its own
 * owner's roster row (topology hiding) — so this group is always the
 * caller's own person. It keeps the per-person shape rather than flattening
 * to a bare device list because the header still carries what devices only
 * inherit: the person's name and the vaults they own.
 *
 * Removing a PERSON is a host-custody act on this machine (`owners-routes.ts`)
 * — never reachable from a device-token client — so the only removal verb
 * this card offers at all is "Revoke device", on each row.
 */

export interface DeviceOwnerGroupProps {
  label: string;
  /** The vaults this person owns. */
  vaults: readonly GatewayOwnerVault[];
  /** Live bindings. */
  devices: readonly GroupedDevice[];
  /** Tombstoned bindings, kept so past attribution still resolves. */
  revoked: readonly GroupedDevice[];
  /** True for the group holding the device making this request. */
  isSelf: boolean;
  now: number;
  onRevokeDevice?: (
    device: GroupedDevice,
    confirmLastDevice?: string
  ) => Promise<void>;
  onRenameDevice?: (device: GroupedDevice, label: string) => Promise<void>;
  onUpdateCompute?: (device: GroupedDevice, enabled: boolean) => Promise<void>;
}

export default function DeviceOwnerGroup({
  label,
  vaults,
  devices,
  revoked,
  isSelf,
  now,
  onRevokeDevice,
  onRenameDevice,
  onUpdateCompute,
}: DeviceOwnerGroupProps): JSX.Element {
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
            {vaults.length > 0 ? (
              vaults.map((vault) => (
                <span key={vault.vaultId} className={styles.roleChip}>
                  {vault.vaultName ?? vault.vaultId}
                </span>
              ))
            ) : (
              <span data-quiet="true">no vaults yet</span>
            )}
            <span data-quiet="true">
              {devices.length} device{devices.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      </header>

      {devices.length > 0 ? (
        <div className={styles.list}>
          {devices.map((device) => (
            <DeviceRow
              key={device.deviceId}
              device={device}
              now={now}
              {...(onRevokeDevice ? { onRevoke: onRevokeDevice } : {})}
              {...(onRenameDevice ? { onRename: onRenameDevice } : {})}
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
