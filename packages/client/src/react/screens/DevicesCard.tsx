import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { IconName } from '@centraid/design-tokens';
import Icon from '../ui/Icon.js';
import { cx } from '../ui/cx.js';
import { formatClock, formatDuration } from '../shell/routes/gatewayData.js';
import type {
  CentraidGatewayDevice,
  GatewayDeviceTicket,
  GatewayDeviceWorkDepth,
} from '../../gateway-client.js';
import buttonCss from '../ui/Button.module.css';
import controlsCss from '../styles/controls.module.css';
import gwStyles from './GatewayScreen.module.css';
import styles from './DevicesCard.module.css';

// Gateway → Overview → Paired devices: the owner surface over the daemon's
// `EnrollmentStore` + `DeviceTokenStore` (issue #392 follow-up). Until now
// the roster of paired browsers/phones was reachable only through the
// `centraid-gateway devices` CLI on the host machine — no way to see, let
// alone revoke, a device from the app. That matters most for the case you
// can't reach the device at all (lost/stolen): revoke here and the durable
// web-session store's `isDeviceValid` re-check kills its live control/app
// cookies on their very next request.
//
// It reads as a sibling of the Backups/Storage cards — same `.panel` shell,
// mono meta, hairline-bordered list — not a bolted-on settings form. A
// device carries a type glyph (browser / phone / desktop), a transport chip
// (Relay vs Direct), its vault, and humanized paired/last-seen ages. Revoke
// is a two-step inline confirm, never a bare destructive click; the current
// device is called out so signing yourself out is a deliberate choice.

export interface DevicesCardProps {
  /** Live clock (parent ticks it each second) — drives the humanized ages. */
  now: number;
  loadDevices: () => Promise<CentraidGatewayDevice[]>;
  onRevokeDevice: (deviceId: string) => Promise<{ removed: boolean }>;
  /** Eager local cleanup after this renderer successfully revokes itself. */
  onCurrentDeviceRevoked?: () => Promise<void>;
  /**
   * Mint a one-time pairing ticket for the active vault (`POST
   * _gateway/devices/ticket`). Optional so a host that can't mint (or a test)
   * simply hides the "Pair a device" affordance.
   */
  onCreateTicket?: (input?: { ttlMinutes?: number }) => Promise<GatewayDeviceTicket>;
  onUpdateCompute?: (
    device: CentraidGatewayDevice,
    contributeWhileCharging: boolean,
  ) => Promise<CentraidGatewayDevice>;
  loadWorkStatus?: () => Promise<GatewayDeviceWorkDepth[]>;
}

/** Ticket lifetimes offered in the pairing panel (minutes). */
const TTL_PRESETS: readonly { label: string; minutes: number }[] = [
  { label: '15 min', minutes: 15 },
  { label: '1 hour', minutes: 60 },
  { label: '24 hours', minutes: 1440 },
];

/** Poll cadence — same order of magnitude as the Backups card. */
const POLL_MS = 15_000;

function platformGlyph(device: CentraidGatewayDevice): IconName {
  const platform = (device.platform ?? '').toLowerCase();
  if (device.transport === 'iroh' && /ios|android|iphone|ipad|mobile|phone/.test(platform)) {
    return 'Phone';
  }
  if (/ios|android|iphone|ipad|mobile|phone/.test(platform)) return 'Phone';
  if (/web|browser|chrome|safari|firefox|edge/.test(platform)) return 'Globe';
  if (/mac|win|linux|desktop|electron/.test(platform)) return 'Monitor';
  // Fall back on the transport: a browser pairs over Iroh or direct HTTP.
  return 'Globe';
}

function ageLabel(iso: string | undefined, now: number): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  return `${formatDuration(Math.max(0, now - at))} ago`;
}

function DeviceRow({
  device,
  now,
  onRevoke,
  onUpdateCompute,
}: {
  device: CentraidGatewayDevice;
  now: number;
  onRevoke: (device: CentraidGatewayDevice) => Promise<void>;
  onUpdateCompute?: (device: CentraidGatewayDevice, enabled: boolean) => Promise<void>;
}): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [computeBusy, setComputeBusy] = useState(false);

  const lastSeen = device.lastUsedAt ? ageLabel(device.lastUsedAt, now) : undefined;
  const paired = ageLabel(device.addedAt, now);
  const transportLabel = device.transport === 'iroh' ? 'Relay' : 'Direct';

  const revoke = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onRevoke(device);
      // On success the parent drops the row; nothing more to do here.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      setConfirming(false);
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
            title={
              device.transport === 'iroh'
                ? 'Paired over the relay-only Iroh tunnel'
                : 'Paired over direct HTTP'
            }
          >
            {transportLabel}
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
        {error ? <div className={styles.rowError}>{error}</div> : null}
      </div>

      <div className={styles.rowAction}>
        {confirming ? (
          <div className={styles.confirm}>
            <span className={styles.confirmAsk}>
              {device.current ? 'Sign out this device?' : 'Remove?'}
            </span>
            <button
              type="button"
              className={cx(buttonCss.btn, buttonCss.sm, styles.confirmYes)}
              disabled={busy}
              onClick={() => void revoke()}
            >
              {busy ? (
                <span className={styles.spin}>
                  <Icon name="Loader" size={13} />
                </span>
              ) : (
                'Remove'
              )}
            </button>
            <button
              type="button"
              className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
              disabled={busy}
              onClick={() => setConfirming(false)}
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
            <span>Revoke</span>
          </button>
        )}
      </div>
    </div>
  );
}

function PairPanel({
  now,
  onCreateTicket,
  onClose,
}: {
  now: number;
  onCreateTicket: NonNullable<DevicesCardProps['onCreateTicket']>;
  onClose: () => void;
}): JSX.Element {
  const [minutes, setMinutes] = useState(15);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticket, setTicket] = useState<GatewayDeviceTicket | null>(null);
  const [copied, setCopied] = useState(false);

  const generate = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setTicket(await onCreateTicket({ ttlMinutes: minutes }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const copy = (): void => {
    if (!ticket) return;
    void navigator.clipboard
      .writeText(ticket.ticket)
      .then(() => setCopied(true))
      .catch(() =>
        setError('Couldn’t copy to the clipboard — select and copy the ticket manually.'),
      );
  };

  if (ticket) {
    const expMs = Date.parse(ticket.expiresAt);
    return (
      <div className={styles.pair} data-testid="pair-panel">
        <div className={styles.pairLead}>
          One-time ticket for <strong>{ticket.vaultName ?? 'your vault'}</strong>. Paste it into the
          new device’s “Add gateway” dialog — it burns on first use.
        </div>
        <div className={styles.ticketRow}>
          <code className={styles.ticket}>{ticket.ticket}</code>
          <button
            type="button"
            className={cx(buttonCss.btn, buttonCss.sm, styles.copyBtn)}
            onClick={copy}
          >
            <Icon name={copied ? 'Check' : 'Copy'} size={13} />
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
        <div className={styles.pairFoot}>
          <span className={styles.pairExpiry}>
            {Number.isNaN(expMs)
              ? ''
              : expMs <= now
                ? 'Expired'
                : `Expires ${formatClock(expMs)} · in ${formatDuration(expMs - now)}`}
          </span>
          <div className={styles.pairActions}>
            <button
              type="button"
              className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
              onClick={() => {
                setTicket(null);
                setCopied(false);
              }}
            >
              New ticket
            </button>
            <button
              type="button"
              className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
              onClick={onClose}
            >
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.pair} data-testid="pair-panel">
      <div className={styles.pairLead}>
        Generate a one-time ticket, then paste it into the new device’s “Add gateway” dialog. The
        device pairs into your active vault and appears here once it connects.
      </div>
      <div className={styles.pairForm}>
        <div className={styles.ttlGroup} role="group" aria-label="Ticket lifetime">
          {TTL_PRESETS.map((preset) => (
            <button
              key={preset.minutes}
              type="button"
              className={cx(styles.ttlPreset, preset.minutes === minutes && styles.ttlPresetOn)}
              aria-pressed={preset.minutes === minutes}
              disabled={busy}
              onClick={() => setMinutes(preset.minutes)}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <div className={styles.pairActions}>
          <button
            type="button"
            className={cx(buttonCss.btn, buttonCss.sm, styles.generateBtn)}
            disabled={busy}
            onClick={() => void generate()}
          >
            {busy ? (
              <span className={styles.spin}>
                <Icon name="Loader" size={13} />
              </span>
            ) : (
              'Generate ticket'
            )}
          </button>
          <button
            type="button"
            className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
      {error ? <div className={styles.rowError}>{error}</div> : null}
    </div>
  );
}

export default function DevicesCard({
  now,
  loadDevices,
  onRevokeDevice,
  onCurrentDeviceRevoked,
  onCreateTicket,
  onUpdateCompute,
  loadWorkStatus,
}: DevicesCardProps): JSX.Element {
  const [devices, setDevices] = useState<CentraidGatewayDevice[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [workDepth, setWorkDepth] = useState<GatewayDeviceWorkDepth[]>([]);
  const mountedRef = useRef(true);

  const refresh = useCallback((): void => {
    loadDevices()
      .then((list) => {
        if (!mountedRef.current) return;
        setDevices(list);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    void loadWorkStatus?.().then((depth) => {
      if (mountedRef.current) setWorkDepth(depth);
    });
  }, [loadDevices, loadWorkStatus]);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  const revoke = useCallback(
    async (device: CentraidGatewayDevice): Promise<void> => {
      await onRevokeDevice(device.deviceId);
      if (device.current) await onCurrentDeviceRevoked?.();
      // Optimistically drop the row; a background refresh reconciles.
      if (mountedRef.current) {
        setDevices((prev) => prev?.filter((d) => d.deviceId !== device.deviceId) ?? prev);
      }
      refresh();
    },
    [onCurrentDeviceRevoked, onRevokeDevice, refresh],
  );

  const updateCompute = useCallback(
    async (device: CentraidGatewayDevice, enabled: boolean): Promise<void> => {
      if (!onUpdateCompute) return;
      const updated = await onUpdateCompute(device, enabled);
      if (!mountedRef.current) return;
      setDevices(
        (previous) =>
          previous?.map((row) => (row.deviceId === updated.deviceId ? updated : row)) ?? previous,
      );
    },
    [onUpdateCompute],
  );

  const count = devices?.length ?? 0;
  const queued = workDepth.reduce((sum, depth) => sum + depth.available, 0);
  const leased = workDepth.reduce((sum, depth) => sum + depth.leased, 0);
  const [pairing, setPairing] = useState(false);

  return (
    <section className={cx(gwStyles.panel, styles.card)}>
      <div className={gwStyles.panelHead}>
        <h2>Paired devices</h2>
        <div className={styles.headRight}>
          {devices && count > 0 ? (
            <span className={gwStyles.panelMeta}>
              {count} device{count === 1 ? '' : 's'}
            </span>
          ) : null}
          {loadWorkStatus ? (
            <span className={gwStyles.panelMeta} data-testid="device-work-depth">
              {queued} queued · {leased} leased
            </span>
          ) : null}
          {onCreateTicket && !pairing ? (
            <button
              type="button"
              className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
              onClick={() => setPairing(true)}
            >
              <Icon name="Plus" size={13} />
              <span>Pair a device</span>
            </button>
          ) : null}
        </div>
      </div>

      <div className={styles.body}>
        {onCreateTicket && pairing ? (
          <PairPanel now={now} onCreateTicket={onCreateTicket} onClose={() => setPairing(false)} />
        ) : null}
        {loadError ? (
          <div className={styles.loadError}>Couldn’t list paired devices: {loadError}</div>
        ) : !devices ? (
          <div className={gwStyles.panelEmpty}>Checking paired devices…</div>
        ) : devices.length === 0 ? (
          <div className={gwStyles.panelEmpty}>
            No devices are paired with this gateway yet. Pair a browser or phone with a one-time
            ticket, and it will show up here — revocable in one click.
          </div>
        ) : (
          <div className={styles.list}>
            {devices.map((device) => (
              <DeviceRow
                key={device.deviceId}
                device={device}
                now={now}
                onRevoke={revoke}
                onUpdateCompute={onUpdateCompute ? updateCompute : undefined}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
