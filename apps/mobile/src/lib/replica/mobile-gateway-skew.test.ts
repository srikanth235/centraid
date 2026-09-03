import { describe, expect, test } from "vitest";

import {
  GATEWAY_MIN_PROTOCOL_VERSION,
  GATEWAY_PROTOCOL_VERSION,
} from "@centraid/core/protocol";

import { judgeMobileGatewayCompatibility } from "./mobile-gateway-compatibility-core";

const COMPLETE_CAPABILITIES = {
  webSessions: true,
  devicePairing: true,
  tunnel: true,
  backupWal: true,
  assistOAuth: true,
  automationTurns: true,
  multiVaultReplica: true,
  crossVaultPlacements: true,
};

function gatewayAt(
  min: number,
  protocol: number,
  capabilities: Record<string, boolean> = COMPLETE_CAPABILITIES
) {
  return {
    version: `stub-${min}-${protocol}`,
    minSupportedProtocol: min,
    protocolVersion: protocol,
    capabilities,
  };
}

const APP_MIN = GATEWAY_MIN_PROTOCOL_VERSION;
const APP_MAX = GATEWAY_PROTOCOL_VERSION;

describe("mobile ↔ gateway version skew", () => {
  test("the app's own advertised range is well formed", () => {
    expect(APP_MIN).toBeLessThanOrEqual(APP_MAX);
  });

  describe("overlapping ranges are supported, whichever side is newer", () => {
    test("exact agreement", () => {
      expect(judgeMobileGatewayCompatibility(gatewayAt(APP_MIN, APP_MAX))).toBe(
        "supported"
      );
    });

    test("a NEWER gateway that still speaks our floor", () => {
      expect(
        judgeMobileGatewayCompatibility(gatewayAt(APP_MIN, APP_MAX + 3))
      ).toBe("supported");
    });

    test("an OLDER gateway whose ceiling still reaches us", () => {
      expect(
        judgeMobileGatewayCompatibility(gatewayAt(APP_MIN - 3, APP_MAX))
      ).toBe("supported");
    });

    test("a gateway whose range strictly contains ours", () => {
      expect(
        judgeMobileGatewayCompatibility(gatewayAt(APP_MIN - 2, APP_MAX + 2))
      ).toBe("supported");
    });

    test("overlap of exactly one version at the top of our range", () => {
      expect(
        judgeMobileGatewayCompatibility(gatewayAt(APP_MAX, APP_MAX + 5))
      ).toBe("supported");
    });

    test("overlap of exactly one version at the bottom of our range", () => {
      expect(
        judgeMobileGatewayCompatibility(gatewayAt(APP_MIN - 5, APP_MIN))
      ).toBe("supported");
    });
  });

  describe("disjoint ranges name the OLDER side, and name it correctly", () => {
    test("a gateway entirely behind us asks for a gateway update", () => {
      expect(
        judgeMobileGatewayCompatibility(gatewayAt(APP_MIN - 4, APP_MIN - 1))
      ).toBe("update-gateway");
    });

    test("a gateway entirely ahead of us asks for an app update", () => {
      expect(
        judgeMobileGatewayCompatibility(gatewayAt(APP_MAX + 1, APP_MAX + 4))
      ).toBe("update-app");
    });

    test("the boundary on the behind side is one version, not two", () => {
      expect(
        judgeMobileGatewayCompatibility(gatewayAt(APP_MIN - 1, APP_MIN - 1))
      ).toBe("update-gateway");
    });

    test("the boundary on the ahead side is one version, not two", () => {
      expect(
        judgeMobileGatewayCompatibility(gatewayAt(APP_MAX + 1, APP_MAX + 1))
      ).toBe("update-app");
    });
  });

  describe("a capability gap is always the gateway's to close", () => {
    test("a well-formed gateway reporting the feature OFF asks for a gateway update", () => {
      expect(
        judgeMobileGatewayCompatibility(
          gatewayAt(APP_MIN, APP_MAX, {
            ...COMPLETE_CAPABILITIES,
            multiVaultReplica: false,
          })
        )
      ).toBe("update-gateway");
    });

    test("a NEWER gateway reporting the feature OFF still asks for a gateway update", () => {
      expect(
        judgeMobileGatewayCompatibility(
          gatewayAt(APP_MIN, APP_MAX + 2, {
            ...COMPLETE_CAPABILITIES,
            crossVaultPlacements: false,
          })
        )
      ).toBe("update-gateway");
    });

    test("a gateway too old to carry the capability keys at all asks for a gateway update", () => {
      const { multiVaultReplica: _absent, ...tooOld } = COMPLETE_CAPABILITIES;
      expect(
        judgeMobileGatewayCompatibility(gatewayAt(APP_MIN, APP_MAX, tooOld))
      ).toBe("update-gateway");
    });
  });

  describe("an unreadable handshake never blames the app", () => {
    test.each([
      ["not an object", "gateway-info"],
      ["null", null],
      [
        "missing the version string",
        { protocolVersion: 3, minSupportedProtocol: 3 },
      ],
      ["missing protocol fields", { version: "0.1.0" }],
      [
        "carrying non-numeric protocol fields",
        {
          version: "0.1.0",
          protocolVersion: "three",
          minSupportedProtocol: "three",
        },
      ],
    ])("%s", (_label, raw) => {
      expect(judgeMobileGatewayCompatibility(raw)).toBe("update-gateway");
    });
  });

  test("never reports supported for a gateway outside our range", () => {
    for (let offset = 1; offset <= 6; offset += 1) {
      expect(
        judgeMobileGatewayCompatibility(
          gatewayAt(APP_MAX + offset, APP_MAX + offset)
        )
      ).not.toBe("supported");
      expect(
        judgeMobileGatewayCompatibility(
          gatewayAt(APP_MIN - offset, APP_MIN - offset)
        )
      ).not.toBe("supported");
    }
  });
});
