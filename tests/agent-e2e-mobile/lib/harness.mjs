// Mobile agent-e2e harness. One entry point — `runFlow` — handles setup
// governance: allow-repo-hygiene file-size-limit The #716 harness centralizes one simulator/gateway lifecycle; splitting it would duplicate cleanup and verdict invariants.
// (run dir, sim discovery, app-install check), provides a `ctx` surface to
// the flow body (run / restart / note), and writes a verdict.md at the end.
//
// Mirrors tests/agent-e2e/lib/harness.mjs (desktop) in shape, with two real
// differences:
//   1. There's no per-run workspace to seed — the iOS sim and Centraid.app
//      persist across runs. State lives in the app's data container.
//      Flows that need a clean slate use `launchApp: { clearState: true }`.
//   2. Each ctx.run() spawns `maestro test <tmp.yaml>` once. That's heavier
//      than Playwright's CDP messages (~hundreds of ms per call vs ~ms),
//      so flows batch many directives per call instead of one-per-action.
//
// Side CLI for ad-hoc debugging:
//   node lib/harness.mjs setup         -> JSON with runId, platform, udid, runDir
//   node lib/harness.mjs list-devices  -> JSON with first booted device

import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  defaultRunId,
  writeFlowVerdict,
} from "../../agent-e2e-shared/harness.mjs";
import { purgeDemo, seedDemo } from "./demo-corpus.mjs";
import { classifyFailure, countMaestroAssertions } from "./failure-class.mjs";
import {
  DISMISS_KEYBOARD_ONBOARDING,
  retryableTapCommands,
} from "./first-run.mjs";
import { digestLines } from "./hierarchy-digest.mjs";
import {
  DEV_LAUNCHER_LINK,
  METRO_ORIGIN,
  METRO_PORT,
  prewarmMetroBundle,
  waitForMetroReachable,
} from "./metro.mjs";
import { appendRunRecord, ledgerPathFromEnv } from "./run-ledger.mjs";
import { spawnLive, spawnQuiet } from "./spawn.mjs";

const execFileAsync = promisify(execFile);

const __dirname = import.meta.dirname;
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const RUNS_DIR = path.join(__dirname, "..", "runs");

// iOS bundle id, and the Android *release* applicationId. Android *debug*
// builds append `.debug` (applicationIdSuffix in android/app/build.gradle, kept
// so a debug build and a Play-release build can coexist on one device —
// J1/#501). `setup()` resolves the id per platform AND per build type and
// threads it through `state.appId`; flows must launch the package that is
// installed, not this base id, so they read `ctx.state.appId` rather than
// importing APP_ID.
export const APP_ID = "dev.centraid.mobile";

/**
 * Which artifact this run drives (#890 W1). `release` is what every scheduled
 * lane sets — CI tests the build a member installs, with the Hermes bundle
 * embedded, no Metro and no dev launcher. `dev` is the LOCAL exploratory rig:
 * `expo start --dev-client` plus a debug build, which is the loop the Maestro
 * MCP session uses and the only place the dev-harness machinery below belongs.
 *
 * Default `dev` rather than `release` on purpose. A local operator with a dev
 * build and Metro running is the unconfigured case, and defaulting the other way
 * would make their first run fail on a missing package with a confusing message.
 * Every CI lane sets it explicitly, and validate-nightly-wiring.mjs refuses a
 * lane that starts Metro, so the default cannot leak back into CI unnoticed.
 */
export const BUILD_TYPE =
  process.env.CENTRAID_MOBILE_BUILD === "release" ? "release" : "dev";
export const IS_RELEASE_BUILD = BUILD_TYPE === "release";

// A release Android build has NO applicationIdSuffix, so it installs under the
// base id; a debug build installs as `dev.centraid.mobile.debug`. iOS carries
// one bundle id for both configurations. Getting this wrong does not fail
// loudly at install — it fails several minutes later inside Maestro, on a
// launch of a package that is not there (#535).
const appIdForPlatform = (platform) =>
  platform === "android" && !IS_RELEASE_BUILD ? `${APP_ID}.debug` : APP_ID;

/**
 * Budget for the first `assertVisible` after a `clearState: true` launch.
 *
 * `clearState` wipes the dev build's cached JS bundle, so that first launch has
 * to refetch it from Metro. With a warm Metro transform cache that costs a few
 * seconds; with a cold one it is the dominant cost of the whole flow. Measured
 * on this repo: home-loads takes ~19s end-to-end against a warm Metro and ~43s
 * against a cold one on an M-series Mac. The nightly macOS runner is slower
 * still, which is exactly how the old 30s budget failed — CI's launch completed
 * at 13:05:24 and the assertion gave up at 13:05:55, 30s later, on copy that was
 * correct and did eventually render.
 *
 * `setup()` prewarms the bundle so this budget covers app start plus render
 * rather than a cold Metro build, but keep it generous: it is a bundle-fetch
 * wait, not a product-latency assertion, and nothing is proven by making it tight.
 *
 * #892 P0 — ON A RELEASE ARTIFACT THERE IS NO BUNDLE FETCH. Every sentence above
 * prices a dev client refetching its JS from Metro after `clearState`; a release
 * build carries its own Hermes bundle, so a cleared launch is a process start and
 * a first render and nothing else. Keeping the dev number on that path was not
 * merely generous, it was load-bearing in the wrong direction: `extendedWaitUntil`
 * spends its whole ceiling before failing, so each doomed wait burned two minutes
 * of a twelve-minute gate. 45s is still ~4x a healthy cold release launch on the
 * emulator's software GPU, and it is a ceiling, not a target — a passing flow
 * never reaches it.
 */
export const FIRST_LAUNCH_TIMEOUT_MS = IS_RELEASE_BUILD ? 45_000 : 120_000;

/**
 * Quote one value for the DEVICE's shell, for use inside an `adb shell` argv.
 *
 * `adb shell` joins its arguments with spaces and passes the result to
 * `/system/bin/sh` unescaped, so an interpolated payload is re-parsed there:
 * spaces split it into words and an apostrophe opens an unterminated quote.
 * Single quotes are the only fully literal form in `sh`, and the `'\\''` dance is
 * how a single quote is embedded in a single-quoted string — close, escape one
 * quote, reopen.
 *
 * @param {string} value Raw value to embed.
 * @returns {string} The value as one shell-safe word.
 */
export function shQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}
// The Home band's accessibility label (apps/mobile/src/screens/home/
// HomeBand.tsx). The previous marker, "Home ready", was HomeStatusLine's
// settled-state label until #789 replaced that component's copy with the
// dynamic origin-health sentence — leaving every pairing flow waiting on a
// string the app no longer renders (#839). This label is Home-only and
// stable, but it is a render signal, not a settled signal: it appears when
// the band mounts, which may precede tile settlement.
export const HOME_READY_MARKER = "All apps and places";
// THE LAUNCHER — what "Home is ready" was always meant to mean (#905).
//
// The marker above renders in BOTH of Home's branches: the launcher grid and
// the `DayOne` empty-vault fallback (apps/mobile/src/screens/Home.tsx picks
// between them on `springboardState`). So it proves the band mounted and says
// nothing about whether the vault's contents arrived — and a flow that waits
// only for it walks into DayOne and then fails on its own selector. "could not
// tap Open Notes" is what the log said; "the initial replica clone had not
// landed yet" is what had happened.
//
// `home-grid` is published by `LauncherGrid` alone (kit/test-ids.ts
// `TEST_IDS.home.grid`), so it is the first thing on screen that tells the two
// branches apart. It is deliberately a HANDLE: every string on this screen is
// copy that moves, and the branch is the contract.
//
// Waiting on it is also the repair, not merely the diagnosis. Home's tile reads
// are LIVE — `useReplicaQuery` re-reads when a scope syncs — so a clone landing
// a beat after the band flips the screen by itself. Nothing polls; this wait is
// only what gives that beat somewhere to happen.
export const HOME_LAUNCHER_HANDLE = "home-grid";
// Budgeted like the pairing handshake rather than like a render: the initial
// clone crosses iroh, and on a cold emulator that is the slow part.
export const LAUNCHER_ARRIVAL_TIMEOUT_MS = 60_000;
/**
 * Wait for the launcher, for a flow whose next act is opening an app from Home.
 * A flow that deliberately faces an empty vault (a purge, a cleared client)
 * must NOT use this — DayOne is the correct screen there.
 */
export const AWAIT_LAUNCHER = `- extendedWaitUntil:
    visible:
      id: "${HOME_LAUNCHER_HANDLE}"
    timeout: ${LAUNCHER_ARRIVAL_TIMEOUT_MS}
`;
// iOS Simulator's `openLink` (simctl openurl) raises a system
// `Open in "Centraid"?` confirmation for custom-scheme links a moment AFTER the
// openLink directive returns; Android fires the VIEW intent directly. That half
// applies to EVERY build type and is why this constant survives #890 W1: a
// `centraid://` deep link is a product path, not dev-harness machinery.
//
// The second tap is the vestige. On a dev build, because CI reinstalled it every
// run, expo-dev-client showed its one-time "This is the developer menu"
// explainer sheet over whatever the app rendered — both screenshots in the 05:42
// home-loads run show "Connect your gateway." fully painted BEHIND that sheet.
// A release artifact has no developer menu, so on that path the tap matches
// nothing; it is kept rather than gated because `optional: true` already makes a
// non-match a no-op, and one constant that is correct on both build types beats
// two that can drift apart.
//
// `optional: true` absorbs the no-dialog cases (Android, an already-open
// session, or a release build); `^…$` anchors each tap so it cannot land on the
// dialog's own title text, which also contains "Open", or on prose that
// contains "Continue".
export const CONFIRM_SYSTEM_OPEN = `# iOS system confirmation for a custom-scheme openLink, then the dev-client
# first-run explainer — see CONFIRM_SYSTEM_OPEN.
- tapOn:
    text: "^Open$"
    optional: true
- tapOn:
    text: "^Continue$"
    optional: true
`;
// An individual chunk owns one coherent user interaction. Fresh pairing is the
// slowest legitimate chunk (~4 minutes on the reviewed CI runner); 12 minutes
// leaves ample network/render headroom while still terminating a wedged
// accessibility driver before the workflow's outer timeout destroys evidence.
const MAESTRO_CHUNK_TIMEOUT_MS = 12 * 60_000;

// #892 P0 — but 12 minutes is ALSO the whole pr-gate suite budget, so a single
// wedged chunk could spend it and leave the suite's own comparison to report an
// overrun it could no longer prevent. `lib/run-suite.mjs` publishes the suite's
// absolute deadline here; a chunk gets whichever is smaller. A lane with no
// deadline (a local `node flows/<flow>.mjs`, the nightly's un-budgeted members)
// keeps the flat ceiling, so this only ever tightens.
//
// The floor exists because a clamp that reaches zero would kill Maestro before
// it connected and report a driver fault where the truth is "the budget was
// already gone" — the suite runner refuses to start a member in that state, and
// this is the same refusal expressed as a timeout.
const MAESTRO_CHUNK_FLOOR_MS = 15_000;

/**
 * The process timeout for one Maestro chunk: the flat ceiling, clamped to the
 * suite deadline when a suite runner published one.
 *
 * @param {number} [now] injectable clock for the unit suite
 * @returns {number} milliseconds
 */
export function maestroChunkTimeoutMs(now = Date.now()) {
  const deadline = Number(process.env.CENTRAID_MOBILE_DEADLINE_MS);
  if (!Number.isFinite(deadline) || deadline <= 0) {
    return MAESTRO_CHUNK_TIMEOUT_MS;
  }
  const remaining = deadline - now;
  if (remaining >= MAESTRO_CHUNK_TIMEOUT_MS) return MAESTRO_CHUNK_TIMEOUT_MS;
  return Math.max(MAESTRO_CHUNK_FLOOR_MS, remaining);
}

// #890 W1 — the dev-launcher handoff, and the clearest example of what "the
// device under test is not the product" meant. On a DEV build,
// `launchApp: { clearState: true }` wipes expo-dev-client's stored "last opened"
// URL along with app state, so the plain relaunch sits on the launcher's empty
// server picker forever; every cleared-state launch therefore had to hand the
// launcher the Metro bundle URL explicitly, and then tap away the iOS
// `Open in "Centraid"?` confirmation and the one-time developer-menu explainer
// sheet. A RELEASE artifact has no launcher, no custom-scheme round trip and no
// developer menu — it just starts — so on that path this is the empty string
// and the flow observes what the member observes.
//
// Every flow that clears state itself must interpolate THIS rather than
// open-coding the openLink, or it will hang on the picker in dev and tap at
// nothing in release.
export const DEV_LAUNCHER_HANDOFF = IS_RELEASE_BUILD
  ? ""
  : `# clearState wiped the dev client's stored "last opened" URL, so the plain
# launch lands on the launcher's empty server picker. Hand it the bundle URL
# explicitly (DEV_LAUNCHER_LINK in lib/metro.mjs has the full story).
- openLink: "${DEV_LAUNCHER_LINK}"
${CONFIRM_SYSTEM_OPEN}`;

function spawnText(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
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
  const data = JSON.parse(out);
  for (const list of Object.values(data.devices ?? {})) {
    for (const dev of list ?? []) {
      if (dev.state === "Booted") return dev.udid;
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
async function bootedDevice() {
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

async function appInstalled(device, appId) {
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
async function ensureMetroReverseForAndroid(udid) {
  await spawnText("adb", [
    "-s",
    udid,
    "reverse",
    `tcp:${METRO_PORT}`,
    `tcp:${METRO_PORT}`,
  ]);
}

export async function setup({ runId } = {}) {
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

// Write the YAML chunk into flows/ for the audit trail and execute it with
// cwd = screenshots/, so `takeScreenshot: foo` lands at runs/.../screenshots/foo.png.
// `--udid` pins Maestro to the chosen device — without it Maestro picks any
// connected target, which silently runs flows on the wrong platform when
// both an iOS sim and an Android emulator are booted.
/** Long enough for a slow emulator to answer, short enough that a wedged
 *  device cannot add a minute to a failure that already happened. */
const HIERARCHY_TIMEOUT_MS = 20_000;

/** A hierarchy from a scrollable screen is large; the default 1MB truncates it
 *  into unparseable JSON, which reads as "no hierarchy" rather than as a cap. */
const HIERARCHY_MAX_BYTES = 16 * 1024 * 1024;

/**
 * `maestro hierarchy` on the device, as a string, or `undefined`.
 *
 * `execFile` rather than a hand-rolled promise: it already owns the timeout, the
 * kill and the single settlement, and every one of those is a place a bespoke
 * version gets subtly wrong on the failure path.
 */
async function captureHierarchy(udid) {
  try {
    const { stdout } = await execFileAsync(
      "maestro",
      ["--udid", udid, "hierarchy"],
      { maxBuffer: HIERARCHY_MAX_BYTES, timeout: HIERARCHY_TIMEOUT_MS }
    );
    return stdout;
  } catch {
    return undefined;
  }
}

/** Keep the tail bounded: a wedged app can fill logcat faster than anyone reads it. */
const LOGCAT_TAIL_LINES = 4000;
const LOGCAT_DIGEST_LINES = 40;

/**
 * What the app SAID while it was failing, reduced to the replica story.
 *
 * The screen digest answers "what was drawn"; nothing so far has answered "why
 * was it drawn that way". A library that renders its empty state on a vault
 * holding sixteen rows is either a clone that never arrived or a read that
 * cannot see it, and those two look identical from the hierarchy. The app's own
 * console reaches logcat under `ReactNativeJS` even in the release artifact, so
 * this is available without changing one line of the bundle — which matters,
 * because the apk cache key hashes the bundle and a JS-only diagnostic would
 * cost a sixteen-minute rebuild to ask a question.
 *
 * Matched loosely on purpose. A regex tuned to today's phrasing goes quiet the
 * first time a message is reworded, and a quiet diagnostic is worse than none.
 */
const REPLICA_LOG_PATTERN =
  /replica|bootstrap|scope|vault|pull|sync|cursor|clone|undefined is not|Error|Exception/iu;

async function printReplicaDigest(udid) {
  try {
    const { stdout } = await execFileAsync(
      "adb",
      ["-s", udid, "logcat", "-d", "-t", String(LOGCAT_TAIL_LINES)],
      { maxBuffer: HIERARCHY_MAX_BYTES, timeout: HIERARCHY_TIMEOUT_MS }
    );
    const lines = stdout
      .split("\n")
      .filter((line) => /ReactNativeJS|ReactNative:|centraid/iu.test(line))
      .filter((line) => REPLICA_LOG_PATTERN.test(line))
      .slice(-LOGCAT_DIGEST_LINES);
    if (lines.length === 0) {
      console.error("  the app logged nothing about the replica");
      return;
    }
    console.error("  the app logged:");
    for (const line of lines) console.error(`    ${line.trim()}`);
  } catch {
    // Same contract as the screen digest: never outlive the failure it explains.
  }
}

/**
 * Print the handles the failing screen is carrying.
 *
 * Read from the DEVICE, not from `--debug-output`: Maestro writes no hierarchy
 * there under `--flatten-debug-output` — run 33465058064 reported the directory
 * holding only `commands-(<chunk>.yaml).json`, `maestro.log` and a screenshot.
 * Maestro has exited by the time this runs but the app is still foregrounded on
 * the failing screen, so a live capture is both available and more truthful
 * than a file: it is the screen the assertion actually missed on.
 *
 * Swallows everything. This runs while an error is already in flight, and a
 * diagnostic that throws would replace the real failure with its own.
 */
async function printScreenDigest(udid, debugDir) {
  try {
    const lines = digestLines(await captureHierarchy(udid));
    if (lines.length > 0) {
      console.error("  the screen carried:");
      for (const line of lines) console.error(`    ${line}`);
      return;
    }
    // A SILENT NO-OP IS A FAILURE. If the capture came back empty the reason is
    // the next thing anyone needs, so say what the run dir does hold rather
    // than printing nothing and looking like a screen with no handles.
    const names = await fs
      .readdir(debugDir, { recursive: true })
      .catch(() => []);
    console.error(
      `  no hierarchy from the device; ${path.basename(debugDir)} holds: ${
        names.slice(0, 20).join(", ") || "nothing"
      }`
    );
  } catch {
    // Never let the diagnostic outlive the failure it was meant to explain.
  }
}

async function runMaestroChunk(
  yaml,
  { state, label, maestroEnv = {}, sensitive = false }
) {
  const flowFile = path.join(state.flowsDir, `${label}.yaml`);
  const debugDir = path.join(state.runDir, "maestro-debug", label);
  await fs.writeFile(flowFile, yaml);
  // `--debug-output` redirects Maestro's own per-step screenshots and view
  // hierarchies into the run dir. Without it they land in `~/.maestro/tests/`,
  // which the nightly workflow does not upload — so a CI failure arrived with
  // literally no picture of the screen. A flow that fails *before* its first
  // `takeScreenshot` (the 2026-07-20 home-loads failure did) then leaves
  // nothing to diagnose at all. Keep this pointed inside `state.runDir`, which
  // is already an uploaded artifact path.
  const run = sensitive ? spawnQuiet : spawnLive;
  try {
    await run(
      "maestro",
      [
        "--udid",
        state.udid,
        "test",
        "--debug-output",
        debugDir,
        "--flatten-debug-output",
        flowFile,
      ],
      {
        cwd: state.screenshotsDir,
        env: { ...process.env, ...maestroEnv },
        // The chunk's own capabilities, so a failure can print its step lines
        // with every one of them replaced by exact match. `spawnLive` ignores
        // this; only the sensitive path reads it.
        secrets: Object.values(maestroEnv),
        timeoutMs: maestroChunkTimeoutMs(),
      }
    );
  } catch (error) {
    // THE SCREEN, on the failure path only. `Element not found` names the
    // selector that missed and nothing about what was there instead, which is
    // the difference between "Home rendered the other branch" and "the tile is
    // broken" — see hierarchy-digest.mjs. Printed rather than left in the
    // artifact because the artifact is not evidence to a reader who cannot
    // download it.
    //
    // NEVER for a sensitive chunk: its hierarchy is discarded below precisely
    // because it may hold a live enrollment capability, and reading it here to
    // print a digest would defeat the control. The `configure-gateway` guard
    // repeats the workflow's own pre-upload scrub as belt-and-braces, so a
    // chunk that pairs stays silent even if it is ever run non-sensitive.
    if (!sensitive && !label.includes("configure-gateway")) {
      await printScreenDigest(state.udid, debugDir);
      await printReplicaDigest(state.udid);
    }
    throw error;
  } finally {
    // A pairing ticket is a live enrollment capability. Sensitive flows use a
    // MAESTRO_* variable so the retained YAML contains only a placeholder, run
    // without console output, and discard Maestro's hierarchy/screenshots even
    // on failure. The workflow repeats this cleanup before artifact upload as a
    // defense against abrupt harness termination.
    if (sensitive) await fs.rm(debugDir, { force: true, recursive: true });
  }
}

/**
 * Run a mobile agent-e2e flow end-to-end: discover sim → setup run dir →
 * exec → verdict.
 *
 * Usage in flows/<slug>.mjs:
 *
 *   import { runFlow } from '../lib/harness.mjs';
 *   await runFlow('home-loads', async (ctx) => {
 *     await ctx.run(`
 *       appId: dev.centraid.mobile
 *       ---
 *       - launchApp: { clearState: true }
 *       - extendedWaitUntil: { visible: { text: "Connect your gateway." }, timeout: 30000 }
 *       - takeScreenshot: 01-ticket-onboarding
 *     `);
 *     ctx.note('ticket-only onboarding rendered after clearState');
 *     return { pass: true, notes: 'one-line verdict summary' };
 *   });
 *
 * ctx surface:
 *   ctx.state               read-only snapshot of {runId, runDir, udid, appId, ...}
 *   ctx.run(yaml, label?, options?) execute a YAML chunk; screenshots land under runs/.../screenshots/
 *   ctx.restart()           stopApp + launchApp without clearing state — mirrors desktop's ctx.restart()
 *   ctx.configureGateway()  pair from a clean state, or reuse the paired nightly profile when requested
 *   ctx.ensureDemo(appId)   seed a scenario before the initial replica clone, if absent
 *   ctx.purgeDemo(appId)    remove a scenario before an empty-vault journey
 *   ctx.note(msg)           record an observation; surfaces in verdict.md
 *   ctx.device(argv, opts?) one `adb -s <udid> …` / `xcrun simctl … <udid> …`
 *                           against THIS target — the escape for acts that
 *                           originate outside the app (a biometric touch, a
 *                           share intent, a pushed notification, a seeded
 *                           library). argv array only, never a shell string.
 *
 * Failure model: throw OR return { pass: false, ... }. Either writes a FAIL
 * verdict, leaves the run dir in place, and exits non-zero.
 *
 * runDir layout:
 *   runs/<slug-runId>/
 *     state.json
 *     flows/<NN-label>.yaml     ← every ctx.run() chunk, in order
 *     screenshots/<NN-name>.png ← whatever `takeScreenshot:` produced
 *     verdict.md                ← PASS/FAIL + notes (written last)
 */
export async function runFlow(slug, fn) {
  const state = await setup({ runId: `${slug}-${defaultRunId()}` });
  console.log(`[runFlow] ${slug}`);
  console.log(`  run dir : ${path.relative(REPO_ROOT, state.runDir)}`);
  console.log(`  target  : ${state.platform} ${state.udid}`);

  let stepIdx = 0;
  const nextLabel = (hint) => {
    stepIdx += 1;
    const n = String(stepIdx).padStart(2, "0");
    return hint ? `${n}-${hint}` : `${n}-step`;
  };

  const notes = [];
  // The honest bound on "did this flow observe anything before it failed"
  // (#890). We can only know a chunk RAN, never which directive inside it was
  // reached, so a chunk's assertions count once `maestro test` exits 0 and the
  // chunk that threw contributes zero. That undercounts — a chunk failing on
  // its last of six assertions reports none of them — and undercounting is the
  // safe direction: it never inflates the evidence a failure claims to have.
  let assertionsRun = 0;
  const run = async (yaml, hint, options = {}) => {
    const label = nextLabel(hint);
    console.log(`  run     : ${label}`);
    await runMaestroChunk(yaml, { state, label, ...options });
    assertionsRun += countMaestroAssertions(yaml);
  };
  // THE DEVICE ESCAPE (#890 follow-up). Maestro drives ONE app's UI and nothing
  // around it, which is why six W5 journeys were recorded as blocked on "tooling
  // the harness does not wrap": a biometric touch, a share intent from another
  // app, a pushed notification and a seeded photo library all originate OUTSIDE
  // the app under test and have no Maestro directive at all. Each of them is one
  // `adb` or `simctl` invocation, and the only thing missing was somewhere to
  // put it.
  //
  // TARGETED AT state.udid, never at "the device". A flow that shells out to a
  // bare `adb` hits whichever emulator answers first, which on a runner hosting
  // two is a coin flip and produces the worst kind of failure: intermittent, and
  // attributed to the app.
  //
  // ARGV, NOT A STRING — but read the next paragraph before trusting that.
  // Nothing here interpolates a flow's data through the HOST's shell, because
  // spawnText passes argv directly.
  //
  // `adb shell` IS STILL A SHELL, and this is the trap. adb joins its argv with
  // spaces and WITHOUT escaping (its own source carries the comment "We don't
  // escape here, just like ssh(1)"), then hands the result to `/system/bin/sh`
  // on the device. So for `adb shell …` the flow's data is parsed by the
  // DEVICE's shell even though the host never saw a shell: a payload containing
  // spaces splits into separate words, and one containing an apostrophe opens a
  // quote that is never closed. Use `shQuote` on every interpolated value in an
  // `adb shell` argv. Not needed for plain `adb` verbs (`emu`, `install`) or for
  // simctl, neither of which re-parses.
  const device = async (args, { label } = {}) => {
    const hint = label ?? args[0] ?? "device";
    console.log(`  device  : ${hint}`);
    if (state.platform === "android")
      return spawnText("adb", ["-s", state.udid, ...args]);
    return spawnText("xcrun", [
      "simctl",
      args[0],
      state.udid,
      ...args.slice(1),
    ]);
  };

  const ctx = {
    state,
    note(m) {
      notes.push(m);
      console.log(`  note    : ${m}`);
    },
    run,
    device,
  };

  // Mint the one-time pairing ticket the phone will redeem.
  //
  // Two lanes, because the two rigs have different custody. `MAESTRO_GATEWAY_DATA_DIR`
  // drives `centraid-gateway pair`, the supported host-custody path: it derives the
  // daemon's loopback bearer from the data dir itself, which a bare `fetch` cannot
  // (the route answers `unauthorized` without it). Use this against a real
  // `centraid-gateway serve` — the only gateway that owns an iroh endpoint, and
  // therefore the only one whose ticket the phone can actually dial.
  // The HTTP lane stays for a tokenless embedded host that already grants host
  // custody to loopback.
  const mintPairingTicket = async (gatewayUrl, gatewayToken) => {
    const dataDir = process.env.MAESTRO_GATEWAY_DATA_DIR;
    if (dataDir) {
      const cli = path.join(REPO_ROOT, "packages/server/dist/cli/cli.js");
      const port = new URL(gatewayUrl).port;
      // A daemon started with a pinned `CENTRAID_GATEWAY_TOKEN` rejects the
      // bearer the CLI would otherwise derive from `keys/endpoint-key.bin`, so
      // the pin has to travel with the subprocess.
      const pairEnv = gatewayToken
        ? { env: { ...process.env, CENTRAID_GATEWAY_TOKEN: gatewayToken } }
        : {};
      const out = await spawnText(
        "node",
        [
          cli,
          "pair",
          "--data-dir",
          dataDir,
          ...(port ? ["--port", port] : []),
          "--ttl-minutes",
          "30",
          "--json",
        ],
        pairEnv
      );
      // The CLI prints node's SQLite ExperimentalWarning on stdout's sibling
      // stream, but its JSON is the last line either way.
      const line = out.trim().split("\n").at(-1);
      const parsed = JSON.parse(line ?? "{}");
      if (parsed.ok !== true || typeof parsed.ticket !== "string") {
        throw new Error(
          `centraid-gateway pair refused a mobile ticket (${parsed.error ?? "no ticket"})`
        );
      }
      return parsed.ticket;
    }
    const ticketResponse = await fetch(
      `${gatewayUrl.replace(/\/+$/u, "")}/centraid/_gateway/devices/ticket`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(gatewayToken ? { authorization: `Bearer ${gatewayToken}` } : {}),
        },
        body: JSON.stringify({
          ttlMinutes: 15,
        }),
      }
    );
    const ticketResult = await ticketResponse.json().catch(() => ({}));
    if (
      !ticketResponse.ok ||
      ticketResult?.ok !== true ||
      typeof ticketResult.ticket !== "string"
    ) {
      throw new Error(
        `gateway refused mobile pairing ticket (${ticketResult?.error ?? ticketResponse.status})`
      );
    }
    return ticketResult.ticket;
  };

  ctx.configureGateway = async (
    gatewayUrl = process.env.MAESTRO_GATEWAY_URL,
    gatewayToken = process.env.MAESTRO_GATEWAY_TOKEN ?? ""
  ) => {
    if (!gatewayUrl) {
      throw new Error(
        "MAESTRO_GATEWAY_URL is required for this mobile journey"
      );
    }
    if (process.env.MAESTRO_REUSE_PAIRED_STATE === "1") {
      await ctx.run(
        `appId: ${state.appId}
---
- launchApp:
    clearState: false
- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
`,
        "reuse-paired-gateway"
      );
      ctx.note(`reused the paired nightly profile for ${gatewayUrl}`);
      return;
    }
    const pairingTicket = await mintPairingTicket(gatewayUrl, gatewayToken);

    // #603 removed the local/manual-URL bypass: every fresh client must redeem
    // a real one-time pairing ticket. #634 made the profile step conditional:
    // an owner who already has a name goes straight to Done, while one still
    // carrying the placeholder label is asked for a profile. The gateway URL
    // is used only by the host-side harness to mint that ticket; the phone
    // reaches the gateway through the ticket's iroh endpoint.
    //
    // SPLIT AT THE CAPABILITY (#905 P). Everything up to the ticket field is
    // ordinary onboarding: a cold launch and two taps, with nothing on screen
    // and nothing in the environment that is worth protecting. It used to ride
    // in the sensitive chunk anyway, which cost twice over — the ticket was
    // handed to steps that never use it, and the chunk that fails most often on
    // this lane was the one chunk that may not say what it saw. The failing
    // assertion below is the FIRST in the journey, long before redemption.
    await ctx.run(
      `appId: ${state.appId}
---
- launchApp:
    clearState: true
${DEV_LAUNCHER_HANDOFF}- extendedWaitUntil:
    visible:
      text: "Connect your gateway."
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- tapOn: "Can't scan? Paste a code instead"
- extendedWaitUntil:
    visible: "Paste the one-line ticket"
    timeout: 10000
`,
      "open-onboarding"
    );

    // From here the capability is real: the ticket is in the environment and,
    // once typed, on the screen. Kept named `configure-gateway` so the
    // workflow's pre-upload scrub keeps matching it.
    await ctx.run(
      `appId: ${state.appId}
---
- tapOn: "Paste the one-line ticket"
# e2e-lint-allow: unasserted-input — throwaway input only provokes iOS keyboard
# onboarding and is erased before the pairing ticket is entered.
- inputText: "x"
${DISMISS_KEYBOARD_ONBOARDING}- eraseText
# e2e-lint-allow: unasserted-input — Maestro cannot reliably match long
# long React Native TextInput values; successful redemption below is the
# end-to-end observation of the one-time ticket. MAESTRO_* shell variables are
# resolved by Maestro without persisting the live capability in this YAML.
- inputText: \${MAESTRO_PAIRING_TICKET}
- hideKeyboard
# The ticket is deliberately a one-line field, so its stable native Pressable
# remains in the viewport even while the iOS keyboard is still visible.
- tapOn:
    id: "onboarding-connect"
# Redemption dials the gateway over iroh; on a cold simulator that handshake is
# the slowest step in the journey, so budget for the network, not the render.
- extendedWaitUntil:
    visible: "Who's using this phone[?]|You're all set, [^.]+[.]"
    timeout: 90000
`,
      "configure-gateway",
      {
        maestroEnv: { MAESTRO_PAIRING_TICKET: pairingTicket },
        sensitive: true,
      }
    );

    // A second, non-sensitive Maestro chunk keeps the pairing capability out
    // of retained diagnostics while proving both legitimate identity paths.
    // Ownership (#726) killed the pre-named-invite mint: a ticket can no
    // longer carry a chosen label, so the FIRST pairing against a fresh
    // gateway always lands the placeholder owner "You" (not a set name) and
    // shows the form. A later flow that reuses the same nightly gateway
    // process finds that owner already renamed "Nightly" by the run below
    // and skips straight to Done — both are real product paths, so the
    // pattern above accepts either.
    await ctx.run(
      `appId: ${state.appId}
---
- runFlow:
    when:
      visible: "Who's using this phone[?]"
    commands:
      - tapOn: "Your name"
# e2e-lint-allow: unasserted-input — React Native TextInput values are not
# reliably Maestro-matchable; the personalized done heading below proves the
# submitted profile name end to end.
      - inputText: "Nightly"
      - hideKeyboard
      - tapOn: "Continue"
- extendedWaitUntil:
    visible: "You're all set, [^.]+[.]"
    timeout: 60000
# iOS can acknowledge an accessibility tap before the RN Pressable is ready.
# The button's press animation changes the hierarchy even if navigation was
# ignored, so retry only while the source control remains visible. The Home
# marker below remains mandatory and prevents a vacuous pass.
${retryableTapCommands("Enter Centraid")}
# The rail remains visible while Home loads, and the async Daily Brief can move
# every tile when it arrives. Wait for its explicit settled accessibility label
# so the next tap never uses coordinates captured before that layout shift.
- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: 30000
`,
      "complete-onboarding"
    );
    ctx.note(`paired the journey with the gateway at ${gatewayUrl}`);
  };

  /**
   * Ensure one deterministic scenario exists before pairing. Seeding on the
   * host first means the phone's initial replica clone contains the corpus;
   * flows never race a later refresh or depend on execution order. The GET
   * guard also lets all five Photos journeys share one gateway boot safely.
   */
  // Both delegate to lib/demo-corpus.mjs, which the LANE also calls before any
  // flow pairs (#905). Keeping the HTTP in one place is not tidiness here: the
  // lane seeder and these two have to agree on the row-count guard, or the
  // lane's corpus would be re-seeded per flow — or worse, disagree about
  // whether one is present.
  ctx.ensureDemo = async (
    appId,
    gatewayUrl = process.env.MAESTRO_GATEWAY_URL,
    gatewayToken = process.env.MAESTRO_GATEWAY_TOKEN ?? ""
  ) => {
    const result = await seedDemo(appId, gatewayUrl, gatewayToken);
    ctx.note(
      result.seeded
        ? `${appId} demo seeded (${result.rows} rows)`
        : `${appId} demo already present (${result.rows} rows)`
    );
  };

  ctx.purgeDemo = async (
    appId,
    gatewayUrl = process.env.MAESTRO_GATEWAY_URL,
    gatewayToken = process.env.MAESTRO_GATEWAY_TOKEN ?? ""
  ) => {
    const result = await purgeDemo(appId, gatewayUrl, gatewayToken);
    ctx.note(`${appId} demo purged (${result.purged} rows)`);
  };

  // Mirror desktop's ctx.restart(): kill the app process so AsyncStorage
  // flushes, then relaunch without clearing state. The 300ms delay before
  // stopApp gives RN's AsyncStorage time to enter its persistence pipeline
  // (analogous to the desktop harness's flushMs before SIGTERM).
  ctx.restart = async () => {
    console.log("  restart …");
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    await ctx.run(
      `appId: ${state.appId}
---
- stopApp
- launchApp:
    clearState: false
`,
      "restart"
    );
  };

  let error;
  let result;
  const t0 = Date.now();
  const startedAt = new Date(t0).toISOString();
  try {
    result = await fn(ctx);
  } catch (caughtError) {
    error = caughtError;
  }
  const elapsedMs = Date.now() - t0;
  const pass = !error && result?.pass !== false;

  // Owner must be the flow FILE the matrix names, not the flow id — they
  // differ for volume-proof.mjs (id "mobile-volume-proof"), and an id-derived
  // path makes the evidence unmappable in the zero-grey report.
  const owner = path
    .relative(REPO_ROOT, path.resolve(process.argv[1] ?? ""))
    .split(path.sep)
    .join("/");

  await writeFlowVerdict({
    repoRoot: REPO_ROOT,
    slug,
    runDir: state.runDir,
    elapsedMs,
    error,
    notes,
    result,
    metadata: { platform: state.platform, udid: state.udid, app: state.appId },
    debug:
      "Maestro keeps per-step screenshots and ai-report.html under `~/.maestro/tests/<timestamp>/`; the newest directory belongs to this run.",
    owner,
  });

  // The ledger is EVIDENCE, never a gate: a flow that did its job and then
  // could not be recorded still passed. Failing here would let a read-only
  // checkout or a full disk red a green nightly, so the failure is a warning
  // naming the path — the one fact needed to fix it (#890).
  const failure = pass ? null : classifyFailure({ error, assertionsRun });
  try {
    await appendRunRecord({
      flow: owner,
      slug,
      platform: state.platform,
      device: state.udid,
      startedAt,
      durationMs: elapsedMs,
      pass,
      failureClass: failure?.class ?? null,
      failureReason: failure ? `${failure.signal}: ${failure.reason}` : "",
      lane: process.env.CENTRAID_MOBILE_LANE ?? "local",
      runId: state.runId,
      commit: process.env.GITHUB_SHA ?? "",
    });
  } catch (ledgerError) {
    console.warn(
      `  ledger  : could not append to ${ledgerPathFromEnv()} — ${ledgerError.message}`
    );
  }

  if (!pass) {
    if (error) console.error(error);
    process.exit(1);
  }
}

const cmd = process.argv[2];
if (cmd) {
  try {
    let out;
    if (cmd === "setup") out = await setup();
    else if (cmd === "list-devices") out = await bootedDevice();
    else {
      console.error(`unknown command: ${cmd}`);
      process.exit(1);
    }
    console.log(JSON.stringify(out, null, 2));
  } catch (error) {
    console.error(error.message ?? error);
    process.exit(1);
  }
}
