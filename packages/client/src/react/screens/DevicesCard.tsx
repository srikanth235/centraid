import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";

import type {
  CentraidGatewayDevice,
  GatewayDeviceTicket,
  GatewayDeviceTicketInput,
  GatewayDeviceWorkDepth,
  GatewayMember,
} from "../../gateway-client.js";
import { cx } from "../ui/cx.js";
import Icon from "../ui/Icon.js";
import { groupDevicesByMember, vaultsFromGroups } from "./device-groups.js";
import type { GroupedDevice } from "./device-groups.js";
import DeviceMemberGroup from "./DeviceMemberGroup.js";
import DevicePairPanel from "./DevicePairPanel.js";

import controlsCss from "../styles/controls.module.css";
import buttonCss from "../ui/Button.module.css";
import styles from "./DevicesCard.module.css";
import gwStyles from "./GatewayScreen.module.css";

// Gateway → Overview → People & devices: the owner surface over the daemon's
// member roster + `EnrollmentStore` (issues #392, #599).
//
// It is people-first because authority is: a role is authored on a PERSON and
// devices inherit it, so "Priya's phone is admin but her laptop is read-only"
// isn't a state this card can even display. Each group is one person, their
// access in ownership words, and the hardware acting as them.
//
// The two removal verbs are deliberately different affordances:
//   Revoke device  (per row)    — "this phone was stolen". The person keeps
//                                 their access and their other devices.
//   Remove <person> (per group) — "she moved out". One atomic act that drops
//                                 their roles and every device they own.
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
    options?: { confirmLastAdmin?: string }
  ) => Promise<{ removed: boolean }>;
  onRenameDevice?: (
    deviceId: string,
    label: string
  ) => Promise<CentraidGatewayDevice>;
  /** Eager local cleanup after this renderer successfully revokes itself. */
  onCurrentDeviceRevoked?: () => Promise<void>;
  /**
   * The household roster. Optional so a gateway with no member surface (or a
   * test) still renders — the groups then come from the devices alone.
   */
  loadMembers?: () => Promise<GatewayMember[]>;
  /** Remove a PERSON. Absent = the card offers only per-device revocation. */
  onRemoveMember?: (
    memberId: string,
    options?: { confirmLastAdmin?: string }
  ) => Promise<{ removed: boolean }>;
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
  /**
   * Whether the viewer owns any vault here. A read-only member saw live
   * `Revoke device` / `Remove <person>` buttons whose clicks the gateway
   * refused with no feedback (onboarding run B11); the roster now renders
   * read-only rows for them instead.
   */
  canAdminister?: boolean;
}

/** Poll cadence — same order of magnitude as the Backups card. */
const POLL_MS = 15_000;

export default function DevicesCard({
  now,
  loadDevices,
  onRevokeDevice,
  onRenameDevice,
  onCurrentDeviceRevoked,
  loadMembers,
  onRemoveMember,
  onCreateTicket,
  onUpdateCompute,
  loadWorkStatus,
  canAdminister = true,
}: DevicesCardProps): JSX.Element {
  const [devices, setDevices] = useState<CentraidGatewayDevice[] | null>(null);
  const [members, setMembers] = useState<GatewayMember[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [workDepth, setWorkDepth] = useState<GatewayDeviceWorkDepth[]>([]);
  const [pairing, setPairing] = useState(false);
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
    void loadMembers?.()
      .then((list) => {
        if (mountedRef.current) setMembers(list);
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
  }, [loadDevices, loadMembers, loadWorkStatus]);

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
    async (device: GroupedDevice, confirmLastAdmin?: string): Promise<void> => {
      // "Revoke device" means the hardware, so every enrollment it holds goes
      // — one per vault it reached. Chained rather than `Promise.all`: the
      // gateway refuses the enrollment that would strand a vault's last owner,
      // and that refusal has to surface before the rest are dropped.
      await device.enrollmentIds.reduce(
        (chain, enrollmentId) =>
          chain.then(async () => {
            await onRevokeDevice(
              enrollmentId,
              confirmLastAdmin === undefined ? undefined : { confirmLastAdmin }
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

  const removeMember = useCallback(
    async (memberId: string, confirmLastAdmin?: string): Promise<void> => {
      if (!onRemoveMember) return;
      await onRemoveMember(
        memberId,
        confirmLastAdmin === undefined ? undefined : { confirmLastAdmin }
      );
      if (mountedRef.current) {
        setMembers((prev) =>
          prev.filter((member) => member.memberId !== memberId)
        );
        setDevices(
          (prev) =>
            prev?.filter((device) => device.memberId !== memberId) ?? prev
        );
      }
      refresh();
    },
    [onRemoveMember, refresh]
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
    () => groupDevicesByMember(devices ?? [], members),
    [devices, members]
  );
  const vaults = useMemo(() => vaultsFromGroups(groups), [groups]);
  const selfMemberId = groups.find((group) => group.isSelf)?.memberId;

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
          {onCreateTicket && canAdminister && !pairing ? (
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
        {onCreateTicket && canAdminister && pairing ? (
          <DevicePairPanel
            now={now}
            onCreateTicket={onCreateTicket}
            onClose={() => {
              setPairing(false);
              refresh();
            }}
            members={members}
            {...(selfMemberId === undefined
              ? {}
              : { currentMemberId: selfMemberId })}
            vaults={vaults}
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
                <DeviceMemberGroup
                  key={group.memberId}
                  label={group.label}
                  roles={group.roles}
                  devices={group.devices}
                  revoked={group.revoked}
                  isSelf={group.isSelf}
                  now={now}
                  onRevokeDevice={revoke}
                  canAdminister={canAdminister}
                  {...(onRenameDevice ? { onRenameDevice: rename } : {})}
                  {...(onUpdateCompute
                    ? { onUpdateCompute: updateCompute }
                    : {})}
                  {...(onRemoveMember
                    ? {
                        onRemoveMember: (confirmLastAdmin?: string) =>
                          removeMember(group.memberId, confirmLastAdmin),
                      }
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
