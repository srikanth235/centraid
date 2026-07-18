import { tempDir } from '@centraid/test-kit/temp-dir';
/*
 * Previews-first, lazy/partial restore (issue #405 §5) — the end-to-end story
 * for restoring a library LARGER than the local disk, scaled down to tiny
 * in-memory buffers. A real seeded vault (image content + `thumb` derivatives)
 * is snapshotted through the REAL BackupService/LocalBackupProvider; a subset
 * of its blobs is replicated to an in-memory remote CAS; then the snapshot is
 * restored in LAZY mode and we assert the §5 contract:
 *
 *   • the DB restores intact (rows + derivative registry survive);
 *   • blobs the remote CAS already holds are NOT materialized locally — they
 *     stay remote-only and read-through on demand (this is what lets a 500 GB
 *     library land on a 30 GB gateway);
 *   • a blob the remote does NOT hold (local-only at snapshot time) DOES
 *     materialize — the snapshot is its only copy, so lazy must never drop it;
 *   • the warm pass pulls ALL tinies into the local spool (usable grid), and
 *   • an on-demand `open()` of a deferred original read-throughs correctly, and
 *   • the time-to-usable-grid metric is reported.
 *
 * Snapshot-blob-inclusion truth this rests on (backup-sources.ts §b): snapshots
 * carry EVERY local CAS blob — a configured remote is NOT durability evidence
 * there — so the lazy SKIP is what trims the restore, per-blob, keyed on a live
 * remote `has(sha)`.
 */

import { expect, test, vi } from 'vitest';
import crypto, { randomBytes } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  BlobCustody,
  FsBlobStore,
  ReplicaIndex,
  type BlobRange,
  type BlobStat,
  type BlobStore,
  type RemoteTier,
} from '@centraid/vault';
import { openVaultRegistry } from '../serve/vault-registry.js';
import type { VaultPlane } from '../serve/vault-plane.js';
import { HealthRegistry } from '../serve/health-registry.js';
import { BackupService } from './backup-service.js';
import type { BackupConfig } from './backup-config.js';

vi.setConfig({ testTimeout: 30_000 });

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** A minimal async remote CAS — the §5 test's "fake/in-memory store". Stores
 * whatever bytes `put` is handed (custody replicates SEALED bytes), keyed by
 * the plaintext sha, exactly like S3BlobStore. No `putStream`, so the small
 * blobs here all replicate through the buffered `put` path. */
class MemoryRemoteStore implements BlobStore {
  readonly kind = 'memory-remote';
  private readonly objects = new Map<string, Buffer>();

  put(sha: string, bytes: Buffer): Promise<void> {
    this.objects.set(sha, Buffer.from(bytes));
    return Promise.resolve();
  }
  get(sha: string, range?: BlobRange): Promise<Buffer | null> {
    const whole = this.objects.get(sha);
    if (!whole) return Promise.resolve(null);
    if (!range) return Promise.resolve(whole);
    const end = Math.min(range.end ?? whole.length - 1, whole.length - 1);
    return Promise.resolve(whole.subarray(range.start, end + 1));
  }
  has(sha: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(sha));
  }
  delete(sha: string): Promise<void> {
    this.objects.delete(sha);
    return Promise.resolve();
  }
  list(): Promise<string[]> {
    return Promise.resolve([...this.objects.keys()]);
  }
  stat(sha: string): Promise<BlobStat | null> {
    const whole = this.objects.get(sha);
    return Promise.resolve(whole ? { size: whole.length } : null);
  }
}

function invoke(
  plane: VaultPlane,
  command: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out = plane.gateway.invoke(plane.ownerCredential, { command, input });
  if (out.status !== 'executed') throw new Error(`${command} failed: ${JSON.stringify(out)}`);
  return (out as { output: Record<string, unknown> }).output;
}

/** Stage arbitrary bytes into the vault's local CAS (they ride into the
 * snapshot) — the same ingress `core.attach` and the derivative pipeline use. */
function stage(plane: VaultPlane, bytes: Buffer, name: string): string {
  return plane.gateway.stageBlob(plane.ownerCredential, {
    bytes,
    mediaType: 'application/octet-stream',
    filename: name,
  }).sha256;
}

function declareRemotePrimary(plane: VaultPlane): void {
  const row = plane.db.vault.prepare('SELECT settings_json FROM core_vault LIMIT 1').get() as {
    settings_json: string | null;
  };
  const settings = row.settings_json
    ? (JSON.parse(row.settings_json) as Record<string, unknown>)
    : {};
  plane.db.vault.prepare('UPDATE core_vault SET settings_json = ?').run(
    JSON.stringify({
      ...settings,
      blob_store: {
        kind: 's3',
        endpoint: 'https://remote-primary.invalid',
        bucket: 'restore-e2e',
      },
    }),
  );
}

test('lazy restore: a library bigger than local disk restores previews-first — remote-held blobs stay remote-only, local-only blobs materialize, tinies warm', async () => {
  const vaultDir = await tempDir('lazy-vault');
  const providerDir = await tempDir('lazy-provider');
  const backupDir = await tempDir('lazy-backup');
  const config: BackupConfig = { enabled: true, provider: { kind: 'local', dir: providerDir } };
  const registry = openVaultRegistry({
    rootDir: vaultDir,
    logger: silentLogger,
    ownerName: 'Mara',
  });
  const vaultId = registry.defaultVaultId();
  const plane = registry.get(vaultId)!;
  const health = new HealthRegistry();
  const service = new BackupService({
    config,
    backupDir,
    vaults: registry,
    health,
    logger: silentLogger,
  });

  // The remote CAS + the seal key its objects are encrypted under. In
  // production this is the vault's configured blob_store; here it is injected.
  const remoteStore = new MemoryRemoteStore();
  const sealKey = randomBytes(32);
  const remote: RemoteTier = { store: remoteStore, encryptKey: sealKey };

  try {
    // 1. Seed three "image" content items, each with an ORIGINAL blob and a
    // tiny THUMB derivative. Buffers are bytes, not real images — the lazy
    // restore is byte-level, and `core_content_derivative` is what the warm
    // pass reads to find the tinies.
    const originals: { contentId: string; sha: string; bytes: Buffer }[] = [];
    const thumbs: { sha: string; bytes: Buffer }[] = [];
    for (let i = 0; i < 3; i++) {
      const taskId = invoke(plane, 'schedule.add_task', { title: `Photo ${i}` })[
        'task_id'
      ] as string;
      const originalBytes = randomBytes(400 + i); // distinct bytes ⇒ distinct shas
      const originalSha = stage(plane, originalBytes, `photo-${i}.bin`);
      const attach = invoke(plane, 'core.attach', {
        subject_type: 'schedule.task',
        subject_id: taskId,
        staged_sha: originalSha,
      });
      const contentId = attach['content_id'] as string;
      expect(contentId).toBeTruthy();
      originals.push({ contentId, sha: originalSha, bytes: originalBytes });

      const thumbBytes = randomBytes(64 + i);
      const thumbSha = stage(plane, thumbBytes, `photo-${i}.thumb`);
      plane.db.vault
        .prepare(
          `INSERT INTO core_content_derivative
             (derivative_id, content_id, variant, sha256, media_type, byte_size, created_at)
           VALUES (?, ?, 'thumb', ?, 'image/webp', ?, ?)`,
        )
        .run(crypto.randomUUID(), contentId, thumbSha, thumbBytes.length, new Date().toISOString());
      thumbs.push({ sha: thumbSha, bytes: thumbBytes });
    }

    // 2. Replicate to the remote CAS: originals[0] and originals[1] plus ALL
    // three thumbs. originals[2] is deliberately LEFT local-only (the remote
    // does NOT hold it) so we can prove lazy still materializes it.
    const seedCustody = new BlobCustody(
      new FsBlobStore(path.join(plane.dir, 'blobs')),
      () => remote,
    );
    const replicated = [originals[0]!.sha, originals[1]!.sha, ...thumbs.map((t) => t.sha)];
    await seedCustody.replicate(replicated);
    for (const sha of replicated) expect(await remoteStore.has(sha)).toBe(true);
    expect(await remoteStore.has(originals[2]!.sha)).toBe(false);

    // 3. Snapshot the whole vault (snapshots carry EVERY local CAS blob).
    await service.runBackup(vaultId);
    expect((await service.status())[vaultId]?.lastSeq).toBe(1);

    // 4. LAZY restore into a fresh dest.
    const destParent = await tempDir('lazy-dest');
    const destDir = path.join(destParent, 'restored');
    const result = await service.restore({ vaultId, destDir, lazy: { remote } });

    // --- The DB restored intact ---
    expect(result.entries).toContain('vault.db');
    expect(result.entries).toContain('journal.db');
    const restoredDb = new DatabaseSync(path.join(destDir, 'vault.db'), { readOnly: true });
    try {
      const taskCount = (
        restoredDb.prepare('SELECT COUNT(*) AS n FROM schedule_task').get() as { n: number }
      ).n;
      expect(taskCount).toBe(3);
      const thumbCount = (
        restoredDb
          .prepare(`SELECT COUNT(*) AS n FROM core_content_derivative WHERE variant = 'thumb'`)
          .get() as { n: number }
      ).n;
      expect(thumbCount).toBe(3);
    } finally {
      restoredDb.close();
    }

    // --- Remote-held blobs were DEFERRED, local-only blob MATERIALIZED ---
    const destBlobs = new FsBlobStore(path.join(destDir, 'blobs'));
    expect(destBlobs.hasSync(originals[0]!.sha)).toBe(false); // remote holds it ⇒ skipped
    expect(destBlobs.hasSync(originals[1]!.sha)).toBe(false); // remote holds it ⇒ skipped
    expect(destBlobs.hasSync(originals[2]!.sha)).toBe(true); // local-only ⇒ materialized
    // The engine reports exactly what it held back.
    expect(result.skippedBlobs).toContain(originals[0]!.sha);
    expect(result.skippedBlobs).toContain(originals[1]!.sha);
    expect(result.skippedBlobs).not.toContain(originals[2]!.sha);

    // --- The warm pass made ALL tinies present locally (usable grid) ---
    for (const t of thumbs) expect(destBlobs.hasSync(t.sha)).toBe(true);

    // --- The §5 time-to-usable-grid metric is reported ---
    expect(result.previewsWarm).toBeDefined();
    expect(result.previewsWarm!.tiniesTotal).toBe(3);
    expect(result.previewsWarm!.tiniesWarmed).toBe(3);
    expect(result.previewsWarm!.tiniesFailed).toBe(0);
    expect(typeof result.previewsWarm!.timeToUsableGridMs).toBe('number');
    expect(result.previewsWarm!.timeToUsableGridMs).toBeGreaterThanOrEqual(0);

    // --- A deferred original read-throughs on demand (mediums/originals stay
    //     remote-only until something asks for them) ---
    const readCustody = new BlobCustody(new FsBlobStore(path.join(destDir, 'blobs')), () => remote);
    const readBack = await readCustody.open(originals[0]!.sha);
    expect(readBack).not.toBeNull();
    expect(readBack!.equals(originals[0]!.bytes)).toBe(true);
    // And the local-only original reads straight from the materialized copy.
    const localOnly = await readCustody.open(originals[2]!.sha);
    expect(localOnly!.equals(originals[2]!.bytes)).toBe(true);
  } finally {
    registry.stop();
  }
}, 30_000);

test('remote-primary snapshot restores from provider bytes plus only the durable outbox', async () => {
  const vaultDir = await tempDir('remote-primary-vault');
  const providerDir = await tempDir('remote-primary-provider');
  const backupDir = await tempDir('remote-primary-backup');
  const registry = openVaultRegistry({
    rootDir: vaultDir,
    logger: silentLogger,
    ownerName: 'Mara',
  });
  const vaultId = registry.defaultVaultId();
  const plane = registry.get(vaultId)!;
  const service = new BackupService({
    config: { enabled: true, provider: { kind: 'local', dir: providerDir } },
    backupDir,
    vaults: registry,
    health: new HealthRegistry(),
    logger: silentLogger,
  });
  const remoteStore = new MemoryRemoteStore();
  const remote: RemoteTier = { store: remoteStore, encryptKey: randomBytes(32) };

  try {
    declareRemotePrimary(plane);
    const taskId = invoke(plane, 'schedule.add_task', { title: 'Restore split custody' })[
      'task_id'
    ] as string;
    const remoteBytes = randomBytes(700);
    const pendingBytes = randomBytes(701);
    const remoteSha = stage(plane, remoteBytes, 'remote.bin');
    const pendingSha = stage(plane, pendingBytes, 'pending.bin');
    for (const sha of [remoteSha, pendingSha]) {
      invoke(plane, 'core.attach', {
        subject_type: 'schedule.task',
        subject_id: taskId,
        staged_sha: sha,
      });
    }

    const seedCustody = new BlobCustody(
      new FsBlobStore(path.join(plane.dir, 'blobs')),
      () => remote,
    );
    await seedCustody.replicate([remoteSha]);
    new ReplicaIndex(plane.db.vault).mark(remoteSha, remoteBytes.length);
    plane.db.blobTransfers.state.completeOutbox(remoteSha);
    expect(plane.db.blobTransfers.pendingSnapshotShas()).toEqual([pendingSha]);

    await service.runBackup(vaultId);
    const destDir = path.join(await tempDir('remote-primary-dest'), 'restored');
    const result = await service.restore({ vaultId, destDir, lazy: { remote } });
    const restoredLocal = new FsBlobStore(path.join(destDir, 'blobs'));

    // Remote-primary originals never enter the snapshot at all; the restored
    // DB still addresses them by SHA and the configured remote answers later.
    expect(result.entries.some((entry) => entry.endsWith(remoteSha))).toBe(false);
    expect(result.skippedBlobs).not.toContain(pendingSha);
    expect(restoredLocal.hasSync(remoteSha)).toBe(false);
    expect(restoredLocal.hasSync(pendingSha)).toBe(true);
    expect((await restoredLocal.get(pendingSha))?.equals(pendingBytes)).toBe(true);

    const restoredCustody = new BlobCustody(restoredLocal, () => remote);
    expect((await restoredCustody.open(remoteSha))?.equals(remoteBytes)).toBe(true);
  } finally {
    registry.stop();
  }
}, 30_000);
