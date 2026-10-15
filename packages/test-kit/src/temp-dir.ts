/* Return a child of the tracked temp root so sibling key custody is removed
 * by afterAll too (#996). */

import { mkdirSync, mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll } from "vitest";

const tracked = new Set<string>();

const WORK = "work";

afterAll(async () => {
  await Promise.all(
    [...tracked].map((dir) => rm(dir, { recursive: true, force: true }))
  );
  tracked.clear();
});

export async function tempDir(prefix = "centraid-test-"): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tracked.add(root);
  const dir = path.join(root, WORK);
  await mkdir(dir, { recursive: true });
  return dir;
}

export function tempDirSync(prefix = "centraid-test-"): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tracked.add(root);
  const dir = path.join(root, WORK);
  mkdirSync(dir, { recursive: true });
  return dir;
}
