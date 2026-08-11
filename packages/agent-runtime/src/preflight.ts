/*
 * CLI preflight — runs `<bin> --version` once on settings change or
 * gateway boot. Result cached in memory and exposed via
 * `GET /centraid/_turn/harness-status` so the chat panel can show a
 * Setup screen when the binary is missing, unauthenticated, or too old.
 *
 * Minimum versions are empirically-verified — see `MIN_VERSIONS` below.
 * If the user's CLI is older than the pinned minimum, preflight reports
 * `ok: true` but `versionAtLeast: false` so the chat panel can warn
 * (without hard-blocking — the adapter may still work; we only know
 * for sure on a fresh-empirically-tested version).
 */

import { spawn } from "node:child_process";

import type { HarnessStatus } from "@centraid/app-engine";

import { resolveAcpCapabilities } from "./backends/acp/capabilities-cache.js";
import { lowPriorityCommand } from "./low-priority.js";
import { readHarnessModels } from "./models/catalog.js";
import { getHarness } from "./registry.js";
import { agentSpawnEnv } from "./spawn-env.js";
import type { HarnessKind, HarnessPrefs } from "./types.js";

const VERSION_TIMEOUT_MS = 5_000;
export const CLI_AVAILABILITY_TTL_MS = 24 * 60 * 60 * 1_000;

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Minimum CLI versions whose event/flag schemas we've verified live in the
 * harness-backend registry (`registry.ts`), alongside each kind's default
 * binary and install hint. codex/claude-code are empirically captured; the
 * ACP-native kinds are pinned to the oldest release whose ACP surface we
 * rely on (see each entry's comment in `registry.ts`).
 */
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
  /** The `<bin> --version` invocation succeeded — the CLI is on PATH. */
  available: boolean;
  /** Trimmed `--version` output when available. */
  version?: string;
}

/**
 * Is a coding-agent CLI available on PATH? Runs `<bin> --version` and
 * reports success — Centraid is agnostic to how the CLI authenticates, so
 * this checks only that the command runs, not for any auth file/keychain/env.
 * Used by the gateway's `GET /centraid/_agents/status` to report which
 * agents its host can drive.
 */
export async function probeCliAvailability(
  kind: HarnessKind,
  binPath?: string,
  opts: { refresh?: boolean; now?: number } = {}
): Promise<CliAvailability> {
  const bin = binPath ?? getHarness(kind).defaultBin;
  // The custom `acp` kind has no default binary — unavailable until configured.
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
      const raw = await execVersion(bin, agentSpawnEnv({ binPath }));
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

/**
 * Run the CLI preflight and attach the chat picker's model list.
 *
 * The `--version` probe is cached (cheap, stable). The model list is a pure
 * read from the gateway-owned catalog — enumeration and warming are owned by
 * the `CatalogWarmer`, driven on boot and Refresh. Without a `catalogPath`
 * there's no list (the picker shows a loading/empty state). The caller (the
 * gateway's `harnessStatus` override) attaches `modelsStatus` and kicks a warm,
 * since this module has no warmer handle.
 */
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
    // Readiness only needs "does this agent reach initialize + session/new,
    // and is it signed in". A fresh cached snapshot answers that, so this
    // never spawns on a warm cache — and when it does have to spawn it skips
    // the probe's live diagnostic prompt, which would bill the owner a real
    // provider turn on every session-ready check.
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
          ? `agent session is not authenticated${caps.reason ? `: ${caps.reason}` : ""}`
          : (caps?.reason ??
            "agent did not complete ACP initialize/session readiness"),
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
  const backend = getHarness(prefs.kind);
  const bin = prefs.binPath ?? backend.defaultBin;
  // The custom `acp` kind has no default binary: report unavailable (with the
  // configuration hint) rather than spawning `undefined --version`.
  if (!bin) {
    return {
      kind: prefs.kind,
      ok: false,
      reason:
        "no binary configured for this harness — set its path in Settings → Agents",
      hint: backend.installHint,
      minVersion: minVersionString(prefs.kind),
    };
  }
  try {
    const raw = await execVersion(
      bin,
      agentSpawnEnv({ binPath: prefs.binPath })
    );
    const trimmed = raw.trim().slice(0, 200);
    const parsed = parseSemver(trimmed);
    const minV = backend.minVersion;
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
        hint: backend.installHint,
        minVersion: minVersionString(prefs.kind),
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: prefs.kind,
      ok: false,
      reason: message,
      hint: backend.installHint,
      minVersion: minVersionString(prefs.kind),
    };
  }
}

/**
 * Parse a semver from a `--version` output string. Accepts shapes like
 *   "codex-cli 0.128.0"
 *   "2.1.126 (Claude Code)"
 *   "v1.2.3"
 * Returns undefined when no semver is found.
 */
export function parseSemver(text: string): SemVer | undefined {
  // No leading `\b` — strings like `v1.2.3` have a word char before the
  // digit, which would block the boundary. We still want `1.2.3` out of
  // them.
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
    timer.unref?.();

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
        // `nice` can report a harmless setpriority denial on stderr inside a
        // sandbox. Successful CLIs normally put their version on stdout; fall
        // back to stderr only for CLIs that intentionally version there.
        settle(() => resolve(stdout.trim() ? stdout : stderr));
      } else
        settle(() => reject(new Error(`--version exited ${code ?? "null"}`)));
    });
  });
}
