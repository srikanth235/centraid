import { describe, expect, test } from "vitest";

import {
  MOBILE_APP_UPDATE_MESSAGE,
  MOBILE_COMPATIBILITY_WALL_COPY,
  MOBILE_GATEWAY_UPDATE_MESSAGE,
  MOBILE_FEATURE_OFF_COPY,
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
});
