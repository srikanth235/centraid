import { describe, expect, it } from "vitest";

import {
  applyProbeOutcome,
  buildGatewayRows,
  buildVaultRows,
  disconnectConfirmCopy,
} from "./gatewayRegistry.js";
import type {
  GatewayProbeCache,
  OwnerVaultScope,
  RegistryGateway,
  RegistryVault,
} from "./gatewayRegistry.js";

// Gateway → Components → Connections is the one surface that still shows hosts
// as hosts (#665); the sidebar switcher shows the vaults they serve, flattened,
// and the vault's own Settings page owns Disconnect. These are the pure halves:
// what a probe does to the cache, what the host rows say once it has, how those
// rows flatten into one vault list, and how Disconnect words its consequence.

const gateways: RegistryGateway[] = [
  { gatewayId: "local", gatewayKind: "local", gatewayLabel: "This Mac" },
  { gatewayId: "office", gatewayKind: "remote", gatewayLabel: "Office" },
  { gatewayId: "attic", gatewayKind: "remote", gatewayLabel: "Attic" },
];

const vaults = (...names: string[]): RegistryVault[] =>
  names.map((name) => ({ name, vaultId: name.toLowerCase() }));

describe(applyProbeOutcome, () => {
  it("keeps the last known vaults across a refresh that is still in flight", () => {
    let cache: GatewayProbeCache = {};
    cache = applyProbeOutcome(cache, "local", {
      status: "ready",
      vaults: vaults("Shared", "Personal", "Work"),
    });
    cache = applyProbeOutcome(cache, "local", { status: "loading" });
    expect(cache.local?.status).toBe("loading");
    expect(cache.local?.vaults).toHaveLength(3);
  });

  it("keeps the last known vaults across a FAILED refresh — a blip must not blank data", () => {
    let cache: GatewayProbeCache = {};
    cache = applyProbeOutcome(cache, "local", {
      status: "ready",
      vaults: vaults("Shared", "Personal"),
    });
    cache = applyProbeOutcome(cache, "local", {
      status: "error",
      error: "unreachable",
    });
    expect(cache.local).toMatchObject({
      status: "error",
      error: "unreachable",
    });
    expect(cache.local?.vaults).toHaveLength(2);
  });

  it("replaces the vault list only on a successful probe", () => {
    let cache: GatewayProbeCache = {};
    cache = applyProbeOutcome(cache, "local", {
      status: "ready",
      vaults: vaults("Shared", "Personal"),
    });
    cache = applyProbeOutcome(cache, "local", {
      status: "ready",
      vaults: vaults("Shared"),
    });
    expect(cache.local?.vaults?.map((v) => v.name)).toStrictEqual(["Shared"]);
  });
});

describe(buildGatewayRows, () => {
  it("puts the active gateway first and sorts the rest by name", () => {
    const rows = buildGatewayRows(gateways, {}, "office");
    expect(rows.map((r) => r.gatewayId)).toStrictEqual([
      "office",
      "attic",
      "local",
    ]);
    expect(rows[0]!.isActive).toBe(true);
  });

  it("badges transport from the profile — This Mac for local, iroh for remote", () => {
    const rows = buildGatewayRows(gateways, {}, "local");
    const badge = (id: string): string =>
      rows.find((r) => r.gatewayId === id)!.transportBadge;
    expect(badge("local")).toBe("This Mac");
    expect(badge("office")).toBe("iroh");
    expect(badge("attic")).toBe("iroh");
  });

  it("reports a gateway with no probe yet as loading, not as broken", () => {
    const rows = buildGatewayRows(gateways, {}, "local");
    expect(rows.every((r) => r.status === "loading")).toBe(true);
    expect(rows.every((r) => r.vaultCount === undefined)).toBe(true);
  });

  it("surfaces the probe error verbatim so the row can say WHY", () => {
    const cache = applyProbeOutcome({}, "attic", {
      status: "error",
      error: "auth_failed",
    });
    const row = buildGatewayRows(gateways, cache, "local").find(
      (r) => r.gatewayId === "attic"
    )!;
    expect(row.status).toBe("auth_failed");
  });

  it("refuses to offer removal of the local gateway — it is the primordial one", () => {
    const rows = buildGatewayRows(gateways, {}, "local");
    expect(rows.find((r) => r.gatewayId === "local")!.canRemove).toBe(false);
    expect(rows.find((r) => r.gatewayId === "office")!.canRemove).toBe(true);
  });

  it("carries the vault count through once a probe lands", () => {
    const cache = applyProbeOutcome({}, "local", {
      status: "ready",
      vaults: vaults("A", "B", "C", "D"),
    });
    const row = buildGatewayRows(gateways, cache, "local")[0]!;
    expect(row.status).toBe("ready");
    expect(row.vaultCount).toBe(4);
  });
});

describe(buildVaultRows, () => {
  const scopes: OwnerVaultScope[] = [
    { id: "shared", label: "Shared", isActive: true },
    { id: "personal", label: "Personal", isActive: false },
  ];

  it("flattens the vaults of every gateway into ONE list", () => {
    let cache = applyProbeOutcome({}, "local", {
      status: "ready",
      vaults: vaults("Shared", "Personal"),
    });
    cache = applyProbeOutcome(cache, "office", {
      status: "ready",
      vaults: [{ name: "Studio", vaultId: "studio" }],
    });
    const rows = buildVaultRows(
      buildGatewayRows(gateways.slice(0, 2), cache, "local"),
      scopes,
      "local"
    );
    expect(rows.map((r) => r.label)).toStrictEqual([
      "Shared",
      "Personal",
      "Studio",
    ]);
    expect(rows.map((r) => r.gatewayId)).toStrictEqual([
      "local",
      "local",
      "office",
    ]);
  });

  it("names the gateway as quiet context ONLY when more than one is registered", () => {
    const cache = applyProbeOutcome({}, "local", {
      status: "ready",
      vaults: vaults("Shared", "Personal"),
    });
    const alone = buildVaultRows(
      buildGatewayRows(gateways.slice(0, 1), cache, "local"),
      scopes,
      "local"
    );
    expect(alone[0]!.subtitle).toBe("Vault");
    const withPeer = buildVaultRows(
      buildGatewayRows(gateways.slice(0, 2), cache, "local"),
      scopes,
      "local"
    );
    // With ownership (#726) there is no per-vault role lead left to say, so a
    // peer'd gateway's own vaults name just the gateway — the same bare
    // context every non-active gateway's rows already carried.
    expect(withPeer[0]!.subtitle).toBe("This Mac");
  });

  it("names the gateway for a vault off a non-active one, and nothing else", () => {
    const cache = applyProbeOutcome({}, "office", {
      status: "ready",
      vaults: [{ name: "Studio", vaultId: "studio" }],
    });
    const rows = buildVaultRows(
      buildGatewayRows(gateways.slice(0, 2), cache, "local"),
      scopes,
      "local"
    );
    const studio = rows.find((r) => r.vaultId === "studio")!;
    expect(studio.subtitle).toBe("Office");
    expect(studio.selectable).toBe(true);
  });

  it("marks the ACTIVE vault of the active gateway, and nothing else", () => {
    const cache = applyProbeOutcome({}, "office", {
      status: "ready",
      vaults: [{ name: "Shared", vaultId: "shared" }],
    });
    const rows = buildVaultRows(
      buildGatewayRows(gateways.slice(0, 2), cache, "local"),
      scopes,
      "local"
    );
    expect(
      rows.filter((r) => r.isActive).map((r) => r.gatewayId)
    ).toStrictEqual(["local"]);
  });

  it("treats a lone gateway as the active one even when the ids disagree (web host)", () => {
    // The web host reports `activeGatewayId: 'web'` but lists its single
    // connection under its EndpointId — the check mark must survive that
    // mismatch.
    const cache = applyProbeOutcome({}, "endpoint-1", {
      status: "ready",
      vaults: [{ name: "Shared", vaultId: "shared" }],
    });
    const rows = buildVaultRows(
      buildGatewayRows(
        [
          {
            gatewayId: "endpoint-1",
            gatewayKind: "remote",
            gatewayLabel: "Home",
          },
        ],
        cache,
        "web"
      ),
      scopes,
      "web"
    );
    expect(rows[0]).toMatchObject({ subtitle: "Vault", isActive: true });
  });

  it("still lists the connected vaults when the host exposes no gateway registry", () => {
    const rows = buildVaultRows([], scopes, "local");
    expect(rows.map((r) => r.label)).toStrictEqual(["Shared", "Personal"]);
    expect(rows[0]).toMatchObject({
      gatewayId: "local",
      isActive: true,
      selectable: true,
      subtitle: "Vault",
    });
  });

  it("shows a gateway still probing as a quiet stand-in rather than dropping it", () => {
    const rows = buildVaultRows(
      buildGatewayRows(gateways.slice(0, 2), {}, "local"),
      [],
      "local"
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      status: "loading",
      subtitle: "Checking…",
      selectable: false,
      vaultId: undefined,
    });
  });

  it("keeps an unreachable gateway's known vaults visible but NOT actionable", () => {
    let cache = applyProbeOutcome({}, "office", {
      status: "ready",
      vaults: [{ name: "Studio", vaultId: "studio" }],
    });
    cache = applyProbeOutcome(cache, "office", {
      status: "error",
      error: "unreachable",
    });
    const rows = buildVaultRows(
      buildGatewayRows(gateways.slice(0, 2), cache, "local"),
      scopes,
      "local"
    );
    const studio = rows.find((r) => r.vaultId === "studio")!;
    expect(studio.selectable).toBe(false);
    expect(studio.status).toBe("error");
    expect(studio.subtitle).toBe("Offline · Office");
  });

  it("says why a gateway that answered with nothing has no rows", () => {
    const cache = applyProbeOutcome({}, "local", {
      status: "ready",
      vaults: [],
    });
    const rows = buildVaultRows(
      buildGatewayRows(gateways.slice(0, 1), cache, "local"),
      [],
      "local"
    );
    expect(rows[0]).toMatchObject({ subtitle: "No vaults", status: "ready" });
  });

  // Disconnect drops the whole CONNECTION, so every vault it serves goes too.
  // The copy has to say that by naming them — and it must never say "gateway".
  describe(disconnectConfirmCopy, () => {
    it("stays vault-first when the connection serves only this vault", () => {
      const copy = disconnectConfirmCopy("Work", []);
      expect(copy).toBe(
        'Disconnect "Work" from this device? Your vault stays intact on its host.'
      );
    });

    it("names every sibling that leaves with it", () => {
      expect(disconnectConfirmCopy("Work", ["Family", "Archive"])).toBe(
        '"Work" shares its connection with "Family" and "Archive" — disconnecting removes all three from this device. The vaults themselves stay intact on their host.'
      );
      expect(disconnectConfirmCopy("Work", ["Family"])).toContain(
        "removes both from this device"
      );
      expect(disconnectConfirmCopy("Work", ["A", "B", "C"])).toContain(
        "removes all 4 from this device"
      );
    });

    it("never calls a host a gateway", () => {
      const copy = disconnectConfirmCopy("Work", ["Family", "Archive"]);
      expect(copy.toLowerCase()).not.toContain("gateway");
    });
  });
});
