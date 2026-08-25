// The Devices place's data half (#765).
//
// Shape follows `apps/automations/useAutomations.ts`: an explicit state union
// rather than try/catch soup, a loader that lives outside the hook so it
// closes over nothing but the setters, and writes that report through the
// app's one feedback channel (`postStatus`) instead of inventing a second.
//
// Two facts the roster read and the vault read do NOT share:
//  - a failed roster read is the page's error state (`listDevices` throws when
//    the gateway serves no device plane at all — an absent plane and an empty
//    roster are different sentences, and the screen says which),
//  - a vault plane that is simply not mounted answers `undefined`, which is
//    not an error and not "you own none": the section does not render.

import { useCallback, useEffect, useState } from "react";

import { postStatus } from "../../kit/components/status-line";
import {
  listDevices,
  listOwnedVaults,
  mintDeviceTicket,
  renameDevice,
  revokeDevice,
} from "../../lib/devices";
import type { DeviceRow, DeviceTicket } from "../../lib/devices";
import { resolveGatewayBase } from "../../lib/gateway";
import type { VaultRow } from "../../lib/gateway";
import { isLastDeviceRefusal, memberDeviceError } from "./devices-model";

export interface DevicesData {
  status: "loading" | "ready" | "error";
  /** What the gateway (or the link) said, in the error state. */
  message?: string;
  /** True when this phone is not paired at all — the error panel then talks
   *  about pairing rather than about an unanswered request. */
  noGateway: boolean;
  devices: DeviceRow[];
  /** `undefined` = no vault plane on this gateway; the section is omitted. */
  vaults?: VaultRow[];
  /** The one ticket this phone has minted and nobody has redeemed yet. */
  ticket?: DeviceTicket;
  busy: boolean;
  refresh: () => Promise<void>;
  mint: () => Promise<void>;
  dismissTicket: () => void;
  rename: (deviceId: string, label: string) => Promise<boolean>;
  /**
   * Revoke one device. Resolves to `"stranded"` when the gateway refused
   * because this is the last live device for a vault — the caller then has to
   * collect the vault's own name FROM THE MEMBER and call again with it.
   */
  revoke: (
    deviceId: string,
    confirmVaultName?: string
  ) => Promise<"done" | "stranded" | "failed">;
}

interface Loaded {
  status: "loading" | "ready" | "error";
  message?: string;
  noGateway: boolean;
  devices: DeviceRow[];
  vaults?: VaultRow[];
}

const START: Loaded = { devices: [], noGateway: false, status: "loading" };

async function loadRoster(set: (next: Loaded) => void): Promise<void> {
  try {
    const base = await resolveGatewayBase();
    if (!base) {
      set({ devices: [], noGateway: true, status: "error" });
      return;
    }
    const devices = await listDevices();
    // The vault registry is a SECOND plane: a gateway can serve devices and no
    // vaults. Its failure never fails the roster — the section just does not
    // render, exactly as an unmounted plane does.
    const vaults = await listOwnedVaults().catch(() => undefined);
    set({
      devices,
      noGateway: false,
      status: "ready",
      ...(vaults ? { vaults } : {}),
    });
  } catch (error) {
    set({
      devices: [],
      message: memberDeviceError(error, "Could not read the devices."),
      noGateway: false,
      status: "error",
    });
  }
}

export function useDevices(): DevicesData {
  const [loaded, setLoaded] = useState<Loaded>(START);
  const [ticket, setTicket] = useState<DeviceTicket | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadRoster(setLoaded);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    await loadRoster(setLoaded);
  }, []);

  const mint = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      setTicket(await mintDeviceTicket());
    } catch (error) {
      postStatus(
        memberDeviceError(
          error,
          "The home machine could not mint a pairing ticket."
        )
      );
    } finally {
      setBusy(false);
    }
  }, []);

  const dismissTicket = useCallback((): void => setTicket(undefined), []);

  const rename = useCallback(
    async (deviceId: string, label: string): Promise<boolean> => {
      setBusy(true);
      try {
        const updated = await renameDevice(deviceId, label);
        setLoaded((prev) => ({
          ...prev,
          devices: prev.devices.map((device) =>
            device.deviceId === deviceId ? updated : device
          ),
        }));
        return true;
      } catch (error) {
        postStatus(memberDeviceError(error, "The device was not renamed."));
        return false;
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const revoke = useCallback(
    async (
      deviceId: string,
      confirmVaultName?: string
    ): Promise<"done" | "stranded" | "failed"> => {
      setBusy(true);
      try {
        await revokeDevice(deviceId, confirmVaultName);
        await loadRoster(setLoaded);
        return "done";
      } catch (error) {
        // Only the FIRST attempt escalates: once the member has typed the
        // vault's name and the gateway still refuses, the refusal is about
        // something else and reads as one.
        if (confirmVaultName === undefined && isLastDeviceRefusal(error)) {
          return "stranded";
        }
        postStatus(memberDeviceError(error, "The device was not revoked."));
        return "failed";
      } finally {
        setBusy(false);
      }
    },
    []
  );

  return {
    busy,
    devices: loaded.devices,
    dismissTicket,
    mint,
    noGateway: loaded.noGateway,
    refresh,
    rename,
    revoke,
    status: loaded.status,
    ...(loaded.message === undefined ? {} : { message: loaded.message }),
    ...(loaded.vaults === undefined ? {} : { vaults: loaded.vaults }),
    ...(ticket === undefined ? {} : { ticket }),
  };
}
