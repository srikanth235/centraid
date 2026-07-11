/*
 * GatewayLogStore: ring buffer + fan-out + the RuntimeLogger tee that
 * feeds the realtime Logs surface.
 */

import { expect, test } from 'vitest';
import type { RuntimeLogger } from '@centraid/app-engine';
import { GatewayLogStore, type GatewayLogEntry } from './gateway-log-store.ts';

test('append assigns monotonic seqs and snapshot honors after', () => {
  const store = new GatewayLogStore();
  store.append('info', 'one');
  store.append('warn', 'two');
  store.append('error', 'three');

  const all = store.snapshot();
  expect(all.map((e) => e.message)).toEqual(['one', 'two', 'three']);
  expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
  expect(all.map((e) => e.level)).toEqual(['info', 'warn', 'error']);

  expect(store.snapshot(2).map((e) => e.message)).toEqual(['three']);
  expect(store.snapshot(3)).toEqual([]);
});

test('ring buffer evicts oldest past capacity but seqs keep counting', () => {
  const store = new GatewayLogStore(3);
  for (let i = 1; i <= 5; i++) store.append('info', `line ${i}`);

  const all = store.snapshot();
  expect(all.map((e) => e.message)).toEqual(['line 3', 'line 4', 'line 5']);
  // Eviction never reuses seqs — a resuming client can't be handed a
  // different line under a seq it already saw.
  expect(all.map((e) => e.seq)).toEqual([3, 4, 5]);
});

test('subscribers get live entries; unsubscribe is idempotent', () => {
  const store = new GatewayLogStore();
  const seen: GatewayLogEntry[] = [];
  const unsub = store.subscribe((e) => seen.push(e));
  expect(store.subscriberCount()).toBe(1);

  store.append('warn', 'live');
  expect(seen.map((e) => e.message)).toEqual(['live']);

  unsub();
  unsub();
  expect(store.subscriberCount()).toBe(0);
  store.append('info', 'after');
  expect(seen).toHaveLength(1);
});

test('a throwing subscriber does not break the fanout', () => {
  const store = new GatewayLogStore();
  const seen: string[] = [];
  store.subscribe(() => {
    throw new Error('wedged');
  });
  store.subscribe((e) => seen.push(e.message));

  store.append('error', 'boom');
  expect(seen).toEqual(['boom']);
});

test('wrap tees into the store and forwards to the inner logger', () => {
  const store = new GatewayLogStore();
  const forwarded: string[] = [];
  const inner: RuntimeLogger = {
    info: (m) => forwarded.push(`info:${m}`),
    warn: (m) => forwarded.push(`warn:${m}`),
    error: (m) => forwarded.push(`error:${m}`),
  };
  const logger = store.wrap(inner);

  logger.info('a');
  logger.warn('b');
  logger.error('c');

  expect(forwarded).toEqual(['info:a', 'warn:b', 'error:c']);
  expect(store.snapshot().map((e) => `${e.level}:${e.message}`)).toEqual([
    'info:a',
    'warn:b',
    'error:c',
  ]);
});
