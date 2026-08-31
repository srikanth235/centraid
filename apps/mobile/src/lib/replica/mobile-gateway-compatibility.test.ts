// The mobile.contracts owner: what shape the app DEMANDS of a gateway that is
// the right age — which capability keys must be present, how an absent optional
// key reads, and that the wall copy names the gateway rather than the app.
//
// Version SKEW — what happens when the two sides are different ages — is a
// different question and lives in mobile-gateway-skew.test.ts, which owns
// mobile.compat. This file used to carry both, so the matrix reported two green
// cells over one body of evidence; #890 split them, and the judge test that used
// to sit at the bottom of this file moved there rather than being duplicated.

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
});
