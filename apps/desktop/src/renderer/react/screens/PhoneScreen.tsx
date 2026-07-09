import { useCallback, useEffect, useState, type JSX } from 'react';
import type {
  PhoneBridgeProps,
  PhoneDeviceDTO,
  PhonePairingDTO,
  PhoneStatusDTO,
} from '../bridge.js';
import styles from './PhoneScreen.module.css';

function Note({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="cd-app-settings-note">{children}</div>;
}

function DeviceRow({
  device,
  onRevoke,
}: {
  device: PhoneDeviceDTO;
  onRevoke: (deviceId: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const added = new Date(device.addedAt);
  const addedLabel = Number.isNaN(added.getTime()) ? '' : ` · added ${added.toLocaleDateString()}`;
  return (
    <div className={styles.deviceRow}>
      <div className={styles.deviceInfo}>
        <div className={styles.deviceName}>{device.name}</div>
        <div className={styles.deviceMeta}>
          {`${device.platform}${addedLabel} · ${device.endpointId.slice(0, 10)}…`}
        </div>
      </div>
      <button
        type="button"
        className={styles.revokeBtn}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          onRevoke(device.deviceId);
        }}
      >
        Revoke
      </button>
    </div>
  );
}

type Pairing = { info: PhonePairingDTO; cancel: () => void } | null;

/**
 * Phone settings pane — the "Connect phone" iroh-tunnel pairing surface, ported
 * to React (issue #325, Phase 3). Stateful: fetches the tunnel status via the
 * vanilla-supplied `loadStatus`, drives the one-time QR pairing through
 * `beginPairing` (which wires the native `onPhonePaired` subscription), and
 * revokes devices. Reloads after every act. Same `cd-phone-*` classes.
 */
export default function PhoneScreen({
  loadStatus,
  beginPairing,
  revoke,
  showToast,
}: PhoneBridgeProps): JSX.Element {
  const [status, setStatus] = useState<PhoneStatusDTO | 'loading' | 'error'>('loading');
  const [pairing, setPairing] = useState<Pairing>(null);

  const reload = useCallback(async () => {
    try {
      const s = await loadStatus();
      setStatus(s ?? 'error');
    } catch {
      setStatus('error');
    }
  }, [loadStatus]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onConnect = (): void => {
    void beginPairing((deviceName) => {
      setPairing(null);
      showToast?.(`Paired ${deviceName}.`);
      void reload();
    }).then((res) => {
      if (!res) {
        showToast?.('Could not start pairing.');
        return;
      }
      setPairing(res);
    });
  };

  const onCancelPairing = (): void => {
    pairing?.cancel();
    setPairing(null);
    void reload();
  };

  const onRevoke = (deviceId: string): void => {
    void revoke(deviceId).then((ok) => {
      showToast?.(ok ? 'Revoked device.' : 'Could not revoke device.');
      void reload();
    });
  };

  if (status === 'loading') {
    return <Note>Loading…</Note>;
  }
  if (status === 'error') {
    return <Note>Could not read the phone link status.</Note>;
  }

  const expiresLabel = pairing
    ? new Date(pairing.info.expiresAt).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      })
    : '';

  return (
    <>
      {status.error ? (
        <Note>{`The tunnel endpoint failed to start: ${status.error}`}</Note>
      ) : !status.running ? (
        <Note>The tunnel endpoint is starting…</Note>
      ) : null}

      <div className={styles.pairing}>
        {pairing ? (
          <>
            <img
              className={styles.qr}
              alt="Pairing QR code — scan from the Centraid mobile app"
              src={pairing.info.qrDataUrl}
            />
            <div className="cd-app-settings-note">
              {`Open the Centraid app on your phone → Settings → Pair with desktop, and scan this code. It works once and expires at ${expiresLabel}.`}
            </div>
            <button type="button" className="cd-link-btn" onClick={onCancelPairing}>
              Cancel pairing
            </button>
          </>
        ) : (
          <>
            <div className="cd-app-settings-note">
              Your phone connects directly to this desktop over an end-to-end encrypted tunnel —
              from any network, with the gateway never exposed. Publish an app here, open it there.
            </div>
            <button type="button" className="cd-btn cd-btn-primary" onClick={onConnect}>
              Connect a phone
            </button>
          </>
        )}
      </div>

      <div className={styles.devices}>
        <div className="drawer-group-label">Paired phones</div>
        {status.devices.length > 0 ? (
          status.devices.map((device) => (
            <DeviceRow key={device.deviceId} device={device} onRevoke={onRevoke} />
          ))
        ) : (
          <Note>
            No phones paired yet. Scan the QR code from the Centraid mobile app to connect one.
          </Note>
        )}
      </div>
    </>
  );
}
