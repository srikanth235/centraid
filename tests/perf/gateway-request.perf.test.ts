import { serve } from '@centraid/gateway';
import { recordQualityResult } from '@centraid/test-kit/quality-result';
import { tempDir } from '@centraid/test-kit/temp-dir';
import { expect, onTestFinished, test } from 'vitest';

const OWNER = 'tests/perf/gateway-request.perf.test.ts';

test('gateway request latency and idle CPU stay within low-end budgets', async () => {
  const root = await tempDir('gateway-perf-');
  const handle = await serve({
    paths: { vaultDir: `${root}/vault`, prefsFile: `${root}/prefs.json` },
  });
  onTestFinished(() => handle.close());
  const samples: number[] = [];
  for (let index = 0; index < 60; index += 1) {
    const started = performance.now();
    const response = await fetch(`${handle.url}/centraid/_apps`, {
      headers: { authorization: `Bearer ${handle.token}` },
    });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  const p95Ms = samples[Math.floor(samples.length * 0.95)] ?? Number.POSITIVE_INFINITY;
  const cpuStart = process.cpuUsage();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const cpu = process.cpuUsage(cpuStart);
  const idleCpuMs = (cpu.user + cpu.system) / 1_000;
  const passed = p95Ms < 150 && idleCpuMs < 300;
  await recordQualityResult({
    lane: 'perf',
    owner: OWNER,
    name: 'Gateway request p95 and idle CPU',
    status: passed ? 'passed' : 'failed',
    measurements: [
      { name: 'request p95', value: p95Ms, unit: 'ms', budget: 150 },
      { name: 'idle CPU over 500ms', value: idleCpuMs, unit: 'ms', budget: 300 },
    ],
  });
  expect(p95Ms).toBeLessThan(150);
  expect(idleCpuMs).toBeLessThan(300);
});
