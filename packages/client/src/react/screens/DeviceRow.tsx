import type { IconName } from '@centraid/design-tokens';
import { useState, type JSX } from 'react';

import type { CentraidGatewayDevice } from '../../gateway-client.js';
import { formatDuration } from '../shell/routes/gatewayData.js';
import { cx } from '../ui/cx.js';
import Icon from '../ui/Icon.js';
import { lastAdminSpace } from './device-roles.js';

import controlsCss from '../styles/controls.module.css';
import buttonCss from '../ui/Button.module.css';
import styles from './DevicesCard.module.css';

/*
 * One hardware binding inside a person's group (issue #599).
 *
 * "Revoke device" is the narrow verb — this phone was lost, the person keeps
 * their access and their other devices. The wide verb ("Remove <person>")
 * lives on the group header, never here, so the two can't be confused at the
 * moment of clicking.
 */

export interface DeviceRowProps {
  device: CentraidGatewayDevice;
  /** Live clock (parent ticks it) — drives the humanized ages. */
  now: number;
  onRevoke: (device: CentraidGatewayDevice, confirmLastAdmin?: string) => Promise<void>;
  onUpdateCompute?: (device: CentraidGatewayDevice, enabled: boolean) => Promise<void>;
}

export function platformGlyph(device: CentraidGatewayDevice): IconName {
  const platform = (device.platform ?? '').toLowerCase();
  if (/ios|android|iphone|ipad|mobile|phone/u.test(platform)) return 'Phone';
  if (/web|browser|chrome|safari|firefox|edge/u.test(platform)) return 'Globe';
  if (/mac|win|linux|desktop|electron/u.test(platform)) return 'Monitor';
  // Every gateway device is admitted by its iroh identity.
  return 'Globe';
}

export function ageLabel(iso: string | undefined, now: number): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  return `${formatDuration(Math.max(0, now - at))} ago`;
}

export default function DeviceRow({
  device,
  now,
  onRevoke,
  onUpdateCompute,
}: DeviceRowProps): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set only once the gateway has refused: this device is the last live one
  // of the space's last owner, so the confirm escalates in place.
  const [strandedSpace, setStrandedSpace] = useState<string | null>(null);
  const [computeBusy, setComputeBusy] = useState(false);

  const lastSeen = device.lastUsedAt ? ageLabel(device.lastUsedAt, now) : undefined;
  const paired = ageLabel(device.addedAt, now);

  const revoke = async (confirmLastAdmin?: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onRevoke(device, confirmLastAdmin);
      // On success the parent drops the row; nothing more to do here.
    } catch (err) {
      const stranded = lastAdminSpace(err);
      if (stranded !== undefined && confirmLastAdmin === undefined) {
        setStrandedSpace(stranded);
      } else {
        setError(err instanceof Error ? err.message : String(err));
        setConfirming(false);
        setStrandedSpace(null);
      }
      setBusy(false);
    }
  };

  const updateCompute = async (enabled: boolean): Promise<void> => {
    if (!onUpdateCompute) return;
    setComputeBusy(true);
    setError(null);
    try {
      await onUpdateCompute(device, enabled);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setComputeBusy(false);
    }
  };

  const cancel = (): void => {
    setConfirming(false);
    setStrandedSpace(null);
  };

  return (
    <div className={styles.row} data-current={device.current || undefined}>
      <span className={styles.glyph} aria-hidden="true">
        <Icon name={platformGlyph(device)} size={16} />
      </span>
      <div className={styles.main}>
        <div className={styles.nameLine}>
          <span className={styles.name}>{device.label}</span>
          {device.current ? <span className={styles.currentChip}>This device</span> : null}
          <span
            className={styles.transportChip}
            data-transport={device.transport}
            title="Paired over the relay-only Iroh tunnel"
          >
            Relay
          </span>
        </div>
        <div className={styles.meta}>
          {device.platform ? <span>{device.platform}</span> : null}
          {(device.vaultName ?? device.vaultId) ? (
            <span className={styles.metaVault}>
              <Icon name="Key" size={11} />
              {device.vaultName ?? device.vaultId}
            </span>
          ) : null}
          {lastSeen ? <span>active {lastSeen}</span> : <span data-quiet="true">never used</span>}
          {paired ? <span data-quiet="true">paired {paired}</span> : null}
        </div>
        {device.grantProfile === undefined ? null : (
          <div className={styles.grantProfile} aria-label="Companion module grants">
            <span>Companion</span>
            {device.grantProfile.length > 0 ? (
              device.grantProfile.map((grant) => <span key={grant}>{grant}</span>)
            ) : (
              <span>no modules</span>
            )}
          </div>
        )}
        {onUpdateCompute ? (
          <label className={styles.computeToggle}>
            <input
              type="checkbox"
              checked={device.compute?.contributeWhileCharging ?? false}
              disabled={computeBusy}
              onChange={(event) => void updateCompute(event.target.checked)}
            />
            <span>Help index your library while charging and unmetered</span>
            {computeBusy ? <small>saving…</small> : null}
          </label>
        ) : null}
        {device.compute?.contributeWhileCharging ? (
          <div className={styles.computeCaps}>
            {Object.entries(device.compute.capabilities)
              .filter(([, enabled]) => enabled)
              .map(([capability]) => (
                <span key={capability}>{capability}</span>
              ))}
          </div>
        ) : null}
        {strandedSpace ? (
          <div className={styles.rowWarn}>
            This is the last owner device for {strandedSpace}. Getting back in would need the
            gateway machine and its command line.
          </div>
        ) : null}
        {error ? <div className={styles.rowError}>{error}</div> : null}
      </div>

      <div className={styles.rowAction}>
        {confirming ? (
          <div className={styles.confirm}>
            <span className={styles.confirmAsk}>
              {device.current ? 'Sign out this device?' : 'Revoke this device?'}
            </span>
            <button
              type="button"
              className={cx(buttonCss.btn, buttonCss.sm, styles.confirmYes)}
              disabled={busy}
              onClick={() => void revoke(strandedSpace ?? undefined)}
            >
              {busy ? (
                <span className={styles.spin}>
                  <Icon name="Loader" size={13} />
                </span>
              ) : strandedSpace ? (
                'Revoke anyway'
              ) : (
                'Revoke'
              )}
            </button>
            <button
              type="button"
              className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
              disabled={busy}
              onClick={cancel}
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
            <span>Revoke device</span>
          </button>
        )}
      </div>
    </div>
  );
}
