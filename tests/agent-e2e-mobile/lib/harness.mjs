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

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  defaultRunId,
  writeFlowVerdict,
} from "../../agent-e2e-shared/harness.mjs";
import {
  COMPLETE_PROFILE_NAME,
  DISMISS_KEYBOARD_ONBOARDING,
  fillSampleContentFlow,
  LAUNCHER_RECOVERY,
  retryableTapCommands,
} from "./first-run.mjs";
import {
  DEV_LAUNCHER_LINK,
  MOBILE_E2E_EMBEDDED,
  METRO_ORIGIN,
  METRO_PORT,
  prewarmMetroBundle,
  waitForMetroReachable,
} from "./metro.mjs";
import { spawnLive, spawnQuiet } from "./spawn.mjs";

const __dirname = import.meta.dirname;
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const RUNS_DIR = path.join(__dirname, "..", "runs");

// iOS bundle id and Android release applicationId. Local Android development
// builds append `.debug`; embedded CI builds exercise the release package so
// both platforms validate the same bundle-owning runtime shape.
// `setup()` resolves the id per platform and threads it through `state.appId`;
// flows must launch the package that is installed, not this base id, so they
// read `ctx.state.appId` rather than importing APP_ID.
export const APP_ID = "dev.centraid.mobile";
const appIdForPlatform = (platform) =>
  platform === "android" && !MOBILE_E2E_EMBEDDED ? `${APP_ID}.debug` : APP_ID;

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
 * 240s: the nightly macOS runner's cold bundle load is minutes, not seconds —
 * dispatch 32933893665's reuse launches exceeded 120s before Home mounted.
 */
export const FIRST_LAUNCH_TIMEOUT_MS = 240_000;
// Ordinary in-app navigation is never allowed to consume the cold-launch
// allowance. A broken tap or destination fails near the action that broke,
// while onboarding, pairing, and first replica paint retain their own budget.
export const SCREEN_TRANSITION_TIMEOUT_MS = 30_000;
export const RELAUNCH_TIMEOUT_MS = 60_000;
// The Home band's accessibility label (apps/mobile/src/screens/home/
// HomeBand.tsx). The previous marker, "Home ready", was HomeStatusLine's
// settled-state label until #789 replaced that component's copy with the
// dynamic origin-health sentence — leaving every pairing flow waiting on a
// string the app no longer renders (#839). This label is Home-only and
// stable, but it is a render signal, not a settled signal: it appears when
// the band mounts, which may precede tile settlement.
export const HOME_READY_MARKER = "All apps and places";
// iOS Simulator's `openLink` (simctl openurl) raises a system
// `Open in "Centraid"?` confirmation for custom-scheme links a moment AFTER
// the openLink directive returns; Android fires the VIEW intent directly.
// Then expo-dev-client layers two more first-run interruptions on top of the
// rendered app (CI reinstalls the dev build every run, so they always hit):
// its one-time "This is the developer menu" explainer, and — observed in the
// 16:39 local run — the dev menu sheet itself, open over the fully painted
// "Connect your gateway." screen. `optional: true` absorbs every no-dialog
// case (Android, or an already-open session); `waitUntilVisible` absorbs the
// iOS sheet's delayed presentation; `^…$` anchors each tap so it cannot land
// on prose that merely contains the word.
export const CONFIRM_SYSTEM_OPEN = `# iOS system confirmation for a custom-scheme openLink, then the dev-client
# explainer and dev-menu sheets — see CONFIRM_SYSTEM_OPEN.
- tapOn:
    text: "^Open$"
    optional: true
    waitUntilVisible: true
- tapOn:
    text: "^Continue$"
    optional: true
- tapOn:
    text: "^Close$"
    optional: true
`;
// An individual chunk owns one coherent user interaction. Keep pairing and
// profile completion in the same Maestro invocation: the iOS driver startup is
// expensive on hosted runners, and splitting those sequential setup actions
// turns infrastructure cost into a misleading app timeout. The invocation is
// still marked sensitive while the ticket is in scope, so its diagnostics are
// sanitized before upload.
const MAESTRO_CHUNK_TIMEOUT_MS = 12 * 60_000;
const COMMAND_TIMEOUT_MS = 30_000;
// CoreSimulator can take longer than the ordinary command budget while its
// launchd service is waking or several hosted jobs are booting devices at
// once. Keep the timeout bounded, but do not turn a slow simulator query into
// a false "no device" setup failure.
const XCRUN_TIMEOUT_MS = 90_000;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const MAESTRO_DRIVER_STARTUP_TIMEOUT_MS = 180_000;
const DETACHED = process.platform !== "win32";

function killTree(child, signal) {
  try {
    if (DETACHED && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The command may already have exited.
  }
}

function spawnText(
  cmd,
  args,
  { timeoutMs = COMMAND_TIMEOUT_MS, sensitive = false, ...spawnOptions } = {}
) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      ...spawnOptions,
      detached: DETACHED,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let forceKillTimer;
    let settled = false;
    let timedOut = false;
    const append = (current, chunk) =>
      `${current}${chunk.toString()}`.slice(-MAX_COMMAND_OUTPUT_BYTES);
    p.stdout.on("data", (d) => (out = append(out, d)));
    p.stderr.on("data", (d) => (err = append(err, d)));
    const timeout = setTimeout(() => {
      timedOut = true;
      killTree(p, "SIGTERM");
      forceKillTimer = setTimeout(() => killTree(p, "SIGKILL"), 5_000);
      forceKillTimer.unref();
    }, timeoutMs);
    timeout.unref();
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      callback();
    };
    p.on("close", (code) => {
      finish(() => {
        if (timedOut) {
          reject(new Error(`${cmd} exceeded its ${timeoutMs}ms timeout`));
        } else if (code === 0) {
          resolve(out);
        } else {
          const detail = sensitive ? "" : `: ${err || out}`;
          reject(new Error(`${cmd} exited ${code}${detail}`));
        }
      });
    });
    p.on("error", (error) => finish(() => reject(error)));
  });
}

// Pick the first booted iOS Simulator. Real-device support comes later
// (Maestro takes --device for that; the seed/install story is different).
async function bootedIosSim() {
  const out = await spawnText(
    "xcrun",
    ["simctl", "list", "devices", "booted", "--json"],
    { timeoutMs: XCRUN_TIMEOUT_MS }
  );
  const data = JSON.parse(out);
  const preferred =
    process.env.MAESTRO_DEVICE_UDID ?? process.env.SIMULATOR_UDID;
  for (const list of Object.values(data.devices ?? {})) {
    for (const dev of list ?? []) {
      if (
        dev.state === "Booted" &&
        (!preferred || String(dev.udid) === preferred)
      )
        return dev.udid;
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
    const preferred =
      process.env.ANDROID_SERIAL ?? process.env.MAESTRO_DEVICE_UDID;
    for (const line of out.split("\n").slice(1)) {
      const [serial, state] = line.split("\t");
      if (
        state?.trim() === "device" &&
        serial &&
        (!preferred || serial.trim() === preferred)
      )
        return serial.trim();
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
      await spawnText(
        "xcrun",
        ["simctl", "get_app_container", device.udid, appId, "app"],
        { timeoutMs: XCRUN_TIMEOUT_MS }
      );
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
  if (!MOBILE_E2E_EMBEDDED) {
    if (device.platform === "android") {
      // Must happen before waitForMetroReachable(): the dev client reaches Metro via
      // the reverse forward, but the harness's own fetch goes directly.
      await ensureMetroReverseForAndroid(device.udid);
    }
    if (!(await waitForMetroReachable())) {
      throw new Error(
        `Metro bundler not reachable at ${METRO_ORIGIN} after the bounded readiness wait. ` +
          "The dev build needs it to serve the JS bundle — start it with " +
          "`cd apps/mobile && bun expo start --dev-client`."
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
async function readJunitSummary(reportFile, { required }) {
  let xml;
  try {
    xml = await fs.readFile(reportFile, "utf8");
  } catch (error) {
    if (required)
      throw new Error(`Maestro emitted no JUnit report at ${reportFile}`, {
        cause: error,
      });
    return { tests: 0, failures: 0, skipped: 0 };
  }
  const summary = {
    tests: (xml.match(/<testcase(?:\s|>)/gu) ?? []).length,
    failures: (xml.match(/<(?:failure|error)(?:\s|>)/gu) ?? []).length,
    skipped: (xml.match(/<skipped(?:\s|>)/gu) ?? []).length,
  };
  if (required && summary.tests === 0) {
    throw new Error(
      `Maestro JUnit report contains no test cases: ${reportFile}`
    );
  }
  return summary;
}

async function runMaestroChunk(
  yaml,
  { state, label, maestroEnv = {}, sensitive = false }
) {
  const flowFile = path.join(state.flowsDir, `${label}.yaml`);
  const debugDir = path.join(state.runDir, "maestro-debug", label);
  const reportsDir = sensitive
    ? debugDir
    : path.join(state.runDir, "maestro-reports");
  const reportFile = path.join(reportsDir, `${label}.xml`);
  await fs.writeFile(flowFile, yaml);
  await fs.mkdir(reportsDir, { recursive: true });
  // `--debug-output` redirects Maestro's own per-step screenshots and view
  // hierarchies into the run dir. Without it they land in `~/.maestro/tests/`,
  // which the nightly workflow does not upload — so a CI failure arrived with
  // literally no picture of the screen. A flow that fails *before* its first
  // `takeScreenshot` (the 2026-07-20 home-loads failure did) then leaves
  // nothing to diagnose at all. Keep this pointed inside `state.runDir`, which
  // is already an uploaded artifact path.
  const run = sensitive ? spawnQuiet : spawnLive;
  const sanitizedReport = path.join(
    state.runDir,
    "maestro-reports",
    `${label}.sanitized.json`
  );
  let commandError;
  let junitSummary = { tests: 0, failures: 0, skipped: 0 };
  try {
    await run(
      "maestro",
      [
        "--udid",
        state.udid,
        "test",
        "--debug-output",
        debugDir,
        "--test-output-dir",
        debugDir,
        "--flatten-debug-output",
        "--format",
        "junit",
        "--output",
        reportFile,
        flowFile,
      ],
      {
        cwd: state.screenshotsDir,
        env: {
          ...process.env,
          MAESTRO_DRIVER_STARTUP_TIMEOUT:
            process.env.MAESTRO_DRIVER_STARTUP_TIMEOUT ??
            String(MAESTRO_DRIVER_STARTUP_TIMEOUT_MS),
          ...maestroEnv,
        },
        timeoutMs: MAESTRO_CHUNK_TIMEOUT_MS,
      }
    );
    junitSummary = await readJunitSummary(reportFile, { required: true });
  } catch (error) {
    commandError = error;
    junitSummary = await readJunitSummary(reportFile, { required: false });
    throw error;
  } finally {
    // A pairing ticket is a live enrollment capability. Sensitive flows use a
    // MAESTRO_* variable so the retained YAML contains only a placeholder, run
    // without console output, and discard Maestro's hierarchy/screenshots even
    // on failure. The workflow repeats this cleanup before artifact upload as a
    // defense against abrupt harness termination.
    if (sensitive) {
      await fs.mkdir(path.dirname(sanitizedReport), { recursive: true });
      await fs.writeFile(
        sanitizedReport,
        `${JSON.stringify(
          {
            status: commandError ? "failed" : "passed",
            ...junitSummary,
          },
          null,
          2
        )}\n`
      );
      await fs.rm(debugDir, { force: true, recursive: true });
    }
  }
  return sensitive ? sanitizedReport : reportFile;
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
  const t0 = Date.now();
  const runId = `${slug}-${defaultRunId()}`;
  const owner = path
    .relative(REPO_ROOT, path.resolve(process.argv[1] ?? ""))
    .split(path.sep)
    .join("/");
  let state;
  try {
    state = await setup({ runId });
  } catch (error) {
    const runDir = path.join(RUNS_DIR, runId);
    await fs.mkdir(runDir, { recursive: true });
    await writeFlowVerdict({
      repoRoot: REPO_ROOT,
      slug,
      runDir,
      elapsedMs: Date.now() - t0,
      error,
      notes: [],
      metadata: { phase: "setup" },
      debug:
        "Setup failed before Maestro started; inspect the suite result and gateway/simulator setup steps.",
      owner,
    });
    console.error(error);
    process.exit(1);
  }
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
  const reportPaths = [];
  const run = async (yaml, hint, options = {}) => {
    const label = nextLabel(hint);
    console.log(`  run     : ${label}`);
    const report = await runMaestroChunk(yaml, { state, label, ...options });
    reportPaths.push(path.relative(REPO_ROOT, report));
  };
  const ctx = {
    state,
    note(m) {
      notes.push(m);
      console.log(`  note    : ${m}`);
    },
    run,
  };

  const markPairedFixtureReady = async () => {
    const marker = process.env.MOBILE_E2E_PREREQUISITE_FILE;
    if (!marker) return;
    await fs.mkdir(path.dirname(marker), { recursive: true });
    const temporary = `${marker}.${process.pid}.tmp`;
    await fs.writeFile(
      temporary,
      `${JSON.stringify(
        {
          ready: true,
          runId: state.runId,
          platform: state.platform,
          udid: state.udid,
          appId: state.appId,
          gatewayUrl: process.env.MAESTRO_GATEWAY_URL ?? null,
          fixtureId:
            process.env.MOBILE_E2E_FIXTURE_ID ??
            `local:${process.env.MAESTRO_GATEWAY_URL ?? "unknown"}`,
          capturedAt: new Date().toISOString(),
        },
        null,
        2
      )}\n`
    );
    await fs.rename(temporary, marker);
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
      const pairEnv = {
        sensitive: true,
        ...(gatewayToken
          ? { env: { ...process.env, CENTRAID_GATEWAY_TOKEN: gatewayToken } }
          : {}),
      };
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
          ttlMinutes: 5,
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

  ctx.configureGateway = async ({
    gatewayUrl = process.env.MAESTRO_GATEWAY_URL,
    gatewayToken = process.env.MAESTRO_GATEWAY_TOKEN ?? "",
    // Tile-driven journeys opt in: a fresh pairing can settle Home on the
    // first-run hero (every tile empty), which leaves no tile to tap. The
    // default stays false for journeys whose premise IS the empty vault
    // (photos-permissions) or that only wait on the band label (cold-start,
    // volume-proof).
    fillSampleContent = false,
    requiredLauncher = "Open Photos.*",
  } = {}) => {
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
${LAUNCHER_RECOVERY}- extendedWaitUntil:
    visible: "${HOME_READY_MARKER}"
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
${fillSampleContent ? fillSampleContentFlow(requiredLauncher) : ""}`,
        "reuse-paired-gateway"
      );
      await markPairedFixtureReady();
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
    const freshLaunch = MOBILE_E2E_EMBEDDED
      ? `- launchApp:
    clearState: true
    clearKeychain: ${state.platform === "ios" ? "true" : "false"}
`
      : `- launchApp:
    clearState: true
# clearState wiped the dev client's stored "last opened" URL, so the plain
# launch lands on the launcher's empty server picker. Hand it the bundle URL
# explicitly (DEV_LAUNCHER_LINK in lib/metro.mjs has the full story).
- openLink: "${DEV_LAUNCHER_LINK}"
${CONFIRM_SYSTEM_OPEN}`;
    await ctx.run(
      `appId: ${state.appId}
---
${freshLaunch}- extendedWaitUntil:
    visible:
      text: "Connect your gateway."
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- tapOn: "Can't scan? Paste a code instead"
- extendedWaitUntil:
    visible: "Paste the one-line ticket"
    timeout: 10000
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
${COMPLETE_PROFILE_NAME}- extendedWaitUntil:
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
${fillSampleContent ? fillSampleContentFlow(requiredLauncher) : ""}
`,
      "configure-gateway",
      {
        maestroEnv: { MAESTRO_PAIRING_TICKET: pairingTicket },
        sensitive: true,
      }
    );
    await markPairedFixtureReady();
    ctx.note(`paired the journey with the gateway at ${gatewayUrl}`);
  };

  /**
   * Ensure one deterministic scenario exists before pairing. Seeding on the
   * host first means the phone's initial replica clone contains the corpus;
   * flows never race a later refresh or depend on execution order. The GET
   * guard also lets all five Photos journeys share one gateway boot safely.
   */
  ctx.ensureDemo = async (
    appId,
    gatewayUrl = process.env.MAESTRO_GATEWAY_URL,
    gatewayToken = process.env.MAESTRO_GATEWAY_TOKEN ?? ""
  ) => {
    if (!gatewayUrl)
      throw new Error("MAESTRO_GATEWAY_URL is required to seed demo data");
    const base = gatewayUrl.replace(/\/+$/u, "");
    const headers = gatewayToken
      ? { authorization: `Bearer ${gatewayToken}` }
      : {};
    const statusResponse = await fetch(`${base}/centraid/_vault/demo`, {
      headers,
    });
    const status = await statusResponse.json().catch(() => ({}));
    if (!statusResponse.ok || !Array.isArray(status?.apps))
      throw new Error(
        `gateway refused demo status (${status?.error ?? statusResponse.status})`
      );
    const current = status.apps.find((app) => app?.appId === appId);
    if (!current?.seedable)
      throw new Error(`gateway does not ship the ${appId} demo scenario`);
    const expectedApps = JSON.parse(
      process.env.MOBILE_E2E_FIXTURE_APPS_JSON ?? "[]"
    );
    const expected = Array.isArray(expectedApps)
      ? expectedApps.find((app) => app?.appId === appId)
      : undefined;
    if (
      expected &&
      (!Number.isFinite(expected.rows) ||
        Number(current.rows) !== expected.rows)
    ) {
      throw new Error(
        `${appId} demo fixture mismatch: expected ${expected.rows} rows, found ${current.rows}`
      );
    }
    if (Number(current.rows) > 0) {
      ctx.note(`${appId} demo already present (${current.rows} rows)`);
      return;
    }
    const seededResponse = await fetch(
      `${base}/centraid/_vault/demo/${encodeURIComponent(appId)}`,
      { headers, method: "POST" }
    );
    const seeded = await seededResponse.json().catch(() => ({}));
    if (!seededResponse.ok)
      throw new Error(
        `gateway refused ${appId} demo seed (${seeded?.error ?? seededResponse.status})`
      );
    ctx.note(`${appId} demo seeded (${seeded.rows ?? "unknown"} rows)`);
  };

  /**
   * Seed every shipped scenario explicitly when a journey needs a populated
   * replica without using the product's Home action. Demo rows are outside
   * the change feed, so host-side seeding is not a substitute for the phone's
   * own fill-and-rebootstrap path after pairing.
   */
  ctx.ensureAllDemos = async (
    gatewayUrlForDemos = process.env.MAESTRO_GATEWAY_URL,
    gatewayTokenForDemos = process.env.MAESTRO_GATEWAY_TOKEN ?? ""
  ) => {
    if (!gatewayUrlForDemos)
      throw new Error("MAESTRO_GATEWAY_URL is required to seed demo data");
    const base = gatewayUrlForDemos.replace(/\/+$/u, "");
    const headers = gatewayTokenForDemos
      ? { authorization: `Bearer ${gatewayTokenForDemos}` }
      : {};
    const seededResponse = await fetch(`${base}/centraid/_vault/demo`, {
      headers,
      method: "POST",
    });
    const result = await seededResponse.json().catch(() => ({}));
    if (!seededResponse.ok || result?.ok !== true)
      throw new Error(
        `gateway refused mobile demo fixture (${result?.error ?? seededResponse.status})`
      );
    ctx.note(
      result.seeded?.length
        ? `host-seeded demo scenarios: ${result.seeded.join(", ")}`
        : `demo scenarios already seeded (${result.skipped?.join(", ") ?? "none"})`
    );
  };

  ctx.purgeDemo = async (
    appId,
    gatewayUrl = process.env.MAESTRO_GATEWAY_URL,
    gatewayToken = process.env.MAESTRO_GATEWAY_TOKEN ?? ""
  ) => {
    if (!gatewayUrl)
      throw new Error("MAESTRO_GATEWAY_URL is required to purge demo data");
    const base = gatewayUrl.replace(/\/+$/u, "");
    const headers = gatewayToken
      ? { authorization: `Bearer ${gatewayToken}` }
      : {};
    const response = await fetch(
      `${base}/centraid/_vault/demo/${encodeURIComponent(appId)}`,
      { headers, method: "DELETE" }
    );
    const result = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        `gateway refused ${appId} demo purge (${result?.error ?? response.status})`
      );
    ctx.note(`${appId} demo purged (${result.purged ?? "unknown"} rows)`);
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
${LAUNCHER_RECOVERY}`,
      "restart"
    );
  };

  let error;
  let result;
  try {
    result = await fn(ctx);
  } catch (caughtError) {
    error = caughtError;
  }
  const elapsedMs = Date.now() - t0;
  const pass = !error && result?.pass !== false;

  await writeFlowVerdict({
    repoRoot: REPO_ROOT,
    slug,
    runDir: state.runDir,
    elapsedMs,
    error,
    notes,
    result,
    metadata: {
      platform: state.platform,
      udid: state.udid,
      app: state.appId,
      reports: reportPaths.join(", "),
    },
    debug:
      "Maestro JUnit, command metadata, logs, and failure screenshots are retained inside this run's `maestro-reports/` and `maestro-debug/` directories.",
    // Owner must be the flow FILE the matrix names, not the flow id — they
    // differ for volume-proof.mjs (id "mobile-volume-proof"), and an id-derived
    // path makes the evidence unmappable in the zero-grey report.
    owner,
  });

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
