// Warm-spare worker pool (issue #404). These cover the four properties the
// pool must hold beyond "dispatch still works": it keeps warm spares between
// runs, it preserves per-run module isolation (a worker is never reused across
// handlers), a hung handler is still terminable, and a worker crash doesn't
// poison the pool for subsequent runs.

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { runHandler, HANDLER_WORKER_FILE } from './handler-runner.js';
import { WorkerPool, workerPoolSizeFromEnv, DEFAULT_WORKER_POOL_SIZE } from './worker-pool.js';

let appDir: string;
let pool: WorkerPool;

beforeEach(async () => {
  appDir = await mkdtemp(path.join(tmpdir(), 'centraid-worker-pool-'));
});

afterEach(() => {
  pool?.dispose();
});

/** Let queued microtasks (pool refill) and a beat of the loop settle. */
function tick(ms = 40): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeHandler(name: string, src: string): Promise<string> {
  const file = path.join(appDir, name);
  await writeFile(file, src);
  return file;
}

test('keeps warm spares between runs and refills after an acquire', async () => {
  pool = new WorkerPool(HANDLER_WORKER_FILE, 2);
  pool.prewarm();
  await tick();
  expect(pool.warm).toBe(2);

  const handlerFile = await writeHandler('ok.js', `export default async () => ({ ok: 1 });`);
  const outcome = await runHandler({
    app: { id: 'demo', dir: appDir },
    handlerFile,
    handlerKind: 'query',
    args: { query: {} },
    timeoutMs: 5_000,
    pool,
  });
  expect(outcome.ok).toBe(true);
  expect(outcome.value).toEqual({ ok: 1 });

  // The acquired spare was consumed and a replacement warmed — back to size.
  await tick();
  expect(pool.warm).toBe(2);
});

test('a warmed pool serves a dispatch even after its spares are drained cold', async () => {
  // size 0 = warming disabled; every acquire spawns cold. Proves the pool is
  // correct without any pre-warm, i.e. warmth is a latency optimization only.
  pool = new WorkerPool(HANDLER_WORKER_FILE, 0);
  expect(pool.warm).toBe(0);
  const handlerFile = await writeHandler('ok.js', `export default async () => 'cold';`);
  const outcome = await runHandler({
    app: { id: 'demo', dir: appDir },
    handlerFile,
    handlerKind: 'query',
    args: { query: {} },
    timeoutMs: 5_000,
    pool,
  });
  expect(outcome.ok).toBe(true);
  expect(outcome.value).toBe('cold');
});

test('module-level state from run A is not visible to run B (no worker reuse)', async () => {
  pool = new WorkerPool(HANDLER_WORKER_FILE, 2);
  pool.prewarm();
  // A handler whose module-scope counter would climb across runs IF the worker
  // (and thus its module registry) were reused. Single-use workers guarantee a
  // fresh module each run, so both runs must observe the initial value.
  const handlerFile = await writeHandler(
    'stateful.js',
    `let seen = 0;\nexport default async () => { seen += 1; return { seen }; };`,
  );
  const run = () =>
    runHandler({
      app: { id: 'demo', dir: appDir },
      handlerFile,
      handlerKind: 'query',
      args: { query: {} },
      timeoutMs: 5_000,
      pool,
    });
  const first = await run();
  const second = await run();
  expect(first.value).toEqual({ seen: 1 });
  // If the worker were reused, this would be { seen: 2 }.
  expect(second.value).toEqual({ seen: 1 });
});

test('a hung handler is still terminated on timeout without poisoning the pool', async () => {
  pool = new WorkerPool(HANDLER_WORKER_FILE, 2);
  pool.prewarm();
  const hung = await writeHandler(
    'hang.js',
    `export default async () => { await new Promise(() => {}); };`,
  );
  const outcome = await runHandler({
    app: { id: 'demo', dir: appDir },
    handlerFile: hung,
    handlerKind: 'query',
    args: { query: {} },
    timeoutMs: 100,
    pool,
  });
  expect(outcome.ok).toBe(false);
  expect(outcome.error).toMatch(/exited with code|worker/i);

  // The pool is unharmed: a normal handler runs fine right after.
  const ok = await writeHandler('ok.js', `export default async () => 'alive';`);
  const after = await runHandler({
    app: { id: 'demo', dir: appDir },
    handlerFile: ok,
    handlerKind: 'query',
    args: { query: {} },
    timeoutMs: 5_000,
    pool,
  });
  expect(after.ok).toBe(true);
  expect(after.value).toBe('alive');
}, 10_000);

test('a worker that crashes mid-run leaves the pool usable for the next run', async () => {
  pool = new WorkerPool(HANDLER_WORKER_FILE, 2);
  pool.prewarm();
  const crash = await writeHandler(
    'crash.js',
    `export default async () => { process.exit(1); };`,
  );
  const crashed = await runHandler({
    app: { id: 'demo', dir: appDir },
    handlerFile: crash,
    handlerKind: 'query',
    args: { query: {} },
    timeoutMs: 5_000,
    pool,
  });
  expect(crashed.ok).toBe(false);

  const ok = await writeHandler('ok.js', `export default async () => 'recovered';`);
  const after = await runHandler({
    app: { id: 'demo', dir: appDir },
    handlerFile: ok,
    handlerKind: 'query',
    args: { query: {} },
    timeoutMs: 5_000,
    pool,
  });
  expect(after.ok).toBe(true);
  expect(after.value).toBe('recovered');
}, 10_000);

test('workerPoolSizeFromEnv clamps and defaults sanely', () => {
  expect(workerPoolSizeFromEnv({})).toBe(DEFAULT_WORKER_POOL_SIZE);
  expect(workerPoolSizeFromEnv({ CENTRAID_WORKER_POOL_SIZE: '' })).toBe(DEFAULT_WORKER_POOL_SIZE);
  expect(workerPoolSizeFromEnv({ CENTRAID_WORKER_POOL_SIZE: '0' })).toBe(0);
  expect(workerPoolSizeFromEnv({ CENTRAID_WORKER_POOL_SIZE: '3' })).toBe(3);
  expect(workerPoolSizeFromEnv({ CENTRAID_WORKER_POOL_SIZE: '999' })).toBe(8);
  expect(workerPoolSizeFromEnv({ CENTRAID_WORKER_POOL_SIZE: 'nonsense' })).toBe(
    DEFAULT_WORKER_POOL_SIZE,
  );
  expect(workerPoolSizeFromEnv({ CENTRAID_WORKER_POOL_SIZE: '-2' })).toBe(DEFAULT_WORKER_POOL_SIZE);
});
