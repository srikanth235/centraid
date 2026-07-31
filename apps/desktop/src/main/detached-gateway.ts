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

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";

import { landlordBearerForDataDir } from "@centraid/gateway";
import { endpointIdForSecret } from "@centraid/tunnel";

import {
  buildDetachedSpawnOptions,
  classifyLockStatus,
  decideControl,
  describeDeviceCustodyGap,
  describeLockRefusal,
  describePortConflict,
  deviceCustodyGap,
  lockViewFor,
  resolveListenPort as resolveConfiguredListenPort,
} from "./detached-gateway-core.js";
import type { ControlDecision, LockProbe } from "./detached-gateway-core.js";
import { LOCAL_GATEWAY_ID } from "./gateway-paths.js";
import {
  getOrCreateGatewayWrappingKey,
  hasGatewayWrappingKey,
  readLocalLoopbackToken,
  storeLocalLoopbackToken,
} from "./gateway-secrets.js";
import { ensureIrohDeviceKey } from "./iroh-dialer.js";

const require = createRequire(import.meta.url);

const DEFAULT_HOST = "127.0.0.1";
const READY_POLL_MS = 100;
const READY_TIMEOUT_MS = 30_000;

/** In-memory handle for a detached (or adopted foreign) gateway child. */
export interface DetachedGatewayHandle {
  mode: "detached";
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
  close: () => Promise<void>;
  /** Minimal health surface so callers that only registerProbe don't crash. */
  health: {
    registerProbe: (
      name: string,
      probe: () => Promise<{
        status: "ok" | "degraded" | "error";
        detail?: string;
      }>
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
  return endpointIdForSecret(ensureIrohDeviceKey(LOCAL_GATEWAY_ID));
}

/**
 * Resolve the compiled `centraid-gateway` CLI entry (`dist/cli/cli.js`).
 * Prefers the package export via require.resolve, then monorepo-relative
 * fallbacks for unpackaged electron runs.
 */
export function resolveGatewayCliPath(): string {
  try {
    const pkgJson = require.resolve("@centraid/gateway/package.json");
    const candidate = path.join(path.dirname(pkgJson), "dist", "cli", "cli.js");
    return candidate;
  } catch {
    // fall through
  }
  const here = import.meta.dirname;
  // apps/desktop/dist/main → ../../../packages/gateway/dist/cli/cli.js
  const monorepo = path.resolve(
    here,
    "../../../packages/gateway/dist/cli/cli.js"
  );
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
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  try {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetchImpl(
      new URL("/centraid/_gateway/info", `${url}/`).toString(),
      {
        headers,
        signal: AbortSignal.timeout(2000),
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

async function probeGatewayAuthenticated(
  url: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  if (!token) return false;
  try {
    const res = await fetchImpl(
      new URL("/centraid/_gateway/health", `${url}/`).toString(),
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2_000),
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** First candidate bearer the live gateway accepts, or `undefined`. */
async function firstWorkingToken(
  url: string,
  candidates: ReadonlyArray<string | undefined>,
  index = 0
): Promise<string | undefined> {
  const candidate = candidates[index];
  if (candidate === undefined) return undefined;
  if (!candidate) return firstWorkingToken(url, candidates, index + 1);
  if (await probeGatewayAuthenticated(url, candidate)) return candidate;
  return firstWorkingToken(url, candidates, index + 1);
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
  if (typeof process.versions.electron === "string") {
    return "node";
  }
  return process.execPath;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
async function terminateDetachedGateway(
  pid: number,
  timeoutMs = STOP_TIMEOUT_MS
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (!processExists(pid)) return;
  signalGatewayGroup(pid, "SIGTERM");
  const deadline = Date.now() + timeoutMs;
  const waitForExit = async (): Promise<void> => {
    if (Date.now() >= deadline || !processExists(pid)) return;
    await sleep(STOP_POLL_MS);
    return waitForExit();
  };
  await waitForExit();
  if (processExists(pid)) {
    signalGatewayGroup(pid, "SIGKILL");
    const hardDeadline = Date.now() + 1_000;
    const waitForHardExit = async (): Promise<void> => {
      if (Date.now() >= hardDeadline || !processExists(pid)) return;
      await sleep(STOP_POLL_MS);
      return waitForHardExit();
    };
    await waitForHardExit();
  }
}

function makeVaults(
  url: string,
  token: string
): DetachedGatewayHandle["vaults"] {
  const request = async (
    pathname: string,
    body: Record<string, unknown>,
    vaultId?: string
  ): Promise<Record<string, unknown>> => {
    const response = await fetch(new URL(pathname, `${url}/`), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(vaultId ? { "x-centraid-vault": vaultId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const result = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok) {
      throw new Error(
        typeof result.message === "string"
          ? result.message
          : `vault operation failed (HTTP ${response.status})`
      );
    }
    return result;
  };
  return {
    async create(name?: string): Promise<{ vaultId: string }> {
      const result = await request("/centraid/_vault/vaults", { name });
      if (typeof result.vaultId !== "string") {
        throw new Error("vault create returned no vaultId");
      }
      return { vaultId: result.vaultId };
    },
    async delete(vaultId: string, name: string): Promise<void> {
      await request("/centraid/_vault/vaults:erase", { name }, vaultId);
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
    mode: "detached",
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
  const pollUntilReady = async (): Promise<{ url: string; token: string }> => {
    if (Date.now() >= deadline) {
      throw new Error(
        `detached gateway at ${url} did not become ready within ${input.timeoutMs}ms`
      );
    }
    const ok = await probeGatewayAuthenticated(url, input.token);
    if (ok) return { url, token: input.token };
    await sleep(READY_POLL_MS);
    return pollUntilReady();
  };
  return pollUntilReady();
}

const LOCK_STATUS_TIMEOUT_MS = 5_000;

/**
 * Run `lock-status` and classify the outcome (never throws).
 *
 * `spawnSync` reports a timeout as `error.code === 'ETIMEDOUT'` after killing
 * the child — the ONLY way to tell "the CLI blocked on the holder's SQLite
 * lock" apart from "the CLI failed fast", and previously discarded.
 */
function probeLockStatus(
  dataDir: string,
  cliPath: string,
  nodeBin: string,
  wrappingKey?: Buffer
): LockProbe {
  const result = spawnSync(
    nodeBin,
    [cliPath, "lock-status", "--data-dir", dataDir, "--json"],
    {
      encoding: "utf8",
      timeout: LOCK_STATUS_TIMEOUT_MS,
      env: {
        ...process.env,
        ...(wrappingKey
          ? { CENTRAID_KEYSTORE_MASTER_KEY: wrappingKey.toString("base64") }
          : {}),
      },
    }
  );
  return classifyLockStatus({
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
    timedOut:
      (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
  });
}

/**
 * Ask the OS which process holds `file`, without opening it.
 *
 * This is the fallback for exactly the case where the CLI cannot tell us —
 * it blocks on the same lock we are asking about — so it must not go through
 * SQLite. `lsof -t` is the portable-enough POSIX answer (the gateway CLI uses
 * it for the same purpose); best-effort and diagnostic only, never a decision
 * input. Returns `undefined` where lsof is absent (Windows) or says nothing.
 */
function osLockHolderPid(file: string): number | undefined {
  const result = spawnSync("lsof", ["-t", file], {
    encoding: "utf8",
    timeout: 2_000,
  });
  if (result.status !== 0) return undefined;
  const pid = Number((result.stdout || "").trim().split(/\s+/u)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Whether `<dataDir>/keys` already holds key-store envelopes (E2 detection). */
function gatewayKeysPresent(dataDir: string): boolean {
  const keysDir = path.join(dataDir, "keys");
  if (!fs.existsSync(keysDir)) return false;
  return fs
    .readdirSync(keysDir, { withFileTypes: true })
    .some((entry) => entry.isFile());
}

/** Whether anything is listening on host:port right now (EADDRINUSE pre-check). */
function portListenerPid(port: number): number | undefined {
  const result = spawnSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
    timeout: 2_000,
  });
  if (result.status !== 0) return undefined;
  const pid = Number((result.stdout || "").trim().split(/\s+/u)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function portInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const settle = (inUse: boolean): void => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(1_000);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

/**
 * Ensure a detached gateway is running for `dataDir`. Adopts a live owned
 * (or foreign) process when possible; refuses reclaim when a probe fails
 * against a foreign stamp (H3).
 */
export async function ensureDetachedGateway(
  options: EnsureDetachedOptions
): Promise<DetachedGatewayHandle> {
  const dataDir = options.dataDir;
  const host = options.host ?? DEFAULT_HOST;
  const port = resolveConfiguredListenPort(options.port);
  const cliPath = options.cliPath ?? resolveGatewayCliPath();
  const nodeBin = options.nodeBin ?? resolveNodeBin();
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const candidateUrl = `http://${host}:${port}`;
  // E2 — check custody BEFORE minting. `getOrCreateGatewayWrappingKey` mints a
  // fresh key whenever this device holds none, which is right for a new gateway
  // and silently fatal for an existing one: the new key cannot open the
  // envelopes already in `<dataDir>/keys`, and every downstream symptom (the
  // CLI's KeyStoreError, the refusal below) points somewhere else.
  if (
    options.gatewayWrappingKey === undefined &&
    deviceCustodyGap({
      hasStoredWrappingKey: hasGatewayWrappingKey(LOCAL_GATEWAY_ID),
      gatewayKeysPresent: gatewayKeysPresent(dataDir),
    })
  ) {
    throw new Error(describeDeviceCustodyGap(dataDir));
  }
  const gatewayWrappingKey =
    options.gatewayWrappingKey ??
    getOrCreateGatewayWrappingKey(LOCAL_GATEWAY_ID);
  const existingToken = readLocalLoopbackToken(LOCAL_GATEWAY_ID);
  const lockProbe = probeLockStatus(
    dataDir,
    cliPath,
    nodeBin,
    gatewayWrappingKey
  );
  const lock = lockViewFor(lockProbe);
  // A gateway the user installed as an OS service was not spawned by this
  // desktop, so it never received `CENTRAID_GATEWAY_TOKEN` and derives its
  // landlord bearer from the endpoint key instead. The desktop holds the same
  // custody credential, so try the derived bearer as well — otherwise opting
  // into the service produces a permanent `'foreign'` refusal on every
  // subsequent launch (issue #568 item F).
  const controlToken = await firstWorkingToken(candidateUrl, [
    existingToken,
    landlordBearerForDataDir(dataDir, { masterKey: gatewayWrappingKey }),
  ]);
  const credentialedProbeOk = controlToken !== undefined;
  const publicProbeOk = await probeGatewayInfo(candidateUrl);
  const decision: ControlDecision = decideControl({
    lockHeld: lock.held,
    credentialedProbeOk,
    publicProbeOk,
  });

  if (decision === "probe-failed-refuse") {
    // Refusing is still correct — we will not open a second writer against a
    // db we could not read the lock of. The pid comes from the OS when the CLI
    // could not name the holder, which is precisely the case where the user
    // needs it (the CLI was blocked by that very holder).
    const holderPid =
      lock.holderPid ?? osLockHolderPid(path.join(dataDir, "gateway.db"));
    throw new Error(
      describeLockRefusal({
        probe: lockProbe,
        dataDir,
        ...(holderPid === undefined ? {} : { holderPid }),
      })
    );
  }

  if (decision === "foreign") {
    throw new Error(
      "a live gateway holds this data directory, but this desktop has no matching " +
        "device credential; leave it running and pair this desktop over iroh"
    );
  }

  if (decision === "own" && controlToken) {
    return makeHandle({
      url: candidateUrl,
      token: controlToken,
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

  // Pre-spawn port identity check. Reaching here means the lock on OUR data dir
  // is free — which says nothing about the port, and a leftover daemon bound to
  // a DIFFERENT data dir still owns it. The child is spawned detached with
  // `stdio: 'ignore'` (H2), so its EADDRINUSE exit is invisible and the only
  // symptom is the ready-poll timing out 30s later against a stranger's gateway.
  if (await portInUse(listenHost, listenPort)) {
    const pid = portListenerPid(listenPort);
    throw new Error(
      describePortConflict({
        host: listenHost,
        port: listenPort,
        dataDir,
        ...(pid === undefined ? {} : { pid }),
      })
    );
  }
  const spawnOpts = buildDetachedSpawnOptions();
  const args = [
    cliPath,
    "serve",
    "--data-dir",
    dataDir,
    "--port",
    String(listenPort),
    "--host",
    listenHost,
  ];

  // Mint the per-launch loopback token and hand it to the daemon via
  // `CENTRAID_GATEWAY_TOKEN`. Persist it in device safeStorage—never the
  // gateway tree—so a desktop restart can re-adopt the child.
  const loopbackToken = crypto.randomBytes(32).toString("hex");
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
        CENTRAID_KEYSTORE_MASTER_KEY: gatewayWrappingKey.toString("base64"),
      },
    });
  } catch (error) {
    throw new Error(
      `failed to spawn detached gateway: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }

  const pid = child.pid;
  if (pid == null) {
    throw new Error("failed to spawn detached gateway: no pid");
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
export function preferEmbeddedGateway(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.CENTRAID_EMBEDDED_GATEWAY === "1";
}

/**
 * H5/H6 — install the OS service unit via the same CLI `service-admin` uses
 * (`centraid-gateway service install --data-dir …`, label `dev.centraid.gateway`).
 * Opt-in only; never call from a silent path.
 */
export async function installGatewayOsService(
  dataDir: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const cliPath = resolveGatewayCliPath();
    const nodeBin = process.execPath;
    const port = resolveConfiguredListenPort();
    const ownerId = await getOrCreateDesktopOwnerId();
    const gatewayWrappingKey = getOrCreateGatewayWrappingKey(LOCAL_GATEWAY_ID);
    const result = spawnSync(
      nodeBin,
      [
        cliPath,
        "service",
        "install",
        "--data-dir",
        dataDir,
        "--host",
        DEFAULT_HOST,
        "--port",
        String(port),
      ],
      // `nodeBin` here is `process.execPath` = the Electron binary. Run it in
      // node mode so this one-shot install doesn't flash the full desktop app
      // (and so the child's own `process.execPath`-derived unit stays sane).
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          CENTRAID_DESKTOP_ENDPOINT_ID: ownerId,
          CENTRAID_KEYSTORE_MASTER_KEY: gatewayWrappingKey.toString("base64"),
        },
      }
    );
    if (result.status === 0) return { ok: true };
    const err = (
      result.stderr ||
      result.stdout ||
      `exit ${result.status}`
    ).trim();
    return { ok: false, error: err || "service install failed" };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
