/**
 * Blank-machine restore journey (#496 P2).
 *
 * Story: snapshot a vault-shaped tree, wipe the destination (blank machine),
 * restore, prove byte-identical files + quarantine marker. Piecewise WAL /
 * backup-service tests already exist; this is the named journey owner.
 */
import { tempDir } from '@centraid/test-kit/temp-dir';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import {
  createKeyring,
  createSnapshot,
  LocalBackupProvider,
  restoreSnapshot,
  type SourceEntry,
} from '@centraid/backup';

const CURRENT = { gatewayVersion: '0.1.0', vaultUserVersion: '1', ontologyVersion: '1.2' };
const APP_META = {
  gatewayVersion: '0.1.0',
  vaultUserVersion: '1',
  ontologyVersion: '1.2',
  sourceInstanceId: 'blank-machine-journey',
};

async function fileSha256(filePath: string): Promise<string> {
  const h = createHash('sha256');
  h.update(await fs.readFile(filePath));
  return h.digest('hex');
}

test('blank-machine restore: snapshot → empty dest → byte-identical + quarantine', async () => {
  const providerRoot = await tempDir('blank-provider-');
  const provider = new LocalBackupProvider({ rootDir: providerRoot });
  const { targetId } = await provider.createTarget({ label: 'blank-machine' });
  const keyringDir = await tempDir('blank-keyring-');
  const keyring = await createKeyring(path.join(keyringDir, 'keyring.json'));

  const sourceDir = await tempDir('blank-src-');
  await fs.mkdir(path.join(sourceDir, 'blobs', 'ab'), { recursive: true });
  const vaultPath = path.join(sourceDir, 'vault.db');
  const vault = new DatabaseSync(vaultPath);
  vault.exec('PRAGMA journal_mode=DELETE; CREATE TABLE payload (bytes BLOB NOT NULL)');
  vault.prepare('INSERT INTO payload (bytes) VALUES (?)').run(Buffer.from('journey-db-payload'));
  vault.close();
  const journalPath = path.join(sourceDir, 'journal.db');
  const journal = new DatabaseSync(journalPath);
  journal.exec('PRAGMA journal_mode=DELETE; CREATE TABLE payload (bytes BLOB NOT NULL)');
  journal.prepare('INSERT INTO payload (bytes) VALUES (?)').run(Buffer.from('journey-journal'));
  journal.close();
  await fs.writeFile(path.join(sourceDir, 'blobs', 'ab', 'cdef'), Buffer.from('journey-blob'));
  await fs.writeFile(path.join(sourceDir, 'apps.bundle'), Buffer.from('journey-bundle'));
  await fs.writeFile(path.join(sourceDir, 'seal.key'), Buffer.alloc(32, 7));

  const entries: SourceEntry[] = [
    {
      path: 'vault.db',
      kind: 'db',
      absolutePath: vaultPath,
      sha256: await fileSha256(vaultPath),
      walGeneration: '11'.repeat(16),
      baseTickMs: 1_752_480_000_000,
    },
    {
      path: 'journal.db',
      kind: 'db',
      absolutePath: journalPath,
      sha256: await fileSha256(journalPath),
      walGeneration: '22'.repeat(16),
      baseTickMs: 1_752_480_000_000,
    },
    {
      path: 'blobs/ab/cdef',
      kind: 'blob',
      absolutePath: path.join(sourceDir, 'blobs', 'ab', 'cdef'),
    },
    { path: 'apps.bundle', kind: 'git-bundle', absolutePath: path.join(sourceDir, 'apps.bundle') },
    { path: 'seal.key', kind: 'seal-key', absolutePath: path.join(sourceDir, 'seal.key') },
  ];

  const row = await createSnapshot({
    provider,
    targetId,
    keyring,
    vaultId: 'vault-blank',
    entries,
    generation: 1,
    appMeta: APP_META,
  });
  expect(row).not.toBeNull();
  expect(row?.seq).toBe(1);

  // Blank machine: dest does not exist yet.
  const destDir = path.join(await tempDir('blank-dest-parent-'), 'fresh-machine');
  // restoreSnapshot creates destDir; ensure parent exists and dest is absent.
  await fs.rm(destDir, { recursive: true, force: true });

  const result = await restoreSnapshot({
    provider,
    targetId,
    keyring,
    vaultId: 'vault-blank',
    destDir,
    current: CURRENT,
  });
  expect(result.seq).toBe(1);
  expect(result.entries.sort()).toEqual(entries.map((e) => e.path).sort());

  for (const entry of entries) {
    const original = await fs.readFile(entry.absolutePath);
    const restored = await fs.readFile(path.join(destDir, ...entry.path.split('/')));
    expect(restored.equals(original)).toBe(true);
  }

  const marker = JSON.parse(
    await fs.readFile(path.join(destDir, 'RESTORE_QUARANTINE.json'), 'utf8'),
  ) as { sourceSeq?: number; restoredAt?: string };
  expect(marker.sourceSeq).toBe(1);
  expect(typeof marker.restoredAt).toBe('string');
});
