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
import Button from "../ui/Button.js";
import NoteBlock from "../ui/NoteBlock.js";
import { groupDevicesByOwner } from "./device-groups.js";
import type { GroupedDevice, OwnerGroup } from "./device-groups.js";
import DeviceOwnerGroup from "./DeviceOwnerGroup.js";
import DevicePairPanel from "./DevicePairPanel.js";

import styles from "./HouseholdScreen.module.css";

// Devices → the roster half of the page (issues #392, #726; v9 shape #765).
//
// It is people-first because a device is always somebody's. A vault has
// exactly one owner and a device caller sees only its own owner's roster row,
// so the block this page almost always renders is the caller's own — "Yours" —
// and "Other people" appears only on a gateway that really does hold more than
// one person's hardware.
//
// "Revoke device" ("this phone was stolen") is the only removal verb offered
// — removing the PERSON is a host-custody act on this machine
// (`owners-routes.ts`), never reachable from a device-token client.
//
// "Add someone" (#726 P1) mints a NEW person a vault of their own, hosted on
// this machine, then shows the SAME ticket panel "Pair a device" renders — the
// two entry points open one `DevicePairPanel`, one self-paired and one
// `forPerson`, rather than two implementations of a ticket screen.
//
// The data half lives in `useDeviceRoster` rather than in this component: the
// page's app-bar count line and status line are published from the counts, and
// the frame renders ABOVE the outlet, so the screen — not a card inside it —
// has to be the thing that holds them.

/** Poll cadence — same order of magnitude as the Backups card. */
const POLL_MS = 15_000;

export interface DeviceRosterWiring {
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
  onUpdateCompute?: (
    device: CentraidGatewayDevice,
    contributeWhileCharging: boolean
  ) => Promise<CentraidGatewayDevice>;
  loadWorkStatus?: () => Promise<GatewayDeviceWorkDepth[]>;
}

export interface DeviceRoster {
  status: "loading" | "ready" | "error";
  /** The message the gateway (or the network) gave, in the error state. */
  error: string | null;
  /** The caller's own person, when any device names them. */
  self?: OwnerGroup;
  /** Everyone else with hardware on this gateway — usually nobody. */
  others: OwnerGroup[];
  /** Live hardware, counted once per device rather than per enrollment. */
  deviceCount: number;
  personCount: number;
  /** Work the gateway has queued for contributing devices. `hasWork` is false
   *  on a host with no work plane at all, which is not the same as a plane
   *  with nothing in it. */
  hasWork: boolean;
  queued: number;
  leased: number;
  refresh: () => void;
  revoke: (device: GroupedDevice, confirmLastDevice?: string) => Promise<void>;
  rename: (device: GroupedDevice, label: string) => Promise<void>;
  updateCompute: (device: GroupedDevice, enabled: boolean) => Promise<void>;
  canRename: boolean;
  canCompute: boolean;
}

/** The roster's data half: one poll, and the three writes a device answers to. */
export function useDeviceRoster(wiring: DeviceRosterWiring): DeviceRoster {
  const {
    loadDevices,
    loadOwners,
    loadWorkStatus,
    onRevokeDevice,
    onRenameDevice,
    onCurrentDeviceRevoked,
    onUpdateCompute,
  } = wiring;
  const [devices, setDevices] = useState<CentraidGatewayDevice[] | null>(null);
  const [owners, setOwners] = useState<GatewayOwner[]>([]);
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
      .catch((error: unknown) => {
        if (!mountedRef.current) return;
        setLoadError(error instanceof Error ? error.message : String(error));
      });
    void loadOwners?.()
      .then((list) => {
        if (mountedRef.current) setOwners(list);
      })
      // A roster the gateway won't serve is not fatal: the devices still name
      // their people, so the page degrades to device-derived groups.
      .catch(() => undefined);
    void loadWorkStatus?.()
      .then((depth) => {
        if (mountedRef.current) setWorkDepth(depth);
      })
      // Poll failures are transient; retain the last successful work figure.
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
      // brings the tombstone back at the foot of its block).
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

  // `isSelf` is set by the device making the request; an admin caller sees no
  // such row, so the first group (already sorted self-first) stands in as the
  // one whose devices these are.
  const self = groups.find((group) => group.isSelf) ?? groups[0];
  const others = groups.filter((group) => group !== self);
  return {
    canCompute: onUpdateCompute !== undefined,
    canRename: onRenameDevice !== undefined,
    // Count hardware, not enrollment rows: a browser paired into two vaults is
    // one device, and counting its rows read as "4 devices" for two.
    deviceCount: groups.reduce((sum, group) => sum + group.devices.length, 0),
    error: loadError,
    hasWork: loadWorkStatus !== undefined,
    leased: workDepth.reduce((sum, depth) => sum + depth.leased, 0),
    others,
    personCount: groups.length,
    queued: workDepth.reduce((sum, depth) => sum + depth.available, 0),
    refresh,
    rename,
    revoke,
    status: loadError ? "error" : devices ? "ready" : "loading",
    updateCompute,
    ...(self ? { self } : {}),
  };
}

export interface DevicesCardProps {
  roster: DeviceRoster;
  /** Live clock (parent ticks it each second) — drives the humanized ages. */
  now: number;
  /**
   * Mint a one-time pairing ticket (`POST _gateway/devices/ticket`). Absent on
   * a host that can't mint, which withdraws both pairing entry points.
   */
  onCreateTicket?: (
    input?: GatewayDeviceTicketInput
  ) => Promise<GatewayDeviceTicket>;
  /** The page's "Pair a device" commit lives in the app bar, so the panel it
   *  opens is controlled from the screen rather than owned here. */
  pairing?: boolean;
  onPairingChange?: (open: boolean) => void;
}

/** The roster's view half: "Yours", then everyone else, then the rule. */
export default function DevicesCard({
  roster,
  now,
  onCreateTicket,
  pairing = false,
  onPairingChange,
}: DevicesCardProps): JSX.Element {
  const [addingPerson, setAddingPerson] = useState(false);
  const actions = {
    ...(roster.canRename ? { onRename: roster.rename } : {}),
    ...(roster.canCompute ? { onUpdateCompute: roster.updateCompute } : {}),
    onRevoke: roster.revoke,
  };
  const others = roster.others.filter((group) => group.devices.length > 0);
  const otherDevices = others.flatMap((group) => group.devices);
  const otherRevoked = others.flatMap((group) => group.revoked);
  return (
    <>
      {onCreateTicket && pairing ? (
        <DevicePairPanel
          now={now}
          onCreateTicket={onCreateTicket}
          onClose={() => {
            onPairingChange?.(false);
            roster.refresh();
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
            roster.refresh();
          }}
        />
      ) : null}

      {/* A block with no rows is an empty scaffold, not a section: on a
          gateway with nothing paired the page's empty state says so instead. */}
      {roster.self &&
      roster.self.devices.length + roster.self.revoked.length > 0 ? (
        <DeviceOwnerGroup
          devices={roster.self.devices}
          label="Yours"
          now={now}
          revoked={roster.self.revoked}
          {...actions}
        />
      ) : null}

      {otherDevices.length > 0 ? (
        <>
          <DeviceOwnerGroup
            devices={otherDevices}
            label="Other people"
            now={now}
            revoked={otherRevoked}
            showOwner
            {...actions}
          />
          <NoteBlock>
            A person on your gateway reaches only what you placed in a shared
            space.
          </NoteBlock>
        </>
      ) : null}

      {roster.hasWork ? (
        <NoteBlock>
          <span data-testid="device-work-depth">
            {roster.queued} queued · {roster.leased} leased
          </span>{" "}
          — indexing work these devices may pick up while charging.
        </NoteBlock>
      ) : null}

      {onCreateTicket && !pairing && !addingPerson ? (
        <p className={styles.asideAction}>
          {/* Not a second commit: "Pair a device" is the page's one filled
              verb and it lives in the app bar. This mints a NEW person, which
              is a different act and a rarer one. */}
          <Button
            commit={false}
            label="Add someone"
            onClick={() => setAddingPerson(true)}
            size="sm"
            variant="secondary"
          />
        </p>
      ) : null}
    </>
  );
}
