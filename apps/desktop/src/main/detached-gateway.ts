// governance: allow-repo-hygiene file-size-limit (#468) one cohesive detached spawn/adopt/poll/stop owner — splitting would scatter lock/probe/CLI resolve that must stay in lockstep
/*
 * Impure detached-gateway glue (issue #468, H2–H7).
 *
 * Pure decisions live in `detached-gateway-core.ts`. This module owns:
 *   - resolving the bundled `centraid-gateway` CLI entry (H6)
 *   - spawning with detached/stdio-ignore/unref (H2)
 *   - kernel-backed gateway.db lock inspection (H3/H4)
 *   - minting the per-launch loopback token, handing it to the spawned daemon
 *     via `CENTRAID_GATEWAY_TOKEN`, and polling `/centraid/_gateway/info` until
 *     ready (issue #505 phase 7 retired the daemon's persistent `token.bin`;
 *     the desktop is the loopback token's landlord now, persisting it only in
 *     device safeStorage so no non-daemon writer touches the data dir)
 *   - stopping only processes we own
 *
 * Lifecycle verbs (start/stop/status/service) all invoke the same CLI
 * entry `service-admin` uses for LaunchAgent/systemd units
 * (`dev.centraid.gateway`). Crash-loop bookkeeping stays in
 * `gateway-supervisor-core.ts` (H7) and is applied by `local-gateway.ts`.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { endpointIdForSecret, loadEndpointSecret } from '@centraid/tunnel';
import {
  buildDetachedSpawnOptions,
  DEFAULT_GATEWAY_PORT,
  decideControl,
  resolveListenPort,
  type ControlDecision,
} from './detached-gateway-core.js';
import {
  deviceIrohKeyPersistence,
  getOrCreateGatewayWrappingKey,
  readLocalLoopbackToken,
  storeLocalLoopbackToken,
} from './gateway-secrets.js';
import { LOCAL_GATEWAY_ID } from './gateway-paths.js';

const require = createRequire(import.meta.url);

const DEFAULT_HOST = '127.0.0.1';
const READY_POLL_MS = 100;
const READY_TIMEOUT_MS = 30_000;

/** In-memory handle for a detached (or adopted foreign) gateway child. */
export interface DetachedGatewayHandle {
  mode: 'detached';
  url: string;
  token: string;
  pid: number;
  host: string;
  port: number;
  dataDir: string;
  /** True when ownership stamp matches this desktop install. */
  owned: boolean;
  /**
   * Stop the child if we own it. Foreign gateways are left alone (H3).
   * App quit must NOT call this for detached handles — see
   * `shutdownAllLocalGatewaysExcept` in local-gateway.ts.
   */
  close(): Promise<void>;
  /** Minimal health surface so callers that only registerProbe don't crash. */
  health: {
    registerProbe: (
      name: string,
      probe: () => Promise<{ status: 'ok' | 'degraded' | 'error'; detail?: string }>,
    ) => void;
  };
  /**
   * Owner vault acts through the live daemon. A second CLI writer cannot
   * mutate gateway.db while the daemon holds its lifetime exclusive lock.
   */
  vaults: {
    create: (name?: string) => Promise<{ vaultId: string }>;
    delete: (vaultId: string, name: string) => Promise<void>;
  };
}

/**
 * Stable desktop device identity derived from its safeStorage-backed iroh key.
 * This is an EndpointId, not a parallel UUID or a gateway-tree credential.
 */
export async function getOrCreateDesktopOwnerId(): Promise<string> {
  const secret = loadEndpointSecret({
    persistence: deviceIrohKeyPersistence(LOCAL_GATEWAY_ID),
    onCorrupt: 'remint',
    label: 'local desktop iroh key',
    warn: (message) => console.warn(`desktop identity: ${message}`),
  });
  return endpointIdForSecret(secret);
}

/**
 * Resolve the compiled `centraid-gateway` CLI entry (`dist/cli/cli.js`).
 * Prefers the package export via require.resolve, then monorepo-relative
 * fallbacks for unpackaged electron runs.
 */
export function resolveGatewayCliPath(): string {
  try {
    const pkgJson = require.resolve('@centraid/gateway/package.json');
    const candidate = path.join(path.dirname(pkgJson), 'dist', 'cli', 'cli.js');
    return candidate;
  } catch {
    // fall through
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  // apps/desktop/dist/main → ../../../packages/gateway/dist/cli/cli.js
  const monorepo = path.resolve(here, '../../../packages/gateway/dist/cli/cli.js');
  return monorepo;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Probe HTTP liveness on the gateway info route. */
export async function probeGatewayInfo(
  url: string,
  token?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetchImpl(new URL('/centraid/_gateway/info', `${url}/`).toString(), {
      headers,
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function probeGatewayAuthenticated(
  url: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!token) return false;
  try {
    const res = await fetchImpl(new URL('/centraid/_gateway/health', `${url}/`).toString(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface EnsureDetachedOptions {
  dataDir: string;
  /** Optional port override; defaults to DEFAULT_GATEWAY_PORT. */
  port?: number;
  host?: string;
  ownerId: string;
  /** safeStorage-backed AES wrapping key for gateway KeyStore envelopes. */
  gatewayWrappingKey?: Buffer;
  /** Node binary; defaults to process.execPath when not electron, else `node` on PATH. */
  nodeBin?: string;
  cliPath?: string;
  readyTimeoutMs?: number;
  /**
   * When adopting a gateway we OWN, first check whether it was spawned from an
   * older build than the one on disk (via the ownership stamp's `buildTag`) and
   * respawn it if so. The desktop passes `true` so a rebuilt gateway (dev) or an
   * updated app (prod) takes effect on the next launch instead of the stale
   * daemon serving forever. Only ever touches gateways we own (H3 preserved).
   * Absent/false → adopt whatever is live (unit tests, legacy behavior).
   */
  replaceOwnedIfStale?: boolean;
}

function resolveNodeBin(): string {
  // Electron's execPath is the Electron binary, not node — prefer `node` on PATH.
  if (typeof process.versions.electron === 'string') {
    return 'node';
  }
  return process.execPath;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How long to wait for a SIGTERM'd gateway to exit before escalating (H2). */
const STOP_TIMEOUT_MS = 5_000;
const STOP_POLL_MS = 100;

/**
 * Send `signal` to the detached child's whole process group, falling back to
 * the bare pid. Detached children are their own group leaders (H2), so the
 * group signal takes grandchildren (agent runs, workers) down with the gateway.
 */
function signalGatewayGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

/**
 * Stop an owned detached gateway and **wait for it to actually exit** before
 * returning — SIGTERM the group, poll the pid, escalate to SIGKILL, then a
 * short final wait. Callers MUST await this before rebinding the port (else the
 * fresh child races the old listener → EADDRINUSE, swallowed by stdio:'ignore')
 * or before re-reading the ownership stamp (else `ensureDetachedGateway` adopts
 * the still-dying pid and never respawns). This is exactly the restart-crash
 * footgun: the old stop was a fire-and-forget SIGTERM with no wait.
 */
async function terminateDetachedGateway(pid: number, timeoutMs = STOP_TIMEOUT_MS): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (!processExists(pid)) return;
  signalGatewayGroup(pid, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processExists(pid)) {
    await sleep(STOP_POLL_MS);
  }
  if (processExists(pid)) {
    signalGatewayGroup(pid, 'SIGKILL');
    const hardDeadline = Date.now() + 1_000;
    while (Date.now() < hardDeadline && processExists(pid)) {
      await sleep(STOP_POLL_MS);
    }
  }
}

function makeVaults(url: string, token: string): DetachedGatewayHandle['vaults'] {
  const request = async (
    pathname: string,
    body: Record<string, unknown>,
    vaultId?: string,
  ): Promise<Record<string, unknown>> => {
    const response = await fetch(new URL(pathname, `${url}/`), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(vaultId ? { 'x-centraid-vault': vaultId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(
        typeof result.message === 'string'
          ? result.message
          : `vault operation failed (HTTP ${response.status})`,
      );
    }
    return result;
  };
  return {
    async create(name?: string): Promise<{ vaultId: string }> {
      const result = await request('/centraid/_vault/vaults', { name });
      if (typeof result.vaultId !== 'string') {
        throw new Error('vault create returned no vaultId');
      }
      return { vaultId: result.vaultId };
    },
    async delete(vaultId: string, name: string): Promise<void> {
      await request('/centraid/_vault/vaults:erase', { name }, vaultId);
    },
  };
}

function makeHandle(input: {
  url: string;
  token: string;
  pid: number;
  host: string;
  port: number;
  dataDir: string;
  owned: boolean;
  cliPath: string;
  nodeBin: string;
}): DetachedGatewayHandle {
  const { owned, pid } = input;
  return {
    mode: 'detached',
    url: input.url,
    token: input.token,
    pid,
    host: input.host,
    port: input.port,
    dataDir: input.dataDir,
    owned,
    health: {
      registerProbe() {
        // Tunnel/health probes are registered on the in-process embed only;
        // a detached child owns its own health registry.
      },
    },
    vaults: makeVaults(input.url, input.token),
    async close() {
      if (!owned) return;
      // Wait for the process to actually exit (H2) — a fire-and-forget SIGTERM
      // let `restartLocalGateway`'s stop→start race the dying daemon: the
      // respawn either adopted the still-terminating pid or hit EADDRINUSE on
      // the not-yet-released port, leaving the gateway down. Awaiting exit here
      // makes stop→start correct for every caller.
      await terminateDetachedGateway(pid);
    },
  };
}

async function waitUntilReady(input: {
  host: string;
  port: number;
  timeoutMs: number;
  /**
   * The loopback token the daemon was spawned with (issue #505 phase 7). The
   * desktop minted it and handed it over via `CENTRAID_GATEWAY_TOKEN`, so we
   * already know the bearer — no polling a daemon-written token file.
   */
  token: string;
}): Promise<{ url: string; token: string }> {
  const url = `http://${input.host}:${input.port}`;
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const ok = await probeGatewayAuthenticated(url, input.token);
    if (ok) return { url, token: input.token };
    await sleep(READY_POLL_MS);
  }
  throw new Error(`detached gateway at ${url} did not become ready within ${input.timeoutMs}ms`);
}

interface LockSnapshot {
  held: boolean;
  answering: boolean;
  holderPid?: number;
}

function lockSnapshot(
  dataDir: string,
  cliPath: string,
  nodeBin: string,
  wrappingKey?: Buffer,
): LockSnapshot {
  const result = spawnSync(nodeBin, [cliPath, 'lock-status', '--data-dir', dataDir, '--json'], {
    encoding: 'utf8',
    timeout: 5_000,
    env: {
      ...process.env,
      ...(wrappingKey ? { CENTRAID_KEYSTORE_MASTER_KEY: wrappingKey.toString('base64') } : {}),
    },
  });
  const line = (result.stdout || '').trim().split('\n').pop() ?? '';
  try {
    const parsed = JSON.parse(line) as Partial<LockSnapshot> & { ok?: boolean };
    if (
      parsed.ok === true &&
      typeof parsed.held === 'boolean' &&
      typeof parsed.answering === 'boolean'
    ) {
      return {
        held: parsed.held,
        answering: parsed.answering,
        ...(typeof parsed.holderPid === 'number' ? { holderPid: parsed.holderPid } : {}),
      };
    }
  } catch {
    // Fall through to the fail-closed result below.
  }
  return { held: true, answering: false };
}

/**
 * Ensure a detached gateway is running for `dataDir`. Adopts a live owned
 * (or foreign) process when possible; refuses reclaim when a probe fails
 * against a foreign stamp (H3).
 */
export async function ensureDetachedGateway(
  options: EnsureDetachedOptions,
): Promise<DetachedGatewayHandle> {
  const dataDir = options.dataDir;
  const host = options.host ?? DEFAULT_HOST;
  const port = resolveListenPort(options.port);
  const cliPath = options.cliPath ?? resolveGatewayCliPath();
  const nodeBin = options.nodeBin ?? resolveNodeBin();
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const candidateUrl = `http://${host}:${port}`;
  const gatewayWrappingKey =
    options.gatewayWrappingKey ?? getOrCreateGatewayWrappingKey(LOCAL_GATEWAY_ID);
  const existingToken = readLocalLoopbackToken(LOCAL_GATEWAY_ID);
  const lock = lockSnapshot(dataDir, cliPath, nodeBin, gatewayWrappingKey);
  const credentialedProbeOk = await probeGatewayAuthenticated(candidateUrl, existingToken);
  const publicProbeOk = await probeGatewayInfo(candidateUrl);
  const decision: ControlDecision = decideControl({
    lockHeld: lock.held,
    credentialedProbeOk,
    publicProbeOk,
  });

  if (decision === 'probe-failed-refuse') {
    throw new Error(
      'gateway.db is locked but the daemon is not answering — refusing to start ' +
        `a second writer${lock.holderPid ? ` (OS holder pid ${lock.holderPid})` : ''}`,
    );
  }

  if (decision === 'foreign') {
    throw new Error(
      'a live gateway holds this data directory, but this desktop has no matching ' +
        'device credential; leave it running and pair this desktop over iroh',
    );
  }

  if (decision === 'own' && existingToken) {
    return makeHandle({
      url: candidateUrl,
      token: existingToken,
      pid: lock.holderPid ?? 0,
      host,
      port,
      dataDir,
      owned: true,
      cliPath,
      nodeBin,
    });
  }

  // Need to spawn (own-but-dead, stale-reclaim, or failed adopt).
  // Prefer the configured/default port for a fresh bind (H4), not a stale status port.
  const listenPort = port;
  const listenHost = host;
  const spawnOpts = buildDetachedSpawnOptions();
  const args = [
    cliPath,
    'serve',
    '--data-dir',
    dataDir,
    '--port',
    String(listenPort),
    '--host',
    listenHost,
  ];

  // Mint the per-launch loopback token and hand it to the daemon via
  // `CENTRAID_GATEWAY_TOKEN`. Persist it in device safeStorage—never the
  // gateway tree—so a desktop restart can re-adopt the child.
  const loopbackToken = crypto.randomBytes(32).toString('hex');
  storeLocalLoopbackToken(LOCAL_GATEWAY_ID, loopbackToken);

  let child: ChildProcess;
  try {
    child = spawn(nodeBin, args, {
      detached: spawnOpts.detached,
      stdio: spawnOpts.stdio,
      env: {
        ...process.env,
        CENTRAID_GATEWAY_TOKEN: loopbackToken,
        CENTRAID_DESKTOP_ENDPOINT_ID: options.ownerId,
        CENTRAID_KEYSTORE_MASTER_KEY: gatewayWrappingKey.toString('base64'),
      },
    });
  } catch (err) {
    throw new Error(
      `failed to spawn detached gateway: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const pid = child.pid;
  if (pid == null) {
    throw new Error('failed to spawn detached gateway: no pid');
  }
  if (spawnOpts.unref) {
    child.unref();
  }

  const ready = await waitUntilReady({
    host: listenHost,
    port: listenPort,
    timeoutMs: readyTimeoutMs,
    token: loopbackToken,
  });

  return makeHandle({
    url: ready.url,
    token: ready.token,
    pid,
    host: listenHost,
    port: listenPort,
    dataDir,
    owned: true,
    cliPath,
    nodeBin,
  });
}

/** Whether the desktop should prefer the in-process embed (tests/E2E). */
export function preferEmbeddedGateway(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CENTRAID_EMBEDDED_GATEWAY === '1';
}

/**
 * H5/H6 — install the OS service unit via the same CLI `service-admin` uses
 * (`centraid-gateway service install --data-dir …`, label `dev.centraid.gateway`).
 * Opt-in only; never call from a silent path.
 */
export function installGatewayOsService(
  dataDir: string,
): { ok: true } | { ok: false; error: string } {
  try {
    const cliPath = resolveGatewayCliPath();
    const nodeBin = process.execPath;
    const port = resolveListenPort();
    const result = spawnSync(
      nodeBin,
      [
        cliPath,
        'service',
        'install',
        '--data-dir',
        dataDir,
        '--host',
        DEFAULT_HOST,
        '--port',
        String(port),
      ],
      // `nodeBin` here is `process.execPath` = the Electron binary. Run it in
      // node mode so this one-shot install doesn't flash the full desktop app
      // (and so the child's own `process.execPath`-derived unit stays sane).
      { encoding: 'utf8', timeout: 30_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
    );
    if (result.status === 0) return { ok: true };
    const err = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    return { ok: false, error: err || 'service install failed' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export { DEFAULT_GATEWAY_PORT, resolveListenPort };
