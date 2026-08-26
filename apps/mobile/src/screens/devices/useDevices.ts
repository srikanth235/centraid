// Data half of the Devices place (#765).
// A failed roster read is the page's error state — absent plane ≠ empty roster.
// An unmounted vault plane answers undefined: not an error; no section.

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
  message?: string;
  /** This phone is not paired at all; the panel talks pairing. */
  noGateway: boolean;
  devices: DeviceRow[];
  /** `undefined` = no vault plane on this gateway; section omitted. */
  vaults?: VaultRow[];
  ticket?: DeviceTicket;
  busy: boolean;
  refresh: () => Promise<void>;
  mint: () => Promise<void>;
  dismissTicket: () => void;
  rename: (deviceId: string, label: string) => Promise<boolean>;
  /** `"stranded"` = last-device refusal; collect the vault name from the member and retry. */
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
    // Second plane: a gateway may serve devices and no vaults; its failure
    // never fails the roster — the section just does not render.
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
        // Escalate only on the FIRST attempt; a refusal after the member has
        // confirmed the name is about something else.
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
