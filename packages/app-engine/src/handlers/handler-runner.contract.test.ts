import { tempDir } from '@centraid/test-kit/temp-dir';
// Worker-spawn admission control (issue #351 Tier 4 hygiene): `runHandler`
// used to spawn one 256MB-capped worker thread per request with no cap at
// all — a request burst could spawn unboundedly and OOM the host. These pin
// the fix: a fixed number of concurrent slots, a short FIFO queue for the
// rest, and a fast "busy" failure once both are exhausted — never a hang,
// never an unbounded pile of workers.
//
// Each test builds its own small `WorkerAdmission` (2-4 slots) rather than
// the shared production default (8 concurrent + 16 queued) so the cap is
// cheap to exercise without spinning up dozens of real worker threads.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { runHandler, type HandlerOutcome } from './handler-runner.js';
import { WorkerAdmission } from './worker-admission.js';

let appDir: string;
let handlerFile: string;

beforeEach(async () => {
  appDir = await tempDir('centraid-worker-admission-');
  handlerFile = path.join(appDir, 'slow.js');
  // Sleeps long enough that several worker calls genuinely overlap
  // in-flight, short enough to keep the test fast.
  await writeFile(
    handlerFile,
    `export default async ({ body }) => {
       await new Promise((r) => setTimeout(r, 120));
       return { seq: body.seq, finishedAt: Date.now() };
     };`,
  );
});

function run(admission: WorkerAdmission, seq: number): Promise<HandlerOutcome> {
  return runHandler({
    app: { id: 'demo', dir: appDir },
    handlerFile,
    handlerKind: 'action',
    args: { body: { seq } },
    admission,
  });
}

test('a burst beyond cap+queue fails fast with a busy outcome; admitted calls still complete', async () => {
  // 2 concurrent + 2 queued = 4 slots total; a 5th call must be refused.
  const admission = new WorkerAdmission(2, 2, 5_000);
  const [c1, c2, c3, c4, c5] = [1, 2, 3, 4, 5].map((seq) => run(admission, seq));

  // The 5th call is refused immediately — it must not sit behind the
  // 120ms handlers waiting for a slot that will never come.
  const start = Date.now();
  const fifth = await c5!;
  expect(Date.now() - start).toBeLessThan(100);
  expect(fifth.ok).toBe(false);
  expect(fifth.busy).toBe(true);
  expect(fifth.error).toMatch(/busy/i);

  const admitted = await Promise.all([c1!, c2!, c3!, c4!]);
  for (const outcome of admitted) expect(outcome.ok).toBe(true);
  const seqs = admitted.map((o) => (o.value as { seq: number }).seq).toSorted((a, b) => a - b);
  expect(seqs).toEqual([1, 2, 3, 4]);

  // The gate is empty again once every call has settled, and the cumulative
  // resource actuals (#528) recorded all four admitted tasks (the refused 5th
  // never acquired a slot, so it is not a task).
  const settled = admission.stats();
  expect(settled.inFlight).toBe(0);
  expect(settled.queued).toBe(0);
  expect(settled.tasks).toBe(4);
  expect(settled.busyMs).toBeGreaterThanOrEqual(0);
});

test('cumulative task + busyMs counters track admitted work with an injected clock (#528)', async () => {
  let clock = 0;
  const admission = new WorkerAdmission(1, 4, 5_000, () => clock);

  await admission.acquire(); // task 1 acquires at t=0
  clock = 30;
  admission.release(); // task 1 ran 30ms
  await admission.acquire(); // task 2 acquires at t=30
  clock = 100;
  admission.release(); // task 2 ran 70ms

  const stats = admission.stats();
  expect(stats.tasks).toBe(2);
  expect(stats.busyMs).toBe(100);
  expect(stats.inFlight).toBe(0);
});

test('queued requests drain in FIFO order as slots free up', async () => {
  // Only 1 concurrent slot — every later call queues behind the first.
  const admission = new WorkerAdmission(1, 3, 5_000);
  const calls = [1, 2, 3, 4].map((seq) => run(admission, seq));
  const outcomes = await Promise.all(calls);
  for (const outcome of outcomes) expect(outcome.ok).toBe(true);

  const finishOrder = outcomes
    .map((o) => o.value as { seq: number; finishedAt: number })
    .toSorted((a, b) => a.finishedAt - b.finishedAt)
    .map((v) => v.seq);
  expect(finishOrder).toEqual([1, 2, 3, 4]);
});

test('a request that times out waiting in queue gets a busy outcome, not a hang', async () => {
  // 1 concurrent slot, held by a handler that outlives the queue wait.
  const admission = new WorkerAdmission(1, 1, 60);
  const holder = run(admission, 1); // occupies the only slot for ~120ms
  const queued = run(admission, 2); // waits, but times out after 60ms
  const outcome = await queued;
  expect(outcome.ok).toBe(false);
  expect(outcome.busy).toBe(true);
  expect(outcome.error).toMatch(/timed out/i);
  await holder; // let the first handler finish and release its slot
});
