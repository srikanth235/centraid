import { describe, expect, test } from "vitest";

import {
  MOBILE_GATEWAY_UPDATE_MESSAGE,
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
      /Update Centraid on the desktop/u
    );
  });
});
