import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { recordQualityResult } from '@centraid/test-kit/quality-result';
import { tempDir } from '@centraid/test-kit/temp-dir';
import { openVaultPlane } from '../../packages/gateway/src/serve/vault-plane.js';
import { expect, onTestFinished, test } from 'vitest';

const OWNER = 'tests/perf/blob-egress.perf.test.ts';

test('large local blob egress produces a first byte without whole-file buffering', async () => {
  const directory = await tempDir('blob-egress-');
  // Seed outside the measured child. Its allocator has therefore never owned
  // the payload when it records the RSS baseline; a route that reads the whole
  // file must ask the OS for those pages instead of reusing seed-time slabs.
  const seed = openVaultPlane({
    dir: directory,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    ownerName: 'Perf owner',
  });
  const bytes = Buffer.alloc(128 * 1024 * 1024, 0x5a);
  const staged = seed.gateway.stageBlob(seed.ownerCredential, {
    bytes,
    filename: 'large-perf.bin',
    mediaType: 'application/octet-stream',
  });
  const attached = seed.gateway.invoke(seed.ownerCredential, {
    command: 'core.add_document',
    input: { staged_sha: staged.sha256, title: 'large-perf.bin' },
    purpose: 'dpv:ServiceProvision',
  });
  if (attached.status !== 'executed') throw new Error('fixture could not attach staged blob');
  const contentId = String(attached.output.content_id);
  await seed.stop();

  const child = fork(
    path.resolve('tests/perf/fixtures/blob-egress-server.mjs'),
    [directory, contentId, String(bytes.length)],
    {
      execArgv: [...process.execArgv, '--expose-gc'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  let childError = '';
  child.stderr?.on('data', (chunk) => {
    childError += String(chunk);
  });
  onTestFinished(() => {
    if (child.connected) child.send({ type: 'close' });
    child.kill();
  });
  const ready = await childMessage<{
    type: 'ready';
    port: number;
    contentId: string;
    size: number;
  }>(child, 'ready', () => childError);
  const served = childMessage<{ type: 'served'; rssGrowthBytes: number }>(
    child,
    'served',
    () => childError,
  );

  const started = performance.now();
  const response = await fetch(
    `http://127.0.0.1:${ready.port}/centraid/_vault/blobs/${ready.contentId}`,
  );
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const first = await reader.read();
  const ttfbMs = performance.now() - started;
  let received = first.value?.byteLength ?? 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += chunk.value.byteLength;
  }
  const { rssGrowthBytes } = await served;
  // Node may retain the stream's short-lived chunk slabs until its next GC.
  // The 96 MiB ceiling remains below the fixture's 128 MiB payload, so a
  // buffer-whole-file regression cannot fit while allocator noise gets room.
  const memoryBudget = 96 * 1024 * 1024;
  const passed = ttfbMs < 500 && rssGrowthBytes < memoryBudget && received === ready.size;
  await recordQualityResult({
    lane: 'perf',
    owner: OWNER,
    name: 'Large-blob egress TTFB and memory',
    status: passed ? 'passed' : 'failed',
    measurements: [
      { name: 'TTFB', value: ttfbMs, unit: 'ms', budget: 500 },
      { name: 'RSS growth', value: rssGrowthBytes, unit: 'bytes', budget: memoryBudget },
      { name: 'bytes streamed', value: received, unit: 'bytes', budget: ready.size },
    ],
  });
  expect(first.value?.byteLength).toBeGreaterThan(0);
  expect(received).toBe(ready.size);
  expect(ttfbMs).toBeLessThan(500);
  expect(rssGrowthBytes).toBeLessThan(memoryBudget);
});

function childMessage<T>(
  child: ChildProcess,
  expectedType: string,
  stderr: () => string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`blob egress child timed out waiting for ${expectedType}`)),
      10_000,
    );
    const onMessage = (message: unknown) => {
      if ((message as { type?: string })?.type !== expectedType) return;
      cleanup();
      resolve(message as T);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`blob egress child exited ${code}: ${stderr()}`));
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
