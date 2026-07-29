import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MobileGatewayCompatibilityError } from "./mobile-gateway-compatibility-core";

const storage = vi.hoisted(() => new Map<string, string>());

vi.mock(
  import("@react-native-async-storage/async-storage") as Promise<unknown>,
  () => ({
    default: {
      getItem: vi.fn<(key: string) => Promise<string | null>>(
        async (key) => storage.get(key) ?? null
      ),
      removeItem: vi.fn<(key: string) => Promise<void>>(async (key) => {
        storage.delete(key);
      }),
      setItem: vi.fn<(key: string, value: string) => Promise<void>>(
        async (key, value) => {
          storage.set(key, value);
        }
      ),
    },
  })
);

vi.mock(import("../gateway") as Promise<unknown>, () => ({
  authHeader: () => ({ Authorization: "Bearer test-mobile" }),
}));

const supportedInfo = {
  version: "0.1.0",
  protocolVersion: 2,
  minSupportedProtocol: 2,
  schemaEpoch: 2,
  capabilities: {
    webSessions: true,
    devicePairing: true,
    tunnel: true,
    backupWal: true,
    multiVaultReplica: true,
    crossVaultPlacements: true,
  },
};

describe("mobile gateway compatibility handshake", () => {
  beforeEach(() => {
    storage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("judges the live info response, caches support, and admits an offline restart", async () => {
    const fetchInfo = vi.fn<() => Promise<Response>>(async () =>
      Response.json(supportedInfo)
    );
    vi.stubGlobal("fetch", fetchInfo);

    await expect(
      requireMobileOfflineGateway({
        baseUrl: "http://127.0.0.1:18789",
        gatewayId: "gateway/one",
        online: true,
      })
    ).resolves.toBeUndefined();
    expect(fetchInfo).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:18789/centraid/_gateway/info"),
      { headers: { Authorization: "Bearer test-mobile" } }
    );

    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(async () => {
        throw new Error("offline");
      })
    );
    await expect(
      requireMobileOfflineGateway({
        baseUrl: "http://127.0.0.1:18789",
        gatewayId: "gateway/one",
        online: false,
      })
    ).resolves.toBeUndefined();
  });

  test.each([
    {
      name: "missing info route means the gateway is old",
      response: new Response("missing", { status: 404 }),
      disposition: "update-gateway",
    },
    {
      name: "a newer protocol window means the store app is old",
      response: Response.json({
        ...supportedInfo,
        protocolVersion: 3,
        minSupportedProtocol: 3,
        schemaEpoch: 3,
      }),
      disposition: "update-app",
    },
    {
      name: "a transient server failure asks for a reconnect",
      response: new Response("failed", { status: 503 }),
      disposition: "reconnect",
    },
  ] as const)("$name", async ({ response, disposition }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(async () => response)
    );

    const result = requireMobileOfflineGateway({
      baseUrl: "http://127.0.0.1:18789",
      gatewayId: "gateway-two",
      online: true,
    });
    await expect(result).rejects.toBeInstanceOf(
      MobileGatewayCompatibilityError
    );
    await expect(result).rejects.toMatchObject({ disposition });
    expect(storage.size).toBe(0);
  });

  test("an uncached offline start never guesses compatibility", async () => {
    await expect(
      requireMobileOfflineGateway({
        baseUrl: "http://127.0.0.1:18789",
        gatewayId: "unknown-gateway",
        online: false,
      })
    ).rejects.toMatchObject({ disposition: "reconnect" });
  });
});
