// Scope-set resolution for an inline app mount (issue #599).
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as TypeImport_nod2nz from "../../../gateway-client-core.js";
import type { AppScopeEntry } from "../../../gateway-client-vault.js";
import type * as TypeImport_lhrfvk from "../../../gateway-client-vault.js";
import type * as TypeImport_ntzl9 from "../../../replica/shell-session.js";

const { readAppScopePlane } = vi.hoisted(() => ({
  readAppScopePlane: vi.fn<typeof TypeImport_lhrfvk.readAppScopePlane>(),
}));
vi.mock(import("../../../gateway-client-vault.js") as Promise<unknown>, () => ({
  readAppScopePlane,
}));
vi.mock(import("../../../gateway-client-core.js") as Promise<unknown>, () => ({
  auth: vi.fn<typeof TypeImport_nod2nz.auth>(async () => ({
    baseUrl: "https://gw.test",
    token: "tok",
    gatewayId: "profile-home",
  })),
}));
vi.mock(
  import("../../../replica/shell-session.js") as Promise<unknown>,
  () => ({
    addressedGatewayAuth: vi.fn<typeof TypeImport_ntzl9.addressedGatewayAuth>(
      async () => ({
        baseUrl: "https://gw.test",
        token: "tok",
        gatewayId: "profile-home",
        vaultId: "vault-ambient",
      })
    ),
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

/** The plane as the gateway answers it: rows, plus the member's pointer. */
function plane(
  scopes: AppScopeEntry[],
  defaultShareTargetVaultId?: string
): TypeImport_lhrfvk.AppScopePlane {
  return {
    scopes,
    ...(defaultShareTargetVaultId === undefined
      ? {}
      : { defaultShareTargetVaultId }),
  };
}

describe("resolveAppScopes", () => {
  // Braces matter: an arrow that RETURNS the mock hands vitest a teardown
  // callback, and vitest would then invoke the mock after each test.
  beforeEach(() => {
    readAppScopePlane.mockReset();
  });

  it("maps roles to write capability — read cannot add", async () => {
    readAppScopePlane.mockResolvedValue(
      plane([
        entry("vault-own", "Library", "admin"),
        entry("vault-family", "Family", "write"),
        entry("vault-grandma", "Grandma", "read"),
      ])
    );
    const { scopes } = await resolveAppScopes("photos");
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
    readAppScopePlane.mockResolvedValue(
      plane([
        entry("vault-own", "Library", "admin"),
        { ...entry("vault-family", "Family", "write"), installed: false },
      ])
    );
    const { scopes } = await resolveAppScopes("photos");
    expect(scopes.map((s) => s.scope.id)).toStrictEqual(["vault-own"]);
  });

  it("caps how many scopes are hydrated at once", async () => {
    readAppScopePlane.mockResolvedValue(
      plane(
        Array.from({ length: MAX_MOUNTED_SCOPES + 3 }, (_, i) =>
          entry(`vault-${i}`, `Scope ${i}`, "write")
        )
      )
    );
    await expect(resolveAppScopes("photos")).resolves.toHaveProperty(
      "scopes.length",
      MAX_MOUNTED_SCOPES
    );
  });

  it("degrades to the single ambient scope when the gateway has no scopes plane", async () => {
    readAppScopePlane.mockResolvedValue(undefined);
    const { scopes, shareTargetVaultId } = await resolveAppScopes("photos");
    expect(scopes).toHaveLength(1);
    expect(scopes[0]!.identity.vaultId).toBe("vault-ambient");
    expect(scopes[0]!.scope.canWrite).toBe(true);
    // The solo mount IS the member's own library, so nothing in it is marked
    // as somewhere else, and there is nowhere to share to (issue #711 item H).
    expect(scopes[0]!.scope.personal).toBe(true);
    expect(shareTargetVaultId).toBeUndefined();
  });

  it("degrades rather than failing the mount when the call throws", async () => {
    readAppScopePlane.mockImplementation(() => {
      throw new Error("offline");
    });
    await expect(resolveAppScopes("photos")).resolves.toHaveProperty(
      "scopes.length",
      1
    );
  });

  // Issue #711 item H: the share destination is a POINTER the member owns,
  // carried beside the rows because it is not a property of any of them.
  it("carries the member's share destination, and the founding marker per row", async () => {
    readAppScopePlane.mockResolvedValue(
      plane(
        [
          { ...entry("vault-own", "Library", "admin"), personal: true },
          { ...entry("vault-shared", "Shared", "write"), personal: false },
        ],
        "vault-shared"
      )
    );
    const resolvedScopes = await resolveAppScopes("photos");
    expect(resolvedScopes.shareTargetVaultId).toBe("vault-shared");
    expect(
      resolvedScopes.scopes.map((s) => [s.scope.id, s.scope.personal])
    ).toStrictEqual([
      ["vault-own", true],
      ["vault-shared", false],
    ]);
  });

  it("passes a pointer this mount cannot reach straight through", async () => {
    // Not resolved away here: the app renders the share action disabled WITH
    // the reason rather than silently doing nothing.
    readAppScopePlane.mockResolvedValue(
      plane(
        [{ ...entry("vault-own", "Library", "admin"), personal: true }],
        "vault-gone"
      )
    );
    const resolvedScopes = await resolveAppScopes("photos");
    expect(resolvedScopes.shareTargetVaultId).toBe("vault-gone");
    expect(resolvedScopes.scopes.map((s) => s.scope.id)).toStrictEqual([
      "vault-own",
    ]);
  });

  it("leaves a scope UNMARKED when the gateway did not answer the marker", async () => {
    // An older gateway omits `personal`; marking every tile would say
    // something untrue, so unknown reads as the member's own.
    readAppScopePlane.mockResolvedValue(
      plane([entry("vault-own", "Library", "admin")])
    );
    const resolvedScopes = await resolveAppScopes("photos");
    expect(resolvedScopes.scopes[0]!.scope.personal).toBeUndefined();
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
