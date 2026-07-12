// governance: allow-repo-hygiene file-size-limit (#363) the full-story end-to-end test built exactly the way build-gateway.ts constructs BackupService (no injected provider/assembleEntries); splitting the story would break the point of an end-to-end test
/*
 * The full-story end-to-end test for the offsite backup feature
 * (PROTOCOL.md/FORMAT.md): NO injected provider, NO injected
 * `assembleEntries` — `BackupService` is constructed exactly the way
 * `build-gateway.ts` does (config + backupDir + vaults + health + logger
 * only), against a REAL seeded vault, a REAL `LocalBackupProvider` on a
 * temp dir, restored through the REAL CLI (`commandBackup`), and adopted
 * as a live vault the way an operator recovering onto a new machine would.
 *
 * One shared seeded vault carries most of the suite (beforeAll) to keep
 * runtime sane; tests that mutate provider state in ways that would affect
 * siblings (corruption, generation fencing) are deliberately ordered last.
 */

import { afterAll, beforeAll, expect, test } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import crypto, { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  loadKeyring,
  openLocalBackupProvider,
  openManifest,
  verifySnapshot,
  type BackupProvider,
} from '@centraid/backup';
import { sealAad, unsealValue } from '@centraid/vault';
import { openVaultRegistry, type VaultRegistry } from '../serve/vault-registry.js';
import type { VaultPlane } from '../serve/vault-plane.js';
import { HealthRegistry } from '../serve/health-registry.js';
import { BackupService } from './backup-service.js';
import type { BackupConfig } from './backup-config.js';
import { WorktreeStore } from '../worktree-store/worktree-store.js';
import { run } from '../worktree-store/git.js';
import { commandBackup } from '../cli/backup-admin.js';
import { daemonLayoutFor } from '../cli/paths.js';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-${crypto.randomUUID()}-`));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function countFiles(dir: string): Promise<number> {
  let n = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) n += await countFiles(full);
    else n += 1;
  }
  return n;
}

/** Real command invocation, throwing loudly on refusal — mirrors every other real-vault test in this suite. */
function invoke(
  plane: VaultPlane,
  command: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out = plane.gateway.invoke(plane.ownerCredential, { command, input });
  if (out.status !== 'executed') throw new Error(`${command} failed: ${JSON.stringify(out)}`);
  return (out as { output: Record<string, unknown> }).output;
}

/** Stage bytes through the real blob pipeline, then claim them onto a subject via core.attach. */
function stageAndAttach(plane: VaultPlane, subjectId: string, bytes: Buffer): string {
  const staged = plane.gateway.stageBlob(plane.ownerCredential, {
    bytes,
    mediaType: 'application/octet-stream',
    filename: 'payload.bin',
  });
  invoke(plane, 'core.attach', {
    subject_type: 'schedule.task',
    subject_id: subjectId,
    staged_sha: staged.sha256,
  });
  return staged.sha256;
}

/** Stage + approve one outbox item (mirrors vault-quarantine.test.ts's helper) — quarantine needs something real to park. */
function seedApprovedOutboxItem(plane: VaultPlane): { itemId: string; grantId: string } {
  invoke(plane, 'sync.configure_credential', {
    kind: 'pull.gmail',
    label: 'personal',
    cred_kind: 'api_key',
    api_key: 'sk-e2e-test',
    allowed_hosts: ['gmail.googleapis.com'],
  });
  const staged = invoke(plane, 'outbox.stage', {
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
  });
  const itemId = staged['item_id'] as string;
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

/** One real commit in the plane's own code store via a real WorktreeStore publish. */
async function publishRealApp(plane: VaultPlane, appId: string): Promise<void> {
  const store = new WorktreeStore({ root: plane.codeStoreRoot });
  await store.init();
  const session = await store.openSession('s1');
  const appDir = path.join(session.worktreePath, 'apps', appId);
  await fs.mkdir(path.join(appDir, 'actions'), { recursive: true });
  await fs.writeFile(
    path.join(appDir, 'app.json'),
    JSON.stringify({ id: appId, name: appId }, null, 2),
  );
  await fs.writeFile(
    path.join(appDir, 'actions', 'noop.js'),
    'export default async () => ({ status: 200, body: {} });\n',
  );
  await store.publish({ sessionId: 's1', appId, message: 'v1' });
  await store.closeSession('s1');
}

async function capture(fn: () => Promise<void> | void): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

function jsonLines(out: string): unknown[] {
  return out
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as unknown);
}

interface Seeded {
  taskTitles: string[];
  smallBlobSha: string;
  smallBlobBytes: Buffer;
  bigBlobSha: string;
  bigBlobBytes: Buffer;
  lockerItemId: string;
  lockerPlaintext: string;
  outboxItemId: string;
}

interface Harness {
  dataDir: string;
  configPath: string;
  providerDir: string;
  backupDir: string;
  config: BackupConfig;
  vaultDir: string;
  vaultId: string;
  registry: VaultRegistry;
  plane: VaultPlane;
  service: BackupService;
  health: HealthRegistry;
  seeded: Seeded;
  /** Set once the CLI-restore test has run — reused by the non-empty-dest refusal test. */
  restoredDestDir?: string;
}

let h: Harness;

function reopen(): void {
  h.registry = openVaultRegistry({ rootDir: h.vaultDir, logger: silentLogger, ownerName: 'Priya' });
  const vaultId = h.vaultId || h.registry.defaultVaultId();
  h.plane = h.registry.get(vaultId)!;
  h.vaultId = vaultId;
  h.health = new HealthRegistry();
  h.service = new BackupService({
    config: h.config,
    backupDir: h.backupDir,
    vaults: h.registry,
    health: h.health,
    logger: silentLogger,
  });
}

beforeAll(async () => {
  const dataDir = await tempDir('e2e-data');
  const providerDir = await tempDir('e2e-provider');
  const layout = daemonLayoutFor(dataDir);
  const config: BackupConfig = {
    enabled: true,
    intervalHours: 1,
    verifyEveryDays: 1,
    provider: { kind: 'local', dir: providerDir },
  };
  const configPath = path.join(dataDir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ dataDir, backup: config }));

  h = {
    dataDir,
    configPath,
    providerDir,
    backupDir: layout.backupDir ?? path.join(dataDir, 'backup'),
    config,
    vaultDir: layout.vaultDir,
    vaultId: '',
    registry: undefined as unknown as VaultRegistry,
    plane: undefined as unknown as VaultPlane,
    service: undefined as unknown as BackupService,
    health: undefined as unknown as HealthRegistry,
    seeded: undefined as unknown as Seeded,
  };
  reopen();
  cleanups.push(() => h.registry.stop());

  // 1. Seed a REAL vault: several data rows, real blobs (one > 1MiB, so it
  // spans multiple FastCDC chunks), a real published app (code-store
  // commit), a real sealed value, and one approved outbox item so the
  // eventual quarantine has something real to park.
  const taskTitles = ['Frame the print', 'Pay the invoice', 'Call the vet'];
  const taskIds = taskTitles.map(
    (title) => invoke(h.plane, 'schedule.add_task', { title })['task_id'] as string,
  );

  const PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const smallOut = invoke(h.plane, 'core.attach', {
    subject_type: 'schedule.task',
    subject_id: taskIds[0],
    data_uri: PNG,
  });
  const smallContentId = smallOut['content_id'] as string;
  const smallBlobSha = (
    h.plane.db.vault
      .prepare('SELECT content_uri FROM core_content_item WHERE content_id = ?')
      .get(smallContentId) as { content_uri: string }
  ).content_uri.slice('blob:sha256-'.length);
  const smallBlobBytes = Buffer.from(PNG.slice(PNG.indexOf(',') + 1), 'base64');

  const bigBlobBytes = randomBytes(1_600_000); // > 1MiB — multiple FastCDC chunks
  const bigBlobSha = stageAndAttach(h.plane, taskIds[1]!, bigBlobBytes);

  await publishRealApp(h.plane, 'todo');

  const lockerPlaintext = 'H2$kL9mVq!pR4wZ';
  const lockerOut = invoke(h.plane, 'locker.add_item', {
    type: 'login',
    title: 'GitHub',
    username: 'priya',
    password: lockerPlaintext,
  });
  const lockerItemId = lockerOut['item_id'] as string;

  const { itemId: outboxItemId } = seedApprovedOutboxItem(h.plane);

  h.seeded = {
    taskTitles,
    smallBlobSha,
    smallBlobBytes,
    bigBlobSha,
    bigBlobBytes,
    lockerItemId,
    lockerPlaintext,
    outboxItemId,
  };

  // 2. First real backup — REAL assembleSourceEntries → REAL LocalBackupProvider.
  await h.service.runBackup(h.vaultId);
  const first = (await h.service.status())[h.vaultId];
  expect(first?.lastSeq).toBe(1);
}, 30_000);

test('no-change semantics: a real vault re-registers a NEW snapshot every run (documented, not papered over)', async () => {
  const before = (await h.service.status())[h.vaultId];
  await h.service.runBackup(h.vaultId);
  const after = (await h.service.status())[h.vaultId];

  // OBSERVED CONTRACT (verified by reading engine.ts, not just guessed):
  // `stageVaultDbs` VACUUM INTOs a FRESH vault.db/journal.db file on every
  // tick, and `bundleCodeStore` regenerates apps.bundle fresh every tick
  // too. createSnapshot's "reuse without re-chunking" fast path is keyed on
  // (size, mtimeMs) matching the PREVIOUS manifest's recorded stat for that
  // entry — a freshly-written file's mtime is "now", which never equals a
  // prior run's recorded mtime. So for any vault with a db or git-bundle
  // entry (every real vault has at least the db entries), at least one
  // entry ALWAYS takes the slow re-chunk path, which flips
  // `everyEntryReused` to false regardless of whether the actual bytes are
  // identical — and `chunkIndexIdentical` (the no-op gate) requires
  // `everyEntryReused`. Net effect: "no visible change → no new manifest"
  // never fires for a real, on-disk vault; it only works for hand-built
  // fixtures with a file that is never re-touched between runs. The
  // dedup/reuse win from unchanged bytes still happens at the CHUNK level
  // (no re-upload — see the "incremental" test below), just not at the
  // whole-snapshot-registration level.
  expect(after?.lastSeq).toBe((before?.lastSeq ?? 0) + 1);
});

test('incremental backup: a new blob registers a small delta, not a re-upload of everything', async () => {
  const objectsDir = path.join(h.providerDir, 'objects');
  const targetId = (await h.service.status())[h.vaultId]!.targetId;
  // Per-store isolated prefix (PROTOCOL.md § Layer 1): LocalBackupProvider
  // nests each store class under its own subdirectory.
  const chunksDir = path.join(objectsDir, targetId, 'backup', 'chunks');
  const before = await countFiles(chunksDir);

  const taskId = invoke(h.plane, 'schedule.add_task', { title: 'Renew passport' })[
    'task_id'
  ] as string;
  const newBlobBytes = randomBytes(700_000); // ~1-2 chunks worth
  stageAndAttach(h.plane, taskId, newBlobBytes);

  const beforeStatus = (await h.service.status())[h.vaultId];
  await h.service.runBackup(h.vaultId);
  const afterStatus = (await h.service.status())[h.vaultId];
  expect(afterStatus?.lastSeq).toBe((beforeStatus?.lastSeq ?? 0) + 1);

  const after = await countFiles(chunksDir);
  const delta = after - before;
  // A full re-upload would repeat every chunk from every unchanged entry
  // (db copies, the existing blobs, the bundle) — dozens of objects at
  // least. The new blob is < 2MiB, so its delta is at most a handful of
  // chunks (max chunk size 4MiB, min 512KiB — so 700KB is 1-2 chunks).
  expect(delta).toBeGreaterThan(0);
  expect(delta).toBeLessThanOrEqual(4);
});

test('CLI restore materializes a fresh dest, and adopting it as a live vault mounts, returns real data, and fires quarantine', async () => {
  // Stop the shared registry before the CLI opens its own on the same
  // vaultDir (mirrors backup-admin.test.ts's pattern — avoid two live
  // connections to the same vault.db at once).
  h.registry.stop();

  const destDir = path.join(h.dataDir, 'restored');
  const out = await capture(() =>
    commandBackup(
      ['restore', '--config', h.configPath, '--vault', h.vaultId, '--dest', destDir],
      (msg) => {
        throw new Error(msg);
      },
    ),
  );
  const [result] = jsonLines(out) as [{ seq: number; entries: string[] }];
  expect(result.entries).toContain('vault.db');
  expect(result.entries).toContain('journal.db');
  expect(result.entries).toContain('apps.bundle');
  expect(result.entries).toContain('seal.key');
  expect(existsSync(path.join(destDir, 'RESTORE_QUARANTINE.json'))).toBe(true);
  h.restoredDestDir = destDir;

  // Adopt the restored directory as a live vault — mirroring recovery onto
  // a fresh machine: a fresh registry root, the vault files placed under
  // <root>/<vaultId>/, the seal key placed at <root>/keys/<vaultId>.sealkey
  // per sealKeyFileFor's layout rule, and the code store rebuilt from the
  // restored git bundle.
  const freshRoot = await tempDir('e2e-adopted-root');
  const adoptedDir = path.join(freshRoot, h.vaultId);
  await fs.mkdir(adoptedDir, { recursive: true });
  await fs.copyFile(path.join(destDir, 'vault.db'), path.join(adoptedDir, 'vault.db'));
  await fs.copyFile(path.join(destDir, 'journal.db'), path.join(adoptedDir, 'journal.db'));
  await fs.cp(path.join(destDir, 'blobs'), path.join(adoptedDir, 'blobs'), { recursive: true });
  await fs.copyFile(
    path.join(destDir, 'RESTORE_QUARANTINE.json'),
    path.join(adoptedDir, 'RESTORE_QUARANTINE.json'),
  );
  await fs.mkdir(path.join(freshRoot, 'keys'), { recursive: true });
  await fs.copyFile(
    path.join(destDir, 'seal.key'),
    path.join(freshRoot, 'keys', `${h.vaultId}.sealkey`),
  );
  await fs.mkdir(path.join(adoptedDir, 'code'), { recursive: true });
  await run(
    [
      'clone',
      '--quiet',
      '--bare',
      path.join(destDir, 'apps.bundle'),
      path.join(adoptedDir, 'code', 'apps.git'),
    ],
    {
      cwd: freshRoot,
    },
  );

  const adoptedRegistry = openVaultRegistry({
    rootDir: freshRoot,
    logger: silentLogger,
    ownerName: 'Priya',
  });
  try {
    // The plane MOUNTS — catches "restored DB is garbage" and "seal key
    // custody mismatch" both at once (openVaultDb's resolveSealKey refuses
    // to open on a fingerprint mismatch).
    const adopted = adoptedRegistry.get(h.vaultId);
    expect(adopted).toBeTruthy();
    const plane = adopted!;

    // Quarantine fired on this mount, and the pre-staged approved outbox
    // item got parked for real.
    expect(plane.quarantine).not.toBeNull();
    expect(plane.quarantine?.outboxParked).toBeGreaterThanOrEqual(1);
    const outboxRow = plane.db.vault
      .prepare('SELECT status, grant_id FROM outbox_item WHERE item_id = ?')
      .get(h.seeded.outboxItemId) as { status: string; grant_id: string | null };
    expect(outboxRow.status).toBe('pending');
    expect(outboxRow.grant_id).toBeNull();

    // Original data rows come back via a real owner-credentialed query.
    const rows = plane.sqlAsOwner('SELECT title FROM schedule_task ORDER BY title').rows as Array<{
      title: string;
    }>;
    const titles = rows.map((r) => r.title);
    for (const t of h.seeded.taskTitles) expect(titles).toContain(t);

    // Byte-identical blob content via the real blob read path.
    const smallRead = await plane.db.blobs.open(h.seeded.smallBlobSha);
    expect(smallRead).not.toBeNull();
    expect(smallRead!.equals(h.seeded.smallBlobBytes)).toBe(true);
    const bigRead = await plane.db.blobs.open(h.seeded.bigBlobSha);
    expect(bigRead).not.toBeNull();
    expect(bigRead!.equals(h.seeded.bigBlobBytes)).toBe(true);

    // The sealed value decrypts — the seal-key round trip.
    const lockerRow = plane.db.vault
      .prepare('SELECT password FROM locker_item WHERE item_id = ?')
      .get(h.seeded.lockerItemId) as { password: string };
    const decrypted = unsealValue(
      plane.db.sealKey,
      sealAad('locker_item', 'password', h.seeded.lockerItemId),
      lockerRow.password,
    );
    expect(decrypted).toBe(h.seeded.lockerPlaintext);
  } finally {
    adoptedRegistry.stop();
  }

  // The git bundle restores independently, too — clone + verify.
  const bareRepo = path.join(adoptedDir, 'code', 'apps.git');
  await expect(
    run(['bundle', 'verify', path.join(destDir, 'apps.bundle')], { cwd: bareRepo }),
  ).resolves.toBeTruthy();
  const clone2 = await tempDir('e2e-bundle-clone');
  await run(['clone', '--quiet', bareRepo, clone2], { cwd: freshRoot });
  const appJson = JSON.parse(
    await fs.readFile(path.join(clone2, 'apps', 'todo', 'app.json'), 'utf8'),
  ) as { id: string };
  expect(appJson.id).toBe('todo');

  // Reopen the shared registry for the remaining tests (fencing, verify).
  reopen();
}, 30_000);

test('fencing for real: a second BackupService registers gen+1; the first service fences on its next run', async () => {
  const targetId = (await h.service.status())[h.vaultId]!.targetId;
  const provider: BackupProvider = openLocalBackupProvider({ rootDir: h.providerDir });
  const beforeGen = (await provider.getTarget(targetId)).currentGeneration;

  // Simulate a second gateway's restore-takeover (PROTOCOL.md § Generation
  // fencing): a fresh state dir, seeded with a COPY of the real state +
  // keyring (a takeover reads the SAME keyring off the recovery kit), with
  // its target generation bumped to currentGeneration + 1 — exactly what
  // "read currentGeneration from the target and register the next snapshot
  // with currentGeneration + 1" means in state-file terms.
  const backupDir2 = await tempDir('e2e-backupdir-takeover');
  await fs.copyFile(path.join(h.backupDir, 'keyring.json'), path.join(backupDir2, 'keyring.json'));
  const state = JSON.parse(await fs.readFile(path.join(h.backupDir, 'state.json'), 'utf8')) as {
    targets: Record<string, { generation: number }>;
    sourceInstanceId: string;
  };
  state.targets[h.vaultId]!.generation = beforeGen + 1;
  await fs.writeFile(path.join(backupDir2, 'state.json'), JSON.stringify(state));

  const health2 = new HealthRegistry();
  const serviceB = new BackupService({
    config: h.config,
    backupDir: backupDir2,
    vaults: h.registry,
    health: health2,
    logger: silentLogger,
  });
  await serviceB.runBackup(h.vaultId);
  const afterGen = (await provider.getTarget(targetId)).currentGeneration;
  expect(afterGen).toBe(beforeGen + 1); // the "other machine" won the target

  // The original service's NEXT run (still at the old generation) must
  // fence: health error, no bump, no exception escaping the caller — this
  // is the real product code path that Gap 1's stale-cache bug would have
  // silently defeated (serviceB's own LocalBackupProvider instance is
  // SEPARATE from serviceA's — exactly the cross-process shape the bug
  // affected).
  const before = (await h.service.status())[h.vaultId];
  await h.service.runBackup(h.vaultId); // re-registers because journal.db always changed (see the no-change test) — reaches the provider, which now 409s
  const after = (await h.service.status())[h.vaultId];
  expect(after?.fenced).toBe(true);
  expect(after?.generation).toBe(before?.generation); // never bumped automatically
  expect(after?.lastError).toMatch(/another machine has taken over/);

  const snap = await h.health.snapshot();
  expect(snap.components.find((c) => c.component === 'backups')?.status).toBe('error');
});

test('verify catches real damage: a deleted chunk is reported missing, a flipped chunk is reported corrupt', async () => {
  const targetId = (await h.service.status())[h.vaultId]!.targetId;
  const chunksDir = path.join(h.providerDir, 'objects', targetId, 'backup', 'chunks');

  // Object GC never runs (PROTOCOL.md: "no server-side content GC"), so the
  // provider dir accumulates chunk files from EVERY prior snapshot in this
  // suite, including ones the LATEST manifest no longer references — a
  // random file from `readdir` could easily be one of those orphans, which
  // `verifySnapshot` (scoped to the newest manifest) would never check.
  // Resolve the two victim chunks from the newest manifest's own public
  // chunkIndex instead, so they are guaranteed to be in scope.
  const provider = openLocalBackupProvider({ rootDir: h.providerDir });
  const keyring = await loadKeyring(path.join(h.backupDir, 'keyring.json'));
  const newestRow = (await provider.listSnapshots(targetId))[0]!;
  const store = await provider.openDataPlane(targetId, 'backup', 'read');
  const manifestBytes = await store.get(newestRow.manifestKey);
  const opened = openManifest(manifestBytes, keyring, h.vaultId, newestRow.manifestHash);
  expect(opened.public.chunkIndex.length).toBeGreaterThan(1);
  const [victimA, victimB] = opened.public.chunkIndex;

  const toDelete = path.join(chunksDir, victimA!.id);
  await fs.rm(toDelete);
  const toCorrupt = path.join(chunksDir, victimB!.id);
  const original = await fs.readFile(toCorrupt);
  const flipped = Buffer.from(original);
  flipped[0] = (flipped[0]! ^ 0xff) & 0xff;
  await fs.writeFile(toCorrupt, flipped);

  // Call the engine directly with a sampleCount covering every referenced
  // chunk, so the flipped one is deterministically included — the default
  // sample of 8 (what BackupService.runVerify uses) would make this
  // assertion flaky against a larger chunk set.
  const result = await verifySnapshot({
    provider,
    targetId,
    keyring,
    vaultId: h.vaultId,
    sampleCount: opened.public.chunkIndex.length,
  });
  expect(result.missing).toContain(victimA!.id);
  expect(result.corrupt).toContain(victimB!.id);
});

test('restore refusal: a registered snapshot with a newer vaultUserVersion refuses BEFORE downloading anything', async () => {
  // A fully separate, minimal fixture — deliberately independent of the
  // shared harness's (now chunk-corrupted) provider dir.
  const vaultDir = await tempDir('e2e-refusal-vault');
  const providerDir = await tempDir('e2e-refusal-provider');
  const backupDir = await tempDir('e2e-refusal-backup');
  const registry = openVaultRegistry({
    rootDir: vaultDir,
    logger: silentLogger,
    ownerName: 'Alex',
  });
  const vaultId = registry.defaultVaultId();
  const health = new HealthRegistry();
  const config: BackupConfig = {
    enabled: true,
    provider: { kind: 'local', dir: providerDir },
  };
  const service = new BackupService({
    config,
    backupDir,
    vaults: registry,
    health,
    logger: silentLogger,
  });
  try {
    await service.runBackup(vaultId);
    const target = (await service.status())[vaultId]!;
    const provider = openLocalBackupProvider({ rootDir: providerDir });
    const targetInfo = await provider.getTarget(target.targetId);
    const realRow = (await provider.listSnapshots(target.targetId))[0]!;

    // Register a doctored snapshot THROUGH THE REAL PROVIDER API — a
    // manifestKey that does not exist on the data plane, so if
    // restoreSnapshot ever tried to download it, we'd see an ENOENT/read
    // error instead of the compatibility-gate message, proving the gate
    // really does run first.
    await provider.registerSnapshot(target.targetId, {
      idempotencyKey: 'doctored-newer-version',
      manifestKey: 'manifests/does-not-exist-on-disk.json',
      manifestHash: 'f'.repeat(64),
      totalBytes: 1,
      objectCount: 1,
      generation: targetInfo.currentGeneration,
      format: 'centraid-snapshot/1',
      appMeta: { ...realRow.appMeta, vaultUserVersion: '99999' },
    });
    const destDir = path.join(await tempDir('e2e-refusal-dest-parent'), 'refusal-dest');
    await expect(service.restore({ vaultId, destDir })).rejects.toThrow(/vaultUserVersion.*newer/);
    // Never attempted to materialize anything — the compat gate ran before
    // any directory creation or data-plane read.
    expect(existsSync(destDir)).toBe(false);
  } finally {
    registry.stop();
  }
});

test('restore refusal: the CLI refuses a non-empty --dest', async () => {
  h.registry.stop();
  const restoredDestDir = h.restoredDestDir;
  expect(restoredDestDir).toBeTruthy();
  await expect(
    capture(() =>
      commandBackup(
        ['restore', '--config', h.configPath, '--vault', h.vaultId, '--dest', restoredDestDir!],
        (msg) => {
          throw new Error(msg);
        },
      ),
    ),
  ).rejects.toThrow(/not empty/);
  reopen();
});
