// Agent e2e harness. One entry point — `runFlow` — does build + setup + CDP
// connect + screenshot helpers + restart + verdict + teardown. Each flow file
// under flows/ is a thin wrapper that calls `runFlow` with the actual steps.
//
// Side CLI for ad-hoc debugging (rarely needed):
//   node lib/harness.mjs setup                  -> JSON {runId, cdpUrl, ...}
//   node lib/harness.mjs restart <runId>        -> JSON (new pid/cdpUrl, same userData)
//   node lib/harness.mjs teardown <runId>       -> kills electron, wipes workspace

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import playwright from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ELECTRON_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'electron');
const DESKTOP_ROOT = path.join(REPO_ROOT, 'apps', 'desktop');
const DESKTOP_MAIN = path.join(DESKTOP_ROOT, 'dist', 'main.js');
const RUNS_DIR = path.join(__dirname, '..', 'runs');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForCdp(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      // Endpoint not up yet; fall through to the poll sleep.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`CDP did not become ready on 127.0.0.1:${port} within ${timeoutMs}ms`);
}

async function waitForPortFree(port, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    } catch {
      return;
    }
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// SIGTERM the Electron main process and wait for it to actually exit. Chromium
// persists localStorage / IndexedDB asynchronously on a timer; if we just send
// SIGTERM and immediately respawn, the kernel can reap before before-quit
// handlers finish flushing, and renderer prefs (theme, etc.) get lost across
// restart. The leading 250ms gives just-completed writes time to enter the
// persistence pipeline; the busy-wait blocks until exit. SIGKILL is the
// last-resort fallback for an Electron that's wedged.
async function killAndWait(pid, { flushMs = 250, timeoutMs = 5000 } = {}) {
  if (!pidAlive(pid)) return;
  await new Promise((resolve) => setTimeout(resolve, flushMs));
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Process already gone — nothing to terminate.
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!pidAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Process won the race and exited before the SIGKILL fallback.
  }
}

function killPid(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Process already gone or never started — nothing to kill.
  }
}

function defaultRunId() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

async function ensureBuilt() {
  try {
    await fs.access(DESKTOP_MAIN);
    return;
  } catch {
    // dist/main.js missing — fall through to the build step.
  }
  console.log('[harness] dist/main.js missing — running desktop build...');
  await new Promise((resolve, reject) => {
    const proc = spawn('bun', ['run', '--filter=@centraid/desktop', 'build'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`desktop build exited ${code}`));
    });
    proc.on('error', reject);
  });
}

async function seedFresh(runDir) {
  const workspace = path.join(runDir, 'workspace');
  const userData = path.join(workspace, 'userData');
  const projectsDir = path.join(workspace, 'projects');
  await fs.mkdir(userData, { recursive: true });
  await fs.mkdir(projectsDir, { recursive: true });
  await fs.mkdir(path.join(runDir, 'screenshots'), { recursive: true });
  // Only pin projectsDir — gatewayUrl/gatewayToken fall through to the main
  // process defaults (http://127.0.0.1:18789 + $OPENCLAW_GATEWAY_TOKEN), so
  // flows run against the user's real local gateway.
  await fs.writeFile(
    path.join(userData, 'centraid-settings.json'),
    JSON.stringify({ projectsDir, remoteTemplatesUrl: '' }, null, 2),
    { mode: 0o600 },
  );
  return { workspace, userData, projectsDir };
}

async function spawnElectron(userData, port) {
  const child = spawn(
    ELECTRON_BIN,
    [DESKTOP_ROOT, `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`],
    {
      // Inherit parent env so $OPENCLAW_GATEWAY_TOKEN flows through to the main
      // process default. NODE_ENV=test mirrors the Playwright fixture.
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: 'ignore',
      detached: true,
    },
  );
  child.unref();
  try {
    await waitForCdp(port);
  } catch (e) {
    killPid(child.pid);
    throw e;
  }
  return child.pid;
}

async function writeState(runDir, state) {
  await fs.writeFile(path.join(runDir, 'state.json'), JSON.stringify(state, null, 2));
}

async function loadState(runId) {
  const file = path.join(RUNS_DIR, runId, 'state.json');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function setup({ runId } = {}) {
  await ensureBuilt();
  const id = runId ?? defaultRunId();
  const runDir = path.join(RUNS_DIR, id);
  await fs.mkdir(runDir, { recursive: true });
  const fresh = await seedFresh(runDir);
  const port = await freePort();
  const pid = await spawnElectron(fresh.userData, port);
  const cdpUrl = `http://127.0.0.1:${port}`;
  const state = { runId: id, runDir, ...fresh, port, cdpUrl, pid };
  await writeState(runDir, state);
  return state;
}

export async function restart(runId) {
  const prev = await loadState(runId);
  await killAndWait(prev.pid);
  await waitForPortFree(prev.port);
  const port = await freePort();
  const pid = await spawnElectron(prev.userData, port);
  const cdpUrl = `http://127.0.0.1:${port}`;
  const next = { ...prev, port, cdpUrl, pid };
  await writeState(prev.runDir, next);
  return next;
}

export async function teardown(runId, { keepWorkspace = false } = {}) {
  const state = await loadState(runId);
  await killAndWait(state.pid);
  if (!keepWorkspace) {
    await fs.rm(state.workspace, { recursive: true, force: true });
  }
  return { runId, killed: state.pid, keptWorkspace: keepWorkspace };
}

async function connectCdp(state) {
  const browser = await playwright.chromium.connectOverCDP(state.cdpUrl);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.waitForEvent('page'));
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.home', { timeout: 10000 });
  return { browser, page };
}

function renderVerdict({ slug, pass, error, notes, result, elapsedMs, state }) {
  const lines = [
    `# ${slug}`,
    '',
    `**${pass ? 'PASS' : 'FAIL'}** — ${elapsedMs}ms`,
    '',
    `- run dir: \`${state.runDir}\``,
    `- workspace: \`${state.workspace}\``,
    '',
  ];
  if (error) {
    lines.push('## Error', '```', error.stack ?? String(error), '```', '');
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
 * Run an agent-e2e flow end-to-end: build → setup → connect → exec → verdict → teardown.
 *
 * Usage in flows/<slug>.mjs:
 *
 *   import { runFlow } from '../lib/harness.mjs';
 *   await runFlow('clone-template-and-reopen', async (ctx) => {
 *     await ctx.shot('home-before');
 *     await ctx.page.locator(...).click();
 *     await ctx.restart();              // ctx.page is replaced with the fresh one
 *     await ctx.shot('after-restart');
 *     return { pass: true, notes: 'draft survived restart' };
 *   });
 *
 * The flow function receives a mutable ctx object — read ctx.page each step;
 * don't destructure it, because restart() replaces it.
 */
export async function runFlow(slug, fn, opts = {}) {
  const { keepWorkspaceOnPass = false } = opts;
  const state = await setup({ runId: `${slug}-${defaultRunId()}` });
  console.log(`[runFlow] ${slug}`);
  console.log(`  run dir : ${path.relative(REPO_ROOT, state.runDir)}`);
  console.log(`  cdpUrl  : ${state.cdpUrl}`);

  let { browser, page } = await connectCdp(state);
  const ctx = {
    state,
    get page() {
      return page;
    },
  };

  let shotIdx = 0;
  ctx.shot = async (name) => {
    const file = path.join(
      state.runDir,
      'screenshots',
      `${String(++shotIdx).padStart(2, '0')}-${name}.png`,
    );
    await page.screenshot({ path: file, fullPage: true });
    console.log(`  shot    → ${path.relative(REPO_ROOT, file)}`);
    return file;
  };

  ctx.restart = async () => {
    console.log('  restart …');
    // Close the renderer page first so pagehide/unload fires — that's what
    // makes Chromium flush localStorage to leveldb. SIGTERMing the main
    // process alone can outrun the renderer's IPC flush, losing prefs (e.g.
    // theme) that were set <1s before restart. browser.close() on a
    // connectOverCDP browser only disconnects Playwright, so we have to
    // close the page explicitly.
    await page.close({ runBeforeUnload: true }).catch(() => {});
    await browser.close().catch(() => {});
    const next = await restart(state.runId);
    Object.assign(state, next);
    ({ browser, page } = await connectCdp(state));
  };

  const notes = [];
  ctx.note = (m) => {
    notes.push(m);
    console.log(`  note    : ${m}`);
  };

  let error, result;
  const t0 = Date.now();
  try {
    result = await fn(ctx);
  } catch (e) {
    error = e;
  } finally {
    await browser?.close().catch(() => {});
  }
  const elapsedMs = Date.now() - t0;
  const pass = !error && result?.pass !== false;

  await fs.writeFile(
    path.join(state.runDir, 'verdict.md'),
    renderVerdict({ slug, pass, error, notes, result, elapsedMs, state }),
  );

  // Keep workspace on failure so you can inspect what went wrong.
  const keep = !pass || keepWorkspaceOnPass;
  await teardown(state.runId, { keepWorkspace: keep });

  console.log(`[runFlow] ${slug} ${pass ? 'PASS' : 'FAIL'} in ${elapsedMs}ms`);
  console.log(`  verdict : ${path.relative(REPO_ROOT, path.join(state.runDir, 'verdict.md'))}`);
  if (!pass) {
    if (error) console.error(error);
    process.exit(1);
  }
}

const cmd = process.argv[2];
if (cmd) {
  const arg = process.argv[3];
  try {
    let out;
    if (cmd === 'setup') out = await setup();
    else if (cmd === 'restart') {
      if (!arg) throw new Error('usage: harness.mjs restart <runId>');
      out = await restart(arg);
    } else if (cmd === 'teardown') {
      if (!arg) throw new Error('usage: harness.mjs teardown <runId>');
      const keep = process.argv.includes('--keep-workspace');
      out = await teardown(arg, { keepWorkspace: keep });
    } else {
      console.error(`unknown command: ${cmd}`);
      process.exit(1);
    }
    console.log(JSON.stringify(out, null, 2));
  } catch (err) {
    console.error(err.message ?? err);
    process.exit(1);
  }
}
