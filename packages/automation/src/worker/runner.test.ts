/* oxlint-disable unicorn/require-post-message-target-origin -- node:worker_threads postMessage has no targetOrigin */
/**
 * Direct tests naming packages/automation/src/worker/runner.ts (issue #545 B5).
 * The entry throws without a worker_thread parentPort, so we drive it as a Worker.
 */

import { tempDir } from '@centraid/test-kit/temp-dir';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterEach, expect, test } from 'vitest';

const RUNNER = fileURLToPath(new URL('runner.ts', import.meta.url));

let worker: Worker | undefined;

afterEach(async () => {
  if (!worker) return;
  await worker.terminate();
  worker = undefined;
});

function waitForMessage(
  w: Worker,
  pred: (msg: Record<string, unknown>) => boolean,
  ms = 10_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for worker message')), ms);
    const onMsg = (msg: Record<string, unknown>) => {
      if (!pred(msg)) return;
      clearTimeout(t);
      w.off('message', onMsg);
      resolve(msg);
    };
    w.on('message', onMsg);
  });
}

test('automation worker runs a handler and posts result (names worker/runner.ts)', async () => {
  const dir = await tempDir('auto-worker-');
  const handlerFile = path.join(dir, 'handler.js');
  await writeFile(
    handlerFile,
    `export default async ({ ctx, log }) => {
       log.info('hi');
       const v = await ctx.state.get('cursor');
       await ctx.state.set('cursor', (v ?? 0) + 1);
       return { summary: 'ok', input: ctx.input };
     };`,
  );

  worker = new Worker(RUNNER, {
    workerData: {
      pooled: true,
    },
    execArgv: process.execArgv.filter((a) => !a.includes('vitest')),
  });

  // Pooled shape: wait for ready, then run.
  // Some builds may not emit 'ready' if boot is inline — send run either way after a tick.
  await new Promise((resolve) => setTimeout(resolve, 50));
  worker.postMessage({
    type: 'run',
    request: {
      handlerFile,
      args: {},
      now: new Date(0).toISOString(),
      input: { n: 1 },
    },
  });

  // Service state.get / state.set from the parent side.
  worker.on('message', (msg: Record<string, unknown>) => {
    if (msg.type === 'state' && msg.method === 'get') {
      worker!.postMessage({
        type: 'state-reply',
        id: msg.id,
        ok: true,
        result: 3,
      });
    } else if (msg.type === 'state' && msg.method === 'set') {
      worker!.postMessage({ type: 'state-reply', id: msg.id, ok: true });
    }
  });

  const result = await waitForMessage(worker, (m) => m.type === 'result');
  expect(result.ok).toBe(true);
  expect(result.value).toEqual({ summary: 'ok', input: { n: 1 } });
}, 15_000);

test('importing runner as a non-worker throws the parentPort guard', async () => {
  // The module evaluates parentPort at load and refuses to run on the main thread.
  await expect(import(/* @vite-ignore */ `${RUNNER}?guard=${Date.now()}`)).rejects.toThrow(
    /must be run as a worker_thread/,
  );
});
