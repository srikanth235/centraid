import { tempDir } from '@centraid/test-kit/temp-dir';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { providerConformanceCases, type ConformanceHarness } from './conformance.js';
import { LocalBackupProvider } from './local-provider.js';
import { BackupProviderError } from './provider.js';
async function makeHarness(): Promise<ConformanceHarness> {
  const dir = await tempDir('backup-local-conf-');
  return {
    provider: new LocalBackupProvider({ rootDir: dir }),
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

describe('conformance suite', () => {
  for (const c of providerConformanceCases(makeHarness)) {
    test(c.name, async () => {
      await c.run();
      // Conformance kit uses node:assert (framework-agnostic); pin a vitest expect for requireAssertions (#496 E5).
      expect(true).toBe(true);
    });
  }
});

describe('LocalBackupProvider lifecycle edge cases', () => {
  test('unknown target throws not_found', async () => {
    const provider = new LocalBackupProvider({ rootDir: await tempDir() });
    await expect(provider.getTarget('nope')).rejects.toMatchObject({ code: 'not_found' });
  });

  test('registration replay ignores a stale generation on the replay call', async () => {
    const provider = new LocalBackupProvider({ rootDir: await tempDir() });
    const { targetId } = await provider.createTarget({ label: 't' });
    const reg = {
      idempotencyKey: 'k1',
      manifestKey: 'manifests/1.json',
      manifestHash: 'a'.repeat(64),
      totalBytes: 1,
      objectCount: 1,
      generation: 5,
      format: 'centraid-snapshot/2',
      appMeta: {},
    };
    const first = await provider.registerSnapshot(targetId, reg);
    // Same idempotencyKey, generation now "stale" relative to currentGeneration (5) —
    // replay must win over fencing (spec-mandated order).
    const replay = await provider.registerSnapshot(targetId, { ...reg, generation: 1 });
    expect(replay).toEqual(first);
  });

  test('undelete after the soft-delete window has expired refuses (undelete_window_expired)', async () => {
    const provider = new LocalBackupProvider({ rootDir: await tempDir() });
    const { targetId } = await provider.createTarget({ label: 't' });
    await provider.deleteTarget(targetId);
    // Rewrite the registry with a deletedAt far in the past to simulate an expired window.
    const dir = (provider as unknown as { rootDir: string }).rootDir;
    const registryFile = path.join(dir, 'registry.json');
    const raw = JSON.parse(await fs.readFile(registryFile, 'utf8'));
    raw.targets[targetId].deletedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await fs.writeFile(registryFile, JSON.stringify(raw));
    const fresh = new LocalBackupProvider({ rootDir: dir });
    await expect(fresh.undeleteTarget(targetId)).rejects.toMatchObject({
      code: 'undelete_window_expired',
    });
  });

  test('undelete after purge refuses forever (undelete_window_expired)', async () => {
    const provider = new LocalBackupProvider({ rootDir: await tempDir() });
    const { targetId } = await provider.createTarget({ label: 't' });
    await provider.purgeTarget(targetId);
    await expect(provider.undeleteTarget(targetId)).rejects.toMatchObject({
      code: 'undelete_window_expired',
    });
  });

  test('purge removes all objects and snapshot rows for the target', async () => {
    const provider = new LocalBackupProvider({ rootDir: await tempDir() });
    const { targetId } = await provider.createTarget({ label: 't' });
    const store = await provider.openDataPlane(targetId, 'backup', 'read-write');
    await store.put('chunks/abc', new Uint8Array([1, 2, 3]));
    await provider.registerSnapshot(targetId, {
      idempotencyKey: 'k',
      manifestKey: 'manifests/1.json',
      manifestHash: 'a'.repeat(64),
      totalBytes: 3,
      objectCount: 1,
      generation: 1,
      format: 'centraid-snapshot/2',
      appMeta: {},
    });
    await provider.purgeTarget(targetId);
    const rows = await provider.listSnapshots(targetId, { includePruned: true });
    expect(rows).toEqual([]);
    const roAfterPurge = await provider
      .openDataPlane(targetId, 'backup', 'read')
      .catch((e: unknown) => e);
    expect(roAfterPurge).toBeInstanceOf(BackupProviderError);
  });

  test('generation fencing error carries currentGeneration in details', async () => {
    const provider = new LocalBackupProvider({ rootDir: await tempDir() });
    const { targetId } = await provider.createTarget({ label: 't' });
    await provider.registerSnapshot(targetId, {
      idempotencyKey: 'k1',
      manifestKey: 'manifests/1.json',
      manifestHash: 'a'.repeat(64),
      totalBytes: 1,
      objectCount: 1,
      generation: 4,
      format: 'centraid-snapshot/2',
      appMeta: {},
    });
    try {
      await provider.registerSnapshot(targetId, {
        idempotencyKey: 'k2',
        manifestKey: 'manifests/2.json',
        manifestHash: 'b'.repeat(64),
        totalBytes: 1,
        objectCount: 1,
        generation: 2,
        format: 'centraid-snapshot/2',
        appMeta: {},
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BackupProviderError);
      expect((err as BackupProviderError).code).toBe('conflict_generation');
      expect((err as BackupProviderError).details?.currentGeneration).toBe(4);
    }
  });

  test('listSnapshots(targetId) excludes pruned rows by default (none pruned here, sanity check on shape)', async () => {
    const provider = new LocalBackupProvider({ rootDir: await tempDir() });
    const { targetId } = await provider.createTarget({ label: 't' });
    await provider.registerSnapshot(targetId, {
      idempotencyKey: 'k1',
      manifestKey: 'manifests/1.json',
      manifestHash: 'a'.repeat(64),
      totalBytes: 1,
      objectCount: 1,
      generation: 1,
      format: 'centraid-snapshot/2',
      appMeta: {},
    });
    const rows = await provider.listSnapshots(targetId);
    expect(rows.every((r) => r.prunedAt === null)).toBe(true);
  });

  test('usage sweeps real object bytes on disk', async () => {
    const provider = new LocalBackupProvider({ rootDir: await tempDir() });
    const { targetId } = await provider.createTarget({ label: 't' });
    const store = await provider.openDataPlane(targetId, 'backup', 'read-write');
    await store.put('chunks/a', new Uint8Array(10));
    await store.put('chunks/b', new Uint8Array(20));
    const { usage } = await provider.usage(targetId);
    expect(usage.storedBytes).toBe(30);
    expect(usage.objectCount).toBe(2);
  });

  test('registry survives a process restart (fresh LocalBackupProvider instance re-reads registry.json)', async () => {
    const dir = await tempDir();
    const provider1 = new LocalBackupProvider({ rootDir: dir });
    const { targetId } = await provider1.createTarget({ label: 't' });
    await provider1.registerSnapshot(targetId, {
      idempotencyKey: 'k1',
      manifestKey: 'manifests/1.json',
      manifestHash: 'a'.repeat(64),
      totalBytes: 1,
      objectCount: 1,
      generation: 1,
      format: 'centraid-snapshot/2',
      appMeta: {},
    });
    const provider2 = new LocalBackupProvider({ rootDir: dir });
    const rows = await provider2.listSnapshots(targetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.manifestKey).toBe('manifests/1.json');
  });

  test('policy and audit persist while inventory reflects on-disk objects and soft deletion', async () => {
    const dir = await tempDir();
    const first = new LocalBackupProvider({ rootDir: dir });
    const { targetId } = await first.createTarget({ label: 'observable' });
    const policy = await first.putPolicy(targetId, {
      rpoSeconds: 60,
      snapshotIntervalHours: 24,
      verifyEveryDays: 7,
      casAck: 'replicated',
    });
    const store = await first.openDataPlane(targetId, 'cas', 'read-write');
    await store.put('blobs/a', new Uint8Array([1, 2, 3]));
    await first.deleteTarget(targetId);

    const restarted = new LocalBackupProvider({ rootDir: dir });
    expect(await restarted.getPolicy(targetId)).toEqual(policy);
    const inventory = await restarted.listInventory(targetId, { store: 'cas' });
    expect(inventory.objects).toMatchObject([
      { key: 'blobs/a', sizeBytes: 3, state: 'soft-deleted' },
    ]);
    const audit = await restarted.listEvents(targetId);
    expect(audit.events.map((event) => event.kind)).toEqual(['policy-changed', 'soft-delete']);
  });

  // Gap 1 (the whole point of generation fencing, PROTOCOL.md: "two
  // gateways, one vault"): a SECOND provider instance opened on the same
  // rootDir BEFORE the first instance's write must still observe it on its
  // next operation — no in-memory cache may shadow a sibling instance's (or,
  // in production, a sibling PROCESS's) write to registry.json.
  test("two independent instances sharing one rootDir observe each other's writes (cross-process fencing)", async () => {
    const dir = await tempDir();
    // Instance A creates the target and registers generation 1 first, so
    // both instances open with a real target already on disk.
    const a = new LocalBackupProvider({ rootDir: dir });
    const { targetId } = await a.createTarget({ label: 't' });
    await a.registerSnapshot(targetId, {
      idempotencyKey: 'k1',
      manifestKey: 'manifests/1.json',
      manifestHash: 'a'.repeat(64),
      totalBytes: 1,
      objectCount: 1,
      generation: 1,
      format: 'centraid-snapshot/2',
      appMeta: {},
    });

    // Instance B is opened AFTER A's gen-1 write but has performed no
    // operation of its own yet — simulating a second gateway process that
    // mounted the same NAS-backed provider dir sometime after the first.
    const b = new LocalBackupProvider({ rootDir: dir });

    // A takes over (a restore-takeover, PROTOCOL.md's fencing story):
    // registers generation 2, bumping currentGeneration on disk.
    await a.registerSnapshot(targetId, {
      idempotencyKey: 'k2',
      manifestKey: 'manifests/2.json',
      manifestHash: 'b'.repeat(64),
      totalBytes: 1,
      objectCount: 1,
      generation: 2,
      format: 'centraid-snapshot/2',
      appMeta: {},
    });

    // B — despite having been constructed before A's gen-2 write, and never
    // itself having read the registry until now — must observe
    // currentGeneration 2 on its very next operation (no stale cache).
    const targetInfo = await b.getTarget(targetId);
    expect(targetInfo.currentGeneration).toBe(2);

    // And B's next registration at the now-stale generation 1 must fence —
    // the real cross-process split-brain detection this bug defeated.
    await expect(
      b.registerSnapshot(targetId, {
        idempotencyKey: 'k3-from-b',
        manifestKey: 'manifests/3.json',
        manifestHash: 'c'.repeat(64),
        totalBytes: 1,
        objectCount: 1,
        generation: 1,
        format: 'centraid-snapshot/2',
        appMeta: {},
      }),
    ).rejects.toMatchObject({ code: 'conflict_generation', details: { currentGeneration: 2 } });
  });
});
