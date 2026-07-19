/* Boot-time storage characterization for issue #456 M3. */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import crypto from 'node:crypto';

export interface StorageLatencySample {
  /** Time spent in the durability barrier for one freshly-written 4 KiB file. */
  fsyncMs: number;
  /** Whole probe lifetime, useful for diagnosing unusually slow open/unlink metadata. */
  totalMs: number;
}

/**
 * Measure the filesystem the vault will actually use. The temporary file is
 * created in `dir`, synced once, closed, and always removed.
 */
export async function measureStorageLatency(dir: string): Promise<StorageLatencySample> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `.centraid-storage-probe-${crypto.randomUUID()}`);
  const started = performance.now();
  const handle = await fs.open(file, 'wx', 0o600);
  let fsyncMs = 0;
  try {
    await handle.write(Buffer.alloc(4 * 1024, 0xa5), 0, 4 * 1024, 0);
    const syncStarted = performance.now();
    await handle.sync();
    fsyncMs = performance.now() - syncStarted;
  } finally {
    await handle.close();
    await fs.rm(file, { force: true });
  }
  return { fsyncMs, totalMs: performance.now() - started };
}
