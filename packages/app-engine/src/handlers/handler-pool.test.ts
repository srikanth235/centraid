import { tempDir } from '@centraid/test-kit/temp-dir';
// Warm-spare worker pool (issue #404). These cover the four properties the
// pool must hold beyond "dispatch still works": it keeps warm spares between
// runs, it preserves per-run module isolation (a worker is never reused across
// handlers), a hung handler is still terminable, and a worker crash doesn't
// poison the pool for subsequent runs.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { runHandler, HANDLER_WORKER_FILE } from './handler-runner.js';
import {
  WorkerPool,
  workerPoolSizeFromEnv,
  workerResourceLimitsFromEnv,
  DEFAULT_WORKER_POOL_SIZE,
} from './worker-pool.js';
import { workerMaxConcurrentFromEnv } from './worker-admission.js';

let appDir: string;
let pool: WorkerPool;

beforeEach(async () => {
  appDir = await tempDir('centraid-worker-pool-');
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

test('runs a TypeScript handler graph (typed source + relative .ts sibling import)', async () => {
  // TS-authored apps ship `.ts` handlers; the worker installs the esbuild
  // loader hook (worker/ts-loader-hooks) on demand so a `.ts` graph imports.
  // The sibling is imported by its emitted `.js` name while the file on disk
  // is `.ts` — the TS ESM convention the resolve hook bridges.
  await writeHandler(
    'util.ts',
    `export interface Sum { total: number }\n` +
      `export function addTyped(a: number, b: number): Sum { return { total: a + b }; }`,
  );
  const handlerFile = await writeHandler(
    'compute.ts',
    `import { addTyped, type Sum } from './util.js';\n` +
      `interface Body { a: number; b: number }\n` +
      `export default async ({ body }: { body: Body }): Promise<Sum> => addTyped(body.a, body.b);`,
  );
  pool = new WorkerPool(HANDLER_WORKER_FILE, 1);
  pool.prewarm();
  const outcome = await runHandler({
    app: { id: 'demo', dir: appDir },
    handlerFile,
    handlerKind: 'action',
    args: { body: { a: 40, b: 2 } },
    timeoutMs: 30_000,
    pool,
  });
  expect(outcome.ok).toBe(true);
  expect(outcome.value).toEqual({ total: 42 });
}, 30_000);

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
});

test('a worker that crashes mid-run leaves the pool usable for the next run', async () => {
  pool = new WorkerPool(HANDLER_WORKER_FILE, 2);
  pool.prewarm();
  const crash = await writeHandler('crash.js', `export default async () => { process.exit(1); };`);
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
});

test('workerPoolSizeFromEnv clamps and defaults sanely', () => {
  const standard = { CENTRAID_RESOLVED_HARDWARE_PROFILE: 'standard' };
  expect(workerPoolSizeFromEnv(standard)).toBe(DEFAULT_WORKER_POOL_SIZE);
  expect(workerPoolSizeFromEnv({ ...standard, CENTRAID_WORKER_POOL_SIZE: '' })).toBe(
    DEFAULT_WORKER_POOL_SIZE,
  );
  expect(workerPoolSizeFromEnv({ CENTRAID_RESOLVED_HARDWARE_PROFILE: 'constrained' })).toBe(0);
  expect(workerPoolSizeFromEnv({ CENTRAID_WORKER_POOL_SIZE: '0' })).toBe(0);
  expect(workerPoolSizeFromEnv({ CENTRAID_WORKER_POOL_SIZE: '3' })).toBe(3);
  expect(workerPoolSizeFromEnv({ CENTRAID_WORKER_POOL_SIZE: '999' })).toBe(8);
  expect(workerPoolSizeFromEnv({ ...standard, CENTRAID_WORKER_POOL_SIZE: 'nonsense' })).toBe(
    DEFAULT_WORKER_POOL_SIZE,
  );
  expect(workerPoolSizeFromEnv({ ...standard, CENTRAID_WORKER_POOL_SIZE: '-2' })).toBe(
    DEFAULT_WORKER_POOL_SIZE,
  );
});

test('worker memory and concurrency ceilings default down on constrained hosts and remain tunable', () => {
  const constrained = { cores: 4, totalMemoryBytes: 2 * 1024 ** 3 };
  const large = { cores: 8, totalMemoryBytes: 16 * 1024 ** 3 };
  expect(workerMaxConcurrentFromEnv({}, constrained)).toBe(2);
  expect(workerMaxConcurrentFromEnv({}, large)).toBe(8);
  expect(
    workerMaxConcurrentFromEnv({ CENTRAID_RESOLVED_HARDWARE_PROFILE: 'constrained' }, large),
  ).toBe(2);
  expect(workerMaxConcurrentFromEnv({ CENTRAID_WORKER_MAX_CONCURRENT: '3' }, constrained)).toBe(3);
  expect(workerResourceLimitsFromEnv({}, constrained)).toEqual({
    maxOldGenerationSizeMb: 128,
    maxYoungGenerationSizeMb: 16,
  });
  expect(
    workerResourceLimitsFromEnv({ CENTRAID_RESOLVED_HARDWARE_PROFILE: 'constrained' }, large),
  ).toEqual({ maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 });
  expect(
    workerResourceLimitsFromEnv(
      {
        CENTRAID_WORKER_MAX_OLD_GENERATION_MB: '96',
        CENTRAID_WORKER_MAX_YOUNG_GENERATION_MB: '12',
      },
      constrained,
    ),
  ).toEqual({ maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 12 });
});
