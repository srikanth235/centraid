// The four-scope cap is a bound on what is OPEN at once, not on which vaults a
// member may open (#880 W3.4, docs/mobile-offline.md). Activating a vault
// outside the mounted four used to re-key the write target and nothing else, so
// the Space a member had just tapped stayed unreadable until the app was
// relaunched. These tests pin the live remount, and pin that a switch INSIDE
// the mounted four still costs nothing.
//
// Everything native is mocked outright: the default `@centraid/mobile` vitest
// project carries no react-native transform, so any real import that reaches
// op-sqlite or expo-secure-store fails to parse before a test runs.
// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReplicaProvider, useReplica } from "./ReplicaProvider";
import type { ReplicaContextValue } from "./ReplicaProvider";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type ReactNative = typeof import("react-native");
type NetworkModule = typeof import("expo-network");
type StorageDirModule = typeof import("../../../modules/centraid-storage");
type DailyBriefModule = typeof import("../../lib/daily-brief");
type GatewayModule = typeof import("../../lib/gateway");
type NotificationsModule = typeof import("../../lib/notifications-core");
type BackgroundSyncModule = typeof import("../../lib/replica/background-sync");
type CompatibilityModule =
  typeof import("../../lib/replica/mobile-gateway-compatibility");
type ReaderModule = typeof import("../../lib/replica/multi-vault-reader");
type HashModule = typeof import("../../lib/replica/native-hash");
type MultiplexModule =
  typeof import("../../lib/replica/native-multiplex-change-feed");
type NativeSessionModule = typeof import("../../lib/replica/native-session");
type DriverModule = typeof import("../../lib/replica/op-sqlite-driver");
type PlacementModule = typeof import("../../lib/replica/placement-transport");
type ThumbnailModule = typeof import("../../lib/replica/thumbnail-pack");
type UploadPolicyModule = typeof import("../../lib/upload/native-policy");
type VaultLinksModule = typeof import("../../lib/vault-links");
type StoreModule = typeof import("../../storage");
type ReplicaMountModule = typeof import("./replica-mount");

const registry = vi.hoisted(() => ({
  active: undefined as { gatewayId: string; vaultId: string } | undefined,
  listeners: new Set<() => void>(),
}));

/** The device axis. Every double below used to pin it to "offline" (#905). */
const net = vi.hoisted(() => ({
  deviceOnline: false,
  base: undefined as string | undefined,
}));

const world = vi.hoisted(() => ({
  enrolled: [] as string[],
  /** Scopes the gateway has taken away; the plan can never return them. */
  revoked: [] as string[],
  mountPlans: 0,
  purged: [] as string[],
  closedSessions: [] as string[],
}));

vi.mock(
  import("@react-native-async-storage/async-storage") as Promise<unknown>,
  () => {
    const values = new Map<string, string>();
    return {
      default: {
        getItem: async (key: string) => values.get(key) ?? null,
        setItem: async (key: string, value: string) => {
          values.set(key, value);
        },
        removeItem: async (key: string) => {
          values.delete(key);
        },
      },
    };
  }
);

vi.mock(
  import("react-native"),
  () =>
    ({
      AppState: {
        currentState: "active",
        addEventListener: () => ({ remove: (): void => undefined }),
      },
      InteractionManager: {
        runAfterInteractions: (callback: () => void) => {
          callback();
          return { cancel: (): void => undefined };
        },
      },
    }) as unknown as Partial<ReactNative>
);

vi.mock(
  import("expo-network"),
  () =>
    ({
      addNetworkStateListener: () => ({ remove: (): void => undefined }),
      getNetworkStateAsync: () =>
        Promise.resolve({ isConnected: net.deviceOnline }),
    }) as unknown as Partial<NetworkModule>
);

vi.mock(
  import("../../../modules/centraid-storage"),
  () =>
    ({
      replicaStorageDirectory: () => "/replica",
      replicaStorageDirectoryUri: () => "file:///replica",
    }) as unknown as Partial<StorageDirModule>
);

vi.mock(
  import("../../lib/daily-brief"),
  () =>
    ({
      scheduleDailyBriefNotification: () => Promise.resolve(),
    }) as unknown as Partial<DailyBriefModule>
);

vi.mock(
  import("../../lib/gateway"),
  () =>
    ({
      resolveGatewayBase: () => Promise.resolve(net.base),
    }) as unknown as Partial<GatewayModule>
);

vi.mock(
  import("../../lib/notifications-core"),
  () =>
    ({
      syncDueNotifications: () => Promise.resolve(),
      syncNotifications: () => Promise.resolve(),
    }) as unknown as Partial<NotificationsModule>
);

vi.mock(
  import("../../lib/replica/background-sync"),
  () =>
    ({
      registerReplicaPushWake: () => Promise.resolve(),
    }) as unknown as Partial<BackgroundSyncModule>
);

vi.mock(
  import("../../lib/replica/mobile-gateway-compatibility"),
  () =>
    ({
      requireMobileOfflineGateway: () => Promise.resolve(undefined),
    }) as unknown as Partial<CompatibilityModule>
);

const Inert = vi.hoisted(() => {
  class InertNativeDouble {
    close(): void {}
    placements(): unknown[] {
      return [];
    }
    revokeScope(): void {}
    scope(): unknown {
      return { setActive: (): void => undefined };
    }
    updateGatewayBase(): void {}
  }
  return InertNativeDouble;
});

vi.mock(
  import("../../lib/replica/multi-vault-reader"),
  () =>
    ({
      MultiVaultReplicaReader: Inert,
    }) as unknown as Partial<ReaderModule>
);

vi.mock(
  import("../../lib/replica/native-hash"),
  () =>
    ({
      nativeReplicaDigest: (value: string) => Promise.resolve(value),
      nativeReplicaIdFactory: () => "id-1",
    }) as unknown as Partial<HashModule>
);

vi.mock(
  import("../../lib/replica/native-multiplex-change-feed"),
  () =>
    ({
      NativeMultiplexChangeFeed: Inert,
    }) as unknown as Partial<MultiplexModule>
);

vi.mock(
  import("../../lib/replica/native-session"),
  () =>
    ({
      createNativeReplicaSession: (options: {
        gatewayAuth: { vaultId: string };
      }) => {
        const vaultId = options.gatewayAuth.vaultId;
        return Promise.resolve({
          close: () => {
            world.closedSessions.push(vaultId);
            return Promise.resolve();
          },
          purge: () => {
            world.purged.push(vaultId);
            return Promise.resolve();
          },
          pullNow: () => Promise.resolve(false),
          status: () => Promise.resolve({ coverage: "complete" }),
          subscribe: () => (): void => undefined,
          notifyReachable: (): void => undefined,
          updateGatewayBase: (): void => undefined,
        });
      },
    }) as unknown as Partial<NativeSessionModule>
);

vi.mock(
  import("../../lib/replica/op-sqlite-driver"),
  () =>
    ({
      openMountedReplicaReaderDriver: () =>
        Promise.resolve({ close: (): void => undefined }),
      openNativeReplicaDriver: () =>
        Promise.resolve({ close: (): void => undefined }),
    }) as unknown as Partial<DriverModule>
);

vi.mock(
  import("../../lib/replica/placement-transport"),
  () =>
    ({
      postCommons: () => Promise.reject(new Error("offline")),
      postPlacement: () => Promise.reject(new Error("offline")),
    }) as unknown as Partial<PlacementModule>
);

vi.mock(
  import("../../lib/replica/thumbnail-pack"),
  () =>
    ({
      clearPinnedThumbnailPack: (): void => undefined,
    }) as unknown as Partial<ThumbnailModule>
);

vi.mock(
  import("../../lib/upload/native-policy"),
  () =>
    ({
      nativeSyncAllowed: () => Promise.resolve(true),
      nativeRowSyncAllowed: () => Promise.resolve(true),
    }) as unknown as Partial<UploadPolicyModule>
);

vi.mock(
  import("../../lib/vault-links"),
  () =>
    ({
      LAST_BASE: "replica.lastBase",
      LAST_GATEWAY: "replica.lastGateway",
      LAST_VAULT: "replica.lastVault",
      getActiveVaultLink: () => registry.active,
      hydrateVaultLinks: () => Promise.resolve(),
      subscribeVaultLinks: (listener: () => void) => {
        registry.listeners.add(listener);
        return () => registry.listeners.delete(listener);
      },
    }) as unknown as Partial<VaultLinksModule>
);

vi.mock(
  import("../../storage"),
  () =>
    ({
      Store: {
        hydrate: <T,>(_key: string, fallback: T) => Promise.resolve(fallback),
        set: (): void => undefined,
        get: <T,>(_key: string, fallback: T): T => fallback,
      },
    }) as unknown as Partial<StoreModule>
);

vi.mock(
  import("./replica-mount"),
  () =>
    ({
      REPLICA_UNPAIRED_MESSAGE: "Pair this phone.",
      deleteReplicaDatabaseFamily: (): void => undefined,
      discardRestoredReplicaCache: () => Promise.resolve([]),
      fetcher: () => () => Promise.reject(new Error("offline")),
      freshnessKey: (gatewayId: string, vaultId: string) =>
        `freshness:${gatewayId}:${vaultId}`,
      loadFreshness: () => Promise.resolve(new Map<string, string>()),
      mountedScopes: (identity: { auth: { vaultId: string } }) => {
        world.mountPlans += 1;
        const active = identity.auth.vaultId;
        return Promise.resolve(
          [active, ...world.enrolled.filter((vaultId) => vaultId !== active)]
            .filter((vaultId) => !world.revoked.includes(vaultId))
            .slice(0, 4)
            .map((vaultId) => ({
              vaultId,
              label: `${vaultId} vault`,
              canWrite: true,
              databaseName: `/replica/${vaultId}.sqlite3`,
            }))
        );
      },
      refreshCachedScopes: () => Promise.resolve(),
      removeCachedScope: () => Promise.resolve(),
      resolveIdentity: () => Promise.reject(new Error("must not probe")),
    }) as unknown as Partial<ReplicaMountModule>
);

let container: HTMLDivElement;
let root: Root;
let seen: ReplicaContextValue | undefined;

function Probe(): null {
  const value = useReplica();
  React.useEffect(() => {
    seen = value;
  }, [value]);
  return null;
}

async function settle(): Promise<void> {
  for (let pass = 0; pass < 8; pass += 1) {
    // oxlint-disable-next-line no-await-in-loop -- sequential flushes ARE the work
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function mountedVaultIds(): string[] {
  return (seen?.scopes ?? []).map((scope) => scope.vaultId);
}

async function activate(vaultId: string): Promise<void> {
  registry.active = { gatewayId: "gateway-1", vaultId };
  await act(async () => {
    for (const listener of registry.listeners) listener();
    await Promise.resolve();
  });
  await settle();
}

describe("activating a vault outside the mounted four (#880 W3.4)", () => {
  beforeEach(async () => {
    registry.active = { gatewayId: "gateway-1", vaultId: "vault-1" };
    registry.listeners.clear();
    world.enrolled = [
      "vault-1",
      "vault-2",
      "vault-3",
      "vault-4",
      "vault-5",
      "vault-6",
    ];
    net.deviceOnline = false;
    net.base = undefined;
    world.revoked = [];
    world.mountPlans = 0;
    world.purged = [];
    world.closedSessions = [];
    seen = undefined;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        React.createElement(ReplicaProvider, null, React.createElement(Probe))
      );
    });
    await settle();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("mounts the active vault plus three, and no more", () => {
    expect(mountedVaultIds()).toStrictEqual([
      "vault-1",
      "vault-2",
      "vault-3",
      "vault-4",
    ]);
    expect(world.mountPlans).toBe(1);
  });

  it("re-plans the mounted set around the newly active fifth vault", async () => {
    await activate("vault-5");

    expect(mountedVaultIds()).toContain("vault-5");
    expect(mountedVaultIds()).toHaveLength(4);
    expect(world.mountPlans).toBe(2);
    expect(seen?.ready).toBe(true);
  });

  // A remount is open/close over per-vault SQLite files. Purging one would take
  // that vault's durable outbox with it — the exact thing a switch must not do.
  it("closes the evicted sessions without purging a single outbox", async () => {
    await activate("vault-5");

    expect(world.closedSessions).not.toStrictEqual([]);
    expect(world.purged).toStrictEqual([]);
  });

  it("costs nothing when the new active vault is already mounted", async () => {
    await activate("vault-3");

    expect(world.mountPlans).toBe(1);
    expect(mountedVaultIds()).toStrictEqual([
      "vault-1",
      "vault-2",
      "vault-3",
      "vault-4",
    ]);
  });

  // One attempt per vault. A scope the gateway will not hand back must leave
  // the member on a settled screen, not in a mount loop.
  it("does not spin when the vault cannot be mounted at all", async () => {
    world.revoked = ["vault-5"];
    await activate("vault-5");

    expect(world.mountPlans).toBe(2);
    expect(seen?.ready).toBe(true);
  });
});

// Every double above pinned the device offline, so the suite agreed with a
// provider that never connects. These pin the other half of the axis (#905).
describe("a device that is online with a gateway in reach (#905)", () => {
  const BASE = "http://127.0.0.1:9999";

  beforeEach(async () => {
    net.deviceOnline = true;
    net.base = BASE;
    registry.active = { gatewayId: "gateway-1", vaultId: "vault-1" };
    registry.listeners.clear();
    world.enrolled = ["vault-1"];
    world.revoked = [];
    world.mountPlans = 0;
    world.purged = [];
    world.closedSessions = [];
    seen = undefined;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        React.createElement(ReplicaProvider, null, React.createElement(Probe))
      );
    });
    await settle();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("resolves a base and publishes it as the gateway to talk to", () => {
    expect(seen?.gatewayBase).toBe(BASE);
  });

  it("reports itself online rather than settling offline", () => {
    expect(seen?.online).toBe(true);
    expect(seen?.reachability).not.toBe("device-offline");
  });
});
