// The mobile.compat owner (#890 follow-up): VERSION SKEW, both directions.
//
// This file exists because `mobile.contracts` and `mobile.compat` used to name
// the SAME file (`mobile-gateway-compatibility.test.ts`), so the matrix reported
// two green cells over one body of evidence. They are different questions:
//
//   contracts — what shape the app demands of a gateway that is the right age
//     (which capability keys must be present, how absent keys read). Still owned
//     by the original file.
//   compat    — what happens when the two sides are DIFFERENT ages. That is this
//     file, and almost none of it was covered: the old file proved one step in
//     each direction and nothing about the window arithmetic underneath.
//
// THE MODEL. Each side advertises a RANGE, not a number: the app speaks
// [GATEWAY_MIN_PROTOCOL_VERSION, GATEWAY_PROTOCOL_VERSION] and the gateway
// advertises [minSupportedProtocol, protocolVersion]. Compatible means the two
// ranges OVERLAP. Every case below is a statement about that overlap, written as
// an offset from the shared constants rather than a literal, so the table stays
// true across a protocol bump instead of turning red on the release that moves
// the floor.
//
// NOTE ON TODAY'S WINDOW. Both constants are currently 3, so the app's range is
// the single point [3,3] and the only supported gateway is one whose range
// covers 3. That is an unusually brittle posture and the tests are written to
// SHOW it rather than bake it in: the overlap cases below deliberately use
// gateways with wider ranges, which is what a real rolling deployment produces
// and what the app must keep working against.

import { describe, expect, test } from "vitest";

import {
  GATEWAY_MIN_PROTOCOL_VERSION,
  GATEWAY_PROTOCOL_VERSION,
} from "@centraid/core/protocol";

import { judgeMobileGatewayCompatibility } from "./mobile-gateway-compatibility-core";

/** A capability map that is complete, so protocol is the only variable. */
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

/**
 * A gateway advertising the protocol range [min, protocol].
 *
 * `capabilities` is deliberately a loose record: several cases below hand it a
 * map with a key REMOVED, which is what a gateway too old to know that key
 * actually sends, and which the complete-map type would reject.
 */
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
    // Guards the arithmetic every other case in this file depends on. If a
    // release ever ships MIN above VERSION the app advertises an empty range and
    // NOTHING is compatible — a state where the cases below would still pass
    // individually while the product could not connect to any gateway at all.
    expect(APP_MIN).toBeLessThanOrEqual(APP_MAX);
  });

  describe("overlapping ranges are supported, whichever side is newer", () => {
    test("exact agreement", () => {
      expect(judgeMobileGatewayCompatibility(gatewayAt(APP_MIN, APP_MAX))).toBe(
        "supported"
      );
    });

    test("a NEWER gateway that still speaks our floor", () => {
      // The case a rolling deployment actually produces: the gateway updates
      // first and keeps back-compat. The app must connect, not show a wall.
      // Untested before this file, and the most likely skew in practice.
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
      // The narrowest overlap the arithmetic ALLOWS. It is not, today, a case
      // the wider ones do not already cover: with MIN === VERSION === 3 the app
      // window is the single point [3,3], so `gatewayAt(APP_MAX, APP_MAX + 5)`
      // and `gatewayAt(APP_MIN, APP_MAX + 3)` traverse identical branches and an
      // off-by-one in `protocolsCompatible` reddens both. Verified by mutating
      // `>=` to `>` in each direction rather than assumed. It earns its place by
      // becoming distinct the moment the window widens — which is also when it
      // starts being the case most likely to break.
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
      // Paired with "overlap of exactly one version at the bottom": these two
      // cases sit either side of the same edge. Neither is meaningful alone.
      //
      // KNOWN UNCOVERABLE TODAY, stated so nobody assumes otherwise: the
      // `protocolVersion < GATEWAY_MIN_PROTOCOL_VERSION` comparison inside the
      // judge cannot be distinguished from `<=` by ANY input while the app's
      // window is the single point [3,3]. Verified by mutating the operator and
      // finding no failing input across the suite, not assumed.
      //
      // The REASON is the preceding early return, not range overlap. An earlier
      // draft of this comment said "at equality the ranges always overlap, so
      // the mismatch branch is never entered", which is false — a gateway
      // advertising protocolVersion 3 with minSupportedProtocol 4 does not
      // overlap [3,3] and does reach that branch. What actually pre-empts the
      // comparison is `GATEWAY_PROTOCOL_VERSION < minSupportedProtocol` above
      // it, which returns "update-app" first for every such case. A reader
      // trusting the old explanation would draw the wrong conclusion the moment
      // the window widens — the exact scenario this note exists for.
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
    // TWO DIFFERENT GATEWAYS, two code paths, one required answer. A gateway
    // that OMITS a capability key is too old to know the key exists, and fails
    // `isGatewayCapabilities` as malformed. A gateway that reports the key as
    // `false` is new enough to answer and is telling us the feature is off; its
    // handshake is well formed and it reaches the disposition branch instead.
    // Both must say "update-gateway", and only the second one exercises that
    // branch — a distinction found by mutating the branch and watching an
    // earlier draft of these tests stay green.
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
      // The asymmetry worth pinning: protocol skew can point either way, but a
      // capability the gateway does not offer never means the app is too new.
      // The app cannot be fixed by a store update, and saying otherwise sends
      // the user to the App Store to fix a server they control.
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
    // Every case here is a gateway that answered with something the app cannot
    // parse. The safe disposition is "update-gateway": sending a user to the
    // store because a server sent malformed JSON is an unfixable dead end, and
    // the app is the one side we know is intact enough to be running this code.
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
    // A sweep rather than another example: whatever the constants become, no
    // disjoint range may read as supported. This is the property the individual
    // cases above are instances of, and it is what would catch a future rewrite
    // that special-cases one version and quietly admits the rest.
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
