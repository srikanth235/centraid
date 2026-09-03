import { useEffect, useState } from "react";
import type { JSX } from "react";

import type { CentraidGatewayDevice } from "../../gateway-client-devices.js";
import { formatDuration } from "../shell/routes/gatewayData.js";

import styles from "./BackupCard.module.css";

function lastSeenLabel(iso: string | undefined, now: number): string {
  if (!iso) return "never";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "never";
  return `${formatDuration(Math.max(0, now - at))} ago`;
}

function DeviceListRow({
  device,
  now,
}: {
  device: CentraidGatewayDevice;
  now: number;
}): JSX.Element {
  return (
    <div className={styles.deviceListRow} data-testid="backup-device-row">
      <span className={styles.deviceListName}>
        {device.label}
        {device.current ? (
          <span className={styles.deviceListCurrent}>this device</span>
        ) : null}
      </span>
      <span className={styles.deviceListScope} title={device.vaultId}>
        {device.vaultName ?? device.vaultId}
      </span>
      {/* SEAM: no per-device byte count on the wire yet — see file header. */}
      <span className={styles.deviceListSize} data-quiet="true">
        not reported
      </span>
      <span className={styles.deviceListSeen}>
        {lastSeenLabel(device.lastUsedAt, now)}
      </span>
    </div>
  );
}

export default function BackupDeviceList({
  now,
  loadDevices,
}: {
  now: number;
  loadDevices: () => Promise<CentraidGatewayDevice[]>;
}): JSX.Element | null {
  const [devices, setDevices] = useState<CentraidGatewayDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadDevices()
      .then((rows) => {
        if (!cancelled) setDevices(rows);
      })
      .catch((caughtError: unknown) => {
        if (!cancelled)
          setError(
            caughtError instanceof Error
              ? caughtError.message
              : String(caughtError)
          );
      });
    return () => {
      cancelled = true;
    };
  }, [loadDevices]);

  if (devices !== null && devices.length === 0) return null;

  return (
    <section
      className={styles.deviceListSection}
      data-testid="backup-device-list"
    >
      <h3>Every copy of your data</h3>
      {error ? (
        <p className={styles.deviceListError}>Couldn’t load devices: {error}</p>
      ) : devices === null ? (
        <p className={styles.deviceListError}>Loading devices…</p>
      ) : (
        <div className={styles.deviceListTable}>
          <div className={styles.deviceListHead} aria-hidden="true">
            <span>Device</span>
            <span>Scope</span>
            <span>Size</span>
            <span>Last seen</span>
          </div>
          {devices.map((device) => (
            <DeviceListRow key={device.deviceId} device={device} now={now} />
          ))}
        </div>
      )}
    </section>
  );
}
