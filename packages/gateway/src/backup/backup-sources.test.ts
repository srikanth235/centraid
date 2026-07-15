// `assembleSourceEntries` (backup-sources.ts) against a REAL `VaultPlane`:
// real blobs through the real staging/attach pipeline, a real bare git repo
// through a real `WorktreeStore` publish, and a real sealed value through
// `locker.add_item`. No hand-written files under blobs/sha256/ or apps.git —
// everything here goes through the same product surface a real backup tick
// would see. FORMAT.md's ordering rule (db, db, blobs…, git-bundle,
// seal-key) is asserted directly off the returned array.

import { afterEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import crypto, { randomBytes, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { sealAad, unsealValue } from '@centraid/vault';
import { openVaultPlane, type VaultPlane } from '../serve/vault-plane.js';
import { WorktreeStore } from '../worktree-store/worktree-store.js';
import { run } from '../worktree-store/git.js';
import { assembleSourceEntries, resetStagingDir } from './backup-sources.js';

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

async function openPlane(): Promise<VaultPlane> {
  const dir = await tempDir('backup-sources-vault');
  const plane = openVaultPlane({ dir, logger: silentLogger, ownerName: 'Priya' });
  cleanups.push(() => plane.stop());
  return plane;
}

/** A capturing logger for the "empty code store" skip-log assertion. */
function capturingLogger(): {
  info: string[];
  warn: string[];
  log: { info: (m: string) => void; warn: (m: string) => void };
} {
  const info: string[] = [];
  const warn: string[] = [];
  return {
    info,
    warn,
    log: {
      info: (m: string) => void info.push(m),
      warn: (m: string) => void warn.push(m),
    },
  };
}

// A 1x1 transparent PNG — well under the 360KB inline data_uri cap.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** Real bytes through the real staging pipeline (issue #296 door), then claimed by core.attach. */
function stageAndAttachBigBlob(plane: VaultPlane, subjectId: string, bytes: Buffer): string {
  const staged = plane.gateway.stageBlob(plane.ownerCredential, {
    bytes,
    mediaType: 'application/octet-stream',
    filename: 'big.bin',
  });
  const out = plane.gateway.invoke(plane.ownerCredential, {
    command: 'core.attach',
    input: { subject_type: 'schedule.task', subject_id: subjectId, staged_sha: staged.sha256 },
  });
  if (out.status !== 'executed') throw new Error(`attach failed: ${JSON.stringify(out)}`);
  return staged.sha256;
}

function addTask(plane: VaultPlane, title: string): string {
  const out = plane.gateway.invoke(plane.ownerCredential, {
    command: 'schedule.add_task',
    input: { title },
  });
  if (out.status !== 'executed') throw new Error(`add_task failed: ${JSON.stringify(out)}`);
  return (out as { output: { task_id: string } }).output.task_id;
}

/** Publish one real commit through a real WorktreeStore against the plane's own code store root. */
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

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

test('a fresh vault (no blobs, no code store, nothing sealed) yields only the two staged DB entries', async () => {
  const plane = await openPlane();
  const stagingDir = await tempDir('backup-sources-staging');
  const captured = capturingLogger();

  // The capture tick lives in doRunBackup now — run it here as the service would.
  plane.walTick();
  const entries = await assembleSourceEntries({ plane, stagingDir, log: captured.log });

  expect(entries.map((e) => e.kind)).toEqual(['db', 'db']);
  expect(entries.map((e) => e.path)).toEqual(['vault.db', 'journal.db']);
  // No sealed value was ever written — even though openVaultDb eagerly
  // mints the key FILE on first open, the fingerprint stamp (the real
  // "has this vault ever sealed a value" signal) is absent, so no
  // seal-key entry — see the sealKeyEntry doc comment in backup-sources.ts.
  expect(entries.some((e) => e.kind === 'seal-key')).toBe(false);
  // The empty-code-store skip is logged, not silent.
  expect(captured.info.some((m) => m.includes('no code store bare repo yet'))).toBe(true);

  // The staged DB copies are real, openable SQLite files — not stubs.
  for (const entry of entries) {
    const db = new DatabaseSync(entry.absolutePath, { readOnly: true });
    try {
      const row = db.prepare('SELECT count(*) AS n FROM sqlite_master').get() as { n: number };
      expect(row.n).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  }
  // vault.db is specifically a staged copy of the real vault, not an empty
  // shell — the bootstrapped core_vault row must be there.
  const vaultCopy = new DatabaseSync(entries[0]!.absolutePath, { readOnly: true });
  try {
    const row = vaultCopy.prepare('SELECT count(*) AS n FROM core_vault').get() as { n: number };
    expect(row.n).toBe(1);
  } finally {
    vaultCopy.close();
  }
});

test(
  'a vault with real blobs, a real published app, and a real sealed value ' +
    'yields entries in FORMAT.md order: db, db, blobs…, git-bundle, seal-key',
  async () => {
    const plane = await openPlane();
    const stagingDir = await tempDir('backup-sources-staging');

    // (b) Two real blobs: one through the small inline data_uri door, one
    // through the staged-bytes door (large enough to exercise file custody).
    const taskId = addTask(plane, 'Frame the print');
    const inlineOut = plane.gateway.invoke(plane.ownerCredential, {
      command: 'core.attach',
      input: { subject_type: 'schedule.task', subject_id: taskId, data_uri: PNG },
    });
    if (inlineOut.status !== 'executed') throw new Error('inline attach failed');
    const inlineContentId = (inlineOut as { output: { content_id: string } }).output.content_id;
    const inlineSha = (
      plane.db.vault
        .prepare('SELECT content_uri FROM core_content_item WHERE content_id = ?')
        .get(inlineContentId) as { content_uri: string }
    ).content_uri.slice('blob:sha256-'.length);

    const bigBytes = randomBytes(1_500_000);
    const bigSha = stageAndAttachBigBlob(plane, taskId, bigBytes);
    expect(bigSha).toBe(sha256Of(bigBytes));

    // (c) A real code-store commit via WorktreeStore, mirroring exactly what
    // publishing an app through the gateway produces on disk.
    await publishRealApp(plane, 'todo');

    // (d) A real sealed value — password is a SEALED_COLUMNS entry.
    const lockerOut = plane.gateway.invoke(plane.ownerCredential, {
      command: 'locker.add_item',
      input: { type: 'login', title: 'GitHub', username: 'priya', password: 'H2$kL9mVq!pR4wZ' },
    });
    if (lockerOut.status !== 'executed') throw new Error('locker.add_item failed');

    plane.walTick();
    const entries = await assembleSourceEntries({ plane, stagingDir, log: silentLogger });

    expect(entries.map((e) => e.kind)).toEqual([
      'db',
      'db',
      'blob',
      'blob',
      'git-bundle',
      'seal-key',
    ]);
    // Blob entries are sorted by path (backup-sources.ts: deterministic
    // manifests, not insertion order) — the big blob's random content means
    // its sha, and therefore its sort position relative to the inline
    // blob's sha, is not fixed across runs. Assert the blob PATHS as a set,
    // sorted the same way the source does, rather than a hardcoded order.
    const smallBlobPath = `blobs/sha256/${inlineSha.slice(0, 2)}/${inlineSha}`;
    const bigBlobPath = `blobs/sha256/${bigSha.slice(0, 2)}/${bigSha}`;
    const expectedBlobPaths = [smallBlobPath, bigBlobPath].sort((a, b) => a.localeCompare(b));
    expect(entries.map((e) => e.path)).toEqual([
      'vault.db',
      'journal.db',
      ...expectedBlobPaths,
      'apps.bundle',
      'seal.key',
    ]);

    // Staged DB copies are real, openable SQLite.
    const vaultCopy = new DatabaseSync(entries[0]!.absolutePath, { readOnly: true });
    try {
      const row = vaultCopy.prepare('SELECT count(*) AS n FROM locker_item').get() as {
        n: number;
      };
      expect(row.n).toBe(1);
    } finally {
      vaultCopy.close();
    }

    // Blob entries point at the REAL CAS files — bytes match, sha matches
    // filename (content-addressed).
    const smallBlobEntry = entries.find((e) => e.path === smallBlobPath)!;
    const bigBlobEntry = entries.find((e) => e.path === bigBlobPath)!;
    expect(path.basename(smallBlobEntry.absolutePath)).toBe(inlineSha);
    expect(sha256Of(await fs.readFile(smallBlobEntry.absolutePath))).toBe(inlineSha);
    expect(path.basename(bigBlobEntry.absolutePath)).toBe(bigSha);
    const bigOnDisk = await fs.readFile(bigBlobEntry.absolutePath);
    expect(bigOnDisk.equals(bigBytes)).toBe(true);
    // Blob entries read the CAS IN PLACE — never duplicated into staging.
    expect(smallBlobEntry.absolutePath.startsWith(plane.dir)).toBe(true);
    expect(smallBlobEntry.absolutePath.startsWith(stagingDir)).toBe(false);

    // The git bundle is a real, verifiable bundle — `git bundle verify`
    // needs a repository context (any repo — it only checks the bundle's
    // own prerequisites, none here since it's a full `--all` bundle), so
    // run it against the bare repo itself. Then clone from it and read back
    // the published app.
    const bundleEntry = entries[4]!;
    const bareRepoDir = path.join(plane.codeStoreRoot, 'apps.git');
    await expect(
      run(['bundle', 'verify', bundleEntry.absolutePath], { cwd: bareRepoDir }),
    ).resolves.toBeTruthy();
    const cloneDir = await tempDir('backup-sources-clone');
    await run(['clone', '--quiet', bundleEntry.absolutePath, cloneDir], { cwd: stagingDir });
    const appJson = JSON.parse(
      await fs.readFile(path.join(cloneDir, 'apps', 'todo', 'app.json'), 'utf8'),
    ) as { id: string };
    expect(appJson.id).toBe('todo');

    // The seal-key entry is the vault's real DEK file, and it actually
    // decrypts the sealed password — the "not a placebo" check.
    const sealKeyEntry = entries[5]!;
    expect(sealKeyEntry.absolutePath).toContain('keys');
    const keyBytes = await fs.readFile(sealKeyEntry.absolutePath);
    expect(keyBytes.equals(plane.db.sealKey)).toBe(true);
    const itemId = (
      plane.db.vault.prepare('SELECT item_id FROM locker_item LIMIT 1').get() as {
        item_id: string;
      }
    ).item_id;
    const sealedPassword = (
      plane.db.vault.prepare('SELECT password FROM locker_item WHERE item_id = ?').get(itemId) as {
        password: string;
      }
    ).password;
    expect(unsealValue(keyBytes, sealAad('locker_item', 'password', itemId), sealedPassword)).toBe(
      'H2$kL9mVq!pR4wZ',
    );
  },
);

test('the staging dir is wiped between runs — a stale marker file never survives a second assembly', async () => {
  const plane = await openPlane();
  const stagingDir = await tempDir('backup-sources-staging');

  await resetStagingDir(stagingDir);
  const marker = path.join(stagingDir, 'stale-marker.txt');
  await fs.writeFile(marker, 'left over from a previous, interrupted run');

  await resetStagingDir(stagingDir);
  await expect(fs.access(marker)).rejects.toThrow();

  plane.walTick();
  const entries = await assembleSourceEntries({ plane, stagingDir, log: silentLogger });
  expect(entries.map((e) => e.path)).toEqual(['vault.db', 'journal.db']);
  expect(
    await fs.access(marker).then(
      () => true,
      () => false,
    ),
  ).toBe(false);

  // A second full assembly into the same dir (as a real backup tick's
  // finally-block reset does) leaves exactly the fresh staged files —
  // nothing accumulates across runs, and no stale marker reappears.
  await resetStagingDir(stagingDir);
  const second = await assembleSourceEntries({ plane, stagingDir, log: silentLogger });
  expect(second.map((e) => e.path)).toEqual(['vault.db', 'journal.db']);
  const filesOnDisk = await fs.readdir(stagingDir);
  expect(filesOnDisk).not.toContain('stale-marker.txt');
  // Issue #408: db entries read the WAL shipper's pinned base clones IN
  // PLACE (under <vaultDir>/wal-ship/), never staged copies — staging now
  // holds only what assembly itself produces (the git bundle, when any).
  expect(filesOnDisk).not.toContain('vault.db');
  for (const entry of second) {
    expect(entry.absolutePath).toContain(path.join('wal-ship', 'bases'));
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.walGeneration).toMatch(/^[0-9a-f]{32}$/);
    expect(entry.baseTickMs).toBeGreaterThan(0);
  }
  // Both bases from ONE tick — the coordination the restore asserts.
  expect(second[0]!.baseTickMs).toBe(second[1]!.baseTickMs);
});

test('assembly REFUSES an uncoordinated base pair rather than registering it', async () => {
  const plane = await openPlane();
  const stagingDir = await tempDir('backup-sources-staging');
  plane.walTick();

  // The pair the producer must never register: two bases from two ticks. It is
  // unreachable through the shipper now (generations break together), and a
  // busy checkpoint DEFERS a break rather than half-completing one — but that
  // is a claim about the shipper, and this is the assertion that stands
  // regardless of it. Such a pair has no coordinated restore point: the newer
  // base already holds receipts for rows that live only in the older one's
  // SEGMENTS, so losing any one of those hands back a dangling receipt.
  const shipper = plane.walShipper!;
  const real = shipper.currentBases.bind(shipper);
  shipper.currentBases = () => {
    const bases = real();
    return bases.map((b, i) => (i === 0 ? { ...b, createdAtMs: b.createdAtMs + 60_000 } : b));
  };
  await expect(assembleSourceEntries({ plane, stagingDir, log: silentLogger })).rejects.toThrow(
    /bases are from different ticks/,
  );
  shipper.currentBases = real;
});
