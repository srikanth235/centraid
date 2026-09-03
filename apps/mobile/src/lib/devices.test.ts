/* oxlint-disable import/first -- vi.mock is hoisted; subject imports intentionally follow */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(import("./gateway") as Promise<unknown>, () => ({
  apiHeaders: (extra?: Record<string, string>) => ({ auth: "1", ...extra }),
  fetchJson: vi.fn<typeof GatewayModule.fetchJson>(),
  listVaults: vi.fn<typeof GatewayModule.listVaults>(),
  requireGatewayBase: vi.fn<typeof GatewayModule.requireGatewayBase>(
    async () => "http://127.0.0.1:9"
  ),
}));

import {
  listDevices,
  listOwnedVaults,
  mintDeviceTicket,
  renameDevice,
  revokeDevice,
} from "./devices";
import type * as GatewayModule from "./gateway";
import { fetchJson } from "./gateway";

const json = vi.mocked(fetchJson);

describe("mobile devices client", () => {
  beforeEach(() => {
    json.mockReset();
  });

  describe(listDevices, () => {
    it("unwraps the roster", async () => {
      json.mockResolvedValue({ devices: [{ deviceId: "d1" }] });
      await expect(listDevices()).resolves.toStrictEqual([{ deviceId: "d1" }]);
      expect(json).toHaveBeenCalledWith(
        "http://127.0.0.1:9/centraid/_gateway/devices",
        { headers: { auth: "1" }, method: "GET" }
      );
    });

    it("reads an absent list as an empty roster", async () => {
      json.mockResolvedValue({});
      await expect(listDevices()).resolves.toStrictEqual([]);
    });

    it("lets a failed read surface — no roster is not an empty roster", async () => {
      json.mockRejectedValue(new Error("Gateway returned HTTP 404"));
      await expect(listDevices()).rejects.toThrow("404");
    });
  });

  describe(mintDeviceTicket, () => {
    it("mints a whole-owner ticket when given nothing", async () => {
      json.mockResolvedValue({ ticket: "t" });
      await mintDeviceTicket();
      expect(json).toHaveBeenCalledWith(
        "http://127.0.0.1:9/centraid/_gateway/devices/ticket",
        {
          body: "{}",
          headers: { auth: "1", "content-type": "application/json" },
          method: "POST",
        }
      );
    });

    it("passes a named vault and ttl through", async () => {
      json.mockResolvedValue({ ticket: "t" });
      await mintDeviceTicket({ ttlMinutes: 10, vaultId: "v1" });
      expect(json).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({ ttlMinutes: 10, vaultId: "v1" }),
        })
      );
    });
  });

  describe(renameDevice, () => {
    it("PATCHes the label and returns the updated row", async () => {
      json.mockResolvedValue({ device: { deviceId: "d 1", label: "Kitchen" } });
      await expect(renameDevice("d 1", "Kitchen")).resolves.toStrictEqual({
        deviceId: "d 1",
        label: "Kitchen",
      });
      expect(json).toHaveBeenCalledWith(
        "http://127.0.0.1:9/centraid/_gateway/devices/d%201",
        {
          body: JSON.stringify({ label: "Kitchen" }),
          headers: { auth: "1", "content-type": "application/json" },
          method: "PATCH",
        }
      );
    });
  });

  describe(revokeDevice, () => {
    it("sends no confirmation when none was typed", async () => {
      json.mockResolvedValue({ removed: true });
      await expect(revokeDevice("d1")).resolves.toStrictEqual({
        removed: true,
      });
      expect(json).toHaveBeenCalledWith(
        "http://127.0.0.1:9/centraid/_gateway/devices/d1",
        {
          body: "{}",
          headers: { auth: "1", "content-type": "application/json" },
          method: "DELETE",
        }
      );
    });

    it("echoes the vault name back for a last-device revoke", async () => {
      json.mockResolvedValue({ removed: true });
      await revokeDevice("d1", "Home");
      expect(json).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({ confirmLastDevice: "Home" }),
        })
      );
    });
  });

  describe(listOwnedVaults, () => {
    it("wraps the app's existing listing, keeping its no-vault-plane answer", async () => {
      const gateway = await import("./gateway");
      const vaults = vi.mocked(gateway.listVaults);
      vaults.mockResolvedValueOnce([
        { name: "Home", ownerPartyId: "p1", vaultId: "v1" },
      ]);
      await expect(listOwnedVaults()).resolves.toStrictEqual([
        { name: "Home", ownerPartyId: "p1", vaultId: "v1" },
      ]);
      vaults.mockResolvedValueOnce(undefined);
      await expect(listOwnedVaults()).resolves.toBeUndefined();
    });
  });
});
