import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createKeyring,
  createSnapshot,
  LocalBackupProvider,
  restoreSnapshot,
  type SourceEntry,
} from '@centraid/backup';
import { recordQualityResult } from '@centraid/test-kit/quality-result';
import { tempDir } from '@centraid/test-kit/temp-dir';
import { expect, test } from 'vitest';

const OWNER = 'tests/scale/backup-restore.scale.test.ts';
const APP_META = {
  gatewayVersion: '0.1.0',
  vaultUserVersion: '1',
  ontologyVersion: '1.2',
  sourceInstanceId: 'scale-lane',
};

function bytes(size: number): Buffer {
  let state = 458;
  const result = Buffer.allocUnsafe(size);
  for (let index = 0; index < size; index++) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    result[index] = state & 0xff;
  }
  return result;
}

test('backup restores a large deterministic vault payload byte-for-byte', async () => {
  const providerDir = await tempDir('backup-scale-provider-');
  const sourceDir = await tempDir('backup-scale-source-');
  const keyDir = await tempDir('backup-scale-key-');
  const restoreDir = await tempDir('backup-scale-restore-');
  await rm(restoreDir, { recursive: true, force: true });
  const vaultPath = path.join(sourceDir, 'vault.db');
  const journalPath = path.join(sourceDir, 'journal.db');
  const payload = bytes(32 * 1024 * 1024);
  const vault = new DatabaseSync(vaultPath);
  vault.exec('PRAGMA journal_mode=DELETE; CREATE TABLE payload (bytes BLOB NOT NULL)');
  vault.prepare('INSERT INTO payload (bytes) VALUES (?)').run(payload);
  vault.close();
  const journal = new DatabaseSync(journalPath);
  journal.exec('PRAGMA journal_mode=DELETE; CREATE TABLE events (name TEXT NOT NULL)');
  journal.prepare('INSERT INTO events (name) VALUES (?)').run('scale-lane');
  journal.close();
  const vaultBytes = await readFile(vaultPath);
  const journalBytes = await readFile(journalPath);
  const baseTickMs = 1_752_480_000_000;
  const entries: SourceEntry[] = [
    {
      path: 'vault.db',
      kind: 'db',
      absolutePath: vaultPath,
      sha256: createHash('sha256').update(vaultBytes).digest('hex'),
      walGeneration: '11'.repeat(16),
      baseTickMs,
    },
    {
      path: 'journal.db',
      kind: 'db',
      absolutePath: journalPath,
      sha256: createHash('sha256').update(journalBytes).digest('hex'),
      walGeneration: '22'.repeat(16),
      baseTickMs,
    },
  ];
  const provider = new LocalBackupProvider({ rootDir: providerDir });
  const { targetId } = await provider.createTarget({ label: 'scale-lane' });
  const keyring = await createKeyring(path.join(keyDir, 'keyring.json'));
  const started = performance.now();
  const snapshot = await createSnapshot({
    provider,
    targetId,
    keyring,
    vaultId: 'scale-vault',
    entries,
    generation: 1,
    appMeta: APP_META,
  });
  expect(snapshot).not.toBeNull();
  await restoreSnapshot({
    provider,
    targetId,
    keyring,
    vaultId: 'scale-vault',
    destDir: restoreDir,
    current: { gatewayVersion: '0.1.0', vaultUserVersion: '1', ontologyVersion: '1.2' },
  });
  const restored = await readFile(path.join(restoreDir, 'vault.db'));
  const durationMs = performance.now() - started;
  const sourceHash = createHash('sha256').update(vaultBytes).digest('hex');
  const restoredHash = createHash('sha256').update(restored).digest('hex');
  const passed = sourceHash === restoredHash && durationMs < 90_000;
  await recordQualityResult({
    lane: 'scale',
    owner: OWNER,
    name: 'Backup restore at 32 MiB',
    status: passed ? 'passed' : 'failed',
    measurements: [
      { name: 'wall clock', value: durationMs, unit: 'ms', budget: 90_000 },
      { name: 'restored bytes', value: restored.length, unit: 'bytes' },
    ],
  });
  expect(restoredHash).toBe(sourceHash);
  expect(durationMs).toBeLessThan(90_000);
});
