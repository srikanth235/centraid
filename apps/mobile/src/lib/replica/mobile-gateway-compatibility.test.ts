import { describe, expect, test } from "vitest";

import {
  GATEWAY_MIN_PROTOCOL_VERSION,
  GATEWAY_PROTOCOL_VERSION,
} from "@centraid/protocol";

import {
  MOBILE_APP_UPDATE_MESSAGE,
  MOBILE_COMPATIBILITY_WALL_COPY,
  MOBILE_GATEWAY_UPDATE_MESSAGE,
  judgeMobileGatewayCompatibility,
  supportsMobileOfflineGateway,
} from "./mobile-gateway-compatibility-core";

const base = {
  webSessions: true,
  devicePairing: true,
  tunnel: true,
  backupWal: true,
  assistOAuth: true,
  automationTurns: true,
};

describe("mobile gateway compatibility", () => {
  test("admits only a gateway advertising both issue-628 contracts", () => {
    expect(
      supportsMobileOfflineGateway({
        capabilities: {
          ...base,
          multiVaultReplica: true,
          crossVaultPlacements: true,
        },
      })
    ).toBe(true);
    expect(supportsMobileOfflineGateway({ capabilities: { ...base } })).toBe(
      false
    );
    expect(
      supportsMobileOfflineGateway({
        capabilities: { ...base, multiVaultReplica: true },
      })
    ).toBe(false);
  });

  test("uses one update wall instead of retrying unsupported routes", () => {
    expect(MOBILE_GATEWAY_UPDATE_MESSAGE).toMatch(
      /Update the Centraid gateway/u
    );
    expect(MOBILE_APP_UPDATE_MESSAGE).toMatch(/App Store or Google Play/u);
    expect(MOBILE_COMPATIBILITY_WALL_COPY["update-app"].action).toMatch(
      /retry/iu
    );
  });

  test("runs the mutual protocol judge and names the older side", () => {
    const capabilities = {
      ...base,
      multiVaultReplica: true,
      crossVaultPlacements: true,
    };
    // Stated against the shared constants, not against literals: the floor
    // moves on breaking releases, and a literal here would assert that a
    // current gateway needs updating the next time it does.
    expect(
      judgeMobileGatewayCompatibility({
        version: "0.1.0",
        protocolVersion: GATEWAY_PROTOCOL_VERSION,
        minSupportedProtocol: GATEWAY_MIN_PROTOCOL_VERSION,
        capabilities,
      })
    ).toBe("supported");
    expect(
      judgeMobileGatewayCompatibility({
        version: "old-gateway",
        protocolVersion: GATEWAY_MIN_PROTOCOL_VERSION - 1,
        minSupportedProtocol: GATEWAY_MIN_PROTOCOL_VERSION - 1,
        capabilities,
      })
    ).toBe("update-gateway");
    expect(
      judgeMobileGatewayCompatibility({
        version: "future-gateway",
        protocolVersion: GATEWAY_PROTOCOL_VERSION + 1,
        minSupportedProtocol: GATEWAY_PROTOCOL_VERSION + 1,
        capabilities,
      })
    ).toBe("update-app");
    expect(
      judgeMobileGatewayCompatibility({
        version: "capability-old",
        protocolVersion: GATEWAY_PROTOCOL_VERSION,
        minSupportedProtocol: GATEWAY_MIN_PROTOCOL_VERSION,
        capabilities: base,
      })
    ).toBe("update-gateway");
  });
});
