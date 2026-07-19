import { tempDirSync } from '@centraid/test-kit/temp-dir';
/*
 * GatewayLogStore: ring buffer + fan-out + the RuntimeLogger tee that
 * feeds the realtime Logs surface, plus the optional JSONL persistence
 * (issue #351): rotation, boot-tail reload, and the dropped-writes
 * counter for an unwritable dir.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { RuntimeLogger } from '@centraid/app-engine';
import { DiskFullTracker } from '@centraid/vault';
import { GatewayLogStore, type GatewayLogEntry } from './gateway-log-store.ts';

// ESM's `node:fs` module namespace isn't configurable, so `vi.spyOn` can't
// stub a single export (vitest's documented limitation) — mock the whole
// module through to the real implementation, with `appendFileSync` swapped
// for a toggleable stub, so the disk-full tests below can force an
// ENOSPC-shaped failure deterministically without touching any other test
// in this file (every other fs call in this file keeps its real behavior).
let appendFileSyncShouldFail = false;
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const appendFileSync: typeof actual.appendFileSync = (...args) => {
    if (appendFileSyncShouldFail) {
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    }
    return (actual.appendFileSync as (...a: typeof args) => void)(...args);
  };
  return { ...actual, appendFileSync, default: { ...actual, appendFileSync } };
});

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = tempDirSync('gateway-log-store-');
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

test('with no dir configured, no filesystem activity happens', () => {
  const store = new GatewayLogStore();
  store.append('info', 'one');
  expect(store.droppedWriteCount()).toBe(0);
});

test('with a dir configured, each append is persisted as one JSONL line', () => {
  const dir = makeTmpDir();
  const store = new GatewayLogStore(2000, { dir });
  store.append('info', 'one');
  store.append('warn', 'two');

  const raw = fs.readFileSync(path.join(dir, 'gateway.jsonl'), 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'info', message: 'one' });
  expect(JSON.parse(lines[1]!)).toMatchObject({ level: 'warn', message: 'two' });
  expect(store.droppedWriteCount()).toBe(0);
});

test('rotation: writing past ~4 MiB rotates generations and keeps 3', () => {
  const dir = makeTmpDir();
  const store = new GatewayLogStore(100_000, { dir });
  // Each line is ~1 KiB of message; ~4200 lines pushes well past a single
  // 4 MiB file, forcing several rotations.
  const bigMessage = 'x'.repeat(1000);
  for (let i = 0; i < 4200; i++) store.append('info', bigMessage);

  expect(fs.existsSync(path.join(dir, 'gateway.jsonl'))).toBe(true);
  expect(fs.existsSync(path.join(dir, 'gateway.1.jsonl'))).toBe(true);
  // At most 3 rotated generations are kept — no gateway.4.jsonl.
  expect(fs.existsSync(path.join(dir, 'gateway.4.jsonl'))).toBe(false);
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('gateway.'));
  expect(files.length).toBeLessThanOrEqual(4); // current + up to 3 rotated
});

test('boot-tail load: a new store on an existing dir sees prior entries', () => {
  const dir = makeTmpDir();
  const first = new GatewayLogStore(2000, { dir });
  first.append('info', 'before restart 1');
  first.append('warn', 'before restart 2');
  first.append('error', 'before restart 3');

  const second = new GatewayLogStore(2000, { dir });
  const tail = second.snapshot();
  expect(tail.map((e) => e.message)).toEqual([
    'before restart 1',
    'before restart 2',
    'before restart 3',
  ]);
  // Original timestamps + seqs are preserved, not reassigned.
  expect(tail.map((e) => e.seq)).toEqual([1, 2, 3]);

  // The resumed store continues the seq sequence rather than restarting
  // at 1, so a client's `?after=` cursor never collides with old data.
  const appended = second.append('info', 'after restart');
  expect(appended.seq).toBe(4);
});

test('boot-tail load respects ring capacity — only the newest lines are kept', () => {
  const dir = makeTmpDir();
  const first = new GatewayLogStore(3, { dir });
  for (let i = 1; i <= 5; i++) first.append('info', `line ${i}`);

  const second = new GatewayLogStore(3, { dir });
  expect(second.snapshot().map((e) => e.message)).toEqual(['line 3', 'line 4', 'line 5']);
});

test('dropped-writes counter increments on an unwritable dir, never throws', () => {
  // Point the store's "directory" at a path that is actually a FILE — every
  // mkdir/append underneath it fails, but construction and append() must
  // not throw.
  const parent = makeTmpDir();
  const blocker = path.join(parent, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');
  const dir = path.join(blocker, 'gateway-logs');

  const store = new GatewayLogStore(2000, { dir });
  expect(() => store.append('error', 'should not throw')).not.toThrow();
  store.append('error', 'another');

  expect(store.droppedWriteCount()).toBeGreaterThan(0);
  // In-memory behavior is unaffected by the persistence failure.
  expect(store.snapshot().map((e) => e.message)).toEqual(['should not throw', 'another']);
});

test('disk-full: fails open to the in-memory ring, never throws, and stops hammering the disk', () => {
  const dir = makeTmpDir();
  const tracker = new DiskFullTracker();
  const store = new GatewayLogStore(2000, { dir, diskFullTracker: tracker });

  appendFileSyncShouldFail = true;
  try {
    expect(() => store.append('error', 'one')).not.toThrow();
    expect(store.diskFullSuspended()).toBe(true);
    expect(tracker.current()?.context).toBe('gateway log persistence');

    // Backed off: a second append during the retry window must NOT call
    // appendFileSync again — droppedWrites still counts it, but the ring
    // (the thing that must survive) keeps growing regardless.
    const before = store.droppedWriteCount();
    store.append('error', 'two');
    expect(store.droppedWriteCount()).toBe(before + 1);
    expect(store.snapshot().map((e) => e.message)).toEqual(['one', 'two']);
  } finally {
    appendFileSyncShouldFail = false;
  }
});

test('disk-full: recovers once appendFileSync succeeds again after the backoff window', () => {
  const dir = makeTmpDir();
  const tracker = new DiskFullTracker();
  const store = new GatewayLogStore(2000, { dir, diskFullTracker: tracker });

  appendFileSyncShouldFail = true;
  store.append('error', 'during outage');
  expect(store.diskFullSuspended()).toBe(true);
  appendFileSyncShouldFail = false;

  // Force the retry window to have elapsed without a real sleep.
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
  try {
    store.append('info', 'after recovery');
  } finally {
    vi.restoreAllMocks();
  }
  expect(store.diskFullSuspended()).toBe(false);

  const raw = fs.readFileSync(path.join(dir, 'gateway.jsonl'), 'utf8');
  expect(raw).toContain('after recovery');
});

test('disk-full: a non-ENOSPC failure keeps retrying every append (unchanged prior behavior)', () => {
  const parent = makeTmpDir();
  const blocker = path.join(parent, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');
  const dir = path.join(blocker, 'gateway-logs');
  const tracker = new DiskFullTracker();

  const store = new GatewayLogStore(2000, { dir, diskFullTracker: tracker });
  store.append('error', 'one');
  store.append('error', 'two');

  expect(store.diskFullSuspended()).toBe(false);
  expect(tracker.current()).toBeNull();
  expect(store.droppedWriteCount()).toBe(2);
});
