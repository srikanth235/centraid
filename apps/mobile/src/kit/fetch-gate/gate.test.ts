import { describe, expect, test } from "vitest";

import { fetchAccess, isMeteredConnection } from "./gate";
import type { FetchPolicy } from "./policy";
import { defaultFetchPolicy } from "./policy";

describe("default policy classification", () => {
  test("cellular and WiMAX are metered", () => {
    expect(defaultFetchPolicy.connectionKind("CELLULAR")).toBe("metered");
    expect(defaultFetchPolicy.connectionKind("WIMAX")).toBe("metered");
  });

  test("wifi, ethernet and VPN are unmetered", () => {
    expect(defaultFetchPolicy.connectionKind("WIFI")).toBe("unmetered");
    expect(defaultFetchPolicy.connectionKind("ETHERNET")).toBe("unmetered");
    expect(defaultFetchPolicy.connectionKind("VPN")).toBe("unmetered");
  });

  test("an unreported connection type is unknown, not metered", () => {
    expect(defaultFetchPolicy.connectionKind(undefined)).toBe("unknown");
    expect(defaultFetchPolicy.connectionKind("UNKNOWN")).toBe("unmetered");
  });
});

describe("fetchAccess: metered+ask, wifi allowed, consented-metered allowed", () => {
  test("wifi is granted without asking", () => {
    expect(fetchAccess("WIFI", false)).toBe("granted");
  });

  test("metered without consent needs an explicit choice", () => {
    expect(fetchAccess("CELLULAR", false)).toBe("needs-choice");
  });

  test("metered WITH consent is granted", () => {
    expect(fetchAccess("CELLULAR", true)).toBe("granted");
  });

  test("an unreported connection type does not gate", () => {
    expect(fetchAccess(undefined, false)).toBe("granted");
  });

  test("isMeteredConnection matches the policy's classification", () => {
    expect(isMeteredConnection("CELLULAR")).toBe(true);
    expect(isMeteredConnection("WIFI")).toBe(false);
    expect(isMeteredConnection(undefined)).toBe(false);
  });

  test("a caller may pass a different policy (the seam a frame-level store would use)", () => {
    const alwaysMetered: FetchPolicy = { connectionKind: () => "metered" };
    expect(fetchAccess("WIFI", false, alwaysMetered)).toBe("needs-choice");
    const neverMetered: FetchPolicy = { connectionKind: () => "unmetered" };
    expect(fetchAccess("CELLULAR", false, neverMetered)).toBe("granted");
  });
});
