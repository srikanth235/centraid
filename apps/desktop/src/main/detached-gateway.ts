// governance: allow-repo-hygiene file-size-limit (#468) one cohesive detached spawn/adopt/poll/stop owner — splitting would scatter lock/probe/CLI resolve that must stay in lockstep
/*
 * Impure detached-gateway glue (#468, H2–H7): CLI resolve, detached spawn,
 * lock inspection, loopback-token mint, stopping only processes we own. Pure
 * decisions belong in `detached-gateway-core.ts`, crash-loop bookkeeping in
 * `gateway-supervisor-core.ts`. The desktop is the loopback token's landlord
 * (#505): it lives in device safeStorage, never the data dir.
 */
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";

// Subpath, never the barrel (#883 C5) — see `gateway-paths.ts`. This still
// costs the `@centraid/vault` KeyStore graph that `gateway-secrets.js` pays
// for anyway.
import { landlordBearerForDataDir } from "@centraid/server/landlord-auth";
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

export interface DetachedGatewayHandle {
  mode: "detached";
  url: string;
  /** Minted here, passed via `CENTRAID_GATEWAY_TOKEN` (#505): no token file
   *  exists to poll. */
  token: string;
  pid: number;
  host: string;
  port: number;
  dataDir: string;
  owned: boolean;
  /** Stops the child only if we own it (H3). App quit must NOT call this for
   *  detached handles — see `shutdownAllLocalGatewaysExcept`. */
  close: () => Promise<void>;
  health: {
    registerProbe: (
      name: string,
      probe: () => Promise<{
        status: "ok" | "degraded" | "error";
        detail?: string;
      }>
    ) => void;
  };
  /** Through the live daemon: a second CLI writer cannot mutate gateway.db. */
  vaults: {
    create: (name?: string) => Promise<{ vaultId: string }>;
    delete: (vaultId: string, name: string) => Promise<void>;
  };
}

/** An EndpointId, never a parallel UUID or a gateway-tree credential. */
export async function getOrCreateDesktopOwnerId(): Promise<string> {
  return endpointIdForSecret(ensureIrohDeviceKey(LOCAL_GATEWAY_ID));
}

/**
 * Package resolution serves every INSTALLED layout, and works only because
 * `@centraid/server` exports `./package.json`: drop that subpath and
 * `require.resolve` throws, silently demoting every call to the fallback
 * (`detached-gateway-resolve.test.ts` pins it). The fallback serves the working
 * tree, where this file sits FOUR levels below the repo root, not three.
 */
export function resolveGatewayCliPath(): string {
  try {
    const pkgJson = require.resolve("@centraid/server/package.json");
    const candidate = path.join(path.dirname(pkgJson), "dist", "cli", "cli.js");
    return candidate;
  } catch {
    // Intentionally empty.
  }
  const here = import.meta.dirname;
  const monorepo = path.resolve(
    here,
    "../../../../packages/server/dist/cli/cli.js"
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
  port?: number;
  host?: string;
  ownerId: string;
  gatewayWrappingKey?: Buffer;
  nodeBin?: string;
  cliPath?: string;
  readyTimeoutMs?: number;
  replaceOwnedIfStale?: boolean;
}

function resolveNodeBin(): string {
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

const STOP_TIMEOUT_MS = 5_000;
const STOP_POLL_MS = 100;

function signalGatewayGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Intentionally empty.
    }
  }
}

/**
 * Callers MUST await before rebinding the port (the fresh child otherwise races
 * the old listener into an EADDRINUSE that `stdio:'ignore'` swallows) or before
 * re-reading the stamp (`ensureDetachedGateway` would adopt the dying pid).
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
      registerProbe() {},
    },
    vaults: makeVaults(input.url, input.token),
    async close() {
      if (!owned) return;
      // Awaited (H2): a fire-and-forget SIGTERM lets a restart race the
      // dying daemon.
      await terminateDetachedGateway(pid);
    },
  };
}

async function waitUntilReady(input: {
  host: string;
  port: number;
  timeoutMs: number;
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

/** Never throws. `ETIMEDOUT` is the only signal separating "blocked on the
 *  holder's SQLite lock" from "failed fast". */
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
 * Must not go through SQLite: the CLI may itself be blocked on the lock being
 * asked about. Diagnostic only, never a decision input.
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

function gatewayKeysPresent(dataDir: string): boolean {
  const keysDir = path.join(dataDir, "keys");
  if (!fs.existsSync(keysDir)) return false;
  return fs
    .readdirSync(keysDir, { withFileTypes: true })
    .some((entry) => entry.isFile());
}

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
  // Custody check BEFORE the mint: `getOrCreateGatewayWrappingKey` mints
  // whenever this device holds no key, and a fresh key cannot open envelopes
  // already in `<dataDir>/keys`.
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
  // An OS-service gateway never got `CENTRAID_GATEWAY_TOKEN` and derives
  // its landlord bearer from the endpoint key, so the derived bearer must stay
  // in the candidate list or the service is refused as `'foreign'` (#568).
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
    // Never open a second writer against a db whose lock we could not read:
    // the OS names the holder exactly when the blocked CLI cannot.
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

  const listenPort = port;
  const listenHost = host;

  // A free lock says nothing about the port, and under `stdio: 'ignore'` (H2)
  // a child's EADDRINUSE exit surfaces only as a 30s ready-poll timeout
  // against a stranger's gateway.
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

  // Device safeStorage, never the gateway tree, so a restart can re-adopt.
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

export function preferEmbeddedGateway(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.CENTRAID_EMBEDDED_GATEWAY === "1";
}

/** H5/H6 — opt-in only, never from a silent path. */
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
