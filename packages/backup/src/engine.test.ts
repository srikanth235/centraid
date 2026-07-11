import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createKeyring, type Keyring } from './crypto.js';
import { createSnapshot, restoreSnapshot, verifySnapshot, type SourceEntry } from './engine.js';
import { LocalBackupProvider } from './local-provider.js';
import type { ObjectStore } from './object-store.js';
import type { BackupProvider } from './provider.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(prefix = 'backup-engine-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const CURRENT = { gatewayVersion: '0.1.0', vaultUserVersion: '1', ontologyVersion: '1.2' };
const APP_META = {
  gatewayVersion: '0.1.0',
  vaultUserVersion: '1',
  ontologyVersion: '1.2',
  sourceInstanceId: 'test-instance',
};

/** Wraps an ObjectStore, counting `put` calls so incremental-upload savings are observable. */
class CountingObjectStore implements ObjectStore {
  putCount = 0;
  putKeys: string[] = [];
  constructor(private readonly inner: ObjectStore) {}
  async put(key: string, data: Uint8Array | AsyncIterable<Uint8Array>): Promise<void> {
    this.putCount++;
    this.putKeys.push(key);
    await this.inner.put(key, data);
  }
  get(key: string): Promise<Uint8Array> {
    return this.inner.get(key);
  }
  getStream(key: string): AsyncIterable<Uint8Array> {
    return this.inner.getStream(key);
  }
  head(key: string): Promise<{ size: number } | null> {
    return this.inner.head(key);
  }
  list(prefix: string): AsyncIterable<{ key: string; size: number }> {
    return this.inner.list(prefix);
  }
  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }
}

/* eslint-disable max-classes-per-file -- the two spies are small, colocated
   test-only wrappers around one seam (ObjectStore + BackupProvider). */
/** Wraps a BackupProvider, exposing the CountingObjectStore it hands out from openDataPlane. */
class SpyProvider implements BackupProvider {
  lastStore: CountingObjectStore | undefined;
  constructor(private readonly inner: BackupProvider) {}
  capabilities() {
    return this.inner.capabilities();
  }
  createTarget(opts: { label: string }) {
    return this.inner.createTarget(opts);
  }
  deleteTarget(targetId: string) {
    return this.inner.deleteTarget(targetId);
  }
  undeleteTarget(targetId: string) {
    return this.inner.undeleteTarget(targetId);
  }
  purgeTarget(targetId: string) {
    return this.inner.purgeTarget(targetId);
  }
  async openDataPlane(targetId: string, mode: 'read' | 'read-write') {
    const store = new CountingObjectStore(await this.inner.openDataPlane(targetId, mode));
    if (mode === 'read-write') this.lastStore = store;
    return store;
  }
  registerSnapshot(targetId: string, reg: Parameters<BackupProvider['registerSnapshot']>[1]) {
    return this.inner.registerSnapshot(targetId, reg);
  }
  listSnapshots(targetId: string, opts?: { includePruned?: boolean }) {
    return this.inner.listSnapshots(targetId, opts);
  }
  getSnapshot(targetId: string, seq: number) {
    return this.inner.getSnapshot(targetId, seq);
  }
  getTarget(targetId: string) {
    return this.inner.getTarget(targetId);
  }
  usage(targetId: string) {
    return this.inner.usage(targetId);
  }
}

interface Fixture {
  provider: SpyProvider;
  targetId: string;
  keyring: Keyring;
  sourceDir: string;
  entries: SourceEntry[];
}

async function buildSourceTree(sourceDir: string): Promise<SourceEntry[]> {
  await fs.mkdir(path.join(sourceDir, 'blobs', 'ab'), { recursive: true });
  // "db-like" file — big enough to span multiple FastCDC chunks.
  const dbBytes = pseudoRandomBuffer(3 * 1024 * 1024, 1);
  await fs.writeFile(path.join(sourceDir, 'vault.db'), dbBytes);
  await fs.writeFile(path.join(sourceDir, 'journal.db'), pseudoRandomBuffer(10_000, 2));
  await fs.writeFile(path.join(sourceDir, 'blobs', 'ab', 'cdef'), pseudoRandomBuffer(50_000, 3));
  await fs.writeFile(path.join(sourceDir, 'apps.bundle'), pseudoRandomBuffer(20_000, 4)); // fake git bundle
  await fs.writeFile(path.join(sourceDir, 'seal.key'), pseudoRandomBuffer(32, 5));

  return [
    { path: 'vault.db', kind: 'db', absolutePath: path.join(sourceDir, 'vault.db') },
    { path: 'journal.db', kind: 'db', absolutePath: path.join(sourceDir, 'journal.db') },
    {
      path: 'blobs/ab/cdef',
      kind: 'blob',
      absolutePath: path.join(sourceDir, 'blobs', 'ab', 'cdef'),
    },
    { path: 'apps.bundle', kind: 'git-bundle', absolutePath: path.join(sourceDir, 'apps.bundle') },
    { path: 'seal.key', kind: 'seal-key', absolutePath: path.join(sourceDir, 'seal.key') },
  ];
}

function pseudoRandomBuffer(size: number, seed: number): Uint8Array {
  let x = seed >>> 0 || 1;
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    buf[i] = x & 0xff;
  }
  return buf;
}

async function buildFixture(): Promise<Fixture> {
  const rootDir = await tempDir('backup-engine-provider-');
  const provider = new SpyProvider(new LocalBackupProvider({ rootDir }));
  const { targetId } = await provider.createTarget({ label: 'engine-test' });
  const keyringDir = await tempDir('backup-engine-keyring-');
  const keyring = await createKeyring(path.join(keyringDir, 'keyring.json'));
  const sourceDir = await tempDir('backup-engine-source-');
  const entries = await buildSourceTree(sourceDir);
  return { provider, targetId, keyring, sourceDir, entries };
}

describe('createSnapshot / restoreSnapshot roundtrip', () => {
  test('restores byte-identical files and the directory tree, plus a quarantine marker', async () => {
    const { provider, targetId, keyring, entries } = await buildFixture();
    const row = await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: 'vault-1',
      entries,
      generation: 1,
      appMeta: APP_META,
    });
    expect(row).not.toBeNull();
    expect(row?.seq).toBe(1);

    const destDir = await tempDir('backup-engine-restore-');
    // restoreSnapshot refuses a non-empty dir and requires a truly fresh one —
    // remove it so restoreSnapshot creates it itself.
    await fs.rm(destDir, { recursive: true, force: true });

    const result = await restoreSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: 'vault-1',
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
    );
    expect(marker.sourceSeq).toBe(1);
    expect(marker.quarantine.sort()).toEqual(['automations', 'connections', 'outbox']);
    expect(typeof marker.restoredAt).toBe('string');
  });

  test('incremental second snapshot after a 1-byte change uploads far fewer chunks than the first', async () => {
    const { provider, targetId, keyring, sourceDir, entries } = await buildFixture();
    await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: 'vault-1',
      entries,
      generation: 1,
      appMeta: APP_META,
    });
    const firstPutCount = provider.lastStore!.putCount;
    expect(firstPutCount).toBeGreaterThan(0);

    // Flip one byte in the middle of vault.db; touch mtime forward so the
    // fast-path's mtime check can't accidentally reuse it either.
    const dbPath = path.join(sourceDir, 'vault.db');
    const buf = await fs.readFile(dbPath);
    buf[Math.floor(buf.length / 2)] = (buf[Math.floor(buf.length / 2)]! ^ 0xff) & 0xff;
    await fs.writeFile(dbPath, buf);
    const future = new Date(Date.now() + 5000);
    await fs.utimes(dbPath, future, future);

    const row2 = await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: 'vault-1',
      entries,
      generation: 1,
      appMeta: APP_META,
    });
    expect(row2).not.toBeNull();
    const secondPutCount = provider.lastStore!.putCount;
    // Second run uploads its own manifest (+1) plus only the changed chunk(s)
    // of vault.db — strictly fewer object puts than the full first upload.
    expect(secondPutCount).toBeLessThan(firstPutCount);
  });

  test('no-change run registers nothing (returns null, uploads only the previous unmodified state)', async () => {
    const { provider, targetId, keyring, entries } = await buildFixture();
    const row1 = await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: 'vault-1',
      entries,
      generation: 1,
      appMeta: APP_META,
    });
    expect(row1).not.toBeNull();

    const row2 = await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: 'vault-1',
      entries,
      generation: 1,
      appMeta: APP_META,
    });
    expect(row2).toBeNull();

    const rows = await provider.listSnapshots(targetId);
    expect(rows).toHaveLength(1); // the no-change run registered nothing
  });

  test('restoreSnapshot refuses a non-empty destDir', async () => {
    const { provider, targetId, keyring, entries } = await buildFixture();
    await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: 'vault-1',
      entries,
      generation: 1,
      appMeta: APP_META,
    });
    const destDir = await tempDir('backup-engine-nonempty-');
    await fs.writeFile(path.join(destDir, 'preexisting.txt'), 'hi');
    await expect(
      restoreSnapshot({
        provider,
        targetId,
        keyring,
        vaultId: 'vault-1',
        destDir,
        current: CURRENT,
      }),
    ).rejects.toThrow(/not empty/);
  });

  test('restoreSnapshot refuses a newer vaultUserVersion than the running code', async () => {
    const { provider, targetId, keyring, entries } = await buildFixture();
    await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: 'vault-1',
      entries,
      generation: 1,
      appMeta: { ...APP_META, vaultUserVersion: '99' },
    });
    const destDir = await tempDir('backup-engine-newver-');
    await fs.rm(destDir, { recursive: true, force: true });
    await expect(
      restoreSnapshot({
        provider,
        targetId,
        keyring,
        vaultId: 'vault-1',
        destDir,
        current: CURRENT,
      }),
    ).rejects.toThrow(/newer/);
  });

  test('restoreSnapshot refuses an unknown format', async () => {
    const { provider, targetId, keyring, entries } = await buildFixture();
    await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: 'vault-1',
      entries,
      generation: 1,
      appMeta: APP_META,
    });
    // Sneak a bogus row in via a second registration with a mismatched format
    // (simulating a provider serving a snapshot from a future/unknown format).
    await provider.registerSnapshot(targetId, {
      idempotencyKey: 'bogus-format',
      manifestKey: 'manifests/bogus.json',
      manifestHash: 'f'.repeat(64),
      totalBytes: 1,
      objectCount: 0,
      generation: 2,
      format: 'centraid-snapshot/99',
      appMeta: APP_META,
    });
    const destDir = await tempDir('backup-engine-badfmt-');
    await fs.rm(destDir, { recursive: true, force: true });
    await expect(
      restoreSnapshot({
        provider,
        targetId,
        keyring,
        vaultId: 'vault-1',
        destDir,
        current: CURRENT,
      }),
    ).rejects.toThrow(/unknown format/);
  });

  test('restoreSnapshot rejects a snapshot whose manifest hash does not verify', async () => {
    const { provider, targetId, keyring, entries } = await buildFixture();
    const row = await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: 'vault-1',
      entries,
      generation: 1,
      appMeta: APP_META,
    });
    // Corrupt the stored manifest object directly on disk.
    const store = await provider.openDataPlane(targetId, 'read-write');
    const bytes = await store.get(row!.manifestKey);
    const tampered = new Uint8Array(bytes);
    tampered[0]! ^= 0xff;
    await store.put(row!.manifestKey, tampered);
    const destDir = await tempDir('backup-engine-badhash-');
    await fs.rm(destDir, { recursive: true, force: true });
    await expect(
      restoreSnapshot({
        provider,
        targetId,
        keyring,
        vaultId: 'vault-1',
        destDir,
        current: CURRENT,
      }),
    ).rejects.toThrow(/hash mismatch/);
  });
});

describe('verifySnapshot', () => {
  test('detects a deliberately deleted chunk object', async () => {
    const { provider, targetId, keyring, entries } = await buildFixture();
    await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: 'vault-1',
      entries,
      generation: 1,
      appMeta: APP_META,
    });

    const store = await provider.openDataPlane(targetId, 'read-write');
    const listed: string[] = [];
    for await (const obj of store.list('chunks/')) listed.push(obj.key);
    expect(listed.length).toBeGreaterThan(0);
    await store.delete(listed[0]!);

    const result = await verifySnapshot({
      provider,
      targetId,
      keyring,
      vaultId: 'vault-1',
      sampleCount: 20,
    });
    expect(result.missing).toContain(listed[0]!.slice('chunks/'.length));
  });

  test('detects a corrupted chunk object via the sample pass', async () => {
    const { provider, targetId, keyring, entries } = await buildFixture();
    await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: 'vault-1',
      entries,
      generation: 1,
      appMeta: APP_META,
    });

    const store = await provider.openDataPlane(targetId, 'read-write');
    const listed: string[] = [];
    for await (const obj of store.list('chunks/')) listed.push(obj.key);
    expect(listed.length).toBeGreaterThan(0);
    const target = listed[0]!;
    const bytes = await store.get(target);
    const tampered = new Uint8Array(bytes);
    tampered[tampered.length - 1]! ^= 0xff; // flip a tag byte
    await store.put(target, tampered);

    // sampleCount = all chunks, so the corrupted one is guaranteed to be sampled.
    const result = await verifySnapshot({
      provider,
      targetId,
      keyring,
      vaultId: 'vault-1',
      sampleCount: 1000,
    });
    expect(result.corrupt).toContain(target.slice('chunks/'.length));
  });

  test('a clean snapshot verifies with no missing or corrupt objects', async () => {
    const { provider, targetId, keyring, entries } = await buildFixture();
    await createSnapshot({
      provider,
      targetId,
      keyring,
      vaultId: 'vault-1',
      entries,
      generation: 1,
      appMeta: APP_META,
    });
    const result = await verifySnapshot({
      provider,
      targetId,
      keyring,
      vaultId: 'vault-1',
      sampleCount: 20,
    });
    expect(result.missing).toEqual([]);
    expect(result.corrupt).toEqual([]);
    expect(result.checkedObjects).toBeGreaterThan(0);
  });
});
