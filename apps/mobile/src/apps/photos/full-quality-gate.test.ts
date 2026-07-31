import { describe, expect, test } from "vitest";

import { fullQualityAccess, isMeteredConnection } from "./full-quality-gate";

describe("metered connection detection", () => {
  test("cellular and WiMAX are metered", () => {
    expect(isMeteredConnection("CELLULAR")).toBe(true);
    expect(isMeteredConnection("WIMAX")).toBe(true);
  });

  test("wifi, ethernet and VPN are not", () => {
    expect(isMeteredConnection("WIFI")).toBe(false);
    expect(isMeteredConnection("ETHERNET")).toBe(false);
    expect(isMeteredConnection("VPN")).toBe(false);
  });

  test("an unknown or absent connection type is not treated as metered", () => {
    // Guessing "metered" here would put a tap in front of every photo on a
    // platform that simply does not report the type.
    expect(isMeteredConnection("UNKNOWN")).toBe(false);
    expect(isMeteredConnection(undefined)).toBe(false);
  });
});

describe("full-quality access", () => {
  test("off cellular the original loads without asking", () => {
    expect(fullQualityAccess("WIFI", false)).toBe("granted");
  });

  test("on cellular the original waits for a tap", () => {
    expect(fullQualityAccess("CELLULAR", false)).toBe("needs-tap");
  });

  test("the tap grants access for as long as it is held", () => {
    expect(fullQualityAccess("CELLULAR", true)).toBe("granted");
  });

  test("an unreported connection type does not gate", () => {
    expect(fullQualityAccess(undefined, false)).toBe("granted");
  });
});
