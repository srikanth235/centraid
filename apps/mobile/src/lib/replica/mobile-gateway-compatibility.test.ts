import { describe, expect, test } from "vitest";

import {
  GATEWAY_MIN_PROTOCOL_VERSION,
  GATEWAY_PROTOCOL_VERSION,
} from "@centraid/core/protocol";

import {
  MOBILE_APP_UPDATE_MESSAGE,
  MOBILE_COMPATIBILITY_WALL_COPY,
  MOBILE_GATEWAY_UPDATE_MESSAGE,
  MOBILE_FEATURE_OFF_COPY,
  judgeMobileGatewayCompatibility,
  readMobileGatewayFeatures,
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

  // The v0 experimental gates ride the SAME answer as the wall above. The
  // keys are optional on the wire, so their absence is what a gateway that
  // predates them says — and it must read as off, never as malformed.
  test("reads the experimental feature flags off the same capability map", () => {
    const supported = {
      ...base,
      multiVaultReplica: true,
      crossVaultPlacements: true,
    };
    expect(
      readMobileGatewayFeatures({ capabilities: supported })
    ).toStrictEqual({ automations: false, connectors: false });
    expect(
      readMobileGatewayFeatures({
        capabilities: { ...supported, automations: true, connectors: true },
      })
    ).toStrictEqual({ automations: true, connectors: true });
    expect(
      readMobileGatewayFeatures({
        capabilities: { ...supported, automations: true },
      })
    ).toStrictEqual({ automations: true, connectors: false });
    expect(readMobileGatewayFeatures(undefined)).toStrictEqual({
      automations: false,
      connectors: false,
    });
  });

  test("names the gateway, not the app, when a place is switched off", () => {
    expect(MOBILE_FEATURE_OFF_COPY.automations.body).toMatch(/gateway/u);
    expect(MOBILE_FEATURE_OFF_COPY.connectors.body).toMatch(/gateway/u);
  });

  test("uses one update wall instead of retrying unsupported routes", () => {
    expect(MOBILE_COMPATIBILITY_WALL_COPY["update-gateway"].title).toMatch(
      /Update the gateway/u
    );
    expect(MOBILE_GATEWAY_UPDATE_MESSAGE).toMatch(/multi-vault offline sync/u);
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
