/*
 * CLI preflight — runs `<bin> --version` once on settings change or
 * gateway boot. Result cached in memory and exposed via
 * `GET /centraid/_chat/runner-status` so the chat panel can show a
 * Setup screen when the binary is missing, unauthenticated, or too old.
 *
 * Minimum versions are empirically-verified — see `MIN_VERSIONS` below.
 * If the user's CLI is older than the pinned minimum, preflight reports
 * `ok: true` but `versionAtLeast: false` so the chat panel can warn
 * (without hard-blocking — the adapter may still work; we only know
 * for sure on a fresh-empirically-tested version).
 */

import { spawn } from 'node:child_process';
import type { ProviderStatus, RunnerStatus } from '@centraid/app-engine';
import type { OpenAICompatProvider, RunnerKind, RunnerPrefs } from './types.js';

const VERSION_TIMEOUT_MS = 5_000;
const PROVIDER_PROBE_TIMEOUT_MS = 4_000;

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
  const p = prefs.provider;
  // Provider id + baseUrl + envKey are all part of the cache identity:
  // switching any of them must re-probe both the binary and the endpoint.
  // The API key itself isn't included — rotating just the key shouldn't
  // require a re-probe (the next request will surface a 401 if it's bad).
  const provKey = p ? `${p.id}::${p.baseUrl}::${p.envKey ?? ''}` : '';
  return `${prefs.kind}::${prefs.binPath ?? ''}::${provKey}`;
}

export function invalidatePreflightCache(): void {
  cached = undefined;
}

export async function runPreflight(prefs: RunnerPrefs): Promise<RunnerStatus> {
  const key = cacheKey(prefs);
  if (cached && cached.cacheKey === key) return cached.status;
  const status = await probe(prefs);
  if (prefs.kind === 'codex' && prefs.provider) {
    status.provider = await probeProvider(prefs.provider);
  }
  cached = { status, cacheKey: key };
  return status;
}

async function probe(prefs: RunnerPrefs): Promise<RunnerStatus> {
  const bin = prefs.binPath ?? defaultBinFor(prefs.kind);
  try {
    const raw = await execVersion(bin);
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

/**
 * Probe a custom OpenAI-compatible endpoint by issuing `GET <baseUrl>/models`
 * with the configured bearer token. We treat any 2xx with a JSON body as
 * "ok" and count entries in `data[]` when present (the OpenAI shape).
 *
 * The timeout is short (4s) — settings UIs poll this on every panel
 * open. A slow endpoint surfaces as `ok: false` with reason `timed out`,
 * not a hung UI.
 */
export async function probeProvider(provider: OpenAICompatProvider): Promise<ProviderStatus> {
  const base: ProviderStatus = {
    id: provider.id,
    baseUrl: provider.baseUrl,
    ok: false,
  };
  const url = joinUrl(provider.baseUrl, 'models');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_PROBE_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (provider.envKey && provider.apiKey) {
      headers.Authorization = `Bearer ${provider.apiKey}`;
    }
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        ...base,
        reason:
          res.status === 401 || res.status === 403
            ? `${res.status} — API key rejected by ${provider.id}`
            : `HTTP ${res.status} from ${url}`,
      };
    }
    const body = (await res.json().catch(() => undefined)) as unknown;
    return { ...base, ok: true, modelCount: countModels(body) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isAbort = controller.signal.aborted;
    return {
      ...base,
      reason: isAbort
        ? `${url} timed out after ${PROVIDER_PROBE_TIMEOUT_MS}ms`
        : `failed to reach ${url}: ${message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function joinUrl(base: string, segment: string): string {
  const trimmedBase = base.endsWith('/') ? base.slice(0, -1) : base;
  const trimmedSeg = segment.startsWith('/') ? segment.slice(1) : segment;
  return `${trimmedBase}/${trimmedSeg}`;
}

function countModels(body: unknown): number | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const data = (body as { data?: unknown }).data;
  if (Array.isArray(data)) return data.length;
  // Ollama's /v1/models also returns { data: [...] } so the OpenAI shape
  // is the common path. If a provider deviates, we just omit the count.
  return undefined;
}

async function execVersion(bin: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
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
