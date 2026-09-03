#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";

const MATRIX_PATH = path.join(import.meta.dirname, "device-matrix.json");

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export function resolveSimulator(listing, pin) {
  const ladder = [pin.deviceName, ...(pin.fallbackDeviceNames ?? [])];
  const runtimes = Object.entries(listing?.devices ?? {}).filter(([runtime]) =>
    runtime.includes(".SimRuntime.iOS-")
  );
  runtimes.sort(([a], [b]) => b.localeCompare(a, "en", { numeric: true }));

  const prefix = pin.osPrefix ?? "iOS-";
  for (let rung = 0; rung < ladder.length; rung += 1) {
    const wanted = ladder[rung];
    for (const preferPrefix of [true, false]) {
      for (const [runtime, devices] of runtimes) {
        if (preferPrefix && !runtime.includes(prefix)) continue;
        for (const device of devices ?? []) {
          if (device?.isAvailable !== true) continue;
          if (device.name !== wanted) continue;
          return { udid: device.udid, name: device.name, runtime, rung };
        }
      }
    }
  }
  return null;
}

function main() {
  const pin = JSON.parse(readFileSync(MATRIX_PATH, "utf8")).ios;
  let listing;
  try {
    listing = JSON.parse(readStdin());
  } catch {
    console.error(
      "::error::resolve-ios-simulator: stdin was not the JSON from " +
        "`xcrun simctl list devices available --json`"
    );
    process.exit(1);
  }
  const found = resolveSimulator(listing, pin);
  if (!found) {
    console.error(
      `::error::no pinned simulator available. Wanted "${pin.deviceName}" on ` +
        `${pin.osPrefix}, or one of ${(pin.fallbackDeviceNames ?? []).join(", ")}. ` +
        `Update apps/mobile/scripts/device-matrix.json deliberately — do not ` +
        `fall back to whichever iPhone the image lists first.`
    );
    process.exit(1);
  }
  if (found.rung > 0) {
    console.error(
      `::warning::pinned simulator "${pin.deviceName}" is absent on this image; ` +
        `fell back to "${found.name}" (${found.runtime}). Re-pin device-matrix.json.`
    );
  } else {
    console.error(`pinned simulator: ${found.name} on ${found.runtime}`);
  }
  process.stdout.write(found.udid);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
