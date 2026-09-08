/*
 * A test temp directory — AND ITS PARENT.
 *
 * The subdirectory is the whole point (#996 wave 6). `mkdtemp` used to hand
 * back a directory sitting DIRECTLY in the OS temp dir, and a vault's key
 * custody is a SIBLING of its vault directory by design — `sealKeyFileFor`
 * and `lockerKeyDirFor` both resolve `<dataRoot>/keys` from the vault dir's
 * parent, deliberately outside the directory that export, backup and copy
 * gestures move around. Put a vault in `/tmp/centraid-test-XXXX` and its keys
 * land in `/tmp/keys`, which no test owns, no `afterAll` removes, and every
 * run adds to: this repository's `/tmp/keys` had grown to 118,214 files —
 * ~39k identity seeds, ~39k public pins, ~38k sealing keys and ~1.5k Locker
 * vault keys — real key material for vaults that stopped existing months ago.
 *
 * So the mkdtemp ROOT is what is tracked and removed, and what callers get is
 * a directory INSIDE it. Key custody then resolves to `<root>/keys`, inside
 * the tree the cleanup owns, and a caller that removes the directory it was
 * given still leaves nothing behind — the root goes at `afterAll` either way.
 * No call site changes, which is the property that made this the fix: 700-odd
 * suites cannot each be trusted to remember where their keys went.
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll } from "vitest";

/** The mkdtemp ROOTS, not the directories handed out. */
const tracked = new Set<string>();

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
export async function tempDir(prefix = "centraid-test-"): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tracked.add(root);
  const dir = path.join(root, WORK);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Synchronous companion for constructors and synchronous Vitest hooks. */
export function tempDirSync(prefix = "centraid-test-"): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tracked.add(root);
  const dir = path.join(root, WORK);
  mkdirSync(dir, { recursive: true });
  return dir;
}
