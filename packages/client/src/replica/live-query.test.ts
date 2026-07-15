import { describe, expect, test } from 'vitest';

import { LiveQuery } from './live-query.js';

async function turn(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('LiveQuery', () => {
  test('is awaitable and publishes reruns only for captured dependencies', async () => {
    let value = 1;
    let runs = 0;
    const query = new LiveQuery(async () => ({
      value: { value, run: ++runs },
      dependencies: [{ shapeId: 'shape-agenda', entity: 'core.event' }],
    }));
    expect(await query).toEqual({ value: 1, run: 1 });

    const updates: number[] = [];
    const unsubscribe = query.subscribe((next) => updates.push(next.value));
    expect(updates).toEqual([1]);

    value = 2;
    query.invalidate({
      shapeId: 'shape-agenda',
      entity: 'core.note',
      source: 'canonical',
    });
    await turn();
    expect(runs).toBe(1);

    query.invalidate({
      shapeId: 'shape-agenda',
      entity: 'core.event',
      rowId: 'event-1',
      source: 'canonical',
    });
    await turn();
    expect(updates).toEqual([1, 2]);
    expect(runs).toBe(2);

    unsubscribe();
    query.dispose();
  });

  test('coalesces invalidations received while one execution is in flight', async () => {
    let release!: () => void;
    let runs = 0;
    const query = new LiveQuery(async () => {
      runs += 1;
      if (runs === 1) await new Promise<void>((resolve) => (release = resolve));
      return { value: runs, dependencies: [{ shapeId: 'shape', entity: 'entity' }] };
    });
    query.refresh();
    query.refresh();
    release();
    expect(await query).toBe(1);
    await turn();
    expect(runs).toBe(2);
    query.dispose();
  });
});
