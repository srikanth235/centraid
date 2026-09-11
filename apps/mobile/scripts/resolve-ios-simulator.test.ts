// Unit spec for the pinned-simulator resolver (#890 W0). The whole point of the
// pin is that a substitution is visible and a miss is loud, so both are asserted
// here rather than left to a nightly to discover.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { resolveSimulator } from "./resolve-ios-simulator.ts";

const PIN = {
  deviceName: "iPhone 17 Pro",
  osPrefix: "iOS-26",
  fallbackDeviceNames: ["iPhone 17", "iPhone 16 Pro"],
};

const device = (name: string, udid: string, isAvailable = true) => ({
  name,
  udid,
  isAvailable,
});

describe(resolveSimulator, () => {
  test("resolves the pinned device on the pinned OS at rung 0", () => {
    const found = resolveSimulator(
      {
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-26-2": [
            device("iPhone 17", "u-17"),
            device("iPhone 17 Pro", "u-17-pro"),
          ],
        },
      },
      PIN
    );
    expect(found).not.toBeNull();
    expect({ udid: found?.udid, rung: found?.rung }).toStrictEqual({
      udid: "u-17-pro",
      rung: 0,
    });
  });

  test("prefers the newest matching runtime when the pin exists on two", () => {
    const found = resolveSimulator(
      {
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-26-1": [
            device("iPhone 17 Pro", "old"),
          ],
          "com.apple.CoreSimulator.SimRuntime.iOS-26-4": [
            device("iPhone 17 Pro", "new"),
          ],
        },
      },
      PIN
    );
    expect(found?.udid).toBe("new");
  });

  test("falls back down the ordered ladder and reports the rung", () => {
    const found = resolveSimulator(
      {
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-26-2": [
            device("iPhone 16 Pro", "u-16-pro"),
            device("iPhone 17", "u-17"),
          ],
        },
      },
      PIN
    );
    // "iPhone 17" is rung 1 and must win over "iPhone 16 Pro" at rung 2 even
    // though the latter is listed first — the ladder's order is the contract.
    expect(found).not.toBeNull();
    expect({ udid: found?.udid, rung: found?.rung }).toStrictEqual({
      udid: "u-17",
      rung: 1,
    });
  });

  test("never resolves a non-iOS runtime, even on an exact name match", () => {
    const found = resolveSimulator(
      {
        devices: {
          "com.apple.CoreSimulator.SimRuntime.watchOS-26-0": [
            device("iPhone 17 Pro", "watch-imposter"),
          ],
        },
      },
      PIN
    );
    expect(found).toBeNull();
  });

  test("never resolves an unavailable device", () => {
    const found = resolveSimulator(
      {
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-26-2": [
            device("iPhone 17 Pro", "u", false),
          ],
        },
      },
      PIN
    );
    expect(found).toBeNull();
  });

  test("returns null rather than any available iPhone when the ladder misses", () => {
    const found = resolveSimulator(
      {
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-26-2": [
            device("iPhone 12 mini", "u-12"),
          ],
        },
      },
      PIN
    );
    expect(found).toBeNull();
  });

  test("the committed matrix declares both platforms and records the Android divergences", () => {
    const matrix = JSON.parse(
      readFileSync(path.join(import.meta.dirname, "device-matrix.json"), "utf8")
    ) as {
      ios: { deviceName: unknown; osPrefix: unknown };
      android: {
        apiLevel: unknown;
        arch: unknown;
        divergences: { deliberate: unknown; why: string; axis: string }[];
      };
    };
    expect(matrix.ios.deviceName).toBeTypeOf("string");
    expect(matrix.ios.osPrefix).toBeTypeOf("string");
    expect(matrix.android.apiLevel).toBe(34);
    expect(matrix.android.arch).toBe("x86_64");
    // A divergence entry with no `why` is a divergence nobody decided.
    expect(matrix.android.divergences.length).toBeGreaterThanOrEqual(2);
    for (const divergence of matrix.android.divergences) {
      expect(divergence.deliberate).toBe(true);
      expect(
        divergence.why.length,
        `${divergence.axis} needs a reason`
      ).toBeGreaterThan(40);
    }
  });
});
