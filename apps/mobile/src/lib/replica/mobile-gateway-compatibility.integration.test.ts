import { afterEach, describe, expect, test, vi } from "vitest";

import {
  GATEWAY_MIN_PROTOCOL_VERSION,
  GATEWAY_PROTOCOL_VERSION,
} from "@centraid/core/protocol";

import { requireMobileOfflineGateway } from "./mobile-gateway-compatibility";
import { MobileGatewayCompatibilityError } from "./mobile-gateway-compatibility-core";

vi.mock(import("../gateway") as Promise<unknown>, () => ({
  authHeader: () => ({ Authorization: "Bearer test-mobile" }),
}));

const supportedInfo = {
  version: "0.1.0",
  protocolVersion: GATEWAY_PROTOCOL_VERSION,
  minSupportedProtocol: GATEWAY_MIN_PROTOCOL_VERSION,
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("judges the live info response and admits a supported gateway", async () => {
    const fetchInfo = vi.fn<() => Promise<Response>>(async () =>
      Response.json(supportedInfo)
    );
    vi.stubGlobal("fetch", fetchInfo);

    await expect(
      requireMobileOfflineGateway({
        baseUrl: "http://127.0.0.1:18789",
        online: true,
      })
    ).resolves.toStrictEqual({ automations: false, connectors: false });
    expect(fetchInfo).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:18789/centraid/_gateway/info"),
      { headers: { Authorization: "Bearer test-mobile" } }
    );
  });

  test("reports the experimental features an opted-in gateway advertises", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(async () =>
        Response.json({
          ...supportedInfo,
          capabilities: {
            ...supportedInfo.capabilities,
            automations: true,
            connectors: false,
          },
        })
      )
    );
    await expect(
      requireMobileOfflineGateway({
        baseUrl: "http://127.0.0.1:18789",
        online: true,
      })
    ).resolves.toStrictEqual({ automations: true, connectors: false });
  });

  test("an offline start is admitted — absence of an answer is not a judgment", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(async () => {
        throw new Error("must not be called offline");
      })
    );
    await expect(
      requireMobileOfflineGateway({
        baseUrl: "http://127.0.0.1:18789",
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
        protocolVersion: GATEWAY_PROTOCOL_VERSION + 1,
        minSupportedProtocol: GATEWAY_PROTOCOL_VERSION + 1,
      }),
      disposition: "update-app",
    },
  ] as const)("$name", async ({ response, disposition }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(async () => response)
    );

    const result = requireMobileOfflineGateway({
      baseUrl: "http://127.0.0.1:18789",
      online: true,
    });
    await expect(result).rejects.toBeInstanceOf(
      MobileGatewayCompatibilityError
    );
    await expect(result).rejects.toMatchObject({ disposition });
  });

  test("a transient server failure is the offline case wearing a status code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(
        async () => new Response("failed", { status: 503 })
      )
    );
    await expect(
      requireMobileOfflineGateway({
        baseUrl: "http://127.0.0.1:18789",
        online: true,
      })
    ).resolves.toBeUndefined();
  });
});
