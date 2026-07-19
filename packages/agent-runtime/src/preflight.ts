/*
 * CLI preflight — runs `<bin> --version` once on settings change or
 * gateway boot. Result cached in memory and exposed via
 * `GET /centraid/_turn/runner-status` so the chat panel can show a
 * Setup screen when the binary is missing, unauthenticated, or too old.
 *
 * Minimum versions are empirically-verified — see `MIN_VERSIONS` below.
 * If the user's CLI is older than the pinned minimum, preflight reports
 * `ok: true` but `versionAtLeast: false` so the chat panel can warn
 * (without hard-blocking — the adapter may still work; we only know
 * for sure on a fresh-empirically-tested version).
 */

import { spawn } from 'node:child_process';
import type { RunnerStatus } from '@centraid/app-engine';
import type { RunnerKind, RunnerPrefs } from './types.js';
import { readRunnerModels } from './models/catalog.js';
import { agentSpawnEnv } from './spawn-env.js';
import { lowPriorityCommand } from './low-priority.js';

const VERSION_TIMEOUT_MS = 5_000;

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Minimum CLI versions whose event/flag schemas we've verified. Older
 * versions may still work — the adapter is defensive — but we surface
 * the mismatch in the preflight so users know whether they're on
 * tested ground.
 *
 *  - codex: 0.128.0 (empirically captured `thread.started`,
 *    `item.completed[agent_message]`, `turn.completed`, `--json`,
 *    `exec resume <id>` subcommand, `-c mcp_servers.<name>.url=…`).
 *  - claude-code: 2.1.126 (empirically captured `system/init`,
 *    `assistant`, `user[tool_result]`, `result` events under
 *    `--output-format stream-json --verbose`).
 */
const MIN_VERSIONS: Record<RunnerKind, SemVer> = {
  codex: { major: 0, minor: 128, patch: 0 },
  'claude-code': { major: 2, minor: 1, patch: 126 },
};

export function minVersionString(kind: RunnerKind): string {
  const v = MIN_VERSIONS[kind];
  return `${v.major}.${v.minor}.${v.patch}`;
}

interface CachedStatus {
  status: RunnerStatus;
  cacheKey: string;
}

let cached: CachedStatus | undefined;

function cacheKey(prefs: RunnerPrefs): string {
  return `${prefs.kind}::${prefs.binPath ?? ''}`;
}

export function invalidatePreflightCache(): void {
  cached = undefined;
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
  kind: RunnerKind,
  binPath?: string,
): Promise<CliAvailability> {
  const bin = binPath ?? defaultBinFor(kind);
  try {
    const raw = await execVersion(bin, agentSpawnEnv({ binPath }));
    return { available: true, version: raw.trim().slice(0, 200) };
  } catch {
    return { available: false };
  }
}

/**
 * Run the CLI preflight and attach the chat picker's model list.
 *
 * The `--version` probe is cached (cheap, stable). The model list is a pure
 * read from the gateway-owned catalog — enumeration and warming are owned by
 * the `CatalogWarmer`, driven on boot and Refresh. Without a `catalogPath`
 * there's no list (the picker shows a loading/empty state). The caller (the
 * gateway's `runnerStatus` override) attaches `modelsStatus` and kicks a warm,
 * since this module has no warmer handle.
 */
export async function runPreflight(
  prefs: RunnerPrefs,
  opts: { catalogPath?: string; refresh?: boolean } = {},
): Promise<RunnerStatus> {
  const key = cacheKey(prefs);
  const status = cached && cached.cacheKey === key ? cached.status : await probe(prefs);
  cached = { status, cacheKey: key };

  if (status.ok) {
    status.models = opts.catalogPath ? await readRunnerModels(opts.catalogPath, prefs.kind) : [];
  }
  return status;
}

async function probe(prefs: RunnerPrefs): Promise<RunnerStatus> {
  const bin = prefs.binPath ?? defaultBinFor(prefs.kind);
  try {
    const raw = await execVersion(bin, agentSpawnEnv({ binPath: prefs.binPath }));
    const trimmed = raw.trim().slice(0, 200);
    const parsed = parseSemver(trimmed);
    const minV = MIN_VERSIONS[prefs.kind];
    const versionAtLeast = parsed ? compareSemver(parsed, minV) >= 0 : undefined;
    const status: RunnerStatus = {
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
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        kind: prefs.kind,
        ok: false,
        reason: `${bin} not found on PATH`,
        hint: hintFor(prefs.kind),
        minVersion: minVersionString(prefs.kind),
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: prefs.kind,
      ok: false,
      reason: message,
      hint: hintFor(prefs.kind),
      minVersion: minVersionString(prefs.kind),
    };
  }
}

function defaultBinFor(kind: RunnerKind): string {
  return kind === 'codex' ? 'codex' : 'claude';
}

function hintFor(kind: RunnerKind): string {
  if (kind === 'codex') {
    return 'Install Codex CLI (https://platform.openai.com/docs/codex) and run `codex login`.';
  }
  return 'Install Claude Code (https://claude.com/code) and run `claude login`.';
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
  const m = text.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return undefined;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

export function compareSemver(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

async function execVersion(bin: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const command = lowPriorityCommand(bin, ['--version']);
    const child = spawn(command.bin, command.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    const chunks: Buffer[] = [];
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => {
        child.kill('SIGKILL');
        reject(new Error('--version timed out'));
      });
    }, VERSION_TIMEOUT_MS);
    timer.unref?.();

    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', (err) => {
      clearTimeout(timer);
      settle(() => reject(err));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) settle(() => resolve(Buffer.concat(chunks).toString('utf8')));
      else settle(() => reject(new Error(`--version exited ${code ?? 'null'}`)));
    });
  });
}
