// The forwarder's stamp, at the unit (#1015, ruling R-NY-18). Every case here
// is a way the fallback used to say "host" and must now say nothing.

import { describe, expect, test } from "vitest";

import {
  forwardedDeviceIdentity,
  forwardIdentityHeaders,
  forwardIdentityProof,
} from "./forward-identity.js";
import {
  DEVICE_IDENTITY_HEADER,
  DEVICE_PROOF_HEADER,
  PEER_ENDPOINT_HEADER,
  TUNNEL_FORWARDED_HEADER,
} from "./protocol.js";

const BEARER = "loopback-bearer-0123456789abcdef";

describe(forwardIdentityHeaders, () => {
  test("names the device, proves it, and keeps the forwarded mark", () => {
    const headers = forwardIdentityHeaders(BEARER, "ep-phone");
    expect(headers[DEVICE_IDENTITY_HEADER]).toBe("ep-phone");
    expect(headers[TUNNEL_FORWARDED_HEADER]).toBe("1");
    expect(headers[DEVICE_PROOF_HEADER]).toBe(
      forwardIdentityProof(BEARER, "ep-phone")
    );
  });

  test("never carries the bearer itself", () => {
    const proof = forwardIdentityProof(BEARER, "ep-phone");
    expect(proof).not.toContain(BEARER);
    expect(BEARER).not.toContain(proof);
  });

  test("a different device or a different bearer is a different proof", () => {
    const mine = forwardIdentityProof(BEARER, "ep-phone");
    expect(forwardIdentityProof(BEARER, "ep-other")).not.toBe(mine);
    expect(forwardIdentityProof(`${BEARER}x`, "ep-phone")).not.toBe(mine);
  });
});

describe(forwardedDeviceIdentity, () => {
  test("resolves the device an honest stamp names", () => {
    expect(
      forwardedDeviceIdentity(BEARER, forwardIdentityHeaders(BEARER, "ep-a"))
    ).toBe("ep-a");
  });

  test("refuses a stamp minted for another device", () => {
    expect(
      forwardedDeviceIdentity(BEARER, {
        ...forwardIdentityHeaders(BEARER, "ep-a"),
        [DEVICE_IDENTITY_HEADER]: "ep-b",
      })
    ).toBeUndefined();
  });

  test("refuses a stamp minted under another bearer", () => {
    expect(
      forwardedDeviceIdentity(
        BEARER,
        forwardIdentityHeaders("some-other-bearer", "ep-a")
      )
    ).toBeUndefined();
  });

  test("refuses a proof of the wrong length rather than comparing it", () => {
    expect(
      forwardedDeviceIdentity(BEARER, {
        [DEVICE_IDENTITY_HEADER]: "ep-a",
        [DEVICE_PROOF_HEADER]: "short",
      })
    ).toBeUndefined();
  });

  test("refuses a bare forwarded hop — the fallback this replaced", () => {
    expect(
      forwardedDeviceIdentity(BEARER, { [TUNNEL_FORWARDED_HEADER]: "1" })
    ).toBeUndefined();
    expect(forwardedDeviceIdentity(BEARER, {})).toBeUndefined();
  });

  test("refuses every stamp when this gateway holds no bearer", () => {
    expect(
      forwardedDeviceIdentity(undefined, forwardIdentityHeaders(BEARER, "ep-a"))
    ).toBeUndefined();
  });

  test("refuses the peer lane outright, honest stamp or not", () => {
    // A link's reach is the peer plane or nothing (#726, trap 2), and a peer
    // forwarder delivers to loopback too.
    expect(
      forwardedDeviceIdentity(BEARER, {
        ...forwardIdentityHeaders(BEARER, "ep-a"),
        [PEER_ENDPOINT_HEADER]: "ep-linked-gateway",
      })
    ).toBeUndefined();
  });

  test("reads a repeated header as its first value, never as a join", () => {
    const honest = forwardIdentityHeaders(BEARER, "ep-a");
    expect(
      forwardedDeviceIdentity(BEARER, {
        [DEVICE_IDENTITY_HEADER]: ["ep-a", "ep-b"],
        [DEVICE_PROOF_HEADER]: honest[DEVICE_PROOF_HEADER]!,
      })
    ).toBe("ep-a");
  });
});
