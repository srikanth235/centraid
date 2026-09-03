import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll } from "vitest";

const tracked = new Set<string>();

afterAll(async () => {
  await Promise.all(
    [...tracked].map((dir) => rm(dir, { recursive: true, force: true }))
  );
  tracked.clear();
});

export async function tempDir(prefix = "centraid-test-"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tracked.add(dir);
  return dir;
}

export function tempDirSync(prefix = "centraid-test-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tracked.add(dir);
  return dir;
}
