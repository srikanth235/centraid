/**
 * Replica-sync real-IO perf budget (#496 PD2).
 * Touches IndexedDB store open + enqueue/list — not an in-memory Map stringify.
 */
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { recordQualityResult } from '@centraid/test-kit/quality-result';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { IndexedDbIntentStore } from '../../packages/client/src/replica/intent-store.js';
import { IntentQueue } from '../../packages/client/src/replica/intents.js';

const OWNER = 'tests/perf/replica-sync-io.perf.test.ts';
const BUDGET_MS = 2_500;

beforeEach(() => vi.stubGlobal('IDBKeyRange', IDBKeyRange));
afterEach(() => vi.unstubAllGlobals());

test('intent store open + 200 enqueue/list stays under IO budget', async () => {
  const factory = new IDBFactory();
  const name = `perf-replica-${crypto.randomUUID()}`;
  const started = performance.now();
  const store = await IndexedDbIntentStore.open(name, factory);
  const queue = new IntentQueue(store);
  for (let i = 0; i < 200; i++) {
    await queue.enqueue({
      intentId: `intent-${i}`,
      appId: 'agenda',
      action: 'complete',
      input: { taskId: `t-${i}` },
      optimistic: [
        {
          op: 'upsert',
          shapeId: 'shape-agenda',
          entity: 'core.task',
          rowId: `t-${i}`,
          values: { status: 'done' },
        },
      ],
    });
  }
  const listed = await queue.list();
  const durationMs = performance.now() - started;
  store.close();
  const passed = listed.length === 200 && durationMs < BUDGET_MS;
  await recordQualityResult({
    lane: 'perf',
    owner: OWNER,
    name: 'Replica intent IO (200 enqueues)',
    status: passed ? 'passed' : 'failed',
    measurements: [{ name: 'wall clock', value: durationMs, unit: 'ms', budget: BUDGET_MS }],
  });
  expect(listed).toHaveLength(200);
  expect(durationMs).toBeLessThan(BUDGET_MS);
});
