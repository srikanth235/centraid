/*
 * Issue #439 R2 — lazy-by-default restore, `--full` override, and the
 * metered-egress cost estimate, exercised at the SERVICE layer (where the
 * future `recover()` verb inherits the defaulting). A real `VaultRegistry` +
 * `LocalBackupProvider` over temp dirs, with the same injected `assembleEntries`
 * seam `backup-service.test.ts` uses. Kept in its own file (not appended to
 * that one) purely to stay under the repo-hygiene line cap.
 */

import { afterEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openLocalBackupProvider, WAL_DB_FILES, type BackupProvider } from '@centraid/backup';
import { updateBlobStoreSettings, type BlobStore, type RemoteTier } from '@centraid/vault';
import { openVaultRegistry, type VaultRegistry } from '../serve/vault-registry.js';
import { HealthRegistry } from '../serve/health-registry.js';
import { BackupService } from './backup-service.js';
import type { BackupConfig } from './backup-config.js';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-${crypto.randomUUID()}-`));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

interface Harness {
  service: BackupService;
  registry: VaultRegistry;
  vaultId: string;
}

/** One default vault + a real local backend, with the DB-assembly seam that the
 *  capture tests own; `blobEntry:false` yields a db-only snapshot so the lazy
 *  resolution can be asserted without the auto-resolved remote tier ever being
 *  dialed (no blob ⇒ no skipBlob call; no derivatives ⇒ no warm-pass fetch). */
async function harness(
  wrapProvider?: (real: BackupProvider) => BackupProvider,
  opts: { blobEntry?: boolean } = {},
): Promise<Harness> {
  const includeBlobEntry = opts.blobEntry ?? true;
  const vaultRoot = await tempDir('r439-vault');
  const providerDir = await tempDir('r439-provider');
  const backupDir = await tempDir('r439-state');
  const registry = openVaultRegistry({
    rootDir: vaultRoot,
    logger: silentLogger,
    ownerName: 'Priya',
  });
  cleanups.push(() => registry.stop());
  const vaultId = registry.defaultVaultId();

  const fixtureDir = await tempDir('r439-fixture');
  const fixtureFile = path.join(fixtureDir, 'vault.db');
  await fs.writeFile(fixtureFile, 'v0');

  const config: BackupConfig = { enabled: true, provider: { kind: 'local', dir: providerDir } };
  const realProvider = openLocalBackupProvider({ rootDir: providerDir });
  const service = new BackupService({
    config,
    backupDir,
    vaults: registry,
    health: new HealthRegistry(),
    logger: silentLogger,
    provider: wrapProvider ? wrapProvider(realProvider) : realProvider,
    assembleEntries: ({ plane }) => {
      const bases = plane.walShipper!.currentBases();
      return Promise.resolve([
        ...bases.map((base) => ({
          path: WAL_DB_FILES[base.db],
          kind: 'db' as const,
          absolutePath: base.file,
          sha256: base.sha256,
          walGeneration: base.generation,
          baseTickMs: base.createdAtMs,
        })),
        ...(includeBlobEntry
          ? [{ path: 'fixture.bin', kind: 'blob' as const, absolutePath: fixtureFile }]
          : []),
      ]);
    },
  });
  return { service, registry, vaultId };
}

/** An s3 `blob_store` bag with a resolvable endpoint+bucket — the two fields
 *  `remoteTier()` requires to hand back a non-null tier. The endpoint is
 *  deliberately `.invalid`: these tests assert the RESOLUTION and never let a
 *  store operation dial it. */
function declareRemoteTier(registry: VaultRegistry): void {
  updateBlobStoreSettings(registry.current().db, {
    blob_store: { kind: 's3', endpoint: 'https://remote.invalid', bucket: 'r439' },
  });
}

/** A remote CAS tier that MUST NOT be dialed — the db-only snapshots here never
 *  consult skipBlob and carry no derivatives, so the warm pass reads nothing. */
function undialedRemote(): RemoteTier {
  const store: BlobStore = {
    kind: 'undialed-remote',
    put: () => Promise.reject(new Error('undialed-remote.put must not be called')),
    get: () => Promise.resolve(null),
    has: () => Promise.resolve(false),
    delete: () => Promise.resolve(),
    list: () => Promise.resolve([]),
    stat: () => Promise.resolve(null),
  };
  return { store };
}

/** Wrap a real provider so its declared `restoreCostClass` is a chosen value —
 *  stands in for a hosted (metered-egress) home without a real remote server. */
function withRestoreCostClass(
  real: BackupProvider,
  restoreCostClass: 'free-egress' | 'metered-egress',
): BackupProvider {
  return {
    capabilities: async (...a) => {
      const caps = await real.capabilities(...a);
      return caps.backup ? { ...caps, backup: { ...caps.backup, restoreCostClass } } : caps;
    },
    createTarget: (...a) => real.createTarget(...a),
    deleteTarget: (...a) => real.deleteTarget(...a),
    undeleteTarget: (...a) => real.undeleteTarget(...a),
    purgeTarget: (...a) => real.purgeTarget(...a),
    openDataPlane: (...a) => real.openDataPlane(...a),
    registerSnapshot: (...a) => real.registerSnapshot(...a),
    listSnapshots: (...a) => real.listSnapshots(...a),
    getSnapshot: (...a) => real.getSnapshot(...a),
    getTarget: (...a) => real.getTarget(...a),
    usage: (...a) => real.usage(...a),
  };
}

test('VaultDb.remote() is null without an s3 tier and resolves one when declared (#439 R2)', async () => {
  const h = await harness();
  expect(h.registry.current().db.remote()).toBeNull();
  declareRemoteTier(h.registry);
  expect(h.registry.current().db.remote()).not.toBeNull();
});

test('restore auto-resolves to a FULL materialization with no durable remote tier (#439 R2)', async () => {
  const h = await harness();
  await h.service.runBackup(h.vaultId);
  const destDir = path.join(await tempDir('r439-auto-full-dest'), 'restored');
  const result = await h.service.restore({ vaultId: h.vaultId, destDir });
  // No `previewsWarm` ⇒ the full path ran; nothing was deferred.
  expect(result.previewsWarm).toBeUndefined();
  expect(result.skippedBlobs).toEqual([]);
});

test('restore is LAZY by default when the vault has a durable remote CAS tier (#439 R2)', async () => {
  const h = await harness(undefined, { blobEntry: false });
  declareRemoteTier(h.registry);
  await h.service.runBackup(h.vaultId);
  const destDir = path.join(await tempDir('r439-auto-lazy-dest'), 'restored');
  const result = await h.service.restore({ vaultId: h.vaultId, destDir });
  // `previewsWarm` present ⇒ the previews-first lazy path ran. The db-only
  // snapshot carries no blobs and no derivatives, so the resolved tier is
  // never actually dialed — the resolution alone is under test.
  expect(result.previewsWarm).toBeDefined();
  expect(result.previewsWarm?.tiniesTotal).toBe(0);
  expect(result.skippedBlobs).toEqual([]);
});

test('restore honors full:true even when a durable remote CAS tier exists (#439 R2)', async () => {
  const h = await harness();
  declareRemoteTier(h.registry);
  await h.service.runBackup(h.vaultId);
  const destDir = path.join(await tempDir('r439-full-override-dest'), 'restored');
  const result = await h.service.restore({ vaultId: h.vaultId, destDir, full: true });
  expect(result.previewsWarm).toBeUndefined();
});

test('an explicit lazy option wins over full:true (#439 R2)', async () => {
  const h = await harness(undefined, { blobEntry: false });
  await h.service.runBackup(h.vaultId);
  const destDir = path.join(await tempDir('r439-explicit-lazy-dest'), 'restored');
  const result = await h.service.restore({
    vaultId: h.vaultId,
    destDir,
    lazy: { remote: undialedRemote() },
    full: true,
  });
  expect(result.previewsWarm).toBeDefined();
});

test('restoreEgressEstimate reports the metered cost class and full snapshot size (#439 R2)', async () => {
  const h = await harness((real) => withRestoreCostClass(real, 'metered-egress'));
  await h.service.runBackup(h.vaultId);
  const est = await h.service.restoreEgressEstimate({ vaultId: h.vaultId });
  expect(est.costClass).toBe('metered-egress');
  expect(est.seq).toBe(1);
  expect(est.fullBytes).toBeGreaterThan(0);
  // The default vault has no remote tier ⇒ a restore would be full, not lazy.
  expect(est.lazyAvailable).toBe(false);
});

test('restoreEgressEstimate reports a free-egress home and a resolvable lazy tier (#439 R2)', async () => {
  const h = await harness(undefined, { blobEntry: false });
  declareRemoteTier(h.registry);
  await h.service.runBackup(h.vaultId);
  const est = await h.service.restoreEgressEstimate({ vaultId: h.vaultId });
  expect(est.costClass).toBe('free-egress');
  expect(est.lazyAvailable).toBe(true);
});
