/* oxlint-disable max-classes-per-file -- mock error constructors for gateway-client */
/* oxlint-disable import/first -- vi.mock is hoisted; subject imports intentionally follow */
/**
 * Settings storage data layer (issue #545 B8).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  listStorageConnections,
  gwCreateStorageConnection,
  gwDeleteStorageConnection,
  gwTestStorageConnection,
  confirmGatewayRecoveryKit,
  getVaultBlobStore,
  attachVaultStorageConnection,
  detachVaultStorageConnection,
  RecoveryKitNotConfirmedError,
  ProviderNotHomeProfileError,
} = vi.hoisted(() => {
  class MockRecoveryKitNotConfirmedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "MockRecoveryKitNotConfirmedError";
    }
  }
  class MockProviderNotHomeProfileError extends Error {
    readonly missingCapabilities: string[];
    constructor(message: string, missingCapabilities: string[]) {
      super(message);
      this.name = "MockProviderNotHomeProfileError";
      this.missingCapabilities = missingCapabilities;
    }
  }
  return {
    listStorageConnections:
      vi.fn<typeof TypeImport_1gl5zx7.listStorageConnections>(),
    gwCreateStorageConnection:
      vi.fn<typeof TypeImport_1gl5zx7.createStorageConnection>(),
    gwDeleteStorageConnection:
      vi.fn<typeof TypeImport_1gl5zx7.deleteStorageConnection>(),
    gwTestStorageConnection:
      vi.fn<typeof TypeImport_1gl5zx7.testStorageConnection>(),
    confirmGatewayRecoveryKit:
      vi.fn<typeof TypeImport_1gl5zx7.confirmGatewayRecoveryKit>(),
    getVaultBlobStore: vi.fn<typeof TypeImport_1gl5zx7.getVaultBlobStore>(),
    attachVaultStorageConnection:
      vi.fn<typeof TypeImport_1gl5zx7.attachVaultStorageConnection>(),
    detachVaultStorageConnection:
      vi.fn<typeof TypeImport_1gl5zx7.detachVaultStorageConnection>(),
    RecoveryKitNotConfirmedError: MockRecoveryKitNotConfirmedError,
    ProviderNotHomeProfileError: MockProviderNotHomeProfileError,
  };
});

vi.mock(import("../../../gateway-client.js"), () => ({
  listStorageConnections,
  createStorageConnection: gwCreateStorageConnection,
  deleteStorageConnection: gwDeleteStorageConnection,
  testStorageConnection: gwTestStorageConnection,
  confirmGatewayRecoveryKit,
  getVaultBlobStore,
  attachVaultStorageConnection,
  detachVaultStorageConnection,
  ProviderNotHomeProfileError,
  RecoveryKitNotConfirmedError,
}));

import type * as TypeImport_1gl5zx7 from "../../../gateway-client.js";
/* oxlint-disable-next-line import/first -- subject under test after vi.mock (hoisted) */
import {
  attachVaultConnection,
  createStorageConnection,
  detachVaultConnection,
  loadStorageConnectionsData,
  loadVaultBlobStoreData,
  makeDeleteStorageConnection,
} from "./settingsStorageData.js";

describe("settingsStorageData", () => {
  beforeEach(() => {
    listStorageConnections.mockReset();
    gwCreateStorageConnection.mockReset();
    gwDeleteStorageConnection.mockReset();
    getVaultBlobStore.mockReset();
    attachVaultStorageConnection.mockReset();
    detachVaultStorageConnection.mockReset();
  });

  describe("settingsStorageData", () => {
    it("loadStorageConnectionsData maps rows", async () => {
      listStorageConnections.mockResolvedValue([
        {
          id: "c1",
          name: "Home",
          baseUrl: "https://p",
          kind: "provider",
          createdAt: "2026-07-28T00:00:00.000Z",
          updatedAt: "2026-07-28T00:00:00.000Z",
        },
        {
          id: "c2",
          name: "Other",
          kind: "provider",
          createdAt: "2026-07-28T00:00:00.000Z",
          updatedAt: "2026-07-28T00:00:00.000Z",
        },
      ]);
      await expect(loadStorageConnectionsData()).resolves.toStrictEqual([
        { id: "c1", name: "Home", baseUrl: "https://p" },
        { id: "c2", name: "Other" },
      ]);
    });

    it("createStorageConnection maps recovery-kit and home-profile errors", async () => {
      gwCreateStorageConnection.mockRejectedValueOnce(
        new RecoveryKitNotConfirmedError("kit")
      );
      await expect(
        createStorageConnection({ name: "n", baseUrl: "u", apiKey: "k" })
      ).resolves.toStrictEqual({
        ok: false,
        code: "recovery_kit_not_confirmed",
        message: "kit",
      });

      gwCreateStorageConnection.mockRejectedValueOnce(
        new ProviderNotHomeProfileError("nope", ["cas", "policy"])
      );
      const home = await createStorageConnection({
        name: "n",
        baseUrl: "u",
        apiKey: "k",
      });
      expect(home.ok).toBe(false);
      if (home.ok) return;
      expect(home.message).toMatch(/cas, policy/u);

      gwCreateStorageConnection.mockResolvedValueOnce({
        id: "c1",
        name: "n",
        baseUrl: "u",
        kind: "provider",
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:00.000Z",
      });
      await expect(
        createStorageConnection({ name: "n", baseUrl: "u", apiKey: "k" })
      ).resolves.toStrictEqual({
        ok: true,
        value: { id: "c1", name: "n", baseUrl: "u" },
      });
    });

    it("makeDeleteStorageConnection respects confirm cancel and deletes on confirm", async () => {
      const del = makeDeleteStorageConnection(async () => false);
      await del("c1", "Home");
      expect(gwDeleteStorageConnection).not.toHaveBeenCalled();

      const del2 = makeDeleteStorageConnection(async () => true);
      await del2("c1", "Home");
      expect(gwDeleteStorageConnection).toHaveBeenCalledWith("c1");
    });

    it("loadVaultBlobStoreData / attach / detach map fs vs s3", async () => {
      getVaultBlobStore.mockResolvedValue({ kind: "fs" });
      await expect(loadVaultBlobStoreData()).resolves.toStrictEqual({
        kind: "fs",
      });

      getVaultBlobStore.mockResolvedValue({ kind: "s3", connectionId: "c1" });
      await expect(loadVaultBlobStoreData()).resolves.toStrictEqual({
        kind: "s3",
        connectionId: "c1",
      });

      attachVaultStorageConnection.mockResolvedValue({
        kind: "s3",
        connectionId: "c9",
      });
      await expect(attachVaultConnection("c9")).resolves.toStrictEqual({
        ok: true,
        value: { kind: "s3", connectionId: "c9" },
      });

      attachVaultStorageConnection.mockRejectedValue(
        new RecoveryKitNotConfirmedError("kit")
      );
      await expect(attachVaultConnection("c9")).resolves.toMatchObject({
        ok: false,
        code: "recovery_kit_not_confirmed",
      });

      detachVaultStorageConnection.mockResolvedValue({ kind: "fs" });
      await expect(detachVaultConnection()).resolves.toStrictEqual({
        kind: "fs",
      });
    });
  });
});
