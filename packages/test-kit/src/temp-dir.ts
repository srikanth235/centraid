import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const tracked = new Set<string>();

afterAll(async () => {
  await Promise.all([...tracked].map((dir) => rm(dir, { recursive: true, force: true })));
  tracked.clear();
});

/** Create a test temp directory and remove it after the current test file. */
export async function tempDir(prefix = 'centraid-test-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tracked.add(dir);
  return dir;
}

/** Synchronous companion for constructors and synchronous Vitest hooks. */
export function tempDirSync(prefix = 'centraid-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tracked.add(dir);
  return dir;
}
