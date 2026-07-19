import { afterEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { measureStorageLatency } from './storage-latency.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

it('fsyncs one 4 KiB sample on the target filesystem and removes the probe file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-storage-latency-'));
  dirs.push(dir);
  const sample = await measureStorageLatency(dir);
  expect(sample.fsyncMs).toBeGreaterThanOrEqual(0);
  expect(sample.totalMs).toBeGreaterThanOrEqual(sample.fsyncMs);
  expect(await fs.readdir(dir)).toEqual([]);
});
