/* oxlint-disable import/first -- vi.mock is hoisted; subject imports intentionally follow */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as GatewayClient from "../../../gateway-client.js";

const listVaults = vi.fn<typeof GatewayClient.listVaults>();

vi.mock(import("../../../gateway-client.js"), () => ({
  listVaults: () => listVaults(),
}));

import {
  loadActiveVaultData,
  loadSettingsStamp,
  phoneCallbacks,
} from "./settingsAccountData.js";

describe("settingsAccountData", () => {
  beforeEach(() => {
    listVaults.mockReset();
    window.CentraidApi = {
      getGatewayAuth: vi
        .fn<() => Promise<{ vaultId: string }>>()
        .mockResolvedValue({
          vaultId: "v1",
        }),
      listGateways: vi
        .fn<typeof window.CentraidApi.listGateways>()
        .mockResolvedValue([]),
      beginPhonePairing: vi.fn<typeof window.CentraidApi.beginPhonePairing>(),
      onPhonePaired: vi.fn<typeof window.CentraidApi.onPhonePaired>(
        () => () => undefined
      ),
      cancelPhonePairing: vi.fn<typeof window.CentraidApi.cancelPhonePairing>(),
      getPhoneLinkStatus: vi.fn<typeof window.CentraidApi.getPhoneLinkStatus>(),
      revokePhoneDevice: vi.fn<typeof window.CentraidApi.revokePhoneDevice>(),
    } as unknown as typeof window.CentraidApi;
  });

  describe(loadSettingsStamp, () => {
    it("states the running build and the gateway it is talking to", async () => {
      window.CentraidApi.getChangelog = () =>
        Promise.resolve({ currentVersion: "v0.6.0", releases: [] });
      window.CentraidApi.getGatewayAuth = () =>
        Promise.resolve({ baseUrl: "http://home-gateway.local:4319" });
      await expect(loadSettingsStamp()).resolves.toBe(
        "Centraid 0.6.0 · home-gateway.local:4319"
      );
    });

    it("omits what this build cannot answer for rather than inventing it", async () => {
      window.CentraidApi.getChangelog = undefined;
      window.CentraidApi.getGatewayAuth = () =>
        Promise.reject(new Error("no gateway"));
      await expect(loadSettingsStamp()).resolves.toBe("Centraid");
    });
  });

  describe(loadActiveVaultData, () => {
    it("returns null when no active vault is found", async () => {
      listVaults.mockResolvedValue([]);
      await expect(loadActiveVaultData()).resolves.toBeNull();
    });

    it("maps the active vault and deletable when more than one vault exists", async () => {
      listVaults.mockResolvedValue([
        {
          vaultId: "v1",
          name: "Home",
          ownerPartyId: "p1",
          icon: "Folder",
          color: "#111",
          blurb: "b",
        },
        {
          vaultId: "v2",
          name: "Work",
          ownerPartyId: "p1",
          icon: "Briefcase",
          color: "#222",
        },
      ]);
      await expect(loadActiveVaultData()).resolves.toStrictEqual({
        vaultId: "v1",
        name: "Home",
        icon: "Folder",
        color: "#111",
        blurb: "b",
        deletable: true,
      });
    });

    it("marks the sole vault non-deletable", async () => {
      listVaults.mockResolvedValue([
        {
          vaultId: "v1",
          name: "Only",
          ownerPartyId: "p1",
          icon: "Folder",
          color: "#111",
        },
      ]);
      const data = await loadActiveVaultData();
      expect(data?.deletable).toBe(false);
    });

    describe("remote connection", () => {
      const twoVaults = [
        {
          vaultId: "v1",
          name: "Work",
          ownerPartyId: "p1",
          icon: "Folder" as const,
          color: "#111",
        },
        {
          vaultId: "v2",
          name: "Family",
          ownerPartyId: "p1",
          icon: "Folder" as const,
          color: "#222",
        },
      ];
      const withGateway = (kind: "local" | "remote"): void => {
        vi.spyOn(window.CentraidApi, "getGatewayAuth").mockResolvedValue({
          gatewayId: "office",
          vaultId: "v1",
        } as Awaited<ReturnType<typeof window.CentraidApi.getGatewayAuth>>);
        vi.spyOn(window.CentraidApi, "listGateways").mockResolvedValue([
          { id: "office", kind, label: "Office" },
        ] as Awaited<ReturnType<typeof window.CentraidApi.listGateways>>);
      };

      it("names every sibling vault the connection also serves", async () => {
        listVaults.mockResolvedValue(twoVaults);
        withGateway("remote");
        const data = await loadActiveVaultData();
        expect(data?.connection).toStrictEqual({
          gatewayId: "office",
          siblingNames: ["Family"],
        });
      });

      it("offers nothing to disconnect on the primordial local host", async () => {
        listVaults.mockResolvedValue(twoVaults);
        withGateway("local");
        const data = await loadActiveVaultData();
        expect(data?.connection).toBeUndefined();
      });
    });
  });

  describe(phoneCallbacks, () => {
    it("phone loadStatus maps devices; revoke folds missing result to false", async () => {
      const toast = vi.fn<Parameters<typeof phoneCallbacks>[0]>();
      const phone = phoneCallbacks(toast);
      (
        window.CentraidApi.getPhoneLinkStatus as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        running: true,
        error: null,
        devices: [
          {
            deviceId: "d1",
            name: "Phone",
            platform: "ios",
            endpointId: "e1",
            addedAt: 1,
          },
        ],
      });
      await expect(phone.loadStatus()).resolves.toMatchObject({
        running: true,
        devices: [{ deviceId: "d1", name: "Phone" }],
      });

      (
        window.CentraidApi.revokePhoneDevice as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        removed: true,
      });
      await expect(phone.revoke("d1")).resolves.toBe(true);
      (
        window.CentraidApi.revokePhoneDevice as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new Error("x"));
      await expect(phone.revoke("d1")).resolves.toBe(false);
    });
  });
});
