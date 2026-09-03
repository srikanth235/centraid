import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as TypeImport_vault from "../gateway-client-vault.js";
import type * as TypeImport_shellSession from "./shell-session.js";

const vaultStatus = vi.fn<typeof TypeImport_vault.vaultStatus>();
vi.mock(import("../gateway-client-vault.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  vaultStatus: () => vaultStatus(),
}));

const status = (vaultId: string): TypeImport_vault.VaultStatus => ({
  fresh: false,
  name: "Vault",
  ownerPartyId: "party-1",
  vaultId,
});

const POINTER_KEY = "centraid.v1.replica.addressedVault";

function installHost(vaultId?: string): void {
  Object.assign(window, {
    CentraidApi: {
      getGatewayAuth: () =>
        Promise.resolve({
          baseUrl: "https://gateway.example",
          ...(vaultId ? { vaultId } : {}),
          rememberDevice: false,
        }),
      onGatewayChanged: () => () => undefined,
      onVaultChanged: () => () => undefined,
    },
  });
}

async function reboot(): Promise<typeof TypeImport_shellSession> {
  vi.resetModules();
  return import("./shell-session.js");
}

describe("addressedGatewayAuth", () => {
  beforeEach(() => {
    vaultStatus.mockReset();
    localStorage.clear();
  });
  afterEach(() => localStorage.clear());

  it("remembers the vault the gateway resolved, for the next launch", async () => {
    installHost();
    vaultStatus.mockResolvedValue(status("vault-7"));
    const mod = await reboot();
    expect((await mod.addressedGatewayAuth()).vaultId).toBe("vault-7");
    await vi.waitFor(() =>
      expect(
        JSON.parse(localStorage.getItem(POINTER_KEY) ?? "{}")
      ).toStrictEqual({ "url:https://gateway.example/": "vault-7" })
    );
  });

  it("answers from the remembered pointer when the gateway cannot be reached", async () => {
    installHost();
    vaultStatus.mockResolvedValue(status("vault-7"));
    const first = await reboot();
    await first.addressedGatewayAuth();

    const offline = await reboot();
    vaultStatus.mockRejectedValue(new Error("offline"));
    const gatewayAuth = await offline.addressedGatewayAuth();
    expect(gatewayAuth.vaultId).toBe("vault-7");
    expect(offline.replicaIdentityForGatewayAuth(gatewayAuth)).toStrictEqual({
      gatewayId: "url:https://gateway.example/",
      vaultId: "vault-7",
    });
  });

  it("also remembers a vault the host itself already addresses", async () => {
    installHost("vault-9");
    const mod = await reboot();
    expect((await mod.addressedGatewayAuth()).vaultId).toBe("vault-9");
    expect(JSON.parse(localStorage.getItem(POINTER_KEY) ?? "{}")).toStrictEqual(
      {
        "url:https://gateway.example/": "vault-9",
      }
    );
    expect(vaultStatus).not.toHaveBeenCalled();
  });

  it("forgets the pointer when this device loses its access", async () => {
    installHost("vault-9");
    const mod = await reboot();
    await mod.addressedGatewayAuth();
    await mod.purgeCurrentReplicaDevice();
    expect(localStorage.getItem(POINTER_KEY)).toBeNull();
  });
});
