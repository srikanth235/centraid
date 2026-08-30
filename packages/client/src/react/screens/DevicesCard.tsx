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

// Devices roster (#392, #726; v9 #765). People-first: a device is always
// somebody's. "Revoke device" is the only removal verb — removing the PERSON
// is host-custody (`owners-routes.ts`), never a device-token client. "Add
// someone" (#726) mints a NEW person then the SAME `DevicePairPanel` as "Pair
// a device". Data lives in `useDeviceRoster`.

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
  onCurrentDeviceRevoked?: () => Promise<void>;
  loadOwners?: () => Promise<GatewayOwner[]>;
  onUpdateCompute?: (
    device: CentraidGatewayDevice,
    contributeWhileCharging: boolean
  ) => Promise<CentraidGatewayDevice>;
  loadWorkStatus?: () => Promise<GatewayDeviceWorkDepth[]>;
}

export interface DeviceRoster {
  status: "loading" | "ready" | "error";
  error: string | null;
  self?: OwnerGroup;
  others: OwnerGroup[];
  deviceCount: number;
  personCount: number;
  /** `hasWork` is false on a host with no work plane at all, which is not
   *  the same as a plane with nothing in it. */
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
      // A roster the gateway won't serve is not fatal: the page degrades to
      // device-derived groups.
      .catch(() => undefined);
    void loadWorkStatus?.()
      .then((depth) => {
        if (mountedRef.current) setWorkDepth(depth);
      })
      // Poll failures are transient; keep the last good work figure.
      .catch(() => undefined);
  }, [loadDevices, loadOwners, loadWorkStatus]);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    // Suspended while the tab is hidden, caught up on return (#659).
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
      // Hardware revoke: every enrollment it holds goes. Chained, not
      // `Promise.all`: the gateway refuses the enrollment that would strand the
      // owner's last device for a vault, and that refusal must surface first.
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

  // `isSelf` is set by the requesting device; an admin caller sees no such row,
  // so the first group (already sorted self-first) stands in.
  const self = groups.find((group) => group.isSelf) ?? groups[0];
  const others = groups.filter((group) => group !== self);
  return {
    canCompute: onUpdateCompute !== undefined,
    canRename: onRenameDevice !== undefined,
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
  now: number;
  /** What revoking a device can promise, in the VAULT'S words (#883). Absent
   *  when the wire did not say — never written by this surface. */
  boundaryPromise?: string;
  onCreateTicket?: (
    input?: GatewayDeviceTicketInput
  ) => Promise<GatewayDeviceTicket>;
  pairing?: boolean;
  onPairingChange?: (open: boolean) => void;
}

export default function DevicesCard({
  roster,
  now,
  boundaryPromise,
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

      {/* Empty scaffold is not a section: the page empty state says so. */}
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
            A person on your vault host reaches only what you placed in a shared
            space.
          </NoteBlock>
        </>
      ) : null}

      {boundaryPromise ? (
        <NoteBlock>
          <span data-testid="device-boundary-promise">{boundaryPromise}</span>
        </NoteBlock>
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
              verb in the app bar. This mints a NEW person. */}
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
