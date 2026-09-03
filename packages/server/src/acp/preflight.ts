import { spawn } from "node:child_process";

import type { HarnessStatus } from "@centraid/server/engine";

import { unrefTimer } from "../lib/unref-timer.js";
import { resolveAcpCapabilities } from "./backends/acp/capabilities-cache.js";
import { lowPriorityCommand } from "./low-priority.js";
import { readHarnessModels } from "./models/catalog.js";
import { getHarness } from "./registry.js";
import { harnessSpawnEnv } from "./spawn-env.js";
import type { HarnessKind, HarnessPrefs } from "./types.js";

const VERSION_TIMEOUT_MS = 5_000;
export const CLI_AVAILABILITY_TTL_MS = 24 * 60 * 60 * 1_000;

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

export function minVersionString(kind: HarnessKind): string {
  const v = getHarness(kind).minVersion;
  return `${v.major}.${v.minor}.${v.patch}`;
}

interface CachedStatus {
  status: HarnessStatus;
  cacheKey: string;
}

let cached: CachedStatus | undefined;
const availabilityCache = new Map<
  string,
  { readonly checkedAt: number; readonly status: CliAvailability }
>();
const availabilityInFlight = new Map<string, Promise<CliAvailability>>();

function cacheKey(prefs: HarnessPrefs): string {
  return `${prefs.kind}::${prefs.binPath ?? ""}::${JSON.stringify(prefs.extraArgs ?? [])}`;
}

export function invalidatePreflightCache(): void {
  cached = undefined;
  availabilityCache.clear();
  availabilityInFlight.clear();
}

export interface CliAvailability {
  available: boolean;
  version?: string;
}

/** PATH probe only — does not check auth. */
export async function probeCliAvailability(
  kind: HarnessKind,
  binPath?: string,
  opts: { refresh?: boolean; now?: number } = {}
): Promise<CliAvailability> {
  const bin = binPath ?? getHarness(kind).defaultBin;
  if (!bin) return { available: false };
  const key = `${kind}::${bin}`;
  const now = opts.now ?? Date.now();
  const prior = availabilityCache.get(key);
  if (
    !opts.refresh &&
    prior &&
    now - prior.checkedAt < CLI_AVAILABILITY_TTL_MS
  ) {
    return prior.status;
  }
  const pending = availabilityInFlight.get(key);
  if (!opts.refresh && pending) return pending;
  const probeLocal = (async (): Promise<CliAvailability> => {
    try {
      const raw = await execVersion(bin, harnessSpawnEnv({ binPath }));
      return { available: true, version: raw.trim().slice(0, 200) };
    } catch {
      return { available: false };
    }
  })();
  availabilityInFlight.set(key, probeLocal);
  try {
    const status = await probeLocal;
    availabilityCache.set(key, { checkedAt: now, status });
    return status;
  } finally {
    availabilityInFlight.delete(key);
  }
}

/** Cached `--version` plus catalog model list; no warmer handle here. */
export async function runPreflight(
  prefs: HarnessPrefs,
  opts: {
    catalogPath?: string;
    refresh?: boolean;
    requireSessionReady?: boolean;
  } = {}
): Promise<HarnessStatus> {
  const key = cacheKey(prefs);
  const status =
    cached && cached.cacheKey === key ? cached.status : await probe(prefs);
  cached = { status, cacheKey: key };

  if (status.ok && opts.requireSessionReady) {
    const caps = await resolveAcpCapabilities(prefs.kind, {
      ...(prefs.binPath ? { binPath: prefs.binPath } : {}),
      ...(prefs.extraArgs?.length ? { extraArgs: prefs.extraArgs } : {}),
      probeIfMissing: true,
      probeLivePrompt: false,
    });
    if (!caps?.reachable || caps.authRequired) {
      return {
        ...status,
        ok: false,
        reason: caps?.authRequired
          ? `harness session is not authenticated${caps.reason ? `: ${caps.reason}` : ""}`
          : (caps?.reason ??
            "harness did not complete ACP initialize/session readiness"),
        hint: getHarness(prefs.kind).installHint,
      };
    }
  }
  if (status.ok) {
    status.models = opts.catalogPath
      ? await readHarnessModels(opts.catalogPath, prefs.kind)
      : [];
  }
  return status;
}

async function probe(prefs: HarnessPrefs): Promise<HarnessStatus> {
  const harness = getHarness(prefs.kind);
  const bin = prefs.binPath ?? harness.defaultBin;
  // Custom `acp` has no default binary — do not spawn `undefined --version`.
  if (!bin) {
    return {
      kind: prefs.kind,
      ok: false,
      reason:
        "no binary configured for this harness — set its path in Settings → Agents",
      hint: harness.installHint,
      minVersion: minVersionString(prefs.kind),
    };
  }
  try {
    const raw = await execVersion(
      bin,
      harnessSpawnEnv({ binPath: prefs.binPath })
    );
    const trimmed = raw.trim().slice(0, 200);
    const parsed = parseSemver(trimmed);
    const minV = harness.minVersion;
    const versionAtLeast = parsed
      ? compareSemver(parsed, minV) >= 0
      : undefined;
    const status: HarnessStatus = {
      kind: prefs.kind,
      ok: true,
      version: trimmed,
      minVersion: minVersionString(prefs.kind),
    };
    if (versionAtLeast !== undefined) status.versionAtLeast = versionAtLeast;
    if (versionAtLeast === false) {
      status.reason = `installed ${trimmed} is older than minimum ${minVersionString(prefs.kind)} verified to work — proceed with caution`;
      status.hint = `Run ${bin} update (or your package manager's upgrade command) to bring it up to date.`;
    }
    return status;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        kind: prefs.kind,
        ok: false,
        reason: `${bin} not found on PATH`,
        hint: harness.installHint,
        minVersion: minVersionString(prefs.kind),
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: prefs.kind,
      ok: false,
      reason: message,
      hint: harness.installHint,
      minVersion: minVersionString(prefs.kind),
    };
  }
}

export function parseSemver(text: string): SemVer | undefined {
  const m = text.match(/(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/u);
  if (!m) return undefined;
  return {
    major: Number(m.groups?.major),
    minor: Number(m.groups?.minor),
    patch: Number(m.groups?.patch),
  };
}

export function compareSemver(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

async function execVersion(
  bin: string,
  env: NodeJS.ProcessEnv
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const command = lowPriorityCommand(bin, ["--version"]);
    const child = spawn(command.bin, command.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => {
        child.kill("SIGKILL");
        reject(new Error("--version timed out"));
      });
    }, VERSION_TIMEOUT_MS);
    unrefTimer(timer);

    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    child.on("error", (err) => {
      clearTimeout(timer);
      settle(() => reject(err));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        // `nice` may print a sandbox setpriority denial on stderr; prefer stdout.
        settle(() => resolve(stdout.trim() ? stdout : stderr));
      } else
        settle(() => reject(new Error(`--version exited ${code ?? "null"}`)));
    });
  });
}
