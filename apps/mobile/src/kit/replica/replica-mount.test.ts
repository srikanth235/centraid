import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  GATEWAY_MIN_PROTOCOL_VERSION,
  GATEWAY_PROTOCOL_VERSION,
} from "@centraid/core/protocol";

const resolveGatewayBase = vi.hoisted(() =>
  vi.fn<() => Promise<string | undefined>>()
);
const noteActiveIdentity = vi.hoisted(() =>
  vi.fn<(input: { gatewayId: string; vaultId: string }) => Promise<void>>(
    async () => undefined
  )
);

const store = vi.hoisted(() => ({
  values: new Map<string, string>(),
  removed: [] as string[],
}));

vi.mock(
  import("@react-native-async-storage/async-storage") as Promise<unknown>,
  () => ({
    default: {
      getItem: async (key: string) => store.values.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        store.values.set(key, value);
      },
      removeItem: async (key: string) => {
        store.removed.push(key);
        store.values.delete(key);
      },
    },
  })
);

const files = vi.hoisted(() => ({
  present: new Set<string>(),
  deleted: [] as string[],
}));

vi.mock(import("expo-file-system") as Promise<unknown>, () => ({
  File: class {
    constructor(readonly uri: string) {}
    get exists(): boolean {
      return files.present.has(this.uri);
    }
    get size(): number {
      return files.present.has(this.uri) ? 4_096 : 0;
    }
    delete(): void {
      files.deleted.push(this.uri);
      files.present.delete(this.uri);
    }
  },
}));

vi.mock(
  import("../../../modules/centraid-storage") as Promise<unknown>,
  () => ({
    pathToFileUri: (path: string) =>
      path.startsWith("/") ? `file://${path}` : path,
  })
);

vi.mock(import("../../lib/gateway") as Promise<unknown>, () => ({
  authHeader: () => ({ Authorization: "Bearer test-mobile" }),
  resolveGatewayBase,
}));

vi.mock(import("@centraid/client/replica/native") as Promise<unknown>, () => ({
  fetchReplicaBootstrapPage: async () => ({ vaultId: "vault-1" }),
}));

vi.mock(import("../../lib/replica/native-hash") as Promise<unknown>, () => ({
  nativeReplicaDigest: async (value: string) => value,
}));

vi.mock(
  import("../../lib/replica/op-sqlite-driver") as Promise<unknown>,
  () => ({ nativeReplicaDatabasePath: async () => "replica.sqlite3" })
);

vi.mock(import("../../lib/vault-links") as Promise<unknown>, () => ({
  LAST_BASE: "replica.lastBase",
  MANUAL_GATEWAY_ID: "manual",
  noteActiveIdentity,
}));

const {
  deleteReplicaDatabaseFamily,
  discardRestoredReplicaCache,
  freshnessKey,
  replicaDatabaseFamily,
  resolveIdentity,
} = await import("./replica-mount");

type MountedScope = Awaited<
  ReturnType<typeof import("./replica-mount").mountedScopes>
>[number];

function mounted(vaultId: string, databaseName: string): MountedScope {
  return { vaultId, label: `${vaultId} vault`, canWrite: true, databaseName };
}

const GATEWAY = "gateway-1";

function cursorKeys(vaultId: string): string[] {
  const suffix = encodeURIComponent(`${GATEWAY} ${vaultId}`);
  return [
    freshnessKey(GATEWAY, vaultId),
    `centraid:multiplex-cursor:${suffix}`,
    `centraid:vault-change-cursor:${suffix}`,
  ];
}

function seedCache(vaultId: string): void {
  for (const key of cursorKeys(vaultId)) store.values.set(key, "1");
}

const ENDPOINT_ID =
  "2315e0468b58adbbf0411da619288dbbb334b40d14ff4ca51cf32a0693367a01";

const info = {
  version: "0.1.0",
  protocolVersion: GATEWAY_PROTOCOL_VERSION,
  minSupportedProtocol: GATEWAY_MIN_PROTOCOL_VERSION,
  endpointId: ENDPOINT_ID,
  capabilities: {
    webSessions: true,
    devicePairing: true,
    tunnel: true,
    backupWal: true,
    assistOAuth: true,
    automationTurns: true,
    multiVaultReplica: true,
    crossVaultPlacements: true,
  },
};

function stubInfo(body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      body === undefined
        ? new Response("boom", { status: 500 })
        : Response.json(body)
    )
  );
}

const pairedVault = {
  id: "sp_1",
  gatewayId: ENDPOINT_ID,
  desktopName: "Personal",
  deviceId: "device-1",
  vaultId: "vault-1",
};

describe("resolveIdentity picks a durable gateway namespace", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    resolveGatewayBase.mockReset();
    noteActiveIdentity.mockClear();
  });

  test("a paired vault's own gateway id is authoritative", async () => {
    resolveGatewayBase.mockResolvedValue("http://127.0.0.1:51890");
    stubInfo(info);

    const identity = await resolveIdentity(pairedVault);

    expect(identity.gatewayId).toBe(ENDPOINT_ID);
    expect(identity.online).toBe(true);
  });

  test("a freshly paired vault keeps its endpoint id, not the desktop name", async () => {
    resolveGatewayBase.mockResolvedValue("http://127.0.0.1:51890");
    stubInfo(info);

    const identity = await resolveIdentity({ ...pairedVault, vaultId: "" });

    expect(identity.gatewayId).toBe(ENDPOINT_ID);
    expect(identity.gatewayId).not.toBe("Personal");
    expect(noteActiveIdentity).toHaveBeenCalledWith({
      gatewayId: ENDPOINT_ID,
      vaultId: "vault-1",
    });
  });

  test("an unpaired install adopts the gateway's reported endpoint id", async () => {
    resolveGatewayBase.mockResolvedValue("http://127.0.0.1:65277");
    stubInfo(info);

    await expect(resolveIdentity(undefined)).resolves.toMatchObject({
      gatewayId: ENDPOINT_ID,
    });
  });

  test("the namespace survives the tunnel moving to a new ephemeral port", async () => {
    stubInfo(info);

    resolveGatewayBase.mockResolvedValue("http://127.0.0.1:65277");
    const first = await resolveIdentity(undefined);
    resolveGatewayBase.mockResolvedValue("http://127.0.0.1:51890");
    const second = await resolveIdentity(undefined);

    expect(second.gatewayId).toBe(first.gatewayId);
    expect(second.auth.baseUrl).not.toBe(first.auth.baseUrl);
  });

  test.each([
    {
      name: "reports no endpoint id",
      body: { ...info, endpointId: undefined },
    },
    { name: "cannot be read at all", body: undefined },
  ])("falls back to a stable id when the gateway $name", async ({ body }) => {
    resolveGatewayBase.mockResolvedValue("http://127.0.0.1:65277");
    stubInfo(body);

    const identity = await resolveIdentity(undefined);

    expect(identity.gatewayId).toBe("manual");
    expect(identity.gatewayId).not.toContain("127.0.0.1");
  });
});

describe("what a restored container may resume from", () => {
  beforeEach(() => {
    store.values.clear();
    store.removed.length = 0;
  });

  test("discards cursors and stamps when the replica database is gone", async () => {
    seedCache("vault-1");

    await expect(
      discardRestoredReplicaCache(
        GATEWAY,
        [mounted("vault-1", "/replica/vault-1.sqlite3")],
        () => false
      )
    ).resolves.toStrictEqual(["vault-1"]);

    for (const key of cursorKeys("vault-1"))
      expect(store.values.has(key)).toBe(false);
  });

  test("leaves a scope whose database really is on disk alone", async () => {
    seedCache("vault-1");

    await expect(
      discardRestoredReplicaCache(
        GATEWAY,
        [mounted("vault-1", "/replica/vault-1.sqlite3")],
        () => true
      )
    ).resolves.toStrictEqual([]);

    expect(store.removed).toStrictEqual([]);
    for (const key of cursorKeys("vault-1"))
      expect(store.values.get(key)).toBe("1");
  });

  test("a first launch after pairing is a cold start, not a restore", async () => {
    await expect(
      discardRestoredReplicaCache(
        GATEWAY,
        [mounted("vault-1", "/replica/vault-1.sqlite3")],
        () => false
      )
    ).resolves.toStrictEqual([]);

    expect(store.removed).toStrictEqual([]);
  });

  test("judges each mounted scope on its own database", async () => {
    seedCache("vault-1");
    seedCache("vault-2");

    await expect(
      discardRestoredReplicaCache(
        GATEWAY,
        [
          mounted("vault-1", "/replica/vault-1.sqlite3"),
          mounted("vault-2", "/replica/vault-2.sqlite3"),
        ],
        (databaseName) => databaseName.endsWith("vault-2.sqlite3")
      )
    ).resolves.toStrictEqual(["vault-1"]);

    for (const key of cursorKeys("vault-2"))
      expect(store.values.get(key)).toBe("1");
  });
});

describe("reclaiming a revoked scope's bytes", () => {
  beforeEach(() => {
    files.present.clear();
    files.deleted.length = 0;
  });

  test("the family is the main file plus every live sidecar", () => {
    expect(replicaDatabaseFamily("/replica/vault-1.sqlite3")).toStrictEqual([
      "/replica/vault-1.sqlite3",
      "/replica/vault-1.sqlite3-journal",
      "/replica/vault-1.sqlite3-wal",
      "/replica/vault-1.sqlite3-shm",
    ]);
  });

  test("deletes every family member that exists, and nothing else", () => {
    files.present.add("file:///replica/vault-1.sqlite3");
    files.present.add("file:///replica/vault-1.sqlite3-wal");
    files.present.add("file:///replica/vault-2.sqlite3");

    deleteReplicaDatabaseFamily("/replica/vault-1.sqlite3");

    expect(files.deleted).toStrictEqual([
      "file:///replica/vault-1.sqlite3",
      "file:///replica/vault-1.sqlite3-wal",
    ]);
    expect(files.present.has("file:///replica/vault-2.sqlite3")).toBe(true);
  });

  test("refuses a bare database name it cannot place", () => {
    files.present.add("replica.sqlite3");

    deleteReplicaDatabaseFamily("replica.sqlite3");

    expect(files.deleted).toStrictEqual([]);
  });
});
