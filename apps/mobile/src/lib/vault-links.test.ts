/**
 * Vaults owner (#545) — device-local (gateway, vault) registry.
 */
import { describe, expect, it, vi } from "vitest";

const storeMem = new Map<string, unknown>();
const secureMem = new Map<string, string>();

vi.mock(import("../storage"), () => ({
  Store: {
    get<T>(key: string, fallback: T): T {
      return storeMem.has(key) ? (storeMem.get(key) as T) : fallback;
    },
    set<T>(key: string, value: T): void {
      storeMem.set(key, value);
    },
    async hydrate<T>(key: string, fallback: T): Promise<T> {
      if (!storeMem.has(key)) storeMem.set(key, fallback);
      return storeMem.get(key) as T;
    },
  },
}));

vi.mock(import("./secure-storage"), () => ({
  async hydrateSecure(key: string, fallback = ""): Promise<string> {
    return secureMem.has(key) ? (secureMem.get(key) as string) : fallback;
  },
  async setSecure(key: string, value: string): Promise<void> {
    secureMem.set(key, value);
  },
  getSecure(key: string, fallback = ""): string {
    return secureMem.has(key) ? (secureMem.get(key) as string) : fallback;
  },
}));

async function loadVaultLinks() {
  vi.resetModules();
  storeMem.clear();
  secureMem.clear();
  return import("./vault-links");
}

describe("Vaults registry", () => {
  it("adds a vault, projects the active slot, and lists it", async () => {
    const vaults = await loadVaultLinks();
    const vault = await vaults.addVaultLink({
      gatewayId: "gw-1",
      desktopName: "Mac mini",
      deviceId: "dev-1",
      vaultId: "vault-a",
      endpointHint: "relay-hint-1",
      vaultName: "Personal",
    });
    expect(vault.gatewayId).toBe("gw-1");
    expect(vaults.listVaultLinks()).toHaveLength(1);
    expect(vaults.getActiveVaultLink()?.id).toBe(vault.id);
    expect(vaults.getActiveVaultId()).toBe("vault-a");
    expect(secureMem.get(vaults.LINK_ENDPOINT_HINT_KEY)).toBe("relay-hint-1");
  });

  it("upserts the same (gateway, vault) tuple instead of duplicating", async () => {
    const vaults = await loadVaultLinks();
    const first = await vaults.addVaultLink({
      gatewayId: "gw-1",
      desktopName: "Desk",
      deviceId: "d1",
      vaultId: "v1",
      endpointHint: "hint-old",
    });
    const second = await vaults.addVaultLink({
      gatewayId: "gw-1",
      desktopName: "Desk",
      deviceId: "d1",
      vaultId: "v1",
      endpointHint: "hint-new",
      vaultName: "Home",
    });
    expect(second.id).toBe(first.id);
    expect(vaults.listVaultLinks()).toHaveLength(1);
    expect(vaults.getActiveVaultLink()?.vaultName).toBe("Home");
    expect(secureMem.get(vaults.LINK_ENDPOINT_HINT_KEY)).toBe("hint-new");
  });

  it("switches active vault and notifies subscribers", async () => {
    const vaults = await loadVaultLinks();
    const a = await vaults.addVaultLink({
      gatewayId: "gw-a",
      desktopName: "A",
      deviceId: "d",
      vaultId: "va",
      endpointHint: "ha",
    });
    const b = await vaults.addVaultLink({
      gatewayId: "gw-b",
      desktopName: "B",
      deviceId: "d",
      vaultId: "vb",
      endpointHint: "hb",
    });
    expect(vaults.getActiveVaultLink()?.id).toBe(b.id);
    let ticks = 0;
    const unsub = vaults.subscribeVaultLinks(() => {
      ticks += 1;
    });
    await vaults.setActiveVaultLink(a.id);
    expect(vaults.getActiveVaultLink()?.id).toBe(a.id);
    expect(ticks).toBeGreaterThanOrEqual(1);
    unsub();
  });

  it("forgets a vault and falls back when it was active", async () => {
    const vaults = await loadVaultLinks();
    const a = await vaults.addVaultLink({
      gatewayId: "gw-a",
      desktopName: "A",
      deviceId: "d",
      vaultId: "va",
      endpointHint: "ha",
    });
    const b = await vaults.addVaultLink({
      gatewayId: "gw-b",
      desktopName: "B",
      deviceId: "d",
      vaultId: "vb",
      endpointHint: "hb",
    });
    await vaults.removeVaultLink(b.id);
    expect(vaults.listVaultLinks().map((s) => s.id)).toStrictEqual([a.id]);
    expect(vaults.getActiveVaultLink()?.id).toBe(a.id);
    await vaults.removeVaultLink(a.id);
    expect(vaults.listVaultLinks()).toStrictEqual([]);
    expect(vaults.getActiveVaultLink()).toBeUndefined();
    expect(vaults.getActiveVaultId()).toBe("");
  });
  it("notifies subscribers when hydration finds a registry on disk", async () => {
    // The boot race Home lost: `getActiveVaultLink()` reads in-memory state that
    // only exists after the async hydrate, so a screen that mounts and
    // subscribes FIRST must still be told once the registry lands. Without the
    // emit at the end of hydration it waits forever and renders "No vault yet"
    // over a fully populated replica.
    const seed = await loadVaultLinks();
    const added = await seed.addVaultLink({
      gatewayId: "gw-1",
      desktopName: "Mac mini",
      deviceId: "dev-1",
      vaultId: "vault-a",
      endpointHint: "hint",
      vaultName: "Personal",
    });

    // A fresh module over the SAME storage — a cold boot with links on disk.
    vi.resetModules();
    const booted = await import("./vault-links");
    expect(booted.getActiveVaultLink()).toBeUndefined();

    let notified = 0;
    booted.subscribeVaultLinks(() => (notified += 1));
    await booted.hydrateVaultLinks();

    expect(notified).toBeGreaterThan(0);
    expect(booted.getActiveVaultLink()?.id).toBe(added.id);
  });
});
