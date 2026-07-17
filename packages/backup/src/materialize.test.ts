/*
 * `materializeSnapshotBlobs` (issue #439 R5) — the targeted blob re-pin the
 * adopt-time reconcile leans on. It must pull ONLY the requested shas out of a
 * real snapshot, land them byte-exact under the `FsBlobStore` layout, verify
 * each against the manifest sha, and report a requested sha the snapshot does
 * not carry as `absent` (which the reconcile records lost) — never write it.
 */

import { afterEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createKeyring } from './crypto.js';
import { openLocalBackupProvider } from './local-provider.js';
import { createSnapshot, type SourceEntry } from './engine.js';
import { materializeSnapshotBlobs } from './materialize.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** A minimal but VALID snapshot source: a real base pair plus content-addressed
 *  blobs at `blobs/sha256/<fan>/<sha>` (the layout the reconcile re-pins into). */
async function buildSource(sourceDir: string, blobs: Buffer[]): Promise<SourceEntry[]> {
  const dbEntry = async (name: string, gen: string): Promise<SourceEntry> => {
    const p = path.join(sourceDir, name);
    const db = new DatabaseSync(p);
    db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE t (b BLOB)');
    db.prepare('INSERT INTO t (b) VALUES (?)').run(randomBytes(2048));
    db.close();
    return {
      path: name,
      kind: 'db',
      absolutePath: p,
      sha256: sha256(await fs.readFile(p)),
      walGeneration: gen,
      baseTickMs: 1_752_480_000_000,
    };
  };
  const entries: SourceEntry[] = [
    await dbEntry('vault.db', '11'.repeat(16)),
    await dbEntry('journal.db', '22'.repeat(16)),
  ];
  for (const bytes of blobs) {
    const sha = sha256(bytes);
    const rel = `blobs/sha256/${sha.slice(0, 2)}/${sha}`;
    const abs = path.join(sourceDir, ...rel.split('/'));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, bytes);
    entries.push({ path: rel, kind: 'blob', absolutePath: abs });
  }
  return entries;
}

test('materializes exactly the requested carried shas, byte-exact, and reports the rest absent', async () => {
  const provider = openLocalBackupProvider({ rootDir: await tempDir('mz-provider') });
  const { targetId } = await provider.createTarget({ label: 'mz' });
  const keyring = await createKeyring(path.join(await tempDir('mz-keyring'), 'keyring.json'));

  const wantBytes = randomBytes(9000);
  const otherBytes = randomBytes(4000); // in the snapshot, but NOT requested
  const wantSha = sha256(wantBytes);
  const otherSha = sha256(otherBytes);
  const absentSha = 'f'.repeat(64); // never in the snapshot

  const sourceDir = await tempDir('mz-source');
  const entries = await buildSource(sourceDir, [wantBytes, otherBytes]);
  const row = await createSnapshot({
    provider,
    targetId,
    keyring,
    vaultId: 'vault-1',
    entries,
    generation: 1,
    appMeta: { vaultUserVersion: '1', ontologyVersion: '1.0' },
  });
  expect(row?.seq).toBe(1);

  const destDir = await tempDir('mz-dest');
  const result = await materializeSnapshotBlobs({
    provider,
    targetId,
    keyring,
    vaultId: 'vault-1',
    seq: row!.seq,
    shas: [wantSha, absentSha],
    destDir,
  });

  expect(result.materialized).toEqual([wantSha]);
  expect(result.absent).toEqual([absentSha]);

  // The wanted blob landed byte-exact at the FsBlobStore path.
  const landed = await fs.readFile(
    path.join(destDir, 'blobs', 'sha256', wantSha.slice(0, 2), wantSha),
  );
  expect(landed.equals(wantBytes)).toBe(true);
  // Selective: neither the un-requested carried blob nor the absent one was written.
  expect(
    await fs.readdir(path.join(destDir, 'blobs', 'sha256', otherSha.slice(0, 2))).catch(() => []),
  ).not.toContain(otherSha);
  await expect(
    fs.access(path.join(destDir, 'blobs', 'sha256', absentSha.slice(0, 2), absentSha)),
  ).rejects.toThrow();
});
