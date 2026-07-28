// Scope-set resolution for an inline app mount (issue #599).
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppScopeEntry } from "../../../gateway-client-vault.js";

const { listAppScopes } = vi.hoisted(() => ({
  listAppScopes:
    vi.fn<typeof import("../../../gateway-client-vault.js").listAppScopes>(),
}));
vi.mock(import("../../../gateway-client-vault.js") as Promise<unknown>, () => ({
  listAppScopes,
}));
vi.mock(import("../../../gateway-client-core.js") as Promise<unknown>, () => ({
  auth: vi.fn<typeof import("../../../gateway-client-core.js").auth>(
    async () => ({
      baseUrl: "https://gw.test",
      token: "tok",
      gatewayId: "profile-home",
    })
  ),
}));
vi.mock(
  import("../../../replica/shell-session.js") as Promise<unknown>,
  () => ({
    addressedGatewayAuth: vi.fn<
      typeof import("../../../replica/shell-session.js").addressedGatewayAuth
    >(async () => ({
      baseUrl: "https://gw.test",
      token: "tok",
      gatewayId: "profile-home",
      vaultId: "vault-ambient",
    })),
    replicaIdentityForGatewayAuth: (gatewayAuth: {
      gatewayId?: string;
      vaultId?: string;
    }) => ({
      gatewayId: gatewayAuth.gatewayId,
      vaultId: gatewayAuth.vaultId,
    }),
  })
);

const { MAX_MOUNTED_SCOPES, resolveAppScopes, scopeSetKey } =
  await import("./useAppScopes.js");

function entry(vaultId: string, label: string, role: string): AppScopeEntry {
  return { vaultId, label, role, installed: true };
}

describe("resolveAppScopes", () => {
  // Braces matter: an arrow that RETURNS the mock hands vitest a teardown
  // callback, and vitest would then invoke the mock after each test.
  beforeEach(() => {
    listAppScopes.mockReset();
  });

  it("maps roles to write capability — read cannot add", async () => {
    listAppScopes.mockResolvedValue([
      entry("vault-own", "Library", "admin"),
      entry("vault-family", "Family", "write"),
      entry("vault-grandma", "Grandma", "read"),
    ]);
    const scopes = await resolveAppScopes("photos");
    expect(scopes.map((s) => [s.scope.id, s.scope.canWrite])).toStrictEqual([
      ["vault-own", true],
      ["vault-family", true],
      ["vault-grandma", false],
    ]);
    expect(scopes[0]!.identity).toStrictEqual({
      gatewayId: "profile-home",
      vaultId: "vault-own",
    });
  });

  it("drops a scope the app is not installed in — it would have no shapes to read", async () => {
    listAppScopes.mockResolvedValue([
      entry("vault-own", "Library", "admin"),
      { ...entry("vault-family", "Family", "write"), installed: false },
    ]);
    const scopes = await resolveAppScopes("photos");
    expect(scopes.map((s) => s.scope.id)).toStrictEqual(["vault-own"]);
  });

  it("caps how many scopes are hydrated at once", async () => {
    listAppScopes.mockResolvedValue(
      Array.from({ length: MAX_MOUNTED_SCOPES + 3 }, (_, i) =>
        entry(`vault-${i}`, `Scope ${i}`, "write")
      )
    );
    await expect(resolveAppScopes("photos")).resolves.toHaveLength(
      MAX_MOUNTED_SCOPES
    );
  });

  it("degrades to the single ambient scope when the gateway has no scopes plane", async () => {
    listAppScopes.mockResolvedValue(undefined);
    const scopes = await resolveAppScopes("photos");
    expect(scopes).toHaveLength(1);
    expect(scopes[0]!.identity.vaultId).toBe("vault-ambient");
    expect(scopes[0]!.scope.canWrite).toBe(true);
  });

  it("degrades rather than failing the mount when the call throws", async () => {
    listAppScopes.mockImplementation(() => {
      throw new Error("offline");
    });
    await expect(resolveAppScopes("photos")).resolves.toHaveLength(1);
  });
});

describe("scopeSetKey", () => {
  it("is order-independent, so a reordered listing never re-mounts the app", () => {
    const a = [
      {
        scope: { id: "b", label: "B", canWrite: true },
        identity: { gatewayId: "g", vaultId: "b" },
      },
      {
        scope: { id: "a", label: "A", canWrite: true },
        identity: { gatewayId: "g", vaultId: "a" },
      },
    ];
    const b = [a[1]!, a[0]!];
    expect(scopeSetKey(a)).toBe(scopeSetKey(b));
    expect(scopeSetKey(a)).not.toBe(scopeSetKey([a[0]!]));
  });
});
