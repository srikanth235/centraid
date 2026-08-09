// Scope-set resolution for an inline app mount (issue #599, ownership #726).
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

function entry(
  vaultId: string,
  label: string,
  canWrite: boolean
): AppScopeEntry {
  return { vaultId, label, canWrite, installed: true };
}

/** The plane as the gateway answers it: the mountable rows. */
function plane(scopes: AppScopeEntry[]): TypeImport_lhrfvk.AppScopePlane {
  return { scopes };
}

describe("resolveAppScopes", () => {
  // Braces matter: an arrow that RETURNS the mock hands vitest a teardown
  // callback, and vitest would then invoke the mock after each test.
  beforeEach(() => {
    readAppScopePlane.mockReset();
  });

  it("carries canWrite straight through — sourced from the gateway, never derived", async () => {
    readAppScopePlane.mockResolvedValue(
      plane([
        entry("vault-own", "Library", true),
        entry("vault-family", "Family", true),
        entry("vault-grandma", "Grandma", false),
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
        entry("vault-own", "Library", true),
        { ...entry("vault-family", "Family", true), installed: false },
      ])
    );
    const { scopes } = await resolveAppScopes("photos");
    expect(scopes.map((s) => s.scope.id)).toStrictEqual(["vault-own"]);
  });

  it("caps how many scopes are hydrated at once", async () => {
    readAppScopePlane.mockResolvedValue(
      plane(
        Array.from({ length: MAX_MOUNTED_SCOPES + 3 }, (_, i) =>
          entry(`vault-${i}`, `Scope ${i}`, true)
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
    const { scopes } = await resolveAppScopes("photos");
    expect(scopes).toHaveLength(1);
    expect(scopes[0]!.identity.vaultId).toBe("vault-ambient");
    expect(scopes[0]!.scope.canWrite).toBe(true);
    // The solo mount IS the member's own library, so nothing in it is marked
    // as somewhere else.
    expect(scopes[0]!.scope.personal).toBe(true);
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

  it("carries the founding marker per row", async () => {
    readAppScopePlane.mockResolvedValue(
      plane([
        { ...entry("vault-own", "Library", true), personal: true },
        { ...entry("vault-shared", "Shared", true), personal: false },
      ])
    );
    const resolvedScopes = await resolveAppScopes("photos");
    expect(
      resolvedScopes.scopes.map((s) => [s.scope.id, s.scope.personal])
    ).toStrictEqual([
      ["vault-own", true],
      ["vault-shared", false],
    ]);
  });

  it("leaves a scope UNMARKED when the gateway did not answer the marker", async () => {
    // An older gateway omits `personal`; marking every tile would say
    // something untrue, so unknown reads as the member's own.
    readAppScopePlane.mockResolvedValue(
      plane([entry("vault-own", "Library", true)])
    );
    const resolvedScopes = await resolveAppScopes("photos");
    expect(resolvedScopes.scopes[0]!.scope.personal).toBeUndefined();
  });

  it("mounts a borrowed scope through its edge-scoped replica transport", async () => {
    readAppScopePlane.mockResolvedValue(
      plane([
        entry("vault-own", "Library", true),
        {
          ...entry("borrowed:edge-1", "Ada", true),
          borrowed: {
            edgeId: "edge-1",
            originVaultId: "vault-ada",
            holderLabel: "Ada",
            itemType: "core.collection",
            reachState: "established",
            reason: null,
            mounted: true,
          },
        },
      ])
    );

    const { scopes } = await resolveAppScopes("tasks");
    expect(scopes[1]).toMatchObject({
      identity: { vaultId: "borrowed:edge-1" },
      borrowedEdgeId: "edge-1",
      scope: {
        id: "borrowed:edge-1",
        canWrite: true,
        borrowed: { originVaultId: "vault-ada" },
      },
    });
  });

  it("does not mount a borrowed scope denied a replica slot", async () => {
    readAppScopePlane.mockResolvedValue(
      plane([
        entry("vault-own", "Library", true),
        {
          ...entry("borrowed:edge-1", "Ada", false),
          borrowed: {
            edgeId: "edge-1",
            originVaultId: "vault-ada",
            holderLabel: "Ada",
            itemType: "core.collection",
            reachState: "parked",
            reason: "mount budget",
            mounted: false,
          },
        },
      ])
    );
    await expect(resolveAppScopes("tasks")).resolves.toMatchObject({
      scopes: [{ identity: { vaultId: "vault-own" } }],
    });
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
