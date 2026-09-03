import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "vitest";

import { resolveSimulator } from "./resolve-ios-simulator.mjs";

const PIN = {
  deviceName: "iPhone 17 Pro",
  osPrefix: "iOS-26",
  fallbackDeviceNames: ["iPhone 17", "iPhone 16 Pro"],
};

const device = (name, udid, isAvailable = true) => ({
  name,
  udid,
  isAvailable,
});

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
  expect({ udid: found.udid, rung: found.rung }).toEqual({
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
  expect(found.udid).toBe("new");
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
  expect({ udid: found.udid, rung: found.rung }).toEqual({
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
  expect(found).toBe(null);
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
  expect(found).toBe(null);
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
  expect(found).toBe(null);
});

test("the committed matrix declares both platforms and records the Android divergences", () => {
  const matrix = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "device-matrix.json"), "utf8")
  );
  expect(typeof matrix.ios.deviceName).toBe("string");
  expect(typeof matrix.ios.osPrefix).toBe("string");
  expect(matrix.android.apiLevel).toBe(34);
  expect(matrix.android.arch).toBe("x86_64");
  expect(matrix.android.divergences.length >= 2).toBe(true);
  for (const divergence of matrix.android.divergences) {
    expect(divergence.deliberate).toBe(true);
    expect(
      divergence.why.length > 40,
      `${divergence.axis} needs a reason`
    ).toBe(true);
  }
});
