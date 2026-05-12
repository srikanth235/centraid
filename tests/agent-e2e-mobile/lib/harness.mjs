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
//   node lib/harness.mjs setup         -> JSON with runId, udid, runDir
//   node lib/harness.mjs list-devices  -> JSON with first booted iOS udid

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const RUNS_DIR = path.join(__dirname, '..', 'runs');

export const APP_ID = 'com.centraid.mobile';

function defaultRunId() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

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

async function appInstalled(udid, appId) {
  try {
    await spawnText('xcrun', ['simctl', 'get_app_container', udid, appId, 'app']);
    return true;
  } catch {
    return false;
  }
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

export async function setup({ runId } = {}) {
  const udid = await bootedIosSim();
  if (!udid) {
    throw new Error(
      'No booted iOS Simulator. Open Simulator.app (or `xcrun simctl boot <udid>`), ' +
        'then run `bun run --filter=@centraid/mobile ios` to install the dev build.',
    );
  }
  if (!(await appInstalled(udid, APP_ID))) {
    throw new Error(
      `Centraid.app not installed on sim ${udid}. Run \`bun run --filter=@centraid/mobile ios\` first.`,
    );
  }
  if (!(await metroReachable())) {
    throw new Error(
      'Metro bundler not reachable at http://127.0.0.1:8081. The dev build needs it to ' +
        'serve the JS bundle — start it with `cd apps/mobile && bun expo start --dev-client`.',
    );
  }
  const id = runId ?? defaultRunId();
  const runDir = path.join(RUNS_DIR, id);
  const screenshotsDir = path.join(runDir, 'screenshots');
  const flowsDir = path.join(runDir, 'flows');
  await fs.mkdir(screenshotsDir, { recursive: true });
  await fs.mkdir(flowsDir, { recursive: true });

  const state = { runId: id, runDir, screenshotsDir, flowsDir, udid, appId: APP_ID };
  await fs.writeFile(path.join(runDir, 'state.json'), JSON.stringify(state, null, 2));
  return state;
}

// Write the YAML chunk into flows/ for the audit trail and execute it with
// cwd = screenshots/, so `takeScreenshot: foo` lands at runs/.../screenshots/foo.png.
async function runMaestroChunk(yaml, { state, label }) {
  const flowFile = path.join(state.flowsDir, `${label}.yaml`);
  await fs.writeFile(flowFile, yaml);
  await spawnLive('maestro', ['test', flowFile], { cwd: state.screenshotsDir });
}

function renderVerdict({ slug, pass, error, notes, result, elapsedMs, state }) {
  const lines = [
    `# ${slug}`,
    '',
    `**${pass ? 'PASS' : 'FAIL'}** — ${elapsedMs}ms`,
    '',
    `- run dir: \`${state.runDir}\``,
    `- udid: \`${state.udid}\``,
    `- app: \`${state.appId}\``,
    '',
  ];
  if (error) {
    lines.push('## Error', '```', error.stack ?? String(error), '```', '');
    lines.push(
      '## Debug',
      '',
      'Maestro keeps its own debug artifacts (per-step screenshots + ai-report.html) under `~/.maestro/tests/<timestamp>/`. Sort by mtime — the latest one matches this run.',
      '',
    );
  }
  if (notes.length) {
    lines.push('## Notes');
    for (const n of notes) lines.push(`- ${n}`);
    lines.push('');
  }
  if (result?.notes) {
    lines.push('## Result', String(result.notes), '');
  }
  return lines.join('\n');
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
 *       appId: com.centraid.mobile
 *       ---
 *       - launchApp: { clearState: true }
 *       - extendedWaitUntil: { visible: { text: "Open Settings" }, timeout: 30000 }
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
  console.log(`  udid    : ${state.udid}`);

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

  await fs.writeFile(
    path.join(state.runDir, 'verdict.md'),
    renderVerdict({ slug, pass, error, notes, result, elapsedMs, state }),
  );

  console.log(`[runFlow] ${slug} ${pass ? 'PASS' : 'FAIL'} in ${elapsedMs}ms`);
  console.log(`  verdict : ${path.relative(REPO_ROOT, path.join(state.runDir, 'verdict.md'))}`);
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
    else if (cmd === 'list-devices') out = { udid: await bootedIosSim() };
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
