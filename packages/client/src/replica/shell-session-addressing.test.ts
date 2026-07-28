import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

// The client may leave the vault unaddressed ("let the gateway pick", #289).
// HTTP tolerates that; the replica cannot — it keys its local store by
// (gatewayId, vaultId). These cover the resolve that fills the gap.

const vaultStatus =
  vi.fn<typeof import("../gateway-client-vault.js").vaultStatus>();
vi.mock(import("../gateway-client-vault.js"), () => ({
  vaultStatus: () => vaultStatus(),
}));

const status = (
  vaultId: string
): import("../gateway-client-vault.js").VaultStatus => ({
  vaultId,
  name: "Personal",
  ownerPartyId: "party-1",
  fresh: false,
});

let addressedGatewayAuth: typeof import("./shell-session.js").addressedGatewayAuth;
let replicaIdentityForGatewayAuth: typeof import("./shell-session.js").replicaIdentityForGatewayAuth;
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

  // The resolve is cached per gateway for the life of the module, so each test
  // gets its own gateway id rather than a shared one that leaks the previous
  // test's answer.
  let gatewayCounter = 0;
  let gatewayId: string;

  beforeEach(async () => {
    vaultStatus.mockReset();
    gatewayCounter += 1;
    gatewayId = `profile-${gatewayCounter}`;
    gatewayAuth = { baseUrl: "https://gateway.example", gatewayId };
    // `auth()` memoizes per gateway; drop it so each test re-reads the stub.
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
    // Not `listVaults()[0]`: the device-token transport addresses the oldest
    // ENROLLMENT, so only the gateway can answer this without split-braining
    // the replica against every HTTP call.
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
    // Nothing worth caching — the next attempt re-asks rather than pinning
    // "unknown" for the life of the renderer.
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
