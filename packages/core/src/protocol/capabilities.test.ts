import { describe, expect, it } from "vitest";

import {
  DEFAULT_GATEWAY_CAPABILITIES,
  isGatewayCapabilities,
} from "./capabilities.js";

// Titled in prose, not `describe(DEFAULT_GATEWAY_CAPABILITIES)`: the constant
// is an object, and `describe` only accepts a string or a function.
describe("the default gateway capabilities", () => {
  it("is frozen and advertises the modern loopback surface", () => {
    expect(Object.isFrozen(DEFAULT_GATEWAY_CAPABILITIES)).toBe(true);
    expect(DEFAULT_GATEWAY_CAPABILITIES).toStrictEqual({
      webSessions: true,
      devicePairing: true,
      tunnel: true,
      backupWal: true,
      assistOAuth: false,
      automationTurns: true,
      automations: false,
      connectors: false,
      // All three seat doors are served: the snapshot and log tail (#996 W1)
      // and the locker key (#1015, R-NY-19).
      seatReplica: true,
      seatLockerKey: true,
    });
  });
});

describe(isGatewayCapabilities, () => {
  it("requires every advertised capability to be boolean", () => {
    expect(isGatewayCapabilities(null)).toBe(false);
    expect(isGatewayCapabilities("x")).toBe(false);
    expect(isGatewayCapabilities({})).toBe(false);
    expect(
      isGatewayCapabilities({
        webSessions: true,
        devicePairing: true,
        tunnel: false,
        backupWal: true,
        assistOAuth: false,
        automationTurns: true,
      })
    ).toBe(true);
    expect(
      isGatewayCapabilities({
        webSessions: true,
        devicePairing: true,
        tunnel: true,
        backupWal: true,
        assistOAuth: true,
        automationTurns: true,
      })
    ).toBe(true);
    // Experimental flags are optional: absent reads as off, present must be
    // boolean.
    expect(
      isGatewayCapabilities({
        webSessions: true,
        devicePairing: true,
        tunnel: false,
        backupWal: true,
        assistOAuth: false,
        automationTurns: true,
        automations: true,
        connectors: false,
      })
    ).toBe(true);
    expect(
      isGatewayCapabilities({
        webSessions: true,
        devicePairing: true,
        tunnel: false,
        backupWal: true,
        assistOAuth: false,
        automationTurns: true,
        automations: "yes",
      })
    ).toBe(false);
    expect(
      isGatewayCapabilities({
        webSessions: true,
        devicePairing: true,
        tunnel: false,
        backupWal: true,
        assistOAuth: false,
        automationTurns: true,
        connectors: 1,
      })
    ).toBe(false);
    expect(
      isGatewayCapabilities({
        webSessions: true,
        devicePairing: true,
        tunnel: true,
        backupWal: true,
        assistOAuth: "yes",
        automationTurns: true,
      })
    ).toBe(false);
    expect(
      isGatewayCapabilities({
        webSessions: true,
        devicePairing: true,
        tunnel: true,
        backupWal: true,
        assistOAuth: false,
        automationTurns: "yes",
      })
    ).toBe(false);
    expect(
      isGatewayCapabilities({
        webSessions: true,
        devicePairing: true,
        tunnel: true,
        backupWal: "true",
        assistOAuth: false,
        automationTurns: true,
      })
    ).toBe(false);
  });
});
