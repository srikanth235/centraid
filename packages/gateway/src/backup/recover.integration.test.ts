import { tempDir } from '@centraid/test-kit/temp-dir';
/*
 * The blank-machine recovery e2e (issue #439 R1) — the FORMAT.md acceptance
 * test made real, not prose: a fresh empty data dir plus NOTHING but the
 * recovery kit document and the provider api-key becomes a live vault.
 *
 * Machine A: a real seeded vault (tasks + originals + thumbs, following
 * restore-lazy-e2e), a standing outbox grant (so the quarantine has something
 * to revoke), a real backup against `startFakeProviderServer()`, and a subset
 * of its blobs replicated into the provider's attested `cas` store. Then a
 * BLANK machine calls `recover()` with just the kit + the api-key and we assert
 * the whole contract: the vault materializes with its rows intact; remote-held
 * blobs are deferred while local-only ones materialize; the quarantine marker
 * is present pre-mount and fires on first mount; the fenced generation is
 * seeded (old + 1) and the superseded machine's next registration 409s; and the
 * completion report is honest.
 *
 * A second test proves the registry-appMeta compatibility gate refuses a
 * newer-software snapshot BEFORE a single byte is fetched.
 */

import { afterEach, expect, test, vi } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import crypto, { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  BackupProviderError,
  openRemoteBackupProvider,
  SNAPSHOT_FORMAT_V2,
} from '@centraid/backup';
import { startFakeProviderServer } from '@centraid/backup/dist/testing/fake-provider-server.js';
import { FsBlobStore, ReplicaIndex } from '@centraid/vault';
import { openVaultRegistry } from '../serve/vault-registry.js';
import type { VaultPlane } from '../serve/vault-plane.js';
import { WorktreeStore } from '../worktree-store/worktree-store.js';
import { run } from '../worktree-store/git.js';
import { HealthRegistry } from '../serve/health-registry.js';
import { BackupService } from './backup-service.js';
import { daemonLayoutFor } from '../cli/paths.js';
import { recover } from './recover.js';

vi.setConfig({ testTimeout: 30_000 });

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});
function invoke(
  plane: VaultPlane,
  command: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out = plane.gateway.invoke(plane.ownerCredential, { command, input });
  if (out.status !== 'executed') throw new Error(`${command} failed: ${JSON.stringify(out)}`);
  return (out as { output: Record<string, unknown> }).output;
}

function stage(plane: VaultPlane, bytes: Buffer, name: string): string {
  return plane.gateway.stageBlob(plane.ownerCredential, {
    bytes,
    mediaType: 'application/octet-stream',
    filename: name,
  }).sha256;
}

/** A sealed credential + an approved outbox item + a standing grant — the live
 *  states the quarantine gesture must neutralize, and (crucially) the sealed
 *  credential MINTS the vault's seal-key file, so the recovered vault has
 *  sealed secrets and only mounts if `recover()` placed the seal key correctly
 *  (issue #439 R1). Mirrors vault-quarantine.test.ts's seed. */
function seedSealedOutbox(plane: VaultPlane): { itemId: string; grantId: string } {
  invoke(plane, 'sync.configure_credential', {
    kind: 'pull.gmail',
    label: 'personal',
    cred_kind: 'api_key',
    api_key: 'sk-recover-test',
    allowed_hosts: ['gmail.googleapis.com'],
  });
  const itemId = invoke(plane, 'outbox.stage', {
    kind: 'pull.gmail',
    label: 'personal',
    verb: 'gmail.send',
    target: 'ravi@example.com',
    artifact: { to: 'ravi@example.com', subject: 'Hi', body: 'See you.' },
    request: {
      method: 'POST',
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      headers: { authorization: 'Bearer {{connection:api_key}}' },
      body: '{"raw":"x"}',
    },
  })['item_id'] as string;
  const grantId = crypto.randomUUID();
  plane.db.vault
    .prepare(
      `INSERT INTO outbox_grant (grant_id, actor_id, verb, target, created_at, revoked_at)
       VALUES (?, 'owner', 'gmail.send', 'ravi@example.com', ?, NULL)`,
    )
    .run(grantId, new Date().toISOString());
  plane.db.vault
    .prepare(
      `UPDATE outbox_item SET status = 'approved', decided_at = ?, grant_id = ? WHERE item_id = ?`,
    )
    .run(new Date().toISOString(), grantId, itemId);
  return { itemId, grantId };
}

interface MachineA {
  vaultId: string;
  targetId: string;
  oldGeneration: number;
  kitDocument: Record<string, unknown>;
  originals: string[];
  thumbs: string[];
  itemId: string;
  grantId: string;
  /** The app published into machine A's code store — must survive recovery (issue #517). */
  appId: string;
  serverUrl: string;
  apiKey: string;
}

/** Publish a real app into the vault's code store so the snapshot's git bundle
 *  carries app code the recovery must bring back (issue #517). Returns its id. */
async function publishSeedApp(plane: VaultPlane): Promise<string> {
  const appId = 'todo';
  const store = new WorktreeStore({ root: plane.codeStoreRoot });
  await store.init();
  const session = await store.openSession('seed-session');
  const appDir = path.join(session.worktreePath, 'apps', appId);
  await fs.mkdir(path.join(appDir, 'actions'), { recursive: true });
  await fs.writeFile(
    path.join(appDir, 'app.json'),
    JSON.stringify({ id: appId, name: 'Todo' }, null, 2),
  );
  await fs.writeFile(path.join(appDir, 'index.html'), '<h1>Todo</h1>\n');
  await store.publish({ sessionId: 'seed-session', appId, message: 'seed v1' });
  await store.closeSession('seed-session');
  return appId;
}

/** Stand up "machine A": seed a real vault, back it up against the fake HTTP
 *  provider, and replicate a subset of blobs into the provider's cas store so
 *  its attested inventory is non-empty. Returns everything recovery needs. */
async function seedMachineA(
  server: Awaited<ReturnType<typeof startFakeProviderServer>>,
): Promise<MachineA> {
  const vaultRoot = await tempDir('recover-a-vault');
  const backupDir = await tempDir('recover-a-backup');
  const registry = openVaultRegistry({
    rootDir: vaultRoot,
    logger: silentLogger,
    ownerName: 'Mara',
  });
  cleanups.push(() => registry.stop());
  const vaultId = registry.defaultVaultId();
  const plane = registry.get(vaultId)!;
  const service = new BackupService({
    config: {
      enabled: true,
      provider: { kind: 'remote', endpoint: server.url, apiKey: server.apiKey },
    },
    backupDir,
    vaults: registry,
    health: new HealthRegistry(),
    logger: silentLogger,
  });
  cleanups.push(() => service.stop());

  // Three content items, each an original + a tiny thumb (bytes, not real
  // images — recovery is byte-level).
  const originals: string[] = [];
  const thumbs: string[] = [];
  for (let i = 0; i < 3; i++) {
    const taskId = invoke(plane, 'schedule.add_task', { title: `Photo ${i}` })['task_id'] as string;
    const originalSha = stage(plane, randomBytes(400 + i), `photo-${i}.bin`);
    const attach = invoke(plane, 'core.attach', {
      subject_type: 'schedule.task',
      subject_id: taskId,
      staged_sha: originalSha,
    });
    originals.push(originalSha);
    const thumbBytes = randomBytes(64 + i);
    const thumbSha = stage(plane, thumbBytes, `photo-${i}.thumb`);
    plane.db.vault
      .prepare(
        `INSERT INTO core_content_derivative
           (derivative_id, content_id, variant, sha256, media_type, byte_size, created_at)
         VALUES (?, ?, 'thumb', ?, 'image/webp', ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        attach['content_id'] as string,
        thumbSha,
        thumbBytes.length,
        new Date().toISOString(),
      );
    thumbs.push(thumbSha);
  }

  // A sealed credential + approved outbox item + standing grant (see helper):
  // the sealed secret mints the seal key, so recovery must place it or the
  // vault bricks; the approved item + grant are what the quarantine parks.
  const { itemId, grantId } = seedSealedOutbox(plane);

  // A published app in the code store — the snapshot's git bundle carries it,
  // and a correct recovery must rehydrate the bare repo (issue #517).
  const appId = await publishSeedApp(plane);

  // Machine A's vault BELIEVES originals[0] + originals[1] are durable on the
  // remote cas tier (marked 'cas' in blob_replica) — the belief the snapshot
  // carries and the R5 adopt-time reconcile checks against live inventory.
  const replica = new ReplicaIndex(plane.db.vault);
  replica.mark(originals[0]!, 400, 'cas');
  replica.mark(originals[1]!, 401, 'cas');

  await service.runBackup(vaultId);
  const status = await service.status();
  const targetId = status[vaultId]!.targetId;
  const oldGeneration = status[vaultId]!.generation;
  const kitDocument = await service.recoveryKitDocument();

  // Replicate originals[0] + originals[1] into the provider's cas store (the
  // durable copy a hosted vault keeps), directly via the cas data plane. The
  // remote CAS holding them is exactly what makes recovery DEFER them; the rest
  // (originals[2] + the thumbs) stay snapshot-only and must materialize.
  const casProvider = openRemoteBackupProvider({ baseUrl: server.url, apiKey: server.apiKey });
  const casStore = await casProvider.openDataPlane(targetId, 'cas', 'read-write');
  for (const sha of [originals[0]!, originals[1]!]) {
    await casStore.put(`blobs/sha256/${sha}`, new Uint8Array(Buffer.from(`remote-${sha}`)));
  }

  return {
    vaultId,
    targetId,
    oldGeneration,
    kitDocument,
    originals,
    thumbs,
    itemId,
    grantId,
    appId,
    serverUrl: server.url,
    apiKey: server.apiKey,
  };
}

test('a blank machine recovers a whole vault from nothing but the kit and the api-key', async () => {
  const server = await startFakeProviderServer();
  cleanups.push(() => server.close());
  const a = await seedMachineA(server);
  expect(a.oldGeneration).toBe(1);

  // --- The blank machine: a fresh data dir + the kit + the api-key. ---
  const dataDir = await tempDir('recover-blank');
  const layout = daemonLayoutFor(dataDir);
  const report = await recover({
    kitDocument: a.kitDocument,
    apiKey: a.apiKey,
    vaultRoot: layout.vaultDir,
    backupDir: layout.backupDir!,
    log: silentLogger,
  });

  // 1. The vault dir exists with both databases, rows intact.
  const vaultDir = path.join(layout.vaultDir, a.vaultId);
  expect(report.vaultDir).toBe(vaultDir);
  expect(existsSync(path.join(vaultDir, 'vault.db'))).toBe(true);
  expect(existsSync(path.join(vaultDir, 'journal.db'))).toBe(true);
  const restoredDb = new DatabaseSync(path.join(vaultDir, 'vault.db'), { readOnly: true });
  try {
    expect(
      (restoredDb.prepare('SELECT COUNT(*) AS n FROM schedule_task').get() as { n: number }).n,
    ).toBe(3);
  } finally {
    restoredDb.close();
  }

  // 2. Remote-held blobs deferred; local-only + thumbs materialized.
  expect(report.inventoryConsulted).toBe(true);
  expect(report.skippedBlobs).toBe(2);
  const restoredBlobs = new FsBlobStore(path.join(vaultDir, 'blobs'));
  expect(restoredBlobs.hasSync(a.originals[0]!)).toBe(false); // remote holds it ⇒ deferred
  expect(restoredBlobs.hasSync(a.originals[1]!)).toBe(false);
  expect(restoredBlobs.hasSync(a.originals[2]!)).toBe(true); // snapshot-only ⇒ materialized
  for (const thumb of a.thumbs) expect(restoredBlobs.hasSync(thumb)).toBe(true);

  // The seal key was placed where custody expects it (`<root>/keys/<id>.sealkey`)
  // — the recovered vault has sealed secrets, so a wrong placement would brick
  // the mount below.
  expect(existsSync(path.join(layout.vaultDir, 'keys', `${a.vaultId}.sealkey`))).toBe(true);

  // The app code store was rehydrated from the bundle (issue #517): the bare
  // repo exists at `<vaultDir>/code/apps.git`, the consumed `apps.bundle` is
  // gone, the published app's version tag survived, and a fresh WorktreeStore
  // (the real runtime seam) mounts it and lists the app — a restore that left
  // an empty code store would return no apps here.
  const bareDir = path.join(vaultDir, 'code', 'apps.git');
  expect(existsSync(path.join(bareDir, 'HEAD'))).toBe(true);
  expect(existsSync(path.join(vaultDir, 'apps.bundle'))).toBe(false);
  const tags = await run(['tag', '--list'], { cwd: bareDir });
  expect(tags.split('\n')).toContain(`${a.appId}/v1`);
  const recoveredStore = new WorktreeStore({ root: path.join(vaultDir, 'code') });
  await recoveredStore.init();
  expect(await recoveredStore.listApps()).toEqual([a.appId]);

  // 3. Quarantine marker present pre-mount; mounting fires it (item parked,
  //    grant revoked). Mounting a sealed vault also proves the seal key opens.
  expect(existsSync(path.join(vaultDir, 'RESTORE_QUARANTINE.json'))).toBe(true);
  expect(report.quarantine).toContain('outbox');
  const mounted = openVaultRegistry({
    rootDir: layout.vaultDir,
    logger: silentLogger,
    enableWalShipper: false,
  });
  cleanups.push(() => mounted.stop());
  const mountedPlane = mounted.get(a.vaultId)!;
  expect(mountedPlane.quarantine).not.toBeNull();
  expect(mountedPlane.quarantine!.outboxParked).toBeGreaterThanOrEqual(1);
  expect(mountedPlane.quarantine!.outboxGrantsRevoked).toBeGreaterThanOrEqual(1);
  const item = mountedPlane.db.vault
    .prepare('SELECT status FROM outbox_item WHERE item_id = ?')
    .get(a.itemId) as { status: string };
  expect(item.status).toBe('pending'); // approved → parked back to pending
  const grant = mountedPlane.db.vault
    .prepare('SELECT revoked_at FROM outbox_grant WHERE grant_id = ?')
    .get(a.grantId) as { revoked_at: string | null };
  expect(grant.revoked_at).not.toBeNull();

  // 4. Fencing: the seeded state is generation old+1, lastSeq from the restore.
  const state = JSON.parse(
    await fs.readFile(path.join(layout.backupDir!, 'state.json'), 'utf8'),
  ) as {
    targets: Record<string, { generation: number; lastSeq: number }>;
  };
  expect(state.targets[a.vaultId]!.generation).toBe(a.oldGeneration + 1);
  expect(state.targets[a.vaultId]!.lastSeq).toBe(report.seq);
  expect(report.generation).toBe(a.oldGeneration + 1);
  // The recovered gateway also inherited the keyring.
  expect(existsSync(path.join(layout.backupDir!, 'keyring.json'))).toBe(true);

  // Arm the fence: the recovered machine's FIRST post-recovery backup registers
  // at the seeded generation, bumping the provider — and only THEN does the
  // superseded machine's next registration (still at its old generation) 409.
  const providerClient = openRemoteBackupProvider({ baseUrl: a.serverUrl, apiKey: a.apiKey });
  await providerClient.registerSnapshot(a.targetId, {
    idempotencyKey: 'recovered-first',
    manifestKey: `u/${a.targetId}/backup/manifests/recovered.json`,
    manifestHash: 'a'.repeat(64),
    totalBytes: 0,
    objectCount: 0,
    generation: report.generation,
    format: SNAPSHOT_FORMAT_V2,
    appMeta: {},
  });
  let fenced = false;
  try {
    await providerClient.registerSnapshot(a.targetId, {
      idempotencyKey: 'old-machine-next',
      manifestKey: `u/${a.targetId}/backup/manifests/old.json`,
      manifestHash: 'b'.repeat(64),
      totalBytes: 0,
      objectCount: 0,
      generation: a.oldGeneration,
      format: SNAPSHOT_FORMAT_V2,
      appMeta: {},
    });
  } catch (err) {
    fenced = err instanceof BackupProviderError && err.code === 'conflict_generation';
  }
  expect(fenced).toBe(true);

  // 5. Adopt-time reconcile (R5): the provider still holds everything the
  //    restored index believed durable, so nothing is missing, re-pinned, or lost.
  expect(report.reconcile).toMatchObject({ checked: 2, missing: 0, repinned: [], lost: [] });
  expect(report.reconcile.skipped).toBeUndefined();

  // 6. The completion report is honest.
  expect(typeof report.recoveredAsOf).toBe('number');
  expect(report.recoveredAsOf).toBeGreaterThan(0);
  expect(report.truncated).toBe(false);
  // No remote-tier resolver in this headless context ⇒ previews stream on
  // demand, reported honestly (never faked).
  expect(report.previews.warmed).toBe(false);
  if (!report.previews.warmed) expect(report.previews.reason.length).toBeGreaterThan(0);
}, 45_000);

test('recovery refuses a snapshot written by newer software BEFORE any byte is fetched', async () => {
  const server = await startFakeProviderServer();
  cleanups.push(() => server.close());
  const a = await seedMachineA(server);

  // A snapshot registered under a vaultUserVersion far newer than this build
  // can read becomes the newest row — recovery must refuse it from the registry
  // row's appMeta alone, before opening a manifest or a chunk.
  const providerClient = openRemoteBackupProvider({ baseUrl: a.serverUrl, apiKey: a.apiKey });
  await providerClient.registerSnapshot(a.targetId, {
    idempotencyKey: 'from-the-future',
    manifestKey: `u/${a.targetId}/backup/manifests/future.json`,
    manifestHash: 'c'.repeat(64),
    totalBytes: 0,
    objectCount: 0,
    generation: a.oldGeneration,
    format: SNAPSHOT_FORMAT_V2,
    appMeta: { vaultUserVersion: '9999', ontologyVersion: '1.0' },
  });

  const dataDir = await tempDir('recover-incompat');
  const layout = daemonLayoutFor(dataDir);
  await expect(
    recover({
      kitDocument: a.kitDocument,
      apiKey: a.apiKey,
      vaultRoot: layout.vaultDir,
      backupDir: layout.backupDir!,
      log: silentLogger,
    }),
  ).rejects.toThrow(/vaultUserVersion 9999 is newer/);

  // Nothing was fetched or written: no vault dir, no staging scratch, no keyring.
  expect(existsSync(path.join(layout.vaultDir, a.vaultId))).toBe(false);
  const rootEntries = existsSync(layout.vaultDir) ? await fs.readdir(layout.vaultDir) : [];
  expect(rootEntries.filter((e) => e.startsWith('.recover-staging-'))).toHaveLength(0);
  expect(existsSync(path.join(layout.backupDir!, 'keyring.json'))).toBe(false);
}, 45_000);

test('adopt-time reconcile re-pins a replicated blob the provider dropped, and unmarks it', async () => {
  const server = await startFakeProviderServer();
  cleanups.push(() => server.close());
  const a = await seedMachineA(server);

  // The provider LOSES originals[0] after the backup — the exact drift R5 exists
  // for: the restored index still believes it durable, but the live inventory no
  // longer holds it. originals[1] stays put.
  const casProvider = openRemoteBackupProvider({ baseUrl: a.serverUrl, apiKey: a.apiKey });
  const casStore = await casProvider.openDataPlane(a.targetId, 'cas', 'read-write');
  await casStore.delete(`blobs/sha256/${a.originals[0]}`);

  const dataDir = await tempDir('recover-reconcile');
  const layout = daemonLayoutFor(dataDir);
  const report = await recover({
    kitDocument: a.kitDocument,
    apiKey: a.apiKey,
    vaultRoot: layout.vaultDir,
    backupDir: layout.backupDir!,
    log: silentLogger,
  });

  // The report flags exactly the dropped blob, re-pinned from the snapshot; none lost.
  expect(report.reconcile.checked).toBe(2);
  expect(report.reconcile.missing).toBe(1);
  expect(report.reconcile.repinned).toEqual([a.originals[0]]);
  expect(report.reconcile.lost).toEqual([]);

  // The re-pin materialized what the snapshot carried: originals[0] is local
  // again (the lazy restore did not defer it, because the inventory no longer
  // named it), while originals[1] — still remote — stays deferred.
  const vaultDir = path.join(layout.vaultDir, a.vaultId);
  const restoredBlobs = new FsBlobStore(path.join(vaultDir, 'blobs'));
  expect(restoredBlobs.hasSync(a.originals[0]!)).toBe(true);
  expect(restoredBlobs.hasSync(a.originals[1]!)).toBe(false);
  expect(report.skippedBlobs).toBe(1); // only originals[1] deferred now

  // The restored index no longer believes the dropped blob is durable (so
  // custody can never evict a phantom copy); the surviving one is untouched.
  const restoredDb = new DatabaseSync(path.join(vaultDir, 'vault.db'), { readOnly: true });
  try {
    const index = new ReplicaIndex(restoredDb);
    expect(index.has(a.originals[0]!)).toBe(false);
    expect(index.has(a.originals[1]!)).toBe(true);
  } finally {
    restoredDb.close();
  }
}, 45_000);
