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

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRunId, writeFlowVerdict } from '../../agent-e2e-shared/harness.mjs';
import { DISMISS_KEYBOARD_ONBOARDING, SKIP_ONBOARDING } from './first-run.mjs';
import { metroReachable, prewarmMetroBundle } from './metro.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const RUNS_DIR = path.join(__dirname, '..', 'runs');

// iOS bundle id, and the Android *release* applicationId. Android *debug*
// builds append `.debug` (applicationIdSuffix in android/app/build.gradle, kept
// so a debug build and a Play-release build can coexist on one device —
// J1/#501). The agent-e2e build is a debug build, so on Android the package
// that actually installs and launches is the suffixed `dev.centraid.mobile.debug`.
// `setup()` resolves the id per platform and threads it through `state.appId`;
// flows must launch the package that is installed, not this base id, so they
// read `ctx.state.appId` rather than importing APP_ID.
export const APP_ID = 'dev.centraid.mobile';
const appIdForPlatform = (platform) => (platform === 'android' ? `${APP_ID}.debug` : APP_ID);

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

function spawnText(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('exit', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${err || out}`));
    });
    p.on('error', reject);
  });
}

function spawnLive(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts, stdio: 'inherit' });
    p.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`));
    });
    p.on('error', reject);
  });
}

// Pick the first booted iOS Simulator. Real-device support comes later
// (Maestro takes --device for that; the seed/install story is different).
async function bootedIosSim() {
  const out = await spawnText('xcrun', ['simctl', 'list', 'devices', 'booted', '--json']);
  const data = JSON.parse(out);
  for (const list of Object.values(data.devices ?? {})) {
    for (const dev of list ?? []) {
      if (dev.state === 'Booted') return dev.udid;
    }
  }
  return null;
}

// Pick the first online Android device (emulator or USB). `adb devices`
// prints "List of devices attached" then `<serial>\t<state>` per line —
// state is `device` for ready, `offline` / `unauthorized` otherwise.
async function bootedAndroidEmu() {
  try {
    const out = await spawnText('adb', ['devices']);
    for (const line of out.split('\n').slice(1)) {
      const [serial, state] = line.split('\t');
      if (state?.trim() === 'device' && serial) return serial.trim();
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
  if (force === 'android') {
    const udid = await bootedAndroidEmu();
    return udid ? { udid, platform: 'android' } : null;
  }
  if (force === 'ios') {
    const udid = await bootedIosSim();
    return udid ? { udid, platform: 'ios' } : null;
  }
  const ios = await bootedIosSim();
  if (ios) return { udid: ios, platform: 'ios' };
  const android = await bootedAndroidEmu();
  if (android) return { udid: android, platform: 'android' };
  return null;
}

async function appInstalled(device, appId) {
  if (device.platform === 'ios') {
    try {
      await spawnText('xcrun', ['simctl', 'get_app_container', device.udid, appId, 'app']);
      return true;
    } catch {
      return false;
    }
  }
  // Android: `adb shell pm list packages <appId>` echoes `package:<appId>`
  // when installed, empty output otherwise. Exit code is 0 either way.
  try {
    const out = await spawnText('adb', [
      '-s',
      device.udid,
      'shell',
      'pm',
      'list',
      'packages',
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
  await spawnText('adb', ['-s', udid, 'reverse', 'tcp:8081', 'tcp:8081']);
}

export async function setup({ runId } = {}) {
  const device = await bootedDevice();
  if (!device) {
    throw new Error(
      'No booted iOS Simulator or Android emulator. For iOS: open Simulator.app ' +
        '(or `xcrun simctl boot <udid>`) then `bun run --filter=@centraid/mobile ios`. ' +
        'For Android: start an AVD via `emulator @<name>` (or Android Studio) then ' +
        '`bun run --filter=@centraid/mobile android`. Set MAESTRO_PLATFORM=ios|android ' +
        'to force a side when both are present.',
    );
  }
  const appId = appIdForPlatform(device.platform);
  if (!(await appInstalled(device, appId))) {
    throw new Error(
      `${appId} not installed on ${device.platform} device ${device.udid}. ` +
        `Run \`bun run --filter=@centraid/mobile ${device.platform}\` first.`,
    );
  }
  if (device.platform === 'android') {
    // Must happen before metroReachable(): the dev client reaches Metro via
    // the reverse forward, but the harness's own fetch goes directly.
    await ensureMetroReverseForAndroid(device.udid);
  }
  if (!(await metroReachable())) {
    throw new Error(
      'Metro bundler not reachable at http://127.0.0.1:8081. The dev build needs it to ' +
        'serve the JS bundle — start it with `cd apps/mobile && bun expo start --dev-client`.',
    );
  }
  await prewarmMetroBundle(device.platform, appId);
  const id = runId ?? defaultRunId();
  const runDir = path.join(RUNS_DIR, id);
  const screenshotsDir = path.join(runDir, 'screenshots');
  const flowsDir = path.join(runDir, 'flows');
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
  await fs.writeFile(path.join(runDir, 'state.json'), JSON.stringify(state, null, 2));
  return state;
}

// Write the YAML chunk into flows/ for the audit trail and execute it with
// cwd = screenshots/, so `takeScreenshot: foo` lands at runs/.../screenshots/foo.png.
// `--udid` pins Maestro to the chosen device — without it Maestro picks any
// connected target, which silently runs flows on the wrong platform when
// both an iOS sim and an Android emulator are booted.
async function runMaestroChunk(yaml, { state, label }) {
  const flowFile = path.join(state.flowsDir, `${label}.yaml`);
  await fs.writeFile(flowFile, yaml);
  // `--debug-output` redirects Maestro's own per-step screenshots and view
  // hierarchies into the run dir. Without it they land in `~/.maestro/tests/`,
  // which the nightly workflow does not upload — so a CI failure arrived with
  // literally no picture of the screen. A flow that fails *before* its first
  // `takeScreenshot` (the 2026-07-20 home-loads failure did) then leaves
  // nothing to diagnose at all. Keep this pointed inside `state.runDir`, which
  // is already an uploaded artifact path.
  await spawnLive(
    'maestro',
    [
      '--udid',
      state.udid,
      'test',
      '--debug-output',
      path.join(state.runDir, 'maestro-debug', label),
      '--flatten-debug-output',
      flowFile,
    ],
    { cwd: state.screenshotsDir },
  );
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
 *       - extendedWaitUntil: { visible: { text: "Connect your desktop" }, timeout: 30000 }
 *       - takeScreenshot: 01-home-fresh
 *     `);
 *     ctx.note('home rendered in no-gateway state');
 *     return { pass: true, notes: 'one-line verdict summary' };
 *   });
 *
 * ctx surface:
 *   ctx.state               read-only snapshot of {runId, runDir, udid, appId, ...}
 *   ctx.run(yaml, label?)   execute a YAML chunk; screenshots land under runs/.../screenshots/
 *   ctx.restart()           stopApp + launchApp without clearing state — mirrors desktop's ctx.restart()
 *   ctx.configureGateway()  clear state, then save the journey's gateway through the real Settings UI
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
    const n = String(stepIdx).padStart(2, '0');
    return hint ? `${n}-${hint}` : `${n}-step`;
  };

  const notes = [];
  const ctx = {
    state,
    note(m) {
      notes.push(m);
      console.log(`  note    : ${m}`);
    },
  };

  ctx.run = async (yaml, hint) => {
    const label = nextLabel(hint);
    console.log(`  run     : ${label}`);
    await runMaestroChunk(yaml, { state, label });
  };

  ctx.configureGateway = async (
    gatewayUrl = process.env.MAESTRO_GATEWAY_URL,
    gatewayToken = process.env.MAESTRO_GATEWAY_TOKEN ?? '',
  ) => {
    if (!gatewayUrl) {
      throw new Error('MAESTRO_GATEWAY_URL is required for this mobile journey');
    }
    // The token field's placeholder is unique on the screen, so it needs no
    // relative anchor the way the URL field does.
    const tokenSteps = gatewayToken
      ? `- tapOn: "paste token here"
# e2e-lint-allow: unasserted-input — a bearer token is a secret; the field masks
# it and it is never rendered back, so there is no value to assertVisible on.
- inputText: ${JSON.stringify(gatewayToken)}
${DISMISS_KEYBOARD_ONBOARDING}`
      : '';
    // Every selector below was checked against a running build. The previous
    // version of this helper was written from the source instead, and each of
    // these lines is a place where that produced something that "passed" while
    // doing nothing. Please don't shorten them back:
    //
    //   * Reaching Settings: Home's "Pair desktop" button sits *under* the tab
    //     bar on a fresh launch, so tapping it is a silent no-op — Maestro still
    //     reports COMPLETED. Use the header gear, which is always on screen.
    //   * Confirming we arrived: `assertVisible: "Settings"` is vacuous — the
    //     header gear, the tab, and the screen title are all "Settings", so it
    //     passes on Home too. "Gateway link" is unique to the Settings screen
    //     (post-#498 redesign; was "Desktop link").
    //   * The URL field: Maestro matches text as a SUBSTRING, so a bare
    //     `tapOn: "http://127.0.0.1:18789"` matched the help paragraph above the
    //     field ("…e.g. http://127.0.0.1:18789. An authed gateway…") and focused
    //     nothing; the URL was never typed and Save persisted an empty string.
    //     The `below:` anchor is the paragraph itself, so only the input matches.
    //     (An accessibilityLabel on the TextInput does not help — RN does not
    //     surface it to the iOS a11y tree for text fields; it stays the placeholder.)
    //   * `hideKeyboard` before Save: the software keyboard covers the Save
    //     button, so tapping it lands on a key instead.
    //   * After Save: Settings calls `navigation.navigate('Apps', …)`, so the
    //     old `extendedWaitUntil: visible: "Apps"` looks right in the source —
    //     but 'Apps' is the *route* name and the tab renders as "Home". Assert on
    //     what a user sees, and prove the setting actually took by requiring the
    //     no-gateway card to be gone.
    await ctx.run(
      `appId: ${state.appId}
---
- launchApp:
    clearState: true
${SKIP_ONBOARDING}- extendedWaitUntil:
    visible:
      text: "Everything you build, in one place."
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- tapOn: "Settings"
- extendedWaitUntil:
    visible: "Gateway link"
    timeout: 15000
- tapOn: "Advanced (developer)"
- extendedWaitUntil:
    visible: "Gateway URL"
    timeout: 10000
# This literal is the field's PLACEHOLDER, not the URL being configured — the
# input is empty after clearState, and an empty TextInput exposes only its
# placeholder as matchable text. It must therefore stay byte-equal to
# placeholder="http://127.0.0.1:18789" in apps/mobile/src/screens/Settings.tsx,
# even when this flow configures a DIFFERENT gateway (a port already in use
# locally is the common case). The below: anchor is load-bearing too: the help
# paragraph above quotes the same URL, and matching it instead used to type the
# address into nothing. The durable fix is an accessibilityLabel on that
# TextInput so this can select the field by name — see #482.
- tapOn:
    text: "http://127.0.0.1:18789"
    below: "Dev fallback for simulators.*"
# The multilingual-keyboard onboarding sheet is a one-time, per-boot modal that
# iOS raises on the first keystroke and which silently swallows the ones after
# it. Dismissing it AFTER typing the URL — as this flow used to — is a race: on
# ci run 29773028739 it appeared mid-input and corrupted the gateway URL to
# "h7.0.0.1:18789" (the app then redboxed on the malformed address and the Save
# assertion below failed for an unrelated-looking reason). Force it up with one
# throwaway keystroke, dismiss it, then erase and type into a settled keyboard.
# If the sheet never appears (a sim that was already onboarded), the dismiss is a
# no-op and the erase clears the throwaway — so this is safe either way.
# e2e-lint-allow: unasserted-input — a throwaway keystroke to provoke the sheet;
# it is erased immediately below, so there is deliberately nothing to assert.
- inputText: "x"
${DISMISS_KEYBOARD_ONBOARDING}- eraseText
- inputText: ${JSON.stringify(gatewayUrl)}
# Prove the field actually holds the URL before Save, anchored below the help
# paragraph so it checks the INPUT, not the paragraph that quotes the same URL.
# A dropped keystroke fails here, at the field, instead of as a redbox two steps
# on.
- assertVisible:
    text: ${JSON.stringify(gatewayUrl)}
    below: "Dev fallback for simulators.*"
${tokenSteps}- hideKeyboard
- tapOn: "Save"
- extendedWaitUntil:
    visible: "Everything you build, in one place."
    timeout: 30000
- assertNotVisible: "Connect your desktop"
`,
      'configure-gateway',
    );
    ctx.note(`configured the journey gateway at ${gatewayUrl}`);
  };

  // Mirror desktop's ctx.restart(): kill the app process so AsyncStorage
  // flushes, then relaunch without clearing state. The 300ms delay before
  // stopApp gives RN's AsyncStorage time to enter its persistence pipeline
  // (analogous to the desktop harness's flushMs before SIGTERM).
  ctx.restart = async () => {
    console.log('  restart …');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await ctx.run(
      `appId: ${state.appId}
---
- stopApp
- launchApp:
    clearState: false
`,
      'restart',
    );
  };

  let error;
  let result;
  const t0 = Date.now();
  try {
    result = await fn(ctx);
  } catch (e) {
    error = e;
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
      'Maestro keeps per-step screenshots and ai-report.html under `~/.maestro/tests/<timestamp>/`; the newest directory belongs to this run.',
    owner: `tests/agent-e2e-mobile/flows/${slug}.mjs`,
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
    if (cmd === 'setup') out = await setup();
    else if (cmd === 'list-devices') out = await bootedDevice();
    else {
      console.error(`unknown command: ${cmd}`);
      process.exit(1);
    }
    console.log(JSON.stringify(out, null, 2));
  } catch (err) {
    console.error(err.message ?? err);
    process.exit(1);
  }
}
