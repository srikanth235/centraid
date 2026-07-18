import { tempDirSync } from '@centraid/test-kit/temp-dir';
/*
 * The base clone must be a REFLINK, not a byte copy (issue #408).
 *
 * A base is minted on every generation break — daily at minimum. If the clone
 * copies bytes, the shipper writes a second full copy of the vault every day
 * and carries 2x the vault on disk forever: local bytes/day becomes
 * O(database) instead of O(change), which is the entire cost argument for
 * shipping WAL segments in the first place.
 *
 * This is not a hypothetical. `copyFileSync(..., COPYFILE_FICLONE)` — the
 * obvious one-liner, and what this code used to do — is SILENTLY a byte copy on
 * macOS: libuv implements FICLONE via `ioctl` on Linux only, and Darwin accepts
 * the flag and ignores it. It cost ~10 GiB of writes per day on a 10 GiB vault
 * and nobody would have noticed, because nothing about it fails.
 *
 * So this test asserts against the FILESYSTEM, not against the call: clone a
 * large file and check that free space did not drop by its size. A regression
 * to the one-liner fails here instead of quietly doubling every user's disk.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { cloneDbFile } from './wal-shipper.js';

const MiB = 1024 * 1024;
/** Big enough that a byte copy dwarfs ordinary free-space noise from other processes. */
const SIZE = 128 * MiB;

let root: string;

beforeEach(() => {
  root = tempDirSync('wal-clone-');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Free bytes on the volume holding `p`. */
function freeBytes(p: string): number {
  const fs = statfsSync(p);
  return Number(fs.bsize) * Number(fs.bavail);
}

// APFS (Darwin) and reflink-capable Linux filesystems (btrfs/xfs) clone; ext4
// cannot, and there a byte copy is the only thing on offer. Only Darwin is a
// platform we can assert on unconditionally — it is also the one that was
// silently broken, and the one the desktop app runs on.
test.skipIf(process.platform !== 'darwin')(
  'the base clone is a reflink: cloning a 128 MiB database consumes no new disk',
  () => {
    const src = path.join(root, 'vault.db');
    // Incompressible — so a byte copy cannot hide behind filesystem compression.
    writeFileSync(src, randomBytes(SIZE));

    const before = freeBytes(root);
    const dst = path.join(root, 'base.db');
    cloneDbFile(src, dst);
    const consumed = before - freeBytes(root);

    // The clone must be a complete, independent file...
    expect(statSync(dst).size).toBe(SIZE);
    // ...that shares its blocks. A byte copy would consume ~128 MiB; allow a
    // generous margin for metadata and for unrelated writes racing the test.
    expect(consumed).toBeLessThan(SIZE / 4);
  },
);

test('the clone is byte-identical to the source, reflink or not', () => {
  const src = path.join(root, 'vault.db');
  const bytes = randomBytes(4 * MiB);
  writeFileSync(src, bytes);

  const dst = path.join(root, 'base.db');
  cloneDbFile(src, dst);

  // Correctness of the copy is platform-independent; only its COST is not.
  expect(statSync(dst).size).toBe(bytes.length);
  expect(Buffer.compare(Buffer.from(bytes), readFileSync(dst))).toBe(0);
});
