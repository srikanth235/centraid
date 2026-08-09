import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";

import type {
  CentraidGatewayDevice,
  GatewayDeviceTicket,
  GatewayDeviceTicketInput,
  GatewayDeviceWorkDepth,
  GatewayOwner,
} from "../../gateway-client.js";
import { startVisibilityTicker } from "../shell/routes/visibility-ticker.js";
import { cx } from "../ui/cx.js";
import Icon from "../ui/Icon.js";
import { groupDevicesByOwner } from "./device-groups.js";
import type { GroupedDevice } from "./device-groups.js";
import DeviceOwnerGroup from "./DeviceOwnerGroup.js";
import DevicePairPanel from "./DevicePairPanel.js";

import controlsCss from "../styles/controls.module.css";
import buttonCss from "../ui/Button.module.css";
import styles from "./DevicesCard.module.css";
import gwStyles from "./GatewayScreen.module.css";

// Gateway → Overview → People & devices: the owner surface over the daemon's
// owner roster + `EnrollmentStore` (issues #392, #726).
//
// It is people-first because a device is always somebody's: "Priya's laptop
// is revoked but her phone is live" is a state this card can display, but
// "someone else's device" is not, because a vault has exactly one owner and
// a device caller sees only its own owner's roster row. So the one group
// this card ever renders is the caller's own.
//
// "Revoke device" ("this phone was stolen") is the only removal verb this
// card offers — removing the PERSON is a host-custody act on this machine
// (`owners-routes.ts`), never reachable from a device-token client.
//
// "Add someone" (#726 P1) mints a NEW person a vault of their own, hosted on
// this machine, then shows the SAME ticket QR panel "Pair a device" already
// renders — the two buttons open the same `DevicePairPanel`, one self-paired
// and one `forPerson`, rather than two implementations of a ticket screen.
//
// Revoking no longer deletes the row; it tombstones it, so a past write still
// resolves to the device that made it. Tombstones live in a collapsed
// disclosure at the foot of their person's group — present for audit, absent
// from every count and every action.

export interface DevicesCardProps {
  /** Live clock (parent ticks it each second) — drives the humanized ages. */
  now: number;
  loadDevices: () => Promise<CentraidGatewayDevice[]>;
  onRevokeDevice: (
    deviceId: string,
    options?: { confirmLastDevice?: string }
  ) => Promise<{ removed: boolean }>;
  onRenameDevice?: (
    deviceId: string,
    label: string
  ) => Promise<CentraidGatewayDevice>;
  /** Eager local cleanup after this renderer successfully revokes itself. */
  onCurrentDeviceRevoked?: () => Promise<void>;
  /**
   * The caller's own owner row. Optional so a gateway with no owner surface
   * (or a test) still renders — the group then comes from the devices alone.
   */
  loadOwners?: () => Promise<GatewayOwner[]>;
  /**
   * Mint a one-time pairing ticket (`POST _gateway/devices/ticket`). Optional
   * so a host that can't mint (or a test) simply hides "Pair a device".
   */
  onCreateTicket?: (
    input?: GatewayDeviceTicketInput
  ) => Promise<GatewayDeviceTicket>;
  onUpdateCompute?: (
    device: CentraidGatewayDevice,
    contributeWhileCharging: boolean
  ) => Promise<CentraidGatewayDevice>;
  loadWorkStatus?: () => Promise<GatewayDeviceWorkDepth[]>;
}

/** Poll cadence — same order of magnitude as the Backups card. */
const POLL_MS = 15_000;

export default function DevicesCard({
  now,
  loadDevices,
  onRevokeDevice,
  onRenameDevice,
  onCurrentDeviceRevoked,
  loadOwners,
  onCreateTicket,
  onUpdateCompute,
  loadWorkStatus,
}: DevicesCardProps): JSX.Element {
  const [devices, setDevices] = useState<CentraidGatewayDevice[] | null>(null);
  const [owners, setOwners] = useState<GatewayOwner[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [workDepth, setWorkDepth] = useState<GatewayDeviceWorkDepth[]>([]);
  const [pairing, setPairing] = useState(false);
  const [addingPerson, setAddingPerson] = useState(false);
  const mountedRef = useRef(true);

  const refresh = useCallback((): void => {
    loadDevices()
      .then((list) => {
        if (!mountedRef.current) return;
        setDevices(list);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) return;
        setLoadError(error instanceof Error ? error.message : String(error));
      });
    void loadOwners?.()
      .then((list) => {
        if (mountedRef.current) setOwners(list);
      })
      // A roster the gateway won't serve is not fatal: the devices still name
      // their people, so the card degrades to device-derived groups.
      .catch(() => undefined);
    void loadWorkStatus?.()
      .then((depth) => {
        if (mountedRef.current) setWorkDepth(depth);
      })
      // Poll failures are transient; retain the last successful work badge.
      .catch(() => undefined);
  }, [loadDevices, loadOwners, loadWorkStatus]);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    // Suspended while the tab is hidden and caught up on return (issue #659).
    const stop = startVisibilityTicker(refresh, POLL_MS);
    return () => {
      mountedRef.current = false;
      stop();
    };
  }, [refresh]);

  const revoke = useCallback(
    async (
      device: GroupedDevice,
      confirmLastDevice?: string
    ): Promise<void> => {
      // "Revoke device" means the hardware, so every enrollment it holds goes
      // — one per vault it reached. Chained rather than `Promise.all`: the
      // gateway refuses the enrollment that would strand the owner's last
      // device for a vault, and that refusal has to surface before the rest
      // are dropped.
      await device.enrollmentIds.reduce(
        (chain, enrollmentId) =>
          chain.then(async () => {
            await onRevokeDevice(
              enrollmentId,
              confirmLastDevice === undefined
                ? undefined
                : { confirmLastDevice }
            );
          }),
        Promise.resolve()
      );
      if (device.current) await onCurrentDeviceRevoked?.();
      // Optimistically drop the rows; a background refresh reconciles (and
      // brings the tombstone back under the group's revoked disclosure).
      if (mountedRef.current) {
        const dropped = new Set(device.enrollmentIds);
        setDevices(
          (prev) => prev?.filter((d) => !dropped.has(d.deviceId)) ?? prev
        );
      }
      refresh();
    },
    [onCurrentDeviceRevoked, onRevokeDevice, refresh]
  );

  const rename = useCallback(
    async (device: GroupedDevice, label: string): Promise<void> => {
      if (!onRenameDevice) return;
      const updated = await onRenameDevice(device.deviceId, label);
      if (mountedRef.current) {
        setDevices(
          (prev) =>
            prev?.map((row) =>
              row.deviceId === updated.deviceId ? updated : row
            ) ?? prev
        );
      }
    },
    [onRenameDevice]
  );

  const updateCompute = useCallback(
    async (device: GroupedDevice, enabled: boolean): Promise<void> => {
      if (!onUpdateCompute) return;
      const updated = await onUpdateCompute(device, enabled);
      if (!mountedRef.current) return;
      setDevices(
        (previous) =>
          previous?.map((row) =>
            row.deviceId === updated.deviceId ? updated : row
          ) ?? previous
      );
    },
    [onUpdateCompute]
  );

  const groups = useMemo(
    () => groupDevicesByOwner(devices ?? [], owners),
    [devices, owners]
  );

  const people = groups.length;
  // Count hardware, not enrollment rows: a browser paired into two vaults is
  // one device, and counting its rows read as "4 devices" for two.
  const liveCount = groups.reduce(
    (sum, group) => sum + group.devices.length,
    0
  );
  const queued = workDepth.reduce((sum, depth) => sum + depth.available, 0);
  const leased = workDepth.reduce((sum, depth) => sum + depth.leased, 0);

  return (
    <section className={cx(gwStyles.panel, styles.card)}>
      <div className={gwStyles.panelHead}>
        <h2>People &amp; devices</h2>
        <div className={styles.headRight}>
          {devices && people > 0 ? (
            <span className={gwStyles.panelMeta}>
              {people} {people === 1 ? "person" : "people"} · {liveCount} device
              {liveCount === 1 ? "" : "s"}
            </span>
          ) : null}
          {loadWorkStatus ? (
            <span
              className={gwStyles.panelMeta}
              data-testid="device-work-depth"
            >
              {queued} queued · {leased} leased
            </span>
          ) : null}
          {onCreateTicket && !pairing && !addingPerson ? (
            <button
              type="button"
              className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
              onClick={() => setPairing(true)}
            >
              <Icon name="Plus" size={13} />
              <span>Pair a device</span>
            </button>
          ) : null}
          {onCreateTicket && !pairing && !addingPerson ? (
            <button
              type="button"
              className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
              onClick={() => setAddingPerson(true)}
            >
              <Icon name="UserPlus" size={13} />
              <span>Add someone</span>
            </button>
          ) : null}
        </div>
      </div>

      <div className={styles.body}>
        {onCreateTicket && pairing ? (
          <DevicePairPanel
            now={now}
            onCreateTicket={onCreateTicket}
            onClose={() => {
              setPairing(false);
              refresh();
            }}
          />
        ) : null}
        {onCreateTicket && addingPerson ? (
          <DevicePairPanel
            now={now}
            forPerson
            onCreateTicket={onCreateTicket}
            onClose={() => {
              setAddingPerson(false);
              refresh();
            }}
          />
        ) : null}
        {loadError ? (
          <div className={styles.loadError}>
            Couldn’t list paired devices: {loadError}
          </div>
        ) : devices ? (
          groups.length === 0 ? (
            <div className={gwStyles.panelEmpty}>
              No devices are paired with this gateway yet. Pair a browser or
              phone with a one-time ticket, and it will show up here — revocable
              in one click.
            </div>
          ) : (
            <div className={styles.groups}>
              {groups.map((group) => (
                <DeviceOwnerGroup
                  key={group.ownerId}
                  label={group.label}
                  vaults={group.vaults}
                  devices={group.devices}
                  revoked={group.revoked}
                  isSelf={group.isSelf}
                  now={now}
                  onRevokeDevice={revoke}
                  {...(onRenameDevice ? { onRenameDevice: rename } : {})}
                  {...(onUpdateCompute
                    ? { onUpdateCompute: updateCompute }
                    : {})}
                />
              ))}
            </div>
          )
        ) : (
          <div className={gwStyles.panelEmpty}>Checking paired devices…</div>
        )}
      </div>
    </section>
  );
}
