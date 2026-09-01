// The headless pass, with every native module and every collaborator injected
// as a mock: what is under test is the pass's CONTROL FLOW — per-scope
// isolation, the time budget, the connectivity answer it hands its sessions,
// and the registration outcome it records.

import { beforeEach, describe, expect, test, vi } from "vitest";

type CreateSessionOptions = Parameters<
  typeof import("./native-session").createNativeReplicaSession
>[0];
type FakeSession = {
  pullNow: () => Promise<boolean>;
  flushIntents: () => Promise<void>;
  close: () => Promise<void>;
};

const links = {
  hydrateVaultLinks: vi.fn<() => Promise<void>>(async () => undefined),
  getActiveVaultLink: vi.fn<() => { gatewayId: string; vaultId: string }>(
    () => ({ gatewayId: "gateway-1", vaultId: "vault-a" })
  ),
};
const gateway = {
  resolveGatewayBase: vi.fn<() => Promise<string>>(
    async () => "http://127.0.0.1:18789"
  ),
};
const policy = {
  nativeSyncAllowed: vi.fn<() => Promise<boolean>>(async () => true),
};
const network = {
  getNetworkStateAsync: vi.fn<() => Promise<{ isConnected: boolean }>>(
    async () => ({ isConnected: true })
  ),
};
const storage = new Map<string, string>();
const asyncStorage = {
  getItem: vi.fn<(key: string) => Promise<string | null>>(
    async (key) => storage.get(key) ?? null
  ),
  setItem: vi.fn<(key: string, value: string) => Promise<void>>(
    async (key, value) => {
      storage.set(key, value);
    }
  ),
};
const sessionOptions: CreateSessionOptions[] = [];
const sessionFailures = new Map<string, Error>();
const createNativeReplicaSession = vi.fn<
  (options: CreateSessionOptions) => Promise<FakeSession>
>(async (options) => {
  sessionOptions.push(options);
  const failure = sessionFailures.get(options.gatewayAuth.vaultId ?? "");
  if (failure) throw failure;
  return {
    pullNow: async () => true,
    flushIntents: async () => undefined,
    close: async () => undefined,
  };
});
// The device outboxes, in the order the pass drained them: a stage that ran
// twice, ran out of order, or ran past the budget shows up here as state.
const outboxStages: string[] = [];
const facade = {
  flushPlacements: vi.fn<() => Promise<void>>(async () => {
    outboxStages.push("placements");
  }),
  close: vi.fn<() => Promise<void>>(async () => undefined),
};
const drainUploadQueueInBackground = vi.fn<() => Promise<void>>(async () => {
  outboxStages.push("uploads");
});
const notifications = {
  syncDueNotifications: vi.fn<() => Promise<void>>(async () => undefined),
  syncNotifications: vi.fn<() => Promise<void>>(async () => undefined),
};
const backgroundTask = {
  registerTaskAsync: vi.fn<(name: string, options?: unknown) => Promise<void>>(
    async () => undefined
  ),
  getStatusAsync: vi.fn<() => Promise<number>>(async () => 2),
};
const definedTasks = new Map<string, () => Promise<unknown>>();
const expirationListeners: Array<() => void> = [];

// `as Promise<unknown>` on the module specifier, as elsewhere in this suite:
// these stand-ins implement only the members the pass touches, and the real
// module types (enums, 50-member surfaces) are not reconstructible by hand.
vi.mock(
  import("@react-native-async-storage/async-storage") as Promise<unknown>,
  () => ({
    default: asyncStorage,
  })
);
vi.mock(import("expo-background-task") as Promise<unknown>, () => ({
  registerTaskAsync: (name: string, options?: unknown) =>
    backgroundTask.registerTaskAsync(name, options),
  getStatusAsync: () => backgroundTask.getStatusAsync(),
  addExpirationListener: (listener: () => void) => {
    expirationListeners.push(listener);
    return { remove: () => undefined };
  },
  BackgroundTaskResult: { Success: 1, Failed: 2 },
  BackgroundTaskStatus: { Restricted: 1, Available: 2 },
}));
vi.mock(import("expo-network") as Promise<unknown>, () => ({
  getNetworkStateAsync: () => network.getNetworkStateAsync(),
}));
vi.mock(import("expo-notifications") as Promise<unknown>, () => ({
  registerTaskAsync: async () => undefined,
  getPermissionsAsync: async () => ({ granted: false }),
  getExpoPushTokenAsync: async () => undefined,
}));
vi.mock(import("expo-task-manager") as Promise<unknown>, () => ({
  defineTask: (name: string, executor: () => Promise<unknown>) => {
    definedTasks.set(name, executor);
  },
}));
vi.mock(import("react-native") as Promise<unknown>, () => ({
  Platform: { OS: "ios" },
}));
vi.mock(import("../../../modules/centraid-storage"), () => ({
  replicaStorageDirectory: () => "/replica",
  replicaStorageDirectoryUri: () => "file:///replica",
}));
vi.mock(import("../../kit/replica/replica-mount") as Promise<unknown>, () => ({
  deleteReplicaDatabaseFamily: () => undefined,
}));
vi.mock(import("../gateway"), () => ({
  authHeader: () => ({}),
  resolveGatewayBase: () => gateway.resolveGatewayBase(),
}));
vi.mock(import("../notifications-core") as Promise<unknown>, () => ({
  syncDueNotifications: () => notifications.syncDueNotifications(),
  syncNotifications: () => notifications.syncNotifications(),
}));
vi.mock(import("../upload/boot"), () => ({
  drainUploadQueueInBackground: () => drainUploadQueueInBackground(),
}));
vi.mock(import("../upload/native-policy"), () => ({
  nativeSyncAllowed: () => policy.nativeSyncAllowed(),
}));
vi.mock(import("../vault-links") as Promise<unknown>, () => ({
  hydrateVaultLinks: () => links.hydrateVaultLinks(),
  getActiveVaultLink: () => links.getActiveVaultLink(),
}));
vi.mock(import("./mobile-gateway-compatibility") as Promise<unknown>, () => ({
  requireMobileOfflineGateway: async () => undefined,
}));
// Constructor FUNCTIONS, not classes and not arrows: `new` on a function that
// returns an object yields that object, and these modules are only ever `new`ed.
vi.mock(import("./multi-vault-reader") as Promise<unknown>, () => ({
  MultiVaultReplicaReader: function MultiVaultReplicaReader() {
    return {};
  },
}));
vi.mock(import("./multi-vault-session") as Promise<unknown>, () => ({
  MultiVaultReplicaSession: function MultiVaultReplicaSession() {
    return { flushPlacements: facade.flushPlacements, close: facade.close };
  },
}));
vi.mock(import("./native-change-feed") as Promise<unknown>, () => ({
  NativeVaultChangeFeed: function NativeVaultChangeFeed() {
    return { setActive: () => undefined };
  },
}));
vi.mock(import("./native-hash") as Promise<unknown>, () => ({
  nativeReplicaDigest: async () => "digest",
  nativeReplicaIdFactory: () => "id",
}));
vi.mock(import("./native-session") as Promise<unknown>, () => ({
  createNativeReplicaSession: (options: CreateSessionOptions) =>
    createNativeReplicaSession(options),
}));
vi.mock(import("./op-sqlite-driver") as Promise<unknown>, () => ({
  openNativeReplicaDriver: async () => ({ close: () => undefined }),
  openMountedReplicaReaderDriver: async () => ({ close: () => undefined }),
  nativeReplicaDatabasePath: async () => "/replica/db.sqlite3",
}));
vi.mock(import("./placement-transport") as Promise<unknown>, () => ({
  postPlacement: async () => undefined,
}));

const {
  backgroundPassDeadline,
  getReplicaBackgroundRegistrationStatus,
  registerReplicaBackgroundTasks,
  runBackgroundReplicaSync,
} = await import("./background-sync");

const scopeKey = "centraid:replica-scopes:gateway-1";

describe("background replica sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storage.clear();
    storage.set(
      scopeKey,
      JSON.stringify([
        { vaultId: "vault-a", label: "Home", canWrite: true },
        { vaultId: "vault-b", label: "Studio", canWrite: true },
      ])
    );
    sessionOptions.length = 0;
    sessionFailures.clear();
    outboxStages.length = 0;
    network.getNetworkStateAsync.mockResolvedValue({ isConnected: true });
    policy.nativeSyncAllowed.mockResolvedValue(true);
  });

  test("one failing scope never cancels the others or the device outboxes", async () => {
    sessionFailures.set("vault-b", new Error("bootstrap refused"));

    const outcome = await runBackgroundReplicaSync();

    expect(outcome.scopes).toBe(2);
    expect(outcome.synced).toBe(1);
    expect(outcome.failures).toStrictEqual([
      { vaultId: "vault-b", reason: "bootstrap refused" },
    ]);
    expect(outcome.timedOut).toBe(false);
    // The whole point: placements and uploads still drained, once each.
    expect(outboxStages).toStrictEqual(["placements", "uploads"]);
  });

  test("gives the headless session the platform's connectivity answer", async () => {
    network.getNetworkStateAsync.mockResolvedValue({ isConnected: false });

    await runBackgroundReplicaSync();

    expect(sessionOptions).toHaveLength(2);
    // Hardcoding `true` told a session with no radio that its queued writes
    // were sendable.
    expect(sessionOptions[0]?.isConnected?.()).toBe(false);
  });

  test("stops at the pass budget instead of being killed mid-stage", async () => {
    const deadline = backgroundPassDeadline(20_000);
    deadline.expire();

    const outcome = await runBackgroundReplicaSync({ deadline });

    expect(outcome.timedOut).toBe(true);
    expect(outcome.synced).toBe(0);
    expect(createNativeReplicaSession).not.toHaveBeenCalled();
    expect(outboxStages).toStrictEqual([]);
  });

  test("keeps the placement/upload stages inside the budget", async () => {
    let now = 0;
    const deadline = backgroundPassDeadline(20_000, () => now);
    createNativeReplicaSession.mockImplementationOnce(async (options) => {
      // The scopes consumed the whole window.
      now = 25_000;
      sessionOptions.push(options);
      return {
        pullNow: async () => true,
        flushIntents: async () => undefined,
        close: async () => undefined,
      };
    });

    const outcome = await runBackgroundReplicaSync({ deadline });

    expect(outcome.timedOut).toBe(true);
    expect(outboxStages).toStrictEqual([]);
  });

  test("records a refused registration where a status screen can read it", async () => {
    backgroundTask.registerTaskAsync.mockRejectedValueOnce(
      new Error("Background App Refresh is disabled")
    );
    backgroundTask.getStatusAsync.mockResolvedValueOnce(1);

    const status = await registerReplicaBackgroundTasks();

    expect(status.backgroundTask).toStrictEqual({
      registered: false,
      reason: "Background App Refresh is disabled",
    });
    expect(status.availability).toBe("restricted");
    await expect(
      getReplicaBackgroundRegistrationStatus()
    ).resolves.toStrictEqual(status);
  });

  test("the OS task reports Failed only when every selected scope failed", async () => {
    const task = definedTasks.get("centraid-replica-background-sync");
    expect(task).toBeDefined();
    sessionFailures.set("vault-a", new Error("gone"));
    sessionFailures.set("vault-b", new Error("gone"));

    // 2 = BackgroundTaskResult.Failed, 1 = Success.
    await expect(task?.()).resolves.toBe(2);
    // The pass subscribed to iOS's own expiration warning.
    expect(expirationListeners.length).toBeGreaterThan(0);

    sessionFailures.clear();
    await expect(task?.()).resolves.toBe(1);
  });

  test("a deadline reports its remaining budget and honors OS expiration", () => {
    let now = 1_000;
    const deadline = backgroundPassDeadline(20_000, () => now);
    expect(deadline.remainingMs()).toBe(20_000);
    now = 6_000;
    expect(deadline.remainingMs()).toBe(15_000);
    expect(deadline.expired()).toBe(false);
    deadline.expire();
    expect(deadline.remainingMs()).toBe(0);
    expect(deadline.expired()).toBe(true);
  });
});
