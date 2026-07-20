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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const RUNS_DIR = path.join(__dirname, '..', 'runs');

export const APP_ID = 'dev.centraid.mobile';

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

/**
 * The first `inputText` on a freshly-booted simulator raises iOS's multilingual
 * keyboard onboarding sheet ("Type English and Dutch … Continue"). It covers the
 * bottom of the screen — including the tab bar — so every subsequent tap silently
 * lands on the sheet instead. CI boots a clean simulator each run, so it hits
 * this every time. Dismiss it if it showed up; do nothing if it didn't.
 */
export const DISMISS_KEYBOARD_ONBOARDING = `- runFlow:
    when:
      visible: "Continue"
    commands:
      - tapOn: "Continue"
`;

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

// The Expo dev build fetches its JS bundle from Metro at runtime. If
// clearState wipes the cached bundle and Metro isn't reachable, the
// app shows a redbox ("No script URL provided") and every `assertVisible`
// times out cryptically. Fail loudly instead.
async function metroReachable() {
  try {
    const res = await fetch('http://127.0.0.1:8081/status', {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Build the JS bundle once, before any flow starts its clock.
//
// Every flow opens with `launchApp: { clearState: true }`, which drops the dev
// build's cached bundle, so the app refetches it from Metro on that first launch.
// If Metro's transform cache is also cold — as it is on a fresh CI runner — that
// build lands *inside* the flow's first `extendedWaitUntil` and eats the whole
// budget. Paying it here keeps flow timeouts about the app, not about bundling.
//
// Best-effort by design: a failure here is not a flow failure. If the bundle is
// genuinely broken the flow's own assertions will say so, with a screenshot.
async function prewarmMetroBundle(platform) {
  // Metro's project root is the monorepo root (Expo runs from the workspace
  // bin), so the app's entry is served at `apps/mobile/index.ts` — plain
  // `/index.bundle` 404s here. `/.expo/.virtual-metro-entry.bundle` answers 200
  // but builds a 1-module stub, which is why the size floor below matters: a
  // 200 alone does not mean the real graph was built.
  const query = `platform=${platform}&dev=true&minify=false`;
  const candidates = [
    `http://127.0.0.1:8081/apps/mobile/index.bundle?${query}`,
    `http://127.0.0.1:8081/index.bundle?${query}`,
  ];
  const MIN_REAL_BUNDLE_BYTES = 1_000_000;
  for (const url of candidates) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      // Drain the body: Metro streams the bundle and isn't done building until
      // the last byte is out.
      const bytes = (await res.arrayBuffer()).byteLength;
      if (!res.ok || bytes < MIN_REAL_BUNDLE_BYTES) continue;
      console.log(`  prewarm : bundle ready in ${Date.now() - t0}ms (${bytes} bytes)`);
      return;
    } catch (err) {
      console.log(`  prewarm : ${url.split('?')[0]} failed (${err.message ?? err})`);
    }
  }
  console.log('  prewarm : no bundle endpoint matched — flows will pay the cold build');
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
  if (!(await appInstalled(device, APP_ID))) {
    throw new Error(
      `${APP_ID} not installed on ${device.platform} device ${device.udid}. ` +
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
  await prewarmMetroBundle(device.platform);
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
    appId: APP_ID,
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
  await spawnLive('maestro', ['--udid', state.udid, 'test', flowFile], {
    cwd: state.screenshotsDir,
  });
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
    //     passes on Home too. "Desktop link" is unique to the Settings screen.
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
      `appId: ${APP_ID}
---
- launchApp:
    clearState: true
- extendedWaitUntil:
    visible:
      text: "Everything you build, in one place."
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- tapOn: "Settings"
- extendedWaitUntil:
    visible: "Desktop link"
    timeout: 15000
- tapOn: "Advanced (developer)"
- extendedWaitUntil:
    visible: "Gateway URL"
    timeout: 10000
- tapOn:
    text: "http://127.0.0.1:18789"
    below: "Dev fallback for simulators.*"
- inputText: ${JSON.stringify(gatewayUrl)}
${DISMISS_KEYBOARD_ONBOARDING}${tokenSteps}- hideKeyboard
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
      `appId: ${APP_ID}
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
