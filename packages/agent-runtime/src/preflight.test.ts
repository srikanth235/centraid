import { tempDir } from '@centraid/test-kit/temp-dir';
import { afterEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  compareSemver,
  invalidatePreflightCache,
  minVersionString,
  parseSemver,
  probeCliAvailability,
  runPreflight,
} from './preflight.ts';
import { writeCatalogEntry } from './models/catalog.ts';
import { agentSpawnEnv, sanitizeAgentPath } from './spawn-env.ts';

test('reports binary-not-found when bin does not exist', async () => {
  invalidatePreflightCache();
  const status = await runPreflight({
    kind: 'codex',
    binPath: '/this/path/does/not/exist/codex',
  });
  expect(status.kind).toBe('codex');
  expect(status.ok).toBe(false);
  expect(status.reason ?? '').toMatch(/not found|ENOENT|spawn|--version/);
  expect(status.hint?.includes('Codex')).toBeTruthy();
});

test('caches result per (kind, binPath)', async () => {
  invalidatePreflightCache();
  // Use `true` (always succeeds, version output) and `false` (always fails)
  // to exercise both branches without depending on any user-installed CLI.
  const first = await runPreflight({ kind: 'codex', binPath: 'true' });
  const second = await runPreflight({ kind: 'codex', binPath: 'true' });
  // Same cache key → identical object (we don't deep-clone — fine for tests).
  expect(first).toBe(second);
});

test('different binPath busts the cache', async () => {
  invalidatePreflightCache();
  const a = await runPreflight({ kind: 'codex', binPath: 'true' });
  const b = await runPreflight({ kind: 'codex', binPath: '/no/such/bin' });
  expect(a.ok).toBe(true);
  expect(b.ok).toBe(false);
});

test('parseSemver handles common --version output shapes', () => {
  expect(parseSemver('codex-cli 0.128.0')).toEqual({ major: 0, minor: 128, patch: 0 });
  expect(parseSemver('2.1.126 (Claude Code)')).toEqual({ major: 2, minor: 1, patch: 126 });
  expect(parseSemver('v1.2.3-beta')).toEqual({ major: 1, minor: 2, patch: 3 });
  expect(parseSemver('no version here')).toBe(undefined);
});

test('compareSemver orders versions', () => {
  const a = { major: 1, minor: 2, patch: 3 };
  const b = { major: 1, minor: 2, patch: 4 };
  const c = { major: 1, minor: 3, patch: 0 };
  const d = { major: 2, minor: 0, patch: 0 };
  expect(compareSemver(a, b) < 0).toBeTruthy();
  expect(compareSemver(b, a) > 0).toBeTruthy();
  expect(compareSemver(a, a)).toBe(0);
  expect(compareSemver(b, c) < 0).toBeTruthy();
  expect(compareSemver(c, d) < 0).toBeTruthy();
});

test('preflight surfaces versionAtLeast when version parses', async () => {
  invalidatePreflightCache();
  // `true --version` exits 0 and prints empty output → version parses
  // as undefined → versionAtLeast stays undefined. Confirm the field is
  // absent (not falsely false) in that case.
  const status = await runPreflight({ kind: 'codex', binPath: 'true' });
  expect(status.ok).toBe(true);
  expect(status.versionAtLeast).toBe(undefined);
  expect(status.minVersion).toBe(minVersionString('codex'));
});

test('attaches an empty model list when no catalog path is set (no seed)', async () => {
  invalidatePreflightCache();
  const status = await runPreflight({ kind: 'codex', binPath: 'true' });
  expect(status.ok).toBe(true);
  expect(status.models).toEqual([]);
});

test('reads the model list from the catalog without enumerating', async () => {
  invalidatePreflightCache();
  const dir = await tempDir('centraid-preflight-');
  const catalogPath = path.join(dir, 'model-catalog.json');

  // Cold catalog → empty list (a loading/empty state, no seed). The read must
  // not spawn anything, so no catalog file appears.
  const cold = await runPreflight({ kind: 'codex', binPath: 'true' }, { catalogPath });
  expect(cold.models).toEqual([]);
  await expect(fs.access(catalogPath)).rejects.toThrow();

  // A populated catalog is read back verbatim.
  await writeCatalogEntry(catalogPath, 'codex', {
    hash: 'h',
    models: [{ id: 'gpt-x', name: 'GPT-X', default: true }],
    enumeratedAt: '2026-01-01T00:00:00.000Z',
  });
  invalidatePreflightCache();
  const warm = await runPreflight({ kind: 'codex', binPath: 'true' }, { catalogPath });
  expect(warm.models?.map((m) => m.id)).toEqual(['gpt-x']);
});

// ---- pluggable runner kinds (gemini / qwen / custom acp) ----------------

test('gemini/qwen preflight probe their bin and carry the registry min version', async () => {
  invalidatePreflightCache();
  const gemini = await runPreflight({ kind: 'gemini', binPath: 'true' });
  expect(gemini.kind).toBe('gemini');
  expect(gemini.ok).toBe(true);
  expect(gemini.minVersion).toBe(minVersionString('gemini'));

  invalidatePreflightCache();
  const qwen = await runPreflight({ kind: 'qwen', binPath: 'true' });
  expect(qwen.ok).toBe(true);
  expect(qwen.minVersion).toBe(minVersionString('qwen'));
});

test('opencode/grok/kimi preflight probe their bin and carry the registry min version', async () => {
  for (const kind of ['opencode', 'grok', 'kimi'] as const) {
    invalidatePreflightCache();
    const status = await runPreflight({ kind, binPath: 'true' });
    expect(status.kind).toBe(kind);
    expect(status.ok).toBe(true);
    expect(status.minVersion).toBe(minVersionString(kind));
  }
});

test('a missing opencode/grok/kimi binary reports unavailable with the install hint', async () => {
  // The hint IS the "why not" the providers console shows, so an unavailable
  // runner must never come back hintless.
  const expected = {
    opencode: /opencode-ai/,
    grok: /SuperGrok|X Premium/,
    kimi: /uv tool install kimi-cli/,
  } as const;
  for (const [kind, pattern] of Object.entries(expected)) {
    invalidatePreflightCache();
    const status = await runPreflight({
      kind: kind as 'opencode' | 'grok' | 'kimi',
      binPath: `/no/such/${kind}`,
    });
    expect(status.ok, kind).toBe(false);
    expect(status.hint ?? '', kind).toMatch(pattern);
  }
});

// ---- wave 7: eight more ACP-native kinds ---------------------------------

const WAVE_7_KINDS = [
  'copilot',
  'cursor',
  'kilo',
  'cline',
  'goose',
  'auggie',
  'vibe',
  'droid',
] as const;

test('every added kind preflights its bin and carries the registry min version', async () => {
  for (const kind of WAVE_7_KINDS) {
    invalidatePreflightCache();
    const status = await runPreflight({ kind, binPath: 'true' });
    expect(status.kind, kind).toBe(kind);
    expect(status.ok, kind).toBe(true);
    expect(status.minVersion, kind).toBe(minVersionString(kind));
  }
});

test("cursor's CalVer floor survives the semver-shaped minVersion string", () => {
  // 2026.07.16 is year.month.day, not semver — but it renders and compares
  // through the same numeric path, so the reported floor is exactly the date.
  expect(minVersionString('cursor')).toBe('2026.7.16');
});

test('a missing binary for any added kind reports unavailable with its install hint', async () => {
  // The hint IS the "why not" the providers console shows, so an unavailable
  // runner must never come back hintless — and for these kinds it is often
  // the only place the paid-plan / provider-config requirement appears.
  const expected = {
    copilot: /gh\.io\/copilot-install|copilot-cli/,
    cursor: /cursor-agent login/,
    kilo: /@kilocode\/cli/,
    cline: /npm i -g cline/,
    goose: /goose configure/,
    auggie: /@augmentcode\/auggie/,
    vibe: /uv tool install mistral-vibe/,
    droid: /app\.factory\.ai\/cli|brew install --cask droid/,
  } as const;
  for (const [kind, pattern] of Object.entries(expected)) {
    invalidatePreflightCache();
    const status = await runPreflight({
      kind: kind as (typeof WAVE_7_KINDS)[number],
      binPath: `/no/such/${kind}`,
    });
    expect(status.ok, kind).toBe(false);
    expect(status.reason ?? '', kind).toMatch(/not found|ENOENT|spawn|--version/);
    expect(status.hint ?? '', kind).toMatch(pattern);
  }
});

test('probeCliAvailability defaults each added kind to its own binary', async () => {
  // `vibe-acp` (not `vibe`) and `cursor-agent` (not `agent`) are the ones a
  // regression would most plausibly get wrong, so probe with no binPath and
  // confirm the default bin is the one that gets looked up and missed.
  for (const kind of WAVE_7_KINDS) {
    const status = await probeCliAvailability(kind, `/no/such/${kind}`);
    expect(status.available, kind).toBe(false);
  }
});

test('gemini install hint points at the Gemini CLI', async () => {
  invalidatePreflightCache();
  const status = await runPreflight({ kind: 'gemini', binPath: '/no/such/gemini' });
  expect(status.ok).toBe(false);
  expect(status.hint ?? '').toMatch(/Gemini CLI/);
});

test('custom acp kind is unavailable until a binPath is configured', async () => {
  invalidatePreflightCache();
  const status = await runPreflight({ kind: 'acp' });
  expect(status.kind).toBe('acp');
  expect(status.ok).toBe(false);
  expect(status.reason ?? '').toMatch(/no binary configured/);
  expect(status.hint ?? '').toMatch(/Settings/);
});

test('custom acp kind probes a configured binPath like any other runner', async () => {
  invalidatePreflightCache();
  const status = await runPreflight({ kind: 'acp', binPath: 'true' });
  expect(status.ok).toBe(true);
});

test('probeCliAvailability reports unavailable for custom acp with no binPath', async () => {
  const status = await probeCliAvailability('acp');
  expect(status.available).toBe(false);
});

// ---- probeCliAvailability tests -----------------------------------------

test('probeCliAvailability reports available + version when the CLI runs', async () => {
  // `true` always exits 0 (empty output) — stands in for an installed CLI.
  const status = await probeCliAvailability('codex', 'true');
  expect(status.available).toBe(true);
});

test('probeCliAvailability reports unavailable when the CLI is missing', async () => {
  const status = await probeCliAvailability('codex', '/no/such/bin');
  expect(status.available).toBe(false);
  expect(status.version).toBe(undefined);
});

// ---- PATH sanitization (issue: stray ~/node_modules/.bin/claude shim) ---
//
// `npm run` / `bun run` prepend every ancestor directory's
// `node_modules/.bin` to PATH. If one of those ancestors (e.g. a user's
// HOME dir) happens to hold a stray npm install, a `claude`/`codex` shim
// living there silently shadows the user's real, PATH-resolved install —
// the app reports (and runs) whatever stale binary the shim points at.
// `sanitizeAgentPath`/`agentSpawnEnv` (spawn-env.ts) strip those entries
// before any bare-name `spawn('claude'|'codex', …)`.

test('sanitizeAgentPath strips node_modules/.bin entries, preserving order', () => {
  const input = [
    '/usr/local/bin',
    '/Users/x/node_modules/.bin',
    '/opt/homebrew/bin',
    '/Users/x/project/node_modules/.bin',
    '/Users/x/.local/bin',
  ].join(path.delimiter);
  expect(sanitizeAgentPath(input)).toBe(
    ['/usr/local/bin', '/opt/homebrew/bin', '/Users/x/.local/bin'].join(path.delimiter),
  );
});

test('sanitizeAgentPath preserves non-matching entries verbatim (no-op on a clean PATH)', () => {
  const input = ['/usr/bin', '/bin', '/Users/x/.local/bin'].join(path.delimiter);
  expect(sanitizeAgentPath(input)).toBe(input);
});

test('sanitizeAgentPath handles an empty/undefined PATH', () => {
  expect(sanitizeAgentPath(undefined)).toBe('');
  expect(sanitizeAgentPath('')).toBe('');
});

test('agentSpawnEnv strips node_modules/.bin from PATH when no binPath is given', () => {
  const baseEnv = {
    PATH: ['/Users/x/node_modules/.bin', '/Users/x/.local/bin'].join(path.delimiter),
  };
  const env = agentSpawnEnv({ baseEnv });
  expect(env.PATH).toBe('/Users/x/.local/bin');
});

test('agentSpawnEnv leaves PATH untouched when an explicit binPath is given', () => {
  const baseEnv = {
    PATH: ['/Users/x/node_modules/.bin', '/Users/x/.local/bin'].join(path.delimiter),
  };
  const env = agentSpawnEnv({ baseEnv, binPath: '/some/explicit/claude' });
  expect(env.PATH).toBe(baseEnv.PATH);
});

test('agentSpawnEnv prepends extraPath after sanitization', () => {
  const baseEnv = {
    PATH: ['/Users/x/node_modules/.bin', '/Users/x/.local/bin'].join(path.delimiter),
  };
  const env = agentSpawnEnv({ baseEnv, extraPath: '/extra/dir' });
  expect(env.PATH).toBe(['/extra/dir', '/Users/x/.local/bin'].join(path.delimiter));
});

test('agentSpawnEnv preserves other env vars and never mutates baseEnv', () => {
  const baseEnv = { PATH: '/Users/x/node_modules/.bin', FOO: 'bar' };
  const env = agentSpawnEnv({ baseEnv });
  expect(env.FOO).toBe('bar');
  expect(env).not.toBe(baseEnv);
  expect(baseEnv.PATH).toBe('/Users/x/node_modules/.bin'); // unmutated
});

test('agentSpawnEnv defaults baseEnv to process.env', () => {
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = ['/Users/x/node_modules/.bin', '/usr/bin'].join(path.delimiter);
    const env = agentSpawnEnv();
    expect(env.PATH).toBe('/usr/bin');
  } finally {
    process.env.PATH = savedPath;
  }
});

// ---- end-to-end: probeCliAvailability resolves the real install, not a
// stray node_modules/.bin shim shadowing it on a polluted dev-run PATH ----

async function writeFakeBin(dir: string, name: string, version: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.writeFile(file, `#!/bin/sh\necho "${version}"\n`, { mode: 0o755 });
  return file;
}

let savedPath: string | undefined;

afterEach(() => {
  if (savedPath !== undefined) {
    process.env.PATH = savedPath;
    savedPath = undefined;
  }
});

test('probeCliAvailability resolves the real install past a node_modules/.bin shim on PATH', async () => {
  const root = await tempDir('centraid-preflight-pathfix-');
  const shimDir = path.join(root, 'node_modules', '.bin'); // e.g. a stray ~/node_modules/.bin
  const realDir = path.join(root, 'real-bin'); // e.g. ~/.local/bin
  await writeFakeBin(shimDir, 'codex', '1.0.128');
  await writeFakeBin(realDir, 'codex', '2.1.207');

  savedPath = process.env.PATH;
  // Shim first — reproduces npm/bun `run`'s ancestor node_modules/.bin
  // injection landing ahead of the user's real install on PATH.
  process.env.PATH = [shimDir, realDir].join(path.delimiter);

  const status = await probeCliAvailability('codex');
  expect(status.available).toBe(true);
  expect(status.version).toBe('2.1.207');
});

test('probeCliAvailability still finds the shim if it is the only thing on PATH (sanitization is not overzealous)', async () => {
  const root = await tempDir('centraid-preflight-pathfix-');
  const shimDir = path.join(root, 'node_modules', '.bin');
  await writeFakeBin(shimDir, 'codex', '1.0.128');

  savedPath = process.env.PATH;
  process.env.PATH = shimDir;

  const status = await probeCliAvailability('codex');
  expect(status.available).toBe(false);
});

test('probeCliAvailability with an explicit binPath ignores PATH sanitization entirely', async () => {
  const root = await tempDir('centraid-preflight-pathfix-');
  const explicitDir = path.join(root, 'node_modules', '.bin'); // even if it LOOKS like a shim dir
  const explicitBin = await writeFakeBin(explicitDir, 'codex', '3.3.3');

  const status = await probeCliAvailability('codex', explicitBin);
  expect(status.available).toBe(true);
  expect(status.version).toBe('3.3.3');
});
