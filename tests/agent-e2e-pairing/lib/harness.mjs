// Agent e2e harness for the device-pairing ceremony (issue #289).
//
// Unlike tests/agent-e2e (Electron + CDP), this loop is headless: it spawns
// the REAL `centraid-gateway` daemon on a fresh data dir, drives the REAL
// admin CLI (`vault` / `pair` / `devices`) as separate processes, and plays
// the device role with `@centraid/tunnel` over real iroh QUIC on loopback.
// That is exactly the seam the unit tests skip — daemon writes
// endpoint.json, the CLI reads it to mint a pasteable ticket, a fresh
// device identity redeems it over `centraid/gw-pair/1`, and the enrollment
// gates tunneled requests.
//
// One entry point — `runFlow(slug, fn)` — does build + daemon boot + verdict
// + teardown. Flow files under flows/ call it with the actual steps.

import { spawn } from 'node:child_process';
import { promises as fs, createWriteStream, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTunnelClient, tunnelRequest } from '../../../packages/tunnel/dist/index.js';
import { defaultRunId, writeFlowVerdict } from '../../agent-e2e-shared/harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const GATEWAY_CLI = path.join(REPO_ROOT, 'packages', 'gateway', 'dist', 'cli', 'cli.js');
const TUNNEL_DIST = path.join(REPO_ROOT, 'packages', 'tunnel', 'dist', 'index.js');
const RUNS_DIR = path.join(__dirname, '..', 'runs');

// Exported so lib/docker-harness.mjs (cross-network-relay flow) can reuse
// the exact same scoped build instead of re-deriving the turbo filter set.
export async function ensureBuilt() {
  const missing = [];
  for (const file of [GATEWAY_CLI, TUNNEL_DIST]) {
    try {
      await fs.access(file);
    } catch {
      missing.push(path.relative(REPO_ROOT, file));
    }
  }
  if (missing.length === 0) return;
  console.log(`[harness] missing ${missing.join(', ')} — running scoped build…`);
  // Scoped to what this tier actually runs, but the daemon imports
  // @centraid/app-engine, @centraid/vault, etc. at runtime — turbo's
  // `dependsOn: ["^build"]` (see turbo.json) pulls the whole workspace
  // dependency graph in for each filter, so this isn't just gateway+tunnel's
  // own dist output, it's everything they transitively need.
  await new Promise((resolve, reject) => {
    const proc = spawn(
      'bunx',
      ['turbo', 'run', 'build', '--filter=@centraid/gateway', '--filter=@centraid/tunnel'],
      { cwd: REPO_ROOT, stdio: 'inherit' },
    );
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`build exited ${code}`));
    });
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killAndWait(pid, { timeoutMs = 8000 } = {}) {
  if (!pid || !pidAlive(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!pidAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Won the race.
  }
}

/**
 * Spawn `centraid-gateway serve --data-dir <dataDir>` and wait until it has
 * printed both its HTTP listener line and its iroh endpoint id. stdout+stderr
 * stream to `logFile` so a failed run keeps the daemon's own story.
 */
async function spawnDaemon(dataDir, logFile, { timeoutMs = 60000 } = {}) {
  const log = createWriteStream(logFile, { flags: 'a' });
  const child = spawn(process.execPath, [GATEWAY_CLI, 'serve', '--data-dir', dataDir], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buffer = '';
  const wanted = { url: undefined, token: undefined, endpointId: undefined };
  const scan = (chunk) => {
    log.write(chunk);
    buffer += chunk.toString('utf8');
    wanted.url ??= buffer.match(/listening on (http:\/\/[^\s]+)/)?.[1];
    wanted.token ??= buffer.match(/token: ([0-9a-f]+)/)?.[1];
    wanted.endpointId ??= buffer.match(/endpoint: ([0-9a-f]{64})/)?.[1];
  };
  child.stdout.on('data', scan);
  child.stderr.on('data', scan);

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`daemon exited ${child.exitCode} before ready — see ${logFile}`);
    }
    if (wanted.url && wanted.token && wanted.endpointId) {
      return { pid: child.pid, ...wanted };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  await killAndWait(child.pid);
  throw new Error(
    `daemon not ready in ${timeoutMs}ms (url=${wanted.url} endpoint=${wanted.endpointId}) — see ${logFile}`,
  );
}

/** Run one admin CLI command against the run's data dir; returns stdout. */
function cli(dataDir, args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GATEWAY_CLI, ...args, '--data-dir', dataDir], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0 || allowFailure) resolve({ code, stdout, stderr });
      else reject(new Error(`centraid-gateway ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });
}

/** Decode the pasteable one-line token (mirror of pairing-store.ts). */
export function parseTicket(raw) {
  const payload = JSON.parse(Buffer.from(raw.trim(), 'base64url').toString('utf8'));
  if (payload.v !== 1 || payload.kind !== 'centraid-gw-pair') {
    throw new Error(`not a centraid-gw-pair ticket: ${raw.slice(0, 40)}…`);
  }
  return payload;
}

/**
 * Run a pairing flow end-to-end: build → daemon boot → exec → verdict →
 * teardown. The flow function receives a ctx with:
 *
 *   ctx.gateway            — { url, token, endpointId, pid } of the live daemon
 *   ctx.dataDir            — the daemon's --data-dir (devices.json etc. live here)
 *   ctx.cli(args)          — run the admin CLI (`vault`/`pair`/`devices`…); --data-dir is appended
 *   ctx.mintTicket(opts)   — `pair` + parse: { raw, payload } (opts: { vault, ttlMinutes })
 *   ctx.newDevice()        — fresh device identity (iroh endpoint, relays disabled); auto-closed
 *   ctx.request(device, target) — one tunneled HTTP request on a fresh connection
 *   ctx.expectTunnelRefused(device) — assert the QUIC layer refuses this device
 *   ctx.restartGateway()   — SIGTERM + respawn on the same data dir (persistence checks)
 *   ctx.readJson(rel)      — parse a JSON file under the data dir (e.g. 'devices.json')
 *   ctx.note(msg)          — observation preserved in verdict.md
 *
 * Throw on failure, return { pass: true, notes } on success.
 */
export async function runFlow(slug, fn) {
  await ensureBuilt();
  const runId = `${slug}-${defaultRunId()}`;
  const runDir = path.join(RUNS_DIR, runId);
  const workspace = path.join(runDir, 'workspace');
  const dataDir = path.join(workspace, 'gateway');
  const logFile = path.join(runDir, 'gateway.log');
  await fs.mkdir(dataDir, { recursive: true });

  const state = { runId, runDir, workspace, dataDir, gateway: undefined };
  console.log(`[runFlow] ${slug}`);
  console.log(`  run dir : ${path.relative(REPO_ROOT, runDir)}`);

  const devices = [];
  const notes = [];
  let error, result;
  const t0 = Date.now();
  try {
    state.gateway = await spawnDaemon(dataDir, logFile);
    console.log(
      `  gateway : ${state.gateway.url} endpoint=${state.gateway.endpointId.slice(0, 10)}…`,
    );

    const ctx = {
      state,
      dataDir,
      get gateway() {
        return state.gateway;
      },
      cli: (args, opts) => cli(dataDir, args, opts),
      mintTicket: async ({ vault, ttlMinutes } = {}) => {
        const args = ['pair'];
        if (vault) args.push('--vault', vault);
        if (ttlMinutes !== undefined) args.push('--ttl-minutes', String(ttlMinutes));
        const { stdout } = await cli(dataDir, args);
        const raw = stdout.match(/^(ey[A-Za-z0-9_-]{40,})$/m)?.[1];
        if (!raw) throw new Error(`pair printed no ticket token:\n${stdout}`);
        return { raw, payload: parseTicket(raw) };
      },
      newDevice: async () => {
        const device = await createTunnelClient({ relays: 'disabled' });
        devices.push(device);
        return device;
      },
      request: async (device, target) => {
        const connection = await device.connect(ctx._gwTicket());
        try {
          return await tunnelRequest(connection, { method: 'GET', target });
        } finally {
          connection.close(0n, []);
        }
      },
      // The dial ticket the daemon published for the pair CLI — also the
      // tunnel dial target. Re-read per call: restart re-publishes it.
      _gwTicket: () => JSON.parse(readFileSync(path.join(dataDir, 'endpoint.json'), 'utf8')).ticket,
      expectTunnelRefused: async (device) => {
        const connection = await device.connect(ctx._gwTicket());
        try {
          // Mirror packages/tunnel/src/gateway-endpoint.test.ts: the refusal
          // can land on the first stream or on connection close — issue a
          // request, wait for the close, and issue another. One of the two
          // MUST throw for an unauthorized device key.
          try {
            await tunnelRequest(connection, { method: 'GET', target: '/centraid/_vault/vaults' });
            await connection.closed();
            await tunnelRequest(connection, { method: 'GET', target: '/centraid/_vault/vaults' });
          } catch {
            return; // refused — expected
          }
          throw new Error(`device ${device.endpointId.slice(0, 10)}… was NOT refused`);
        } finally {
          try {
            connection.close(0n, []);
          } catch {
            // Already closed by the refusal.
          }
        }
      },
      restartGateway: async () => {
        console.log('  restart gateway …');
        await killAndWait(state.gateway.pid);
        state.gateway = undefined; // a failed respawn must not leave the killed daemon looking live
        state.gateway = await spawnDaemon(dataDir, logFile);
      },
      readJson: async (rel) => JSON.parse(await fs.readFile(path.join(dataDir, rel), 'utf8')),
      note: (m) => {
        notes.push(m);
        console.log(`  note    : ${m}`);
      },
    };

    result = await fn(ctx);
  } catch (e) {
    error = e;
  } finally {
    for (const device of devices) await device.close().catch(() => {});
    await killAndWait(state.gateway?.pid);
  }
  const elapsedMs = Date.now() - t0;
  const pass = !error && result?.pass !== false;

  await writeFlowVerdict({
    repoRoot: REPO_ROOT,
    slug,
    runDir,
    elapsedMs,
    error,
    notes,
    result,
    metadata: {
      'gateway data dir': state.dataDir,
      'gateway endpoint': state.gateway?.endpointId ?? 'never became ready',
    },
    owner: `tests/agent-e2e-pairing/flows/${slug}.mjs`,
  });

  // Keep the workspace on failure so devices.json / pairing-tickets.json /
  // gateway.log can be inspected; wipe on pass (verdict + log stay in runDir).
  if (pass) await fs.rm(workspace, { recursive: true, force: true });

  if (!pass) {
    if (error) console.error(error);
    process.exit(1);
  }
}
