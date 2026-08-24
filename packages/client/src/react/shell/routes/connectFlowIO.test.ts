/* oxlint-disable import/first -- vi.mock is hoisted; subject imports intentionally follow */
/**
 * Connect flow IO error folding (issue #545 B8).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const listVaults = vi.fn<typeof TypeImport_1gl5zx7.listVaults>();
const connectGateway = vi.fn<typeof TypeImport_1fv8ovv.connectGateway>();
const friendlyGatewayError = vi.fn<
  typeof TypeImport_1fv8ovv.friendlyGatewayError
>((error, message) => message || error);

vi.mock(import("../../../gateway-client.js"), () => ({
  listVaults: () => listVaults(),
}));

vi.mock(import("./gatewayModals.js"), () => ({
  connectGateway: (input) => connectGateway(input),
  friendlyGatewayError: (error, message) =>
    friendlyGatewayError(error, message),
}));

import type * as TypeImport_1gl5zx7 from "../../../gateway-client.js";
import {
  commitConnectFlow,
  connectFreshLocalGateway,
  loadLocalVaults,
  runConnectivityTest,
} from "./connectFlowIO.js";
import type * as TypeImport_1fv8ovv from "./gatewayModals.js";

describe("connectFlowIO scenarios", () => {
  beforeEach(() => {
    listVaults.mockReset();
    connectGateway.mockReset();
    window.CentraidApi = {
      getSettings: vi
        .fn<(...args: unknown[]) => unknown>()
        .mockResolvedValue({ activeGatewayId: "local" }),
      setActiveGateway: vi
        .fn<(...args: unknown[]) => unknown>()
        .mockResolvedValue(undefined),
      createVault: vi
        .fn<(...args: unknown[]) => unknown>()
        .mockResolvedValue({ vaultId: "v-new", name: "New" }),
      setActiveVault: vi
        .fn<(...args: unknown[]) => unknown>()
        .mockResolvedValue(undefined),
    } as unknown as typeof window.CentraidApi;
  });

  describe(runConnectivityTest, () => {
    it("fails closed when bridge is missing", async () => {
      window.CentraidApi = {} as typeof window.CentraidApi;
      const report = await runConnectivityTest({
        method: "gateway",
        url: "http://x",
      } as never);
      expect(report.ok).toBe(false);
      expect(report.error).toBe("unavailable");
    });

    it("folds bridge throw into unreachable reach stage", async () => {
      window.CentraidApi = {
        testGatewayConnection: vi
          .fn<(...args: unknown[]) => unknown>()
          .mockRejectedValue(new Error("ECONNREFUSED")),
      } as unknown as typeof window.CentraidApi;
      const report = await runConnectivityTest({
        method: "gateway",
        url: "http://x",
      } as never);
      expect(report.ok).toBe(false);
      expect(report.error).toBe("unreachable");
      expect(report.stages?.[0]?.detail).toMatch(/ECONNREFUSED/u);
    });

    it("returns bridge report on success", async () => {
      const ok = {
        ok: true,
        stages: [{ id: "reach", label: "Reach gateway", status: "ok" }],
        vaults: [],
      };
      window.CentraidApi = {
        testGatewayConnection: vi
          .fn<(...args: unknown[]) => unknown>()
          .mockResolvedValue(ok),
      } as unknown as typeof window.CentraidApi;
      await expect(
        runConnectivityTest({ method: "gateway", url: "http://x" } as never)
      ).resolves.toStrictEqual(ok);
    });
  });

  describe("loadLocalVaults / commitConnectFlow", () => {
    it("maps listVaults rows on a successful read", async () => {
      listVaults.mockResolvedValue([
        {
          color: "#fff",
          icon: "Folder",
          name: "Home",
          ownerPartyId: "party-1",
          vaultId: "v1",
        },
      ]);
      await expect(loadLocalVaults()).resolves.toStrictEqual({
        ok: true,
        vaults: [
          { vaultId: "v1", name: "Home", color: "#fff", icon: "Folder" },
        ],
      });
    });

    // Issue #603 W4: an unreachable gateway must not fold into an empty list,
    // which the UI would render as "no vaults here" and offer to create one
    // against. Failure must stay distinguishable from an empty registry.
    it("reports a transport failure instead of an empty list", async () => {
      listVaults.mockRejectedValue(new Error("down"));
      const result = await loadLocalVaults();
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.message).toMatch(/down/u);
    });

    it("reports a gateway with no vault route as a failure too", async () => {
      listVaults.mockResolvedValue(undefined);
      expect((await loadLocalVaults()).ok).toBe(false);
    });

    it("an empty-but-readable registry is a success with zero vaults", async () => {
      listVaults.mockResolvedValue([]);
      await expect(loadLocalVaults()).resolves.toStrictEqual({
        ok: true,
        vaults: [],
      });
    });

    it("connectFreshLocalGateway addresses the auto-founded Personal vault", async () => {
      listVaults.mockResolvedValue([
        {
          ownerPartyId: "party-1",
          vaultId: "shared",
          name: "Shared",
        },
        {
          ownerPartyId: "party-1",
          vaultId: "personal",
          name: "Personal",
        },
      ]);
      await expect(connectFreshLocalGateway()).resolves.toStrictEqual({
        displayLabel: "This Mac",
        gatewayId: "local",
        vaultId: "personal",
      });
      expect(window.CentraidApi.setActiveVault).toHaveBeenCalledWith({
        vaultId: "personal",
      });
    });

    it("connectFreshLocalGateway finds the owner's vault by its marker after a rename", async () => {
      listVaults.mockResolvedValue([
        {
          ownerPartyId: "party-1",
          vaultId: "shared",
          name: "Shared",
        },
        {
          ownerPartyId: "party-1",
          vaultId: "personal",
          name: "Ada",
          personal: true,
        },
      ]);
      await expect(connectFreshLocalGateway()).resolves.toStrictEqual({
        displayLabel: "This Mac",
        gatewayId: "local",
        vaultId: "personal",
      });
    });

    // Issue #603 C10: a reinstall over data founded before the `personal`
    // marker has no "Personal" vault either — it was renamed on the first
    // first-run — and `vaults[0]` is the OLDEST vault, i.e. "Shared". Entering
    // there is fine; onboarding never renames it or any other vault.
    it("connectFreshLocalGateway enters the oldest fallback vault", async () => {
      listVaults.mockResolvedValue([
        {
          ownerPartyId: "party-1",
          vaultId: "shared",
          name: "Shared",
        },
        {
          ownerPartyId: "party-1",
          vaultId: "ada",
          name: "Ada",
        },
      ]);
      await expect(connectFreshLocalGateway()).resolves.toStrictEqual({
        displayLabel: "This Mac",
        gatewayId: "local",
        vaultId: "shared",
      });
    });

    it("connectFreshLocalGateway surfaces an unreachable gateway", async () => {
      listVaults.mockRejectedValue(new Error("ECONNREFUSED"));
      await expect(connectFreshLocalGateway()).rejects.toThrow(/ECONNREFUSED/u);
    });

    it("rejects commit without a method or vault choice", async () => {
      await expect(
        commitConnectFlow({ method: null } as never)
      ).rejects.toThrow(/No connection method/u);
      await expect(
        commitConnectFlow({ method: "local", vaultChoice: null } as never)
      ).rejects.toThrow(/Pick or create/u);
    });
  });
});
