import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { invalidatePreflightCache, runPreflight } from './preflight.ts';

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
