import { describe, expect, it } from "vitest";

import {
  buildDetachedSpawnOptions,
  decideControl,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_OFFER_GATEWAY_SERVICE,
  resolveListenPort,
  shouldOfferServiceInstall,
} from "./detached-gateway-core.js";

describe("decideControl (gateway.db lock-informed adopt-don't-kill)", () => {
  it("owns a held lock only when the device credential reaches the daemon", () => {
    expect(
      decideControl({
        lockHeld: true,
        credentialedProbeOk: true,
        publicProbeOk: true,
      })
    ).toBe("own");
  });

  it("treats an answering daemon without our credential as foreign", () => {
    expect(
      decideControl({
        lockHeld: true,
        credentialedProbeOk: false,
        publicProbeOk: true,
      })
    ).toBe("foreign");
  });

  it("refuses a lock holder that is not answering", () => {
    expect(
      decideControl({
        lockHeld: true,
        credentialedProbeOk: false,
        publicProbeOk: false,
      })
    ).toBe("probe-failed-refuse");
  });

  it("starts when the kernel lock is free regardless of stale probe state", () => {
    expect(
      decideControl({
        lockHeld: false,
        credentialedProbeOk: false,
        publicProbeOk: false,
      })
    ).toBe("stale-reclaim");
  });
});

describe(resolveListenPort, () => {
  it("returns the stable default when unconfigured", () => {
    expect(resolveListenPort()).toBe(DEFAULT_GATEWAY_PORT);
    expect(resolveListenPort(undefined)).toBe(DEFAULT_GATEWAY_PORT);
  });

  it("rejects zero / negative / out-of-range and falls back to default", () => {
    expect(resolveListenPort(0)).toBe(DEFAULT_GATEWAY_PORT);
    expect(resolveListenPort(-1)).toBe(DEFAULT_GATEWAY_PORT);
    expect(resolveListenPort(70000)).toBe(DEFAULT_GATEWAY_PORT);
    expect(resolveListenPort(1.5)).toBe(DEFAULT_GATEWAY_PORT);
  });

  it("accepts a positive configured port", () => {
    expect(resolveListenPort(8765)).toBe(8765);
  });
});

describe("buildDetachedSpawnOptions (H2)", () => {
  it("describes detached + ignored stdio + unref", () => {
    expect(buildDetachedSpawnOptions()).toStrictEqual({
      detached: true,
      stdio: "ignore",
      unref: true,
    });
  });
});

describe("shouldOfferServiceInstall (H5)", () => {
  it("defaults install off but offers the step during first-run onboarding", () => {
    expect(DEFAULT_OFFER_GATEWAY_SERVICE).toBe(false);
    // No decision + no onboarding stamp → show the opt-in step.
    expect(shouldOfferServiceInstall({})).toBe(true);
  });

  it("does not re-offer after the user decides or finishes onboarding", () => {
    expect(shouldOfferServiceInstall({ offerGatewayService: false })).toBe(
      false
    );
    expect(shouldOfferServiceInstall({ offerGatewayService: true })).toBe(
      false
    );
    expect(
      shouldOfferServiceInstall({
        onboardingCompletedAt: "2026-07-20T00:00:00.000Z",
      })
    ).toBe(false);
  });
});
