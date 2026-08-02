import type * as ExpoFetch from "expo/fetch";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MobileGatewayCompatibilityError } from "./mobile-gateway-compatibility-core";

const storage = vi.hoisted(() => new Map<string, string>());
const expoFetch = vi.hoisted(() =>
  vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()
);

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

vi.mock(import("expo/fetch") as Promise<typeof ExpoFetch>, () => ({
  fetch: expoFetch,
}));

const { requireMobileOfflineGateway } =
  await import("./mobile-gateway-compatibility");

const supportedInfo = {
  version: "0.1.0",
  protocolVersion: 2,
  minSupportedProtocol: 2,
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

describe("mobile gateway compatibility handshake", () => {
  beforeEach(() => {
    storage.clear();
    expoFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("judges the live info response, caches support, and admits an offline restart", async () => {
    expoFetch.mockImplementation(async () => Response.json(supportedInfo));

    await expect(
      requireMobileOfflineGateway({
        baseUrl: "http://127.0.0.1:18789",
        gatewayId: "gateway/one",
        online: true,
      })
    ).resolves.toBeUndefined();
    expect(expoFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:18789/centraid/_gateway/info",
      { headers: { Authorization: "Bearer test-mobile" } }
    );

    expoFetch.mockImplementation(async () => {
      throw new Error("offline");
    });
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
      }),
      disposition: "update-app",
    },
    {
      name: "a transient server failure asks for a reconnect",
      response: new Response("failed", { status: 503 }),
      disposition: "reconnect",
    },
  ] as const)(
    "$name",
    async ({ response, disposition }) => {
      expoFetch.mockImplementation(async () => response);

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
    },
    45_000
  );

  test("an uncached offline start still probes the last-known base before reconnect", async () => {
    expoFetch.mockImplementation(async () => Response.json(supportedInfo));
    await expect(
      requireMobileOfflineGateway({
        baseUrl: "http://127.0.0.1:18789",
        gatewayId: "unknown-gateway",
        online: false,
      })
    ).resolves.toBeUndefined();
    expect(expoFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:18789/centraid/_gateway/info",
      { headers: { Authorization: "Bearer test-mobile" } }
    );
  }, 45_000);
});
