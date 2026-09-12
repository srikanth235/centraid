import { spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { defaultRunId } from "../../agent-e2e-shared/harness.ts";
import {
  appIdForPlatform,
  BUILD_TYPE,
  IS_RELEASE_BUILD,
} from "./harness-surface.ts";
import type { MobileRunState } from "./harness-surface.ts";
import {
  METRO_ORIGIN,
  METRO_PORT,
  prewarmMetroBundle,
  waitForMetroReachable,
} from "./metro.ts";

const __dirname = import.meta.dirname;
const RUNS_DIR = path.join(__dirname, "..", "runs");

function spawnText(
  cmd: string,
  args: string[],
  opts: SpawnOptions = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout?.on("data", (d: Buffer | string) => (out += d.toString()));
    p.stderr?.on("data", (d: Buffer | string) => (err += d.toString()));
    p.on("exit", (code) => {
      if (code === 0) resolve(out);
      else
        reject(
          new Error(`${cmd} ${args.join(" ")} exited ${code}: ${err || out}`)
        );
    });
    p.on("error", reject);
  });
}

// Pick the first booted iOS Simulator. Real-device support comes later
// (Maestro takes --device for that; the seed/install story is different).
async function bootedIosSim() {
  const out = await spawnText("xcrun", [
    "simctl",
    "list",
    "devices",
    "booted",
    "--json",
  ]);
  const data: unknown = JSON.parse(out);
  const devices =
    data &&
    typeof data === "object" &&
    "devices" in data &&
    data.devices &&
    typeof data.devices === "object"
      ? data.devices
      : {};
  for (const list of Object.values(devices)) {
    if (!Array.isArray(list)) continue;
    for (const dev of list) {
      if (
        dev &&
        typeof dev === "object" &&
        "state" in dev &&
        "udid" in dev &&
        dev.state === "Booted" &&
        typeof dev.udid === "string"
      ) {
        return dev.udid;
      }
    }
  }
  return null;
}

// Pick the first online Android device (emulator or USB). `adb devices`
// prints "List of devices attached" then `<serial>\t<state>` per line —
// state is `device` for ready, `offline` / `unauthorized` otherwise.
async function bootedAndroidEmu() {
  try {
    const out = await spawnText("adb", ["devices"]);
    for (const line of out.split("\n").slice(1)) {
      const [serial, state] = line.split("\t");
      if (state?.trim() === "device" && serial) return serial.trim();
    }
  } catch {
    // adb not installed or daemon refused — no Android target.
  }
  return null;
}

// Pick a booted device. MAESTRO_PLATFORM=ios|android forces a side;
// otherwise iOS first (legacy behavior), Android fallback.
export async function bootedDevice() {
  const force = process.env.MAESTRO_PLATFORM;
  if (force === "android") {
    const udid = await bootedAndroidEmu();
    return udid ? { udid, platform: "android" } : null;
  }
  if (force === "ios") {
    const udid = await bootedIosSim();
    return udid ? { udid, platform: "ios" } : null;
  }
  const ios = await bootedIosSim();
  if (ios) return { udid: ios, platform: "ios" };
  const android = await bootedAndroidEmu();
  if (android) return { udid: android, platform: "android" };
  return null;
}

async function appInstalled(
  device: { platform: string; udid: string },
  appId: string
): Promise<boolean> {
  if (device.platform === "ios") {
    try {
      await spawnText("xcrun", [
        "simctl",
        "get_app_container",
        device.udid,
        appId,
        "app",
      ]);
      return true;
    } catch {
      return false;
    }
  }
  // Android: `adb shell pm list packages <appId>` echoes `package:<appId>`
  // when installed, empty output otherwise. Exit code is 0 either way.
  try {
    const out = await spawnText("adb", [
      "-s",
      device.udid,
      "shell",
      "pm",
      "list",
      "packages",
      appId,
    ]);
    return out.includes(`package:${appId}`);
  } catch {
    return false;
  }
}

// Forward the Android emulator's `localhost:8081` to the host's
// `localhost:8081` so the Expo dev client (which fetches the JS bundle
// from `localhost:8081` by default) can reach Metro on the dev machine.
// iOS Simulator shares the host network so no reverse is needed there.
async function ensureMetroReverseForAndroid(udid: string): Promise<void> {
  await spawnText("adb", [
    "-s",
    udid,
    "reverse",
    `tcp:${METRO_PORT}`,
    `tcp:${METRO_PORT}`,
  ]);
}

export async function setup({
  runId,
}: { runId?: string } = {}): Promise<MobileRunState> {
  const device = await bootedDevice();
  if (!device) {
    throw new Error(
      "No booted iOS Simulator or Android emulator. For iOS: open Simulator.app " +
        "(or `xcrun simctl boot <udid>`) then `bun run --filter=@centraid/mobile ios`. " +
        "For Android: start an AVD via `emulator @<name>` (or Android Studio) then " +
        "`bun run --filter=@centraid/mobile android`. Set MAESTRO_PLATFORM=ios|android " +
        "to force a side when both are present."
    );
  }
  const appId = appIdForPlatform(device.platform);
  if (!(await appInstalled(device, appId))) {
    throw new Error(
      `${appId} not installed on ${device.platform} device ${device.udid}. ` +
        `Run \`bun run --filter=@centraid/mobile ${device.platform}\` first.`
    );
  }
  // #890 W1 — a RELEASE artifact carries its own Hermes bundle, so there is no
  // bundler to reach, no port to reverse-forward, and nothing to prewarm. This
  // whole block is dev-harness machinery: the reverse forward exists so the dev
  // client can fetch `localhost:8081`, the readiness wait exists because Expo can
  // answer `/status` once and then briefly stop accepting requests while its file
  // graph settles, and the prewarm exists because a `clearState: true` launch
  // drops the dev build's cached bundle. None of the three describes the product,
  // and running them against a release build would fail on a bundler nobody
  // started. It stays for the local exploratory rig, which is what it is for.
  if (!IS_RELEASE_BUILD) {
    if (device.platform === "android") {
      // Must happen before waitForMetroReachable(): the dev client reaches Metro via
      // the reverse forward, but the harness's own fetch goes directly.
      await ensureMetroReverseForAndroid(device.udid);
    }
    if (!(await waitForMetroReachable())) {
      throw new Error(
        `Metro bundler not reachable at ${METRO_ORIGIN} after the bounded readiness wait. ` +
          "The dev build needs it to serve the JS bundle — start it with " +
          "`cd apps/mobile && bun expo start --dev-client`. (A CI lane should not " +
          "reach here at all: set CENTRAID_MOBILE_BUILD=release and drive the " +
          "artifact members install.)"
      );
    }
    await prewarmMetroBundle(device.platform, appId);
  }
  const id = runId ?? defaultRunId();
  const runDir = path.join(RUNS_DIR, id);
  const screenshotsDir = path.join(runDir, "screenshots");
  const flowsDir = path.join(runDir, "flows");
  await fs.mkdir(screenshotsDir, { recursive: true });
  await fs.mkdir(flowsDir, { recursive: true });

  const state = {
    runId: id,
    runDir,
    screenshotsDir,
    flowsDir,
    udid: device.udid,
    platform: device.platform,
    appId,
    // Recorded in state.json and the run ledger: a duration or a failure from a
    // dev-client run and one from the release artifact are not the same
    // measurement, and a ledger that averaged them would produce a p95 nothing
    // ever experienced.
    buildType: BUILD_TYPE,
  };
  await fs.writeFile(
    path.join(runDir, "state.json"),
    JSON.stringify(state, null, 2)
  );
  return state;
}
