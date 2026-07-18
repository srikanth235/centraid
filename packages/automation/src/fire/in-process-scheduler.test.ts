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

describe('condition-trigger watches', () => {
  function conditionRow(ref: string, every?: string): Row {
    const [ownerApp, id] = ref.split('/') as [string, string];
    const triggers = [
      { kind: 'cron' as const, expr: '0 8 * * *' },
      {
        kind: 'condition' as const,
        entity: 'business.invoice',
        ...(every !== undefined ? { every } : {}),
      },
    ];
    return {
      id,
      dir: `/tmp/${id}`,
      name: id,
      ownerApp,
      ref,
      enabled: true,
      triggers,
      manifest: { ...manifest(true), triggers },
    };
  }

  it('gates evaluation on the trigger every-cron with the ORIGINAL trigger index', async () => {
    const fires: string[] = [];
    const evals: Array<[string, number]> = [];
    let clock = at(8, 0);
    const s = new InProcessScheduler({
      fire: (ref) => void fires.push(ref),
      evaluate: (ref, idx) => void evals.push([ref, idx]),
      now: () => clock,
    });
    await s.register(conditionRow('studio/chaser', '*/10 * * * *'));

    // 08:00 — the cron fires AND the */10 gate opens; the condition trigger
    // sits at index 1 of manifest.triggers (after the cron).
    s.tick();
    expect(fires).toEqual(['studio/chaser']);
    expect(evals).toEqual([['studio/chaser', 1]]);

    // 08:05 — neither.
    clock = at(8, 5);
    s.tick();
    expect(evals).toHaveLength(1);

    // 08:10 — gate only.
    clock = at(8, 10);
    s.tick();
    expect(fires).toHaveLength(1);
    expect(evals).toEqual([
      ['studio/chaser', 1],
      ['studio/chaser', 1],
    ]);
  });

  it('a condition-only automation registers (no cron needed) and defaults to */5', async () => {
    const evals: number[] = [];
    let clock = at(9, 0);
    const s = new InProcessScheduler({
      fire: () => {},
      evaluate: (_ref, idx) => void evals.push(idx),
      now: () => clock,
    });
    const r = conditionRow('studio/chaser');
    // Strip the cron so only the condition trigger remains (index 0).
    const only: Row = { ...r, triggers: [r.triggers[1]!] };
    await s.register(only);
    expect(await s.list()).toEqual(['studio/chaser']);
    s.tick();
    expect(evals).toEqual([0]);
    clock = at(9, 3);
    s.tick();
    expect(evals).toEqual([0]);
    clock = at(9, 5);
    s.tick();
    expect(evals).toEqual([0, 0]);
  });

  it('without an evaluator, condition triggers never gate open', async () => {
    const s = new InProcessScheduler({ fire: () => {}, now: () => at(9, 0) });
    const r = conditionRow('studio/chaser', '* * * * *');
    await s.register({ ...r, triggers: [r.triggers[1]!] });
    expect(() => s.tick()).not.toThrow();
  });
});

describe('InProcessScheduler onTick hook (issue #351)', () => {
  it('fires once per processed minute, before any automation fire', async () => {
    const order: string[] = [];
    let clock = at(8, 0);
    const s = new InProcessScheduler({
      fire: (ref) => void order.push(`fire:${ref}`),
      onTick: (t) => void order.push(`tick:${t.getHours()}:${t.getMinutes()}`),
      now: () => clock,
    });
    await s.reconcile([row('a/one', true, ['0 8 * * *'])]);

    s.tick();
    expect(order).toEqual(['tick:8:0', 'fire:a/one']);

    // Same minute again — de-duped, no second tick or fire.
    s.tick();
    expect(order).toEqual(['tick:8:0', 'fire:a/one']);

    clock = at(8, 1);
    s.tick();
    expect(order).toEqual(['tick:8:0', 'fire:a/one', 'tick:8:1']);
  });

  it('a throwing onTick routes to onError instead of crashing the timer loop', async () => {
    const errors: Array<{ err: unknown; ref: string }> = [];
    const s = new InProcessScheduler({
      fire: () => {},
      onTick: () => {
        throw new Error('boom');
      },
      onError: (err, ref) => errors.push({ err, ref }),
      now: () => at(8, 0),
    });
    await s.reconcile([row('a/one', true, ['0 8 * * *'])]);
    expect(() => s.tick()).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.err).toBeInstanceOf(Error);
  });

  it('does not persist a scheduler tick when no automations are enabled (#456 I3)', () => {
    let ticks = 0;
    const s = new InProcessScheduler({
      fire: () => {},
      onTick: () => {
        ticks += 1;
      },
      now: () => at(8, 0),
    });
    s.tick();
    expect(ticks).toBe(0);
  });

  it('reports only active/dormant transitions so the host can reset liveness once', async () => {
    const transitions: boolean[] = [];
    const s = new InProcessScheduler({
      fire: () => {},
      onDormancyChange: (dormant) => void transitions.push(dormant),
      now: () => at(8, 0),
    });
    await s.reconcile([]);
    await s.reconcile([row('a/one', true, ['0 8 * * *'])]);
    await s.reconcile([row('a/one', true, ['0 8 * * *'])]);
    await s.reconcile([]);
    expect(transitions).toEqual([false, true]);
  });

  it('onTick is optional — omitting it changes nothing about firing', async () => {
    const fired: string[] = [];
    const s = new InProcessScheduler({ fire: (ref) => void fired.push(ref), now: () => at(8, 0) });
    await s.reconcile([row('a/one', true, ['0 8 * * *'])]);
    expect(() => s.tick()).not.toThrow();
    expect(fired).toEqual(['a/one']);
  });
});
