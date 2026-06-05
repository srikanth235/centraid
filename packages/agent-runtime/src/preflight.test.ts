import { expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compareSemver,
  invalidatePreflightCache,
  minVersionString,
  parseSemver,
  probeCliAvailability,
  runPreflight,
} from './preflight.ts';
import { defaultModelsFor } from './models/defaults.ts';

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

test('attaches the default model seed when no catalog path is set', async () => {
  invalidatePreflightCache();
  const status = await runPreflight({ kind: 'codex', binPath: 'true' });
  expect(status.ok).toBe(true);
  expect(status.models).toEqual(defaultModelsFor('codex'));
});

test('serves the default seed from a catalog path without enumerating on a normal load', async () => {
  invalidatePreflightCache();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-preflight-'));
  const catalogPath = path.join(dir, 'model-catalog.json');
  const status = await runPreflight({ kind: 'codex', binPath: 'true' }, { catalogPath });
  expect(status.models).toEqual(defaultModelsFor('codex'));
  // A normal (non-refresh) load must not enumerate, so no catalog is written.
  await expect(fs.access(catalogPath)).rejects.toThrow();
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
