import { afterEach, describe, expect, test, vi } from "vitest";

import { requireMobileOfflineGateway } from "./mobile-gateway-compatibility";
import { MobileGatewayCompatibilityError } from "./mobile-gateway-compatibility-core";

vi.mock(import("../gateway") as Promise<unknown>, () => ({
  authHeader: () => ({ Authorization: "Bearer test-mobile" }),
}));

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
    ).resolves.toBeUndefined();
    expect(fetchInfo).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:18789/centraid/_gateway/info"),
      { headers: { Authorization: "Bearer test-mobile" } }
    );
  });

  // THE ONE THIS FILE EXISTS TO HOLD. The predecessor cached an online
  // verdict (keyed, worse, by an ephemeral tunnel port) and walled every
  // offline start whose cache came up empty behind "Reconnect once" — local
  // reads gated on the network, observed on a device whose replica held the
  // member's whole vault. An unanswered question is not a judgment: offline
  // fails open, and the wall is re-raised the moment a gateway answers.
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
        protocolVersion: 3,
        minSupportedProtocol: 3,
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
    // 503 proves the gateway is unwell, not that it is incompatible — the
    // only status that IS a judgment by itself is 404 (the info route does
    // not exist on gateways that old). Anything else fails open, same as no
    // answer at all.
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
