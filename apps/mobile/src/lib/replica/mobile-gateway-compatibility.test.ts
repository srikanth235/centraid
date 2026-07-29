import { describe, expect, test } from "vitest";

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
    expect(
      judgeMobileGatewayCompatibility({
        version: "0.1.0",
        protocolVersion: 2,
        minSupportedProtocol: 2,
        schemaEpoch: 2,
        capabilities,
      })
    ).toBe("supported");
    expect(
      judgeMobileGatewayCompatibility({
        version: "old-gateway",
        protocolVersion: 1,
        minSupportedProtocol: 1,
        schemaEpoch: 1,
        capabilities,
      })
    ).toBe("update-gateway");
    expect(
      judgeMobileGatewayCompatibility({
        version: "future-gateway",
        protocolVersion: 3,
        minSupportedProtocol: 3,
        schemaEpoch: 3,
        capabilities,
      })
    ).toBe("update-app");
    expect(
      judgeMobileGatewayCompatibility({
        version: "capability-old",
        protocolVersion: 2,
        minSupportedProtocol: 2,
        schemaEpoch: 2,
        capabilities: base,
      })
    ).toBe("update-gateway");
  });
});
