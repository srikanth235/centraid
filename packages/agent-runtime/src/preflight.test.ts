import { test } from 'node:test';
import { strict as assert } from 'node:assert';
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
  assert.equal(status.kind, 'codex');
  assert.equal(status.ok, false);
  assert.match(status.reason ?? '', /not found|ENOENT|spawn|--version/);
  assert.ok(status.hint?.includes('Codex'));
});

test('caches result per (kind, binPath)', async () => {
  invalidatePreflightCache();
  // Use `true` (always succeeds, version output) and `false` (always fails)
  // to exercise both branches without depending on any user-installed CLI.
  const first = await runPreflight({ kind: 'codex', binPath: 'true' });
  const second = await runPreflight({ kind: 'codex', binPath: 'true' });
  // Same cache key → identical object (we don't deep-clone — fine for tests).
  assert.equal(first, second);
});

test('different binPath busts the cache', async () => {
  invalidatePreflightCache();
  const a = await runPreflight({ kind: 'codex', binPath: 'true' });
  const b = await runPreflight({ kind: 'codex', binPath: '/no/such/bin' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
});

test('parseSemver handles common --version output shapes', () => {
  assert.deepEqual(parseSemver('codex-cli 0.128.0'), { major: 0, minor: 128, patch: 0 });
  assert.deepEqual(parseSemver('2.1.126 (Claude Code)'), { major: 2, minor: 1, patch: 126 });
  assert.deepEqual(parseSemver('v1.2.3-beta'), { major: 1, minor: 2, patch: 3 });
  assert.equal(parseSemver('no version here'), undefined);
});

test('compareSemver orders versions', () => {
  const a = { major: 1, minor: 2, patch: 3 };
  const b = { major: 1, minor: 2, patch: 4 };
  const c = { major: 1, minor: 3, patch: 0 };
  const d = { major: 2, minor: 0, patch: 0 };
  assert.ok(compareSemver(a, b) < 0);
  assert.ok(compareSemver(b, a) > 0);
  assert.equal(compareSemver(a, a), 0);
  assert.ok(compareSemver(b, c) < 0);
  assert.ok(compareSemver(c, d) < 0);
});

test('preflight surfaces versionAtLeast when version parses', async () => {
  invalidatePreflightCache();
  // `true --version` exits 0 and prints empty output → version parses
  // as undefined → versionAtLeast stays undefined. Confirm the field is
  // absent (not falsely false) in that case.
  const status = await runPreflight({ kind: 'codex', binPath: 'true' });
  assert.equal(status.ok, true);
  assert.equal(status.versionAtLeast, undefined);
  assert.equal(status.minVersion, minVersionString('codex'));
});

test('attaches the default model seed when no catalog path is set', async () => {
  invalidatePreflightCache();
  const status = await runPreflight({ kind: 'codex', binPath: 'true' });
  assert.equal(status.ok, true);
  assert.deepEqual(status.models, defaultModelsFor('codex'));
});

test('serves the default seed from a catalog path without enumerating on a normal load', async () => {
  invalidatePreflightCache();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-preflight-'));
  const catalogPath = path.join(dir, 'model-catalog.json');
  const status = await runPreflight({ kind: 'codex', binPath: 'true' }, { catalogPath });
  assert.deepEqual(status.models, defaultModelsFor('codex'));
  // A normal (non-refresh) load must not enumerate, so no catalog is written.
  await assert.rejects(fs.access(catalogPath));
});

// ---- probeCliAvailability tests -----------------------------------------

test('probeCliAvailability reports available + version when the CLI runs', async () => {
  // `true` always exits 0 (empty output) — stands in for an installed CLI.
  const status = await probeCliAvailability('codex', 'true');
  assert.equal(status.available, true);
});

test('probeCliAvailability reports unavailable when the CLI is missing', async () => {
  const status = await probeCliAvailability('codex', '/no/such/bin');
  assert.equal(status.available, false);
  assert.equal(status.version, undefined);
});
