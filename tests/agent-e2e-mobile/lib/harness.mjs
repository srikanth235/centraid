// Mobile agent-e2e harness. One entry point — `runFlow` — handles setup
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
  completeOnboardingCommands,
  pasteAndConnectPairingTicketCommands,
  waitForOnboardingConnectCommands,
} from "./first-run.mjs";
import {
  METRO_ORIGIN,
  METRO_PORT,
  prewarmMetroBundle,
  waitForMetroReachable,
} from "./metro.mjs";
import { spawnLive, spawnQuiet } from "./spawn.mjs";

const __dirname = import.meta.dirname;
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const RUNS_DIR = path.join(__dirname, "..", "runs");

// iOS bundle id, and the Android *release* applicationId. Android *debug*
// builds append `.debug` (applicationIdSuffix in android/app/build.gradle, kept
// so a debug build and a Play-release build can coexist on one device —
// J1/#501). The agent-e2e build is a debug build, so on Android the package
// that actually installs and launches is the suffixed `dev.centraid.mobile.debug`.
// `setup()` resolves the id per platform and threads it through `state.appId`;
// flows must launch the package that is installed, not this base id, so they
// read `ctx.state.appId` rather than importing APP_ID.
export const APP_ID = "dev.centraid.mobile";
const appIdForPlatform = (platform) =>
  platform === "android" ? `${APP_ID}.debug` : APP_ID;

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
 */
export const FIRST_LAUNCH_TIMEOUT_MS = 120_000;
export const HOME_READY_MARKER = "Your apps, ready";
// An individual chunk owns one coherent user interaction. Fresh pairing is the
// slowest legitimate chunk (~4 minutes on the reviewed CI runner); 12 minutes
// leaves ample network/render headroom while still terminating a wedged
// accessibility driver before the workflow's outer timeout destroys evidence.
const MAESTRO_CHUNK_TIMEOUT_MS = 12 * 60_000;

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
  // Sensitive flows: ticket is a MAESTRO_* env var (YAML keeps a placeholder)
  // and stdout is quiet. On success discard hierarchy/screenshots; on failure
  // keep them in the uploaded run dir so CI can diagnose (run 30707656659).
  // Note: e2e.yml still prunes `*-configure-gateway` debug dirs before upload
  // as a defense against ticket material on screen; that cleanup is separate.
  const run = sensitive ? spawnQuiet : spawnLive;
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
      timeoutMs: MAESTRO_CHUNK_TIMEOUT_MS,
    }
  );
  if (sensitive) await fs.rm(debugDir, { force: true, recursive: true });
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
 *   ctx.configureGateway()  clear state, mint/redeem a ticket, and complete either valid identity branch
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
  const run = async (yaml, hint, options = {}) => {
    const label = nextLabel(hint);
    console.log(`  run     : ${label}`);
    await runMaestroChunk(yaml, { state, label, ...options });
  };
  const ctx = {
    state,
    note(m) {
      notes.push(m);
      console.log(`  note    : ${m}`);
    },
    run,
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
      const cli = path.join(REPO_ROOT, "packages/gateway/dist/cli/cli.js");
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
          "--new-member",
          `Mobile E2E ${state.runId}`,
          "--role",
          "write",
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
          role: "write",
          ttlMinutes: 15,
          newMemberLabel: `Mobile E2E ${state.runId}`,
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
    const pairingTicket = await mintPairingTicket(gatewayUrl, gatewayToken);

    // #603 removed the local/manual-URL bypass: every fresh client must redeem
    // a real one-time pairing ticket. #643/#644 made the default path
    // scan-first (showPaste=false): open paste via the secondary control, then
    // fill the ticket field and submit with the live primary label "Connect"
    // (not the pre-scan-first "Continue with pasted code"). #634 made the
    // profile step conditional: a named roster member goes straight to Done,
    // while an unnamed member is asked for a profile. The gateway URL is used
    // only by the host-side harness to mint that ticket; the phone reaches the
    // gateway through the ticket's iroh endpoint.
    await ctx.run(
      `appId: ${state.appId}
---
- launchApp:
    clearState: true
${waitForOnboardingConnectCommands(FIRST_LAUNCH_TIMEOUT_MS)}${pasteAndConnectPairingTicketCommands(HOME_READY_MARKER)}`,
      "configure-gateway",
      {
        maestroEnv: { MAESTRO_PAIRING_TICKET: pairingTicket },
        sensitive: true,
      }
    );

    // A second, non-sensitive Maestro chunk keeps the pairing capability out
    // of retained diagnostics while proving both legitimate identity paths.
    // Tickets minted above deliberately name their member "Mobile E2E …", so
    // the normal branch skips the form and greets "Mobile"; the conditional
    // form path remains covered for gateways that return no roster name.
    await ctx.run(
      `appId: ${state.appId}
---
${completeOnboardingCommands(HOME_READY_MARKER)}`,
      "complete-onboarding"
    );
    ctx.note(`paired the journey with the gateway at ${gatewayUrl}`);
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
    metadata: { platform: state.platform, udid: state.udid, app: state.appId },
    debug:
      "Maestro keeps per-step screenshots and ai-report.html under `~/.maestro/tests/<timestamp>/`; the newest directory belongs to this run.",
    // Owner must be the flow FILE the matrix names, not the flow id — they
    // differ for volume-proof.mjs (id "mobile-volume-proof"), and an id-derived
    // path makes the evidence unmappable in the zero-grey report.
    owner: path
      .relative(REPO_ROOT, path.resolve(process.argv[1] ?? ""))
      .split(path.sep)
      .join("/"),
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
