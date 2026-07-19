import { expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tempDir } from '@centraid/test-kit/temp-dir';
import { measureStorageLatency } from './storage-latency.js';

it('fsyncs one 4 KiB sample on the target filesystem and removes the probe file', async () => {
  const dir = await tempDir('centraid-storage-latency-');
  const sample = await measureStorageLatency(dir);
  expect(sample.fsyncMs).toBeGreaterThanOrEqual(0);
  expect(sample.totalMs).toBeGreaterThanOrEqual(sample.fsyncMs);
  expect(await fs.readdir(dir)).toEqual([]);
});
