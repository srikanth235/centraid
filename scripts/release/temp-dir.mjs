/*
 * A test temp directory, removed after the test file whatever the tests do:
 * the mkdtemp ROOT is tracked and removed at `afterAll`, and callers get a
 * directory INSIDE it, so anything the code under test writes beside its
 * directory is still inside the tree that gets removed. Raw `mkdtemp` is an
 * oxlint error in tests (docs/coding-standards.md, "Test seams").
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll } from "vitest";

/** The mkdtemp ROOTS, not the directories handed out. */
const tracked = new Set();

/**
 * What a caller gets, relative to the tracked root. Named rather than "." so
 * anything the code under test writes BESIDE it — `keys/`, a sibling restore
 * directory, a symlink target — is still inside the tree that gets removed.
 */
const WORK = "work";

afterAll(async () => {
  await Promise.all(
    [...tracked].map((dir) => rm(dir, { recursive: true, force: true }))
  );
  tracked.clear();
});

/** Create a test temp directory and remove it after the current test file. */
export async function tempDir(prefix = "centraid-test-") {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tracked.add(root);
  const dir = path.join(root, WORK);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Synchronous companion for constructors and synchronous Vitest hooks. */
export function tempDirSync(prefix = "centraid-test-") {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tracked.add(root);
  const dir = path.join(root, WORK);
  mkdirSync(dir, { recursive: true });
  return dir;
}
