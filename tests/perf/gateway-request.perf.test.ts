import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { recordQualityResult } from '@centraid/test-kit/quality-result';
import { tempDir } from '@centraid/test-kit/temp-dir';
import { expect, onTestFinished, test } from 'vitest';

const OWNER = 'tests/perf/gateway-request.perf.test.ts';

// --- Budgets ---------------------------------------------------------------
// Both measured 2026-07-19 (darwin arm64) against the gateway running in a
// FORKED CHILD (see gateway-idle-server.mjs), self-reporting its own CPU.
//
// Request p95 baseline ≈ 40 ms (60 GETs of /centraid/_apps). Budget = ~3× = 120.
// Idle CPU baseline ≈ 1–3 ms of CPU per second of wall-clock over a 5 s idle
// window (the 1 s idle-poll costs ~nothing). Budget = ~3× a conservative
// baseline. The OLD test measured the VITEST process over 500 ms with a 300 ms
// (60%-of-a-core) ceiling — shorter than the poll period and on the wrong
// process, so the idle-poll defect could never breach it.
const REQUEST_P95_BUDGET_MS = 120;
const IDLE_CPU_BUDGET_MS_PER_S = 25;
const IDLE_WINDOW_MS = 5_000;

test('gateway request latency and idle CPU stay within low-end budgets', async () => {
  const root = await tempDir('gateway-perf-');
  const child = fork(path.resolve('tests/perf/fixtures/gateway-idle-server.mjs'), [root], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let childError = '';
  child.stderr?.on('data', (chunk) => {
    childError += String(chunk);
  });
  onTestFinished(() => {
    if (child.connected) child.send({ type: 'close' });
    child.kill();
  });

  const ready = await childMessage<{ type: 'ready'; url: string; token: string }>(
    child,
    'ready',
    () => childError,
    20_000,
  );

  const samples: number[] = [];
  for (let index = 0; index < 60; index += 1) {
    const started = performance.now();
    const response = await fetch(`${ready.url}/centraid/_apps`, {
      headers: { authorization: `Bearer ${ready.token}` },
    });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  const p95Ms = samples[Math.floor(samples.length * 0.95)] ?? Number.POSITIVE_INFINITY;

  child.send({ type: 'measure-idle', windowMs: IDLE_WINDOW_MS });
  const idle = await childMessage<{
    type: 'idle';
    cpuUserUs: number;
    cpuSystemUs: number;
    wallMs: number;
  }>(child, 'idle', () => childError, IDLE_WINDOW_MS + 15_000);
  const idleCpuMs = (idle.cpuUserUs + idle.cpuSystemUs) / 1_000;
  const idleCpuMsPerSecond = idleCpuMs / (idle.wallMs / 1_000);

  const passed = p95Ms < REQUEST_P95_BUDGET_MS && idleCpuMsPerSecond < IDLE_CPU_BUDGET_MS_PER_S;
  await recordQualityResult({
    lane: 'perf',
    owner: OWNER,
    name: 'Gateway request p95 and idle CPU',
    status: passed ? 'passed' : 'failed',
    measurements: [
      { name: 'request p95', value: p95Ms, unit: 'ms', budget: REQUEST_P95_BUDGET_MS },
      {
        name: 'idle CPU per second',
        value: idleCpuMsPerSecond,
        unit: 'ms/s',
        budget: IDLE_CPU_BUDGET_MS_PER_S,
      },
    ],
  });
  expect(p95Ms).toBeLessThan(REQUEST_P95_BUDGET_MS);
  expect(idleCpuMsPerSecond).toBeLessThan(IDLE_CPU_BUDGET_MS_PER_S);
});

function childMessage<T>(
  child: ChildProcess,
  expectedType: string,
  stderr: () => string,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`gateway perf child timed out waiting for ${expectedType}`)),
      timeoutMs,
    );
    const onMessage = (message: unknown) => {
      if ((message as { type?: string })?.type !== expectedType) return;
      cleanup();
      resolve(message as T);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`gateway perf child exited ${code}: ${stderr()}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}
