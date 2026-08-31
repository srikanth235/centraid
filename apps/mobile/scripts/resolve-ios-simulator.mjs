#!/usr/bin/env node
// Resolve the PINNED iOS simulator UDID from `xcrun simctl list devices
// available --json` on stdin (issue #890 W0).
//
// Why this exists: the nightly booted "the first available iPhone". That is a
// device pin in the same sense that `latest` is a version pin — whichever phone
// the macOS image happens to list first, on whichever iOS it happens to ship.
// When a flow reds the morning after an image roll, nothing in the run says the
// device changed, so a real safe-area or gesture regression and a runner-image
// substitution look identical. The pin lives in device-matrix.json next to the
// Android divergence record, and this script is the only thing that reads it
// for iOS.
//
// The ladder is deliberate and ordered: the pinned device first, then named
// fallbacks. A fallback is not a silent success — the resolver prints the rung
// it landed on to stderr so the substitution appears in the job log, and it
// exits non-zero when nothing on the ladder is present rather than booting an
// iPad or an Apple Watch that happened to match "available".

import { readFileSync } from "node:fs";
import path from "node:path";

const MATRIX_PATH = path.join(import.meta.dirname, "device-matrix.json");

/** Read stdin to a string. `/dev/stdin` keeps this synchronous and dependency-free. */
function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * Pick the pinned simulator out of simctl's device listing.
 *
 * @param listing parsed `simctl list devices available --json`
 * @param pin `{ deviceName, osPrefix, fallbackDeviceNames }`
 * @returns `{ udid, name, runtime, rung }` — `rung` is 0 for the pin itself and
 *   1..n for a named fallback, so the caller can report a substitution.
 */
export function resolveSimulator(listing, pin) {
  const ladder = [pin.deviceName, ...(pin.fallbackDeviceNames ?? [])];
  // simctl keys the map by runtime identifier
  // (com.apple.CoreSimulator.SimRuntime.iOS-26-1). Only iOS runtimes are
  // candidates: an available watchOS or tvOS device would otherwise satisfy a
  // name match on a shared model name.
  const runtimes = Object.entries(listing?.devices ?? {}).filter(([runtime]) =>
    runtime.includes(".SimRuntime.iOS-")
  );
  // Newest runtime first, so a pinned device present on two iOS versions
  // resolves to the newer one deterministically rather than by map order.
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
