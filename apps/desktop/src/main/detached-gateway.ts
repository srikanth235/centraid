// governance: allow-repo-hygiene file-size-limit (#468) one cohesive detached spawn/adopt/poll/stop owner — splitting would scatter stamp/status/token/CLI resolve that must stay in lockstep
/*
 * Impure detached-gateway glue (issue #468, H2–H7).
 *
 * Pure decisions live in `detached-gateway-core.ts`. This module owns:
 *   - resolving the bundled `centraid-gateway` CLI entry (H6)
 *   - spawning with detached/stdio-ignore/unref (H2)
 *   - ownership + status files under the gateway data dir (H3/H4)
 *   - minting the per-launch loopback token, handing it to the spawned daemon
 *     via `CENTRAID_GATEWAY_TOKEN`, and polling `/centraid/_gateway/info` until
 *     ready (issue #505 phase 7 retired the daemon's persistent `token.bin`;
 *     the desktop is the loopback token's landlord now, persisting it beside
 *     the data dir so it can re-adopt its own child after a restart)
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
import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';
import {
  buildDetachedSpawnOptions,
  buildOwnershipStamp,
  buildStatusFile,
  canControl,
  DEFAULT_GATEWAY_PORT,
  isProcessAlive,
  ownedGatewayNeedsRespawn,
  OWNERSHIP_FILE,
  resolveListenPort,
  STATUS_FILE,
  type ControlDecision,
  type GatewayStatusFile,
  type OwnershipStamp,
} from './detached-gateway-core.js';

const require = createRequire(import.meta.url);

const DESKTOP_OWNER_ID_FILE = 'desktop-gateway-owner-id';
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
   * Admin vault acts via the same CLI (create/delete left HTTP in #289).
   * Only meaningful for owned gateways; foreign still shells out against
   * the shared data dir when the operator has shell access.
   */
  vaults: {
    create: (name?: string) => { vaultId: string };
    delete: (vaultId: string) => void;
  };
}

function ownershipPath(dataDir: string): string {
  return path.join(dataDir, OWNERSHIP_FILE);
}

function statusPath(dataDir: string): string {
  return path.join(dataDir, STATUS_FILE);
}

/**
 * The per-launch loopback token file the DESKTOP writes (issue #505 phase 7).
 * NOT the retired daemon `token.bin` (that shared admin plane is gone): this is
 * a loopback-only bearer the desktop mints, hands to its spawned daemon via
 * `CENTRAID_GATEWAY_TOKEN`, and reads back to re-adopt that same child across a
 * desktop restart. A CLI/service daemon we did not spawn has no matching file,
 * so its ephemeral secret is unknown to us and adoption fails closed.
 */
function tokenPath(dataDir: string): string {
  return path.join(dataDir, 'desktop-loopback-token.bin');
}

async function writeLoopbackToken(dataDir: string, token: string): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(tokenPath(dataDir), token, { mode: 0o600 });
}

/** Stable per-install owner id for ownership stamps (persisted in userData). */
export async function getOrCreateDesktopOwnerId(): Promise<string> {
  const file = path.join(app.getPath('userData'), DESKTOP_OWNER_ID_FILE);
  try {
    const existing = (await fs.readFile(file, 'utf8')).trim();
    if (existing.length > 0) return existing;
  } catch {
    // mint
  }
  const { randomUUID } = await import('node:crypto');
  const id = randomUUID();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, id, { mode: 0o600 });
  return id;
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

export async function readOwnershipStamp(dataDir: string): Promise<OwnershipStamp | null> {
  try {
    const raw = await fs.readFile(ownershipPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<OwnershipStamp>;
    if (
      typeof parsed.ownerId === 'string' &&
      typeof parsed.pid === 'number' &&
      (parsed.owner === 'desktop' || parsed.owner === 'cli' || parsed.owner === 'service')
    ) {
      return {
        owner: parsed.owner,
        ownerId: parsed.ownerId,
        pid: parsed.pid,
        startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
        ...(typeof parsed.buildTag === 'string' ? { buildTag: parsed.buildTag } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function writeOwnershipStamp(dataDir: string, stamp: OwnershipStamp): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(ownershipPath(dataDir), JSON.stringify(stamp, null, 2), { mode: 0o600 });
}

export async function readStatusFile(dataDir: string): Promise<GatewayStatusFile | null> {
  try {
    const raw = await fs.readFile(statusPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<GatewayStatusFile>;
    if (
      typeof parsed.url === 'string' &&
      typeof parsed.host === 'string' &&
      typeof parsed.port === 'number' &&
      typeof parsed.pid === 'number'
    ) {
      return {
        url: parsed.url,
        host: parsed.host,
        port: parsed.port,
        pid: parsed.pid,
        ...(typeof parsed.tokenFile === 'string' ? { tokenFile: parsed.tokenFile } : {}),
        renewedAt: typeof parsed.renewedAt === 'string' ? parsed.renewedAt : '',
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function writeStatusFile(dataDir: string, status: GatewayStatusFile): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(statusPath(dataDir), JSON.stringify(status, null, 2), { mode: 0o600 });
}

/**
 * Read the per-launch loopback token this desktop wrote for a daemon it
 * spawned (UTF-8 hex, issue #505 phase 7). Returns undefined when missing/empty.
 * Remote-gateway profile tokens use safeStorage encryption under a different
 * tree (`gateway-secrets.ts`); this plaintext-hex file only ever guards the
 * loopback listener of a locally-spawned detached daemon.
 */
export async function readDaemonToken(dataDir: string): Promise<string | undefined> {
  try {
    const buf = await fs.readFile(tokenPath(dataDir), 'utf8');
    const trimmed = buf.trim();
    // Reject binary/encrypted blobs (non-printable) so we wait for a real mint.
    if (!trimmed || /[^\x20-\x7E]/.test(trimmed)) return undefined;
    return trimmed;
  } catch {
    return undefined;
  }
}

function processAliveCheck(pid: number): boolean {
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

export interface EnsureDetachedOptions {
  dataDir: string;
  /** Optional port override; defaults to DEFAULT_GATEWAY_PORT. */
  port?: number;
  host?: string;
  ownerId: string;
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
  if (!isProcessAlive(pid, processAliveCheck)) return;
  signalGatewayGroup(pid, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isProcessAlive(pid, processAliveCheck)) {
    await sleep(STOP_POLL_MS);
  }
  if (isProcessAlive(pid, processAliveCheck)) {
    signalGatewayGroup(pid, 'SIGKILL');
    const hardDeadline = Date.now() + 1_000;
    while (Date.now() < hardDeadline && isProcessAlive(pid, processAliveCheck)) {
      await sleep(STOP_POLL_MS);
    }
  }
}

/**
 * An opaque tag for the gateway BUILD on disk: the newest mtime across the
 * compiled server tree (`dist/…`, minus the static `web/` bundle, which the
 * daemon serves per-request and never needs a restart to pick up). A rebuild
 * bumps a source file's mtime → a new tag → the desktop respawns instead of
 * adopting the stale daemon. Cheap: one bounded stat walk per launch. Best
 * effort — any failure yields 'unknown', which simply degrades to adoption.
 */
async function gatewayBuildTag(cliPath: string): Promise<string> {
  // cliPath = <dist>/cli/cli.js → distRoot = <dist>
  const distRoot = path.dirname(path.dirname(cliPath));
  let maxMtimeMs = 0;
  let scanned = 0;
  const FILE_CAP = 20_000;
  async function walk(dir: string): Promise<void> {
    if (scanned >= FILE_CAP) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scanned >= FILE_CAP) return;
      if (entry.isDirectory()) {
        // Static embedded UI — served, not executed; no restart needed for it.
        if (entry.name === 'web') continue;
        await walk(path.join(dir, entry.name));
        continue;
      }
      scanned += 1;
      try {
        const st = await fs.stat(path.join(dir, entry.name));
        if (st.mtimeMs > maxMtimeMs) maxMtimeMs = st.mtimeMs;
      } catch {
        // skip unreadable entry
      }
    }
  }
  await walk(distRoot);
  return maxMtimeMs > 0 ? String(Math.floor(maxMtimeMs)) : 'unknown';
}

function makeVaults(
  dataDir: string,
  cliPath: string,
  nodeBin: string,
): DetachedGatewayHandle['vaults'] {
  return {
    create(name?: string): { vaultId: string } {
      const args = ['vault', 'create', '--data-dir', dataDir, '--json'];
      if (name) args.push('--name', name);
      const result = spawnSync(nodeBin, [cliPath, ...args], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      if (result.status !== 0) {
        throw new Error(
          `vault create failed: ${(result.stderr || result.stdout || 'unknown error').trim()}`,
        );
      }
      const line = (result.stdout || '').trim().split('\n').pop() ?? '';
      const parsed = JSON.parse(line) as { ok?: boolean; vaultId?: string };
      if (!parsed.vaultId) throw new Error(`vault create returned no vaultId: ${line}`);
      return { vaultId: parsed.vaultId };
    },
    delete(vaultId: string): void {
      const result = spawnSync(
        nodeBin,
        [cliPath, 'vault', 'delete', '--data-dir', dataDir, vaultId],
        { encoding: 'utf8', timeout: 30_000 },
      );
      if (result.status !== 0) {
        throw new Error(
          `vault delete failed: ${(result.stderr || result.stdout || 'unknown error').trim()}`,
        );
      }
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
    vaults: makeVaults(input.dataDir, input.cliPath, input.nodeBin),
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
  dataDir: string;
  pid: number;
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
    if (!isProcessAlive(input.pid, processAliveCheck)) {
      throw new Error(`detached gateway pid ${input.pid} exited before becoming ready`);
    }
    const ok = await probeGatewayInfo(url, input.token);
    if (ok) return { url, token: input.token };
    await sleep(READY_POLL_MS);
  }
  throw new Error(`detached gateway at ${url} did not become ready within ${input.timeoutMs}ms`);
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
  const ownerId = options.ownerId;
  const cliPath = options.cliPath ?? resolveGatewayCliPath();
  const nodeBin = options.nodeBin ?? resolveNodeBin();
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;

  await fs.mkdir(dataDir, { recursive: true });

  const stamp = await readOwnershipStamp(dataDir);
  const status = await readStatusFile(dataDir);
  const candidatePort = status?.port ?? port;
  const candidateHost = status?.host ?? host;
  const candidateUrl = `http://${candidateHost}:${candidatePort}`;
  const existingToken = await readDaemonToken(dataDir);
  const probeOk = await probeGatewayInfo(candidateUrl, existingToken);

  const decision: ControlDecision = canControl(stamp, ownerId, { probeOk });

  if (decision === 'probe-failed-refuse') {
    throw new Error(
      'A gateway ownership stamp exists for a different owner, but the status ' +
        'probe failed — refusing to reclaim (issue #468 H3). Check whether ' +
        'another process still holds the port, or remove the stale stamp manually.',
    );
  }

  if (decision === 'foreign') {
    // Adopt don't kill — use whatever is answering (or stamped).
    const token = existingToken ?? (await readDaemonToken(dataDir));
    if (!token || !probeOk) {
      throw new Error(
        'A live gateway is present but this desktop install does not own it ' +
          'and cannot read its token — leave it alone or stop it from the shell.',
      );
    }
    const pid = stamp?.pid ?? status?.pid ?? 0;
    return makeHandle({
      url: candidateUrl,
      token,
      pid,
      host: candidateHost,
      port: candidatePort,
      dataDir,
      owned: false,
      cliPath,
      nodeBin,
    });
  }

  // Own + still alive: adopt (or wait for readiness if mid-boot).
  if (decision === 'own' && stamp && isProcessAlive(stamp.pid, processAliveCheck)) {
    if (probeOk) {
      // Freshness gate: if the running daemon was spawned from an older build
      // than the one on disk, stop it and respawn instead of adopting a stale
      // binary (dev rebuild / prod app update). A missing stamp buildTag counts
      // as stale so the mechanism self-establishes on first launch after this
      // ships. Owned only — never touches a foreign gateway (H3).
      const currentBuildTag = await gatewayBuildTag(cliPath);
      const stale = ownedGatewayNeedsRespawn(
        stamp,
        currentBuildTag,
        options.replaceOwnedIfStale === true,
      );
      if (!stale) {
        const token = existingToken ?? (await readDaemonToken(dataDir));
        if (!token) {
          throw new Error('Owned gateway is live but its loopback token file is missing');
        }
        return makeHandle({
          url: candidateUrl,
          token,
          pid: stamp.pid,
          host: candidateHost,
          port: candidatePort,
          dataDir,
          owned: true,
          cliPath,
          nodeBin,
        });
      }
      // Stale build — retire the old daemon and fall through to a fresh spawn.
      await terminateDetachedGateway(stamp.pid);
    } else {
      // Process is up but probe failed — give it time (still booting). We wrote
      // this daemon's loopback token before spawning it, so recover it here.
      const bootToken = existingToken ?? (await readDaemonToken(dataDir));
      try {
        if (!bootToken)
          throw new Error('owned gateway is booting but its loopback token is missing');
        const ready = await waitUntilReady({
          host: candidateHost,
          port: candidatePort,
          dataDir,
          pid: stamp.pid,
          timeoutMs: readyTimeoutMs,
          token: bootToken,
        });
        return makeHandle({
          url: ready.url,
          token: ready.token,
          pid: stamp.pid,
          host: candidateHost,
          port: candidatePort,
          dataDir,
          owned: true,
          cliPath,
          nodeBin,
        });
      } catch {
        // Booting never completed — stop it (waiting for real exit so the
        // respawn below doesn't hit EADDRINUSE) and fall through to a fresh spawn.
        await terminateDetachedGateway(stamp.pid);
      }
    }
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
  // `CENTRAID_GATEWAY_TOKEN` (issue #505 phase 7). Persist it beside the data
  // dir first so a desktop restart can re-adopt this same child.
  const loopbackToken = crypto.randomBytes(32).toString('hex');
  await writeLoopbackToken(dataDir, loopbackToken);

  let child: ChildProcess;
  try {
    child = spawn(nodeBin, args, {
      detached: spawnOpts.detached,
      stdio: spawnOpts.stdio,
      env: { ...process.env, CENTRAID_GATEWAY_TOKEN: loopbackToken },
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

  const ownership = buildOwnershipStamp({
    owner: 'desktop',
    ownerId,
    pid,
    buildTag: await gatewayBuildTag(cliPath),
  });
  await writeOwnershipStamp(dataDir, ownership);

  const ready = await waitUntilReady({
    host: listenHost,
    port: listenPort,
    dataDir,
    pid,
    timeoutMs: readyTimeoutMs,
    token: loopbackToken,
  });

  const statusPayload = buildStatusFile({
    host: listenHost,
    port: listenPort,
    pid,
    tokenFile: tokenPath(dataDir),
  });
  await writeStatusFile(dataDir, statusPayload);

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
