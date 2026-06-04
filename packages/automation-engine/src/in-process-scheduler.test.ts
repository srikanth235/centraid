import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InProcessScheduler } from './in-process-scheduler.js';
import type { AutomationRow } from './app.js';
import type { AutomationManifest } from './manifest.js';

const manifest = (enabled: boolean): AutomationManifest => ({
  name: 'x',
  version: '0.1.0',
  enabled,
  prompt: 'do it',
  triggers: [],
  requires: {},
});

function row(ref: string, enabled: boolean, exprs: readonly string[]): AutomationRow {
  const [ownerApp, id] = ref.split('/') as [string, string];
  return {
    id,
    dir: `/tmp/${id}`,
    name: id,
    ownerApp,
    ref,
    enabled,
    triggers: exprs.map((expr) => ({ kind: 'cron', expr })),
    manifest: manifest(enabled),
  };
}

const at = (h: number, mi: number): Date => new Date(2026, 0, 1, h, mi, 0, 0);

describe('InProcessScheduler.reconcile', () => {
  it('diffs added / updated / removed and tracks only enabled cron rows', async () => {
    const s = new InProcessScheduler({ fire: () => {} });

    let diff = await s.reconcile([
      row('a/one', true, ['0 8 * * *']),
      row('a/two', false, ['0 9 * * *']), // disabled → skipped
      row('a/three', true, []), // no cron → skipped
    ]);
    assert.deepEqual(diff.added, ['a/one']);
    assert.deepEqual(diff.removed, []);
    assert.deepEqual(await s.list(), ['a/one']);

    // Change one's schedule, add one, drop the original.
    diff = await s.reconcile([
      row('a/one', true, ['30 8 * * *']), // expr changed → updated
      row('b/four', true, ['0 10 * * *']), // new → added
    ]);
    assert.deepEqual(diff.added, ['b/four']);
    assert.deepEqual(diff.updated, ['a/one']);
    assert.deepEqual(diff.removed, []);
    assert.deepEqual(await s.list(), ['a/one', 'b/four']);
  });

  it('register/unregister honour enabled + cron presence', async () => {
    const s = new InProcessScheduler({ fire: () => {} });
    await s.register(row('a/one', true, ['0 8 * * *']));
    assert.deepEqual(await s.list(), ['a/one']);
    // Disabling via register drops it from the registry.
    await s.register(row('a/one', false, ['0 8 * * *']));
    assert.deepEqual(await s.list(), []);
    await s.register(row('a/one', true, ['0 8 * * *']));
    await s.unregister('a/one');
    assert.deepEqual(await s.list(), []);
  });
});

describe('InProcessScheduler.tick', () => {
  it('fires matching crons once per minute with no backfill', async () => {
    const fired: string[] = [];
    let clock = at(8, 0);
    const s = new InProcessScheduler({ fire: (ref) => void fired.push(ref), now: () => clock });
    await s.reconcile([
      row('a/morning', true, ['0 8 * * *']),
      row('a/evening', true, ['0 20 * * *']),
    ]);

    // 08:00 — only the morning automation matches.
    s.tick();
    assert.deepEqual(fired, ['a/morning']);

    // Same minute again — de-duped, no second fire.
    s.tick();
    assert.deepEqual(fired, ['a/morning']);

    // A later minute that matches nothing — and note 08:01..19:59 were never
    // ticked: missed minutes are not backfired.
    clock = at(20, 0);
    s.tick();
    assert.deepEqual(fired, ['a/morning', 'a/evening']);
  });

  it('fires every registered automation whose cron matches the minute', async () => {
    const fired: string[] = [];
    const clock = at(8, 0);
    const s = new InProcessScheduler({ fire: (ref) => void fired.push(ref), now: () => clock });
    await s.reconcile([
      row('a/one', true, ['0 8 * * *']),
      row('b/two', true, ['*/15 * * * *']), // also matches :00
      row('c/three', true, ['0 9 * * *']), // does not
    ]);
    s.tick();
    assert.deepEqual(fired.sort(), ['a/one', 'b/two']);
  });
});
