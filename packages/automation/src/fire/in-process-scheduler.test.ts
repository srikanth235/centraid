import { describe, expect, it } from 'vitest';
import { InProcessScheduler } from './in-process-scheduler.js';
import type { Row } from '../scaffold/app.js';
import type { Manifest } from '../manifest/manifest.js';

const manifest = (enabled: boolean): Manifest => ({
  name: 'x',
  version: '0.1.0',
  enabled,
  prompt: 'do it',
  triggers: [],
  requires: {},
  history: { keep: 'all' },
  generated: { by: 'test', at: '2026-01-01T00:00:00.000Z' },
});

function row(ref: string, enabled: boolean, exprs: readonly string[]): Row {
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
    expect(diff.added).toEqual(['a/one']);
    expect(diff.removed).toEqual([]);
    expect(await s.list()).toEqual(['a/one']);

    // Change one's schedule, add one, drop the original.
    diff = await s.reconcile([
      row('a/one', true, ['30 8 * * *']), // expr changed → updated
      row('b/four', true, ['0 10 * * *']), // new → added
    ]);
    expect(diff.added).toEqual(['b/four']);
    expect(diff.updated).toEqual(['a/one']);
    expect(diff.removed).toEqual([]);
    expect(await s.list()).toEqual(['a/one', 'b/four']);
  });

  it('register/unregister honour enabled + cron presence', async () => {
    const s = new InProcessScheduler({ fire: () => {} });
    await s.register(row('a/one', true, ['0 8 * * *']));
    expect(await s.list()).toEqual(['a/one']);
    // Disabling via register drops it from the registry.
    await s.register(row('a/one', false, ['0 8 * * *']));
    expect(await s.list()).toEqual([]);
    await s.register(row('a/one', true, ['0 8 * * *']));
    await s.unregister('a/one');
    expect(await s.list()).toEqual([]);
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
    expect(fired).toEqual(['a/morning']);

    // Same minute again — de-duped, no second fire.
    s.tick();
    expect(fired).toEqual(['a/morning']);

    // A later minute that matches nothing — and note 08:01..19:59 were never
    // ticked: missed minutes are not backfired.
    clock = at(20, 0);
    s.tick();
    expect(fired).toEqual(['a/morning', 'a/evening']);
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
    expect(fired.sort()).toEqual(['a/one', 'b/two']);
  });
});
