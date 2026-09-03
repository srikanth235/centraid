import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import type * as TypeImport_1nb0oqa from "../gateway-client-vault.js";
import type * as TypeImport_1vwuba6 from "./shell-session.js";

const vaultStatus = vi.fn<typeof TypeImport_1nb0oqa.vaultStatus>();
vi.mock(import("../gateway-client-vault.js"), () => ({
  vaultStatus: () => vaultStatus(),
}));

const status = (vaultId: string): TypeImport_1nb0oqa.VaultStatus => ({
  vaultId,
  name: "Personal",
  ownerPartyId: "party-1",
  fresh: false,
});

let addressedGatewayAuth: typeof TypeImport_1vwuba6.addressedGatewayAuth;
let replicaIdentityForGatewayAuth: typeof TypeImport_1vwuba6.replicaIdentityForGatewayAuth;
let gatewayAuth: Record<string, unknown>;

describe("shell-session-addressing", () => {
  beforeAll(async () => {
    Object.assign(window, {
      CentraidApi: {
        getGatewayAuth: () => Promise.resolve(gatewayAuth),
        onGatewayChanged: () => () => undefined,
        onVaultChanged: () => () => undefined,
      },
    });
    ({ addressedGatewayAuth, replicaIdentityForGatewayAuth } =
      await import("./shell-session.js"));
  });

  let gatewayCounter = 0;
  let gatewayId: string;

  beforeEach(async () => {
    vaultStatus.mockReset();
    gatewayCounter += 1;
    gatewayId = `profile-${gatewayCounter}`;
    gatewayAuth = { baseUrl: "https://gateway.example", gatewayId };
    const core = await import("../gateway-client-core.js");
    core.resetGatewayAuthCache();
  });

  test("an addressed vault is left exactly as the client set it", async () => {
    gatewayAuth = { ...gatewayAuth, vaultId: "vault-explicit" };
    await expect(addressedGatewayAuth()).resolves.toMatchObject({
      vaultId: "vault-explicit",
    });
    expect(vaultStatus).not.toHaveBeenCalled();
  });

  test("an unaddressed vault resolves to the plane the gateway itself picked", async () => {
    vaultStatus.mockResolvedValue(status("vault-from-gateway"));
    const resolved = await addressedGatewayAuth();
    expect(resolved.vaultId).toBe("vault-from-gateway");
    expect(replicaIdentityForGatewayAuth(resolved)).toStrictEqual({
      gatewayId,
      vaultId: "vault-from-gateway",
    });
  });

  test("the resolve is held per gateway — a bridged read must not refetch it", async () => {
    vaultStatus.mockResolvedValue(status("vault-from-gateway"));
    await Promise.all([addressedGatewayAuth(), addressedGatewayAuth()]);
    await addressedGatewayAuth();
    expect(vaultStatus).toHaveBeenCalledOnce();
  });

  test("a gateway with no vault plane still raises the protocol error", async () => {
    vaultStatus.mockResolvedValue(undefined);
    const resolved = await addressedGatewayAuth();
    expect(resolved.vaultId).toBeUndefined();
    expect(() => replicaIdentityForGatewayAuth(resolved)).toThrow(
      "An addressed vault is required"
    );
    vaultStatus.mockResolvedValue(status("vault-mounted-later"));
    await expect(addressedGatewayAuth()).resolves.toMatchObject({
      vaultId: "vault-mounted-later",
    });
  });

  test("a failed status read degrades to the protocol error, not a crash", async () => {
    vaultStatus.mockRejectedValue(new Error("offline"));
    const resolved = await addressedGatewayAuth();
    expect(() => replicaIdentityForGatewayAuth(resolved)).toThrow(
      "An addressed vault is required"
    );
  });
});
