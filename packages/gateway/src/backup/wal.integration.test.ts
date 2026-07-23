import { tempDir } from '@centraid/test-kit/temp-dir';
// governance: allow-repo-hygiene file-size-limit (#408) the WAL-shipper acceptance suite is one story — continuous loop, PITR, multi-process generation break, offline drain, restore-verification and the O(change) measurement all share one fixture vocabulary; splitting it would scatter the acceptance criteria across files that only change together
/*
 * System-level acceptance tests for the WAL segment shipper (issue #408):
 * REAL vault planes (`openVaultPlane`, small injected shipper thresholds),
 * a REAL `LocalBackupProvider` on a temp dir, the REAL `BackupService`
 * drain/restore/restore-verify paths, and a REAL child process for the G5
 * multi-writer criterion. Capture-level G1-G7 live in
 * `packages/vault/src/wal-shipper*.test.ts`; format-level damage/PITR in
 * `packages/backup/src/wal-restore.test.ts` — nothing here re-tests those.
 * The only seam is the offline-provider proxy (every call rejects), which
 * stands in for "the network is down", not for any provider behavior.
 */

import { afterEach, expect, test, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, statSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createSnapshot,
  loadKeyring,
  openLocalBackupProvider,
  openManifest,
  SNAPSHOT_FORMAT_V2,
  type BackupProvider,
  type ObjectStore,
} from '@centraid/backup';
import {
  readBackupPolicy,
  updateBackupPolicy,
  verifyRestoredPair,
  type WalShipper,
  type WalShipperOptions,
} from '@centraid/vault';
import { openVaultPlane, type VaultPlane } from '../serve/vault-plane.js';
import type { VaultRegistry } from '../serve/vault-registry.js';
import { HealthRegistry } from '../serve/health-registry.js';
import { BackupService, type BackupServiceOptions } from './backup-service.js';
import { assembleSourceEntries } from './backup-sources.js';
import { evaluateBackupHealth } from './backup-health.js';
import type { BackupTargetState } from './backup-state.js';
import type { BackupConfig } from './backup-config.js';

vi.setConfig({ testTimeout: 30_000 });

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Tiny rollover threshold so a few-KB write batch closes a group. */
const WAL_THRESHOLD = 8 * 1024;
/** SQLite WAL layout for the 8 KiB pages required by issue #456 S7. */
const WAL_HEADER_BYTES = 32;
const WAL_FRAME_BYTES = 24 + 8 * 1024;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});
interface Fx {
  providerDir: string;
  backupDir: string;
  config: BackupConfig;
  plane: VaultPlane;
  vaultId: string;
  shipper: WalShipper;
  registry: VaultRegistry;
  health: HealthRegistry;
  service: BackupService;
  /** Every logger line the service emitted (drain byte counts ride these). */
  logs: string[];
}

/**
 * The registry seam: `BackupService` needs only `get()` + `planesList()`,
 * and `VaultRegistry` does not plumb `VaultPlaneOptions.walShipper`
 * overrides — so the plane is opened directly with test thresholds and
 * served through this two-method view (same pattern as
 * gateway-diagnostics.test.ts / backup-routes.test.ts).
 */
function stubRegistry(planes: VaultPlane[]): VaultRegistry {
  return {
    get: (vaultId: string) => planes.find((p) => p.boot.vaultId === vaultId),
    planesList: () => planes,
  } as unknown as VaultRegistry;
}

interface FxOptions {
  provider?: BackupProvider;
  /** Drives BOTH the shipper's tick clock and the service's (tests that simulate days). */
  now?: () => number;
  /** Extra `WalShipperOptions` (base cadence, local budget) merged over the defaults. */
  walShipper?: Partial<Omit<WalShipperOptions, 'db' | 'log'>>;
  /** `BackupServiceOptions.snapshot` — the registration seam. */
  snapshot?: BackupServiceOptions['snapshot'];
}

async function fx(opts: FxOptions = {}): Promise<Fx> {
  const vaultDir = await tempDir('wal-e2e-vault');
  const providerDir = await tempDir('wal-e2e-provider');
  const backupDir = await tempDir('wal-e2e-backup');
  const plane = openVaultPlane({
    dir: vaultDir,
    logger: silentLogger,
    ownerName: 'Priya',
    walShipper: {
      walSizeThresholdBytes: WAL_THRESHOLD,
      ...(opts.now ? { now: opts.now } : {}),
      ...opts.walShipper,
    },
  });
  updateBackupPolicy(plane.db.vault, { snapshotIntervalHours: 1, verifyEveryDays: 1 });
  cleanups.push(() => plane.stop());
  // Scratch tables for volume writes, created before the first tick so they
  // are part of the first-run base snapshots.
  plane.db.vault.exec('CREATE TABLE _wale2e_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');
  plane.db.journal.exec(
    'CREATE TABLE _wale2e_jprobe (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)',
  );
  const config: BackupConfig = {
    enabled: true,
    provider: { kind: 'local', dir: providerDir },
  };
  const logs: string[] = [];
  const logger = {
    info: (m: string) => void logs.push(m),
    warn: (m: string) => void logs.push(m),
    error: (m: string) => void logs.push(m),
  };
  const registry = stubRegistry([plane]);
  const health = new HealthRegistry();
  const service = new BackupService({
    config,
    backupDir,
    vaults: registry,
    health,
    logger,
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.snapshot ? { snapshot: opts.snapshot } : {}),
  });
  return {
    providerDir,
    backupDir,
    config,
    plane,
    vaultId: plane.boot.vaultId,
    shipper: plane.walShipper!,
    registry,
    health,
    service,
    logs,
  };
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

/** Bulk vault rows in ONE transaction (per-row commits would blow the WAL up with repeated page images and ruin the O(change) story on purpose-built tests). */
function insertVault(plane: VaultPlane, rows: number, size: number, marker: string): number {
  const payload = `${marker}-${'x'.repeat(size)}`;
  plane.db.vault.exec('BEGIN');
  const stmt = plane.db.vault.prepare('INSERT INTO _wale2e_probe (v) VALUES (?)');
  for (let i = 0; i < rows; i++) stmt.run(`${i}-${payload}`);
  plane.db.vault.exec('COMMIT');
  return rows * (payload.length + 8);
}

function walSize(plane: VaultPlane, file: 'vault.db' | 'journal.db'): number {
  const p = path.join(plane.dir, `${file}-wal`);
  return existsSync(p) ? statSync(p).size : 0;
}

function vaultTitles(db: DatabaseSync): string[] {
  return (
    db.prepare('SELECT title FROM schedule_task ORDER BY title').all() as { title: string }[]
  ).map((r) => r.title);
}

function probeCount(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function receiptCount(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM consent_receipt').get() as { n: number }).n;
}

/** Open a restored database read-only, auto-closed at cleanup. */
function openRestored(destDir: string, file: 'vault.db' | 'journal.db'): DatabaseSync {
  const db = new DatabaseSync(path.join(destDir, file), { readOnly: true });
  cleanups.push(() => db.close());
  return db;
}

async function restoreTo(f: Fx, opts: { pointInTimeMs?: number } = {}): Promise<string> {
  const dest = path.join(await tempDir('wal-e2e-dest'), 'restored');
  await f.service.restore({ vaultId: f.vaultId, destDir: dest, ...opts });
  return dest;
}

/** Every remote WAL object file for one target (LocalBackupProvider maps keys to plain nested paths under `objects/<target>/backup/`). */
async function walObjectFiles(f: Fx, targetId: string): Promise<string[]> {
  const root = path.join(f.providerDir, 'objects', targetId, 'backup', 'wal');
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(full);
    }
  };
  await walk(root);
  return out.sort();
}

/** Sum of "N sealed byte(s)" the service's drain loop logged since `from`. */
function drainedBytes(logs: string[], from = 0): { objects: number; bytes: number } {
  let objects = 0;
  let bytes = 0;
  for (const line of logs.slice(from)) {
    const m = /drained (\d+) wal object\(s\), (\d+) sealed byte\(s\)/.exec(line);
    if (m) {
      objects += Number.parseInt(m[1]!, 10);
      bytes += Number.parseInt(m[2]!, 10);
    }
  }
  return { objects, bytes };
}

async function openNewestManifest(f: Fx): Promise<{
  entries: {
    path: string;
    kind: string;
    sha256?: string;
    walGeneration?: string;
    baseTickMs?: number;
    walTipTickMs?: number;
  }[];
}> {
  const targetId = (await f.service.status())[f.vaultId]!.targetId;
  const provider = openLocalBackupProvider({ rootDir: f.providerDir });
  const keyring = await loadKeyring(path.join(f.backupDir, 'keyring.json'));
  const row = (await provider.listSnapshots(targetId))[0]!;
  const store = await provider.openDataPlane(targetId, 'backup', 'read');
  return openManifest(await store.get(row.manifestKey), keyring, f.vaultId, row.manifestHash);
}

// ── 1. Continuous loop: RPO = tick, not backup interval ────────────────────

test('continuous loop: post-manifest writes survive a restore via segments alone (no new manifest)', async () => {
  const f = await fx();
  invoke(f.plane, 'schedule.add_task', { title: 'Frame the print' });
  insertVault(f.plane, 40, 200, 'pre-manifest');

  await f.service.runBackup(f.vaultId);
  const provider = openLocalBackupProvider({ rootDir: f.providerDir });
  const targetId = (await f.service.status())[f.vaultId]!.targetId;
  const rows = await provider.listSnapshots(targetId);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.format).toBe(SNAPSHOT_FORMAT_V2);
  const manifest = await openNewestManifest(f);
  const dbEntries = manifest.entries.filter((e) => e.kind === 'db');
  expect(dbEntries.map((e) => e.path).sort()).toEqual(['journal.db', 'vault.db']);
  for (const entry of dbEntries) {
    expect(entry.walGeneration).toMatch(/^[0-9a-f]{32}$/);
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
  }

  // THE point of WAL shipping: these writes land AFTER the only manifest.
  invoke(f.plane, 'schedule.add_task', { title: 'Pay the invoice (post-manifest)' });
  insertVault(f.plane, 30, 200, 'post-manifest');
  f.plane.walTick();
  await f.service.drainWal();

  expect(await provider.listSnapshots(targetId)).toHaveLength(1); // no new manifest
  expect((await walObjectFiles(f, targetId)).length).toBeGreaterThan(0); // segments went remote
  expect(f.shipper.listUploadable()).toHaveLength(0); // and the local copies drained

  const dest = await restoreTo(f);
  const rv = openRestored(dest, 'vault.db');
  expect(vaultTitles(rv)).toEqual(vaultTitles(f.plane.db.vault));
  expect(vaultTitles(rv)).toContain('Pay the invoice (post-manifest)');
  expect(probeCount(rv, '_wale2e_probe')).toBe(probeCount(f.plane.db.vault, '_wale2e_probe'));
  const report = verifyRestoredPair(dest);
  expect(report.vault.integrity).toBe('ok');
  expect(report.journal.integrity).toBe('ok');
  expect(report.vault.foreignKeyViolations).toBe(0);
  expect(report.journal.foreignKeyViolations).toBe(0);
  expect(report.receiptsChecked).toBeGreaterThan(0);
  expect(report.danglingReceipts).toEqual([]);
}, 30_000);

// ── 2. Point-in-time restore through the service ───────────────────────────

test('PITR through the service: each captured tick restores exactly that instant for BOTH databases', async () => {
  const f = await fx();
  await f.service.runBackup(f.vaultId);

  interface Point {
    tickMs: number;
    titles: string[];
    probe: number;
    jprobe: number;
    receipts: number;
  }
  const points: Point[] = [];
  for (let i = 0; i < 3; i++) {
    invoke(f.plane, 'schedule.add_task', { title: `pitr-task-${i}` });
    insertVault(f.plane, 10, 150, `pitr-${i}`);
    f.plane.db.journal
      .prepare('INSERT INTO _wale2e_jprobe (v) VALUES (?)')
      .run(`jrow-${i}-${'y'.repeat(100)}`);
    const report = f.shipper.tick();
    expect(report.errors).toEqual([]);
    points.push({
      tickMs: report.tickMs,
      titles: vaultTitles(f.plane.db.vault),
      probe: probeCount(f.plane.db.vault, '_wale2e_probe'),
      jprobe: probeCount(f.plane.db.journal, '_wale2e_jprobe'),
      receipts: receiptCount(f.plane.db.journal),
    });
  }
  await f.service.drainWal();

  // Distinct states at every tick, or the assertions below prove nothing.
  expect(new Set(points.map((p) => p.titles.length)).size).toBe(3);

  for (const point of points) {
    const dest = await restoreTo(f, { pointInTimeMs: point.tickMs });
    const rv = openRestored(dest, 'vault.db');
    const rj = openRestored(dest, 'journal.db');
    expect(vaultTitles(rv)).toEqual(point.titles);
    expect(probeCount(rv, '_wale2e_probe')).toBe(point.probe);
    expect(probeCount(rj, '_wale2e_jprobe')).toBe(point.jprobe);
    expect(receiptCount(rj)).toBe(point.receipts);
  }
}, 30_000);

// ── 3. G5: a SECOND PROCESS checkpoints the journal ────────────────────────

/**
 * Write the foreign-writer script and return a SYNCHRONOUS `run()` that spawns
 * it as a real second OS process and blocks until its COMMIT is durable.
 *
 * The split matters: the shipper's tick is synchronous end to end (the
 * cross-database ordering guarantee rests on event-loop atomicity), so a test
 * that needs a foreign commit to land INSIDE the tick cannot await anything —
 * a promise would only resolve once the tick had already finished. Everything
 * async happens up front; `run()` is `spawnSync` and nothing else.
 *
 * `checkpoint` picks the foreign-actor shape:
 *  - `true`  — the child also checkpoints, so the shipper's next tick sees a
 *    mutated main file / fresh salts and breaks BEFORE it ships anything (its
 *    pre-capture detectors catch it; it never enters the dangerous window);
 *  - `false` — it only commits, leaving its frames in the WAL. Whether that is
 *    a hole depends entirely on WHEN it lands relative to capture/checkpoint.
 */
async function foreignJournalWriter(
  plane: VaultPlane,
  opts: { rows: number; marker: string; checkpoint: boolean },
): Promise<{ run: () => void }> {
  const scriptDir = await tempDir('wal-e2e-foreign');
  const script = path.join(scriptDir, 'foreign-writer.mjs');
  await fs.writeFile(
    script,
    [
      "import { DatabaseSync } from 'node:sqlite';",
      'const db = new DatabaseSync(process.argv[2]);',
      "db.exec('PRAGMA busy_timeout = 10000');",
      ...(opts.checkpoint ? [] : ["db.exec('PRAGMA wal_autocheckpoint = 0');"]),
      "db.exec('CREATE TABLE IF NOT EXISTS _wale2e_foreign (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');",
      "db.exec('BEGIN');",
      "const ins = db.prepare('INSERT INTO _wale2e_foreign (v) VALUES (?)');",
      `for (let i = 0; i < ${opts.rows}; i++) ins.run(${JSON.stringify(opts.marker)} + '-' + i + '-' + 'x'.repeat(64));`,
      "db.exec('COMMIT');",
      ...(opts.checkpoint ? ["db.exec('PRAGMA wal_checkpoint(RESTART)');"] : []),
      'db.close();',
    ].join('\n'),
  );
  return {
    run: () => {
      const child = spawnSync(process.execPath, [script, path.join(plane.dir, 'journal.db')], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(child.status).toBe(0);
    },
  };
}

test('G5 multi-process: a real child process COMMITTING inside the capture→TRUNCATE window is detected, and its rows survive the restore', async () => {
  // The hole. The G5 test below checkpoints from the child BEFORE the shipper's
  // tick, so the shipper's pre-capture detectors (mutated main file, fresh
  // salts, shrunken WAL) catch it and nothing is ever at risk — it never enters
  // the dangerous window at all. THIS test puts a real second process's COMMIT
  // between the shipper's capture and its `wal_checkpoint(TRUNCATE)`, where no
  // detector runs: the checkpoint folds those frames into journal.db and zeroes
  // them from the WAL, so they are in no segment and predate no base. Silently
  // unrecoverable — unless the checkpoint itself notices it was raced.
  const f = await fx();
  invoke(f.plane, 'schedule.add_task', { title: 'before-the-race' });
  await f.service.runBackup(f.vaultId);
  await f.service.drainWal();
  const genBefore = f.shipper.status().dbs.journal!.generation;
  const seqBefore = (await f.service.status())[f.vaultId]!.lastSeq!;

  // Hook the checkpoint's own `prepare()`: the child commits after the shipper
  // has captured and stat'd the WAL, and before the checkpoint takes its writer
  // lock. `spawnSync` inside the hook is what makes the window reachable at all
  // — the tick is synchronous, so anything awaited would land after it.
  const writer = await foreignJournalWriter(f.plane, {
    rows: 200,
    marker: 'raced',
    checkpoint: false,
  });
  const journal = f.plane.db.journal;
  const realPrepare = journal.prepare.bind(journal);
  let raced = 0;
  journal.prepare = ((sql: string) => {
    if (raced === 0 && sql.includes('wal_checkpoint(TRUNCATE)')) {
      raced += 1;
      writer.run();
    }
    return realPrepare(sql);
  }) as typeof journal.prepare;

  let report;
  try {
    report = f.shipper.checkpointNow();
  } finally {
    journal.prepare = realPrepare;
  }
  expect(raced).toBe(1);
  expect(report.errors).toEqual([]);
  // The child's rows are in the LIVE database — the checkpoint folded them in.
  expect(probeCount(f.plane.db.journal, '_wale2e_foreign')).toBe(200);

  // Detected as the race it is, and healed the only way it can be: a fresh base
  // pair, cloned from the main files the frames were folded into.
  expect(report.breaks).toEqual([
    { db: 'journal', reason: 'checkpoint-raced-writer' },
    { db: 'vault', reason: 'coordinated:checkpoint-raced-writer' },
  ]);
  const journalAfter = f.shipper.status().dbs.journal!;
  expect(journalAfter.generation).not.toBe(genBefore);
  expect(f.shipper.basesCoordinated()).toBe(true);

  await f.service.runBackup(f.vaultId);
  expect((await f.service.status())[f.vaultId]!.lastSeq).toBe(seqBefore + 1);
  await f.service.drainWal();

  // THE assertion: the restore carries every one of the child's rows. Without
  // the detection it carries NONE of them, reports no damage, and verifies green.
  const dest = await restoreTo(f);
  const rj = openRestored(dest, 'journal.db');
  expect(probeCount(rj, '_wale2e_foreign')).toBe(200);
  const rv = openRestored(dest, 'vault.db');
  expect(vaultTitles(rv)).toContain('before-the-race');
  const pair = verifyRestoredPair(dest);
  expect(pair.vault.integrity).toBe('ok');
  expect(pair.journal.integrity).toBe('ok');
  expect(pair.danglingReceipts).toEqual([]);
}, 45_000);

test('G5 multi-process: a real child process checkpointing journal.db breaks the generation, re-bases, and restores CORRECTLY', async () => {
  const f = await fx();
  invoke(f.plane, 'schedule.add_task', { title: 'before-foreign-writer' });
  await f.service.runBackup(f.vaultId);
  await f.service.drainWal();
  const genBefore = f.shipper.status().dbs.journal!.generation;
  const vaultGenBefore = f.shipper.status().dbs.vault!.generation;
  const seqBefore = (await f.service.status())[f.vaultId]!.lastSeq!;

  // A REAL second OS process, node:sqlite DEFAULTS (no wal_autocheckpoint=0
  // discipline): commits 1500 rows, then checkpoints — exactly the foreign
  // mutation the shipper's invariants forbid and must DETECT.
  //
  // Note WHERE this lands: entirely BEFORE the shipper's next tick. The tick's
  // pre-capture detectors (mutated main file / fresh salts / shrunken WAL) see
  // it and break before a byte ships, so the capture→checkpoint window is never
  // entered. A commit INSIDE that window is a different failure with a different
  // detector, and it has its own test above.
  const writer = await foreignJournalWriter(f.plane, {
    rows: 1500,
    marker: 'foreign',
    checkpoint: true,
  });
  writer.run();

  // Detected — a generation BREAK with a fresh pending base, never a silent gap.
  const report = f.shipper.tick();
  expect(report.breaks.map((b) => b.db)).toContain('journal');
  const journalAfter = f.shipper.status().dbs.journal!;
  expect(journalAfter.generation).not.toBe(genBefore);
  expect(journalAfter.basePending).toBe(true);

  // …and the VAULT re-based with it (issue #408): a journal-only break would
  // leave two bases from two ticks — a journal base holding receipts for vault
  // rows that live only in the vault's SEGMENTS. Lose one of those and the
  // restore hands back history asserting data it does not have. The two
  // generations break TOGETHER, in one tick, or the pair is not registerable.
  expect(report.breaks.map((b) => b.db).sort()).toEqual(['journal', 'vault']);
  expect(f.shipper.status().dbs.vault!.generation).not.toBe(vaultGenBefore);
  expect(f.shipper.basesCoordinated()).toBe(true);
  const bases = f.shipper.currentBases();
  expect(bases[0]!.createdAtMs).toBe(bases[1]!.createdAtMs);

  // Healed — the next backup registers a NEW base anchoring the fresh generation.
  await f.service.runBackup(f.vaultId);
  expect((await f.service.status())[f.vaultId]!.lastSeq).toBe(seqBefore + 1);

  // Issue #411 action 1: the foreign checkpoint the shipper just healed is a
  // churn signal — persisted into the target and surfaced through the health
  // PROBE as DEGRADED (not error: correctness held, the stream self-re-based).
  const foreignTarget = (await f.service.status())[f.vaultId]!;
  expect(foreignTarget.walForeignCheckpointCount).toBeGreaterThanOrEqual(1);
  expect(foreignTarget.walLastForeignCheckpoint?.db).toBe('journal');
  const foreignSnap = await f.health.snapshot();
  const foreignBackups = foreignSnap.components.find((c) => c.component === 'backups');
  expect(foreignBackups?.status).toBe('degraded');
  expect(foreignBackups?.detail).toMatch(/foreign checkpoint/);
  const manifest = await openNewestManifest(f);
  const journalEntry = manifest.entries.find((e) => e.kind === 'db' && e.path === 'journal.db')!;
  const vaultEntry = manifest.entries.find((e) => e.kind === 'db' && e.path === 'vault.db')!;
  expect(journalEntry.walGeneration).toBe(journalAfter.generation);
  expect(vaultEntry.walGeneration).toBe(f.shipper.status().dbs.vault!.generation);
  // The manifest carries BOTH base ticks, and they agree — restore refuses the
  // pair otherwise.
  expect(journalEntry.baseTickMs).toBe(vaultEntry.baseTickMs);
  expect(journalEntry.baseTickMs).toBeGreaterThan(0);
  expect(f.shipper.status().dbs.journal!.basePending).toBe(false);
  await f.service.drainWal();

  // And CORRECT — the restore carries the child's rows, not a stale stream.
  const dest = await restoreTo(f);
  const rj = openRestored(dest, 'journal.db');
  expect(probeCount(rj, '_wale2e_foreign')).toBe(1500);
  const rv = openRestored(dest, 'vault.db');
  expect(vaultTitles(rv)).toContain('before-foreign-writer');
  const pair = verifyRestoredPair(dest);
  expect(pair.vault.integrity).toBe('ok');
  expect(pair.journal.integrity).toBe('ok');
  expect(pair.danglingReceipts).toEqual([]);
}, 45_000);

// ── 4. Offline accumulation, bounded WAL, drain on reconnect ───────────────

/** Every provider call rejects — "the network is down", the only test double in this suite. */
function offlineProvider(): BackupProvider {
  const offline = <T>(): Promise<T> => Promise.reject(new Error('offline: provider unreachable'));
  return {
    capabilities: () => offline(),
    createTarget: () => offline(),
    deleteTarget: () => offline(),
    undeleteTarget: () => offline(),
    purgeTarget: () => offline(),
    openDataPlane: () => offline(),
    registerSnapshot: () => offline(),
    listSnapshots: () => offline(),
    getSnapshot: () => offline(),
    getTarget: () => offline(),
    usage: () => offline(),
  };
}

test('offline: segments accumulate across groups, the WAL stays checkpoint-bounded, and everything drains on reconnect with NO generation break', async () => {
  const f = await fx({ provider: offlineProvider() });
  f.shipper.tick(); // first-run: mint the generations before going "offline"
  const gen0 = {
    vault: f.shipper.status().dbs.vault!.generation,
    journal: f.shipper.status().dbs.journal!.generation,
  };

  const reports = [];
  for (let i = 0; i < 6; i++) {
    invoke(f.plane, 'schedule.add_task', { title: `offline-task-${i}` });
    insertVault(f.plane, 30, 400, `offline-${i}`); // ~12KB > threshold ⇒ rollover
    reports.push(f.shipper.tick());
    // Checkpoints still run while offline — the live WAL never balloons.
    expect(walSize(f.plane, 'vault.db')).toBeLessThanOrEqual(2 * WAL_THRESHOLD);
    await f.service.drainWal(); // fails inside (offline), never throws, never deletes
  }
  expect(reports.flatMap((r) => r.breaks)).toEqual([]);
  expect(reports.flatMap((r) => r.errors)).toEqual([]);

  // Nothing reached the "remote"; multiple CLOSED groups piled up locally.
  expect(Object.keys(await f.service.status())).toHaveLength(0);
  const local = f.shipper.listUploadable();
  const vaultGroups = new Set(
    local.filter((i) => i.kind === 'segment' && i.addr!.db === 'vault').map((i) => i.addr!.group),
  );
  expect(vaultGroups.size).toBeGreaterThanOrEqual(3);
  expect(local.filter((i) => i.kind === 'closer').length).toBeGreaterThanOrEqual(3);

  // Reconnect: a second service over the SAME backupDir/planes, real provider.
  const service2 = new BackupService({
    config: f.config,
    backupDir: f.backupDir,
    vaults: f.registry,
    health: new HealthRegistry(),
    logger: silentLogger,
  });
  await service2.runBackup(f.vaultId);
  await service2.drainWal();
  expect(f.shipper.listUploadable()).toHaveLength(0); // local dir drained

  // Same generations end to end — offline was accumulation, not a break.
  expect(f.shipper.status().dbs.vault!.generation).toBe(gen0.vault);
  expect(f.shipper.status().dbs.journal!.generation).toBe(gen0.journal);

  const dest = path.join(await tempDir('wal-e2e-dest'), 'restored');
  await service2.restore({ vaultId: f.vaultId, destDir: dest });
  const rv = openRestored(dest, 'vault.db');
  expect(vaultTitles(rv)).toEqual(vaultTitles(f.plane.db.vault));
  expect(probeCount(rv, '_wale2e_probe')).toBe(probeCount(f.plane.db.vault, '_wale2e_probe'));
  expect(verifyRestoredPair(dest).danglingReceipts).toEqual([]);
}, 45_000);

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

test('offline for multiple days: daily base rotations fire, the WAL and the local dir stay bounded, and reconnect loses nothing', async () => {
  // The laptop-closed-for-a-week case, and the reason this test drives a clock
  // instead of looping fast: the shipper's DAILY base cadence is a function of
  // wall time, so a rapid loop never fires it — and the base cadence is exactly
  // what makes a long outage survivable. Multi-day simulated outage, four-hour ticks,
  // provider unreachable throughout.
  //
  // The clock STARTS at the real one and only ever moves forward from there (by
  // fixed steps — no wall-clock race): a snapshot's registration time comes from
  // the provider, and a simulated clock in the past would make every restore
  // point predate the manifest that anchors it.
  let clock = Date.now();
  const LOCAL_BUDGET = 8 * 1024 * 1024;
  const f = await fx({
    provider: offlineProvider(),
    now: () => clock,
    walShipper: { baseIntervalMs: DAY_MS, localBudgetBytes: LOCAL_BUDGET },
  });
  f.shipper.tick(); // first run: mint the generations before the outage
  const gen0 = f.shipper.status().dbs.vault!.generation;

  // Four simulated days is enough to prove the constant per-day bound
  // (day N looks like day 1); eight days only lengthened wall clock (~2×).
  const DAYS = 4;
  const TICKS_PER_DAY = 6; // one every four hours
  const reports = [];
  const written: string[] = [];
  /** Per-day: the largest WAL either database reached, and the local segment dir. */
  const perDay: { wal: number; local: number }[] = [];
  for (let day = 0; day < DAYS; day++) {
    let maxWal = 0;
    let maxLocal = 0;
    for (let t = 0; t < TICKS_PER_DAY; t++) {
      const title = `outage-d${day}-t${t}`;
      invoke(f.plane, 'schedule.add_task', { title });
      written.push(title);
      insertVault(f.plane, 30, 400, title); // ~12 KB > threshold ⇒ a rollover every tick
      f.plane.db.journal
        .prepare('INSERT INTO _wale2e_jprobe (v) VALUES (?)')
        .run(`${title}-${'y'.repeat(200)}`);
      clock += 4 * HOUR_MS;
      reports.push(f.shipper.tick());

      // (1) The WAL is CHECKPOINT-BOUNDED. Stage 1 is local disk, so
      // checkpointing never waits on the network: the rollover truncates every
      // tick and the live WAL comes back to zero. (The one exception is a
      // day-boundary tick, which ends by writing the generation-break's consent
      // receipt — a journal.db write, deliberately AFTER both base clones — so
      // journal.db carries those few frames until the next tick captures them.
      // That is a constant, not a function of how long we have been offline,
      // which is exactly what the per-day maxima below pin down.)
      maxWal = Math.max(maxWal, walSize(f.plane, 'vault.db'), walSize(f.plane, 'journal.db'));
      // (2) The local budget policy holds WITHOUT ever having to fire: each
      // daily roll drops the superseded (never-registered) generation's
      // segments, so the offline footprint tracks ONE day, not the whole outage.
      maxLocal = Math.max(maxLocal, f.shipper.status().localBytes);
      expect(f.shipper.status().localBytes).toBeLessThanOrEqual(LOCAL_BUDGET);
      await f.service.drainWal(); // fails inside (offline): never throws, never deletes
    }
    perDay.push({ wal: maxWal, local: maxLocal });
  }
  expect(reports.flatMap((r) => r.errors)).toEqual([]);

  // Neither the WAL nor the local segment dir GROWS WITH THE OUTAGE. This is
  // the whole claim — the last day looks like day one. A shipper that only
  // checkpointed when the network was reachable, or that never rolled its base,
  // would show both of these climbing monotonically.
  expect(perDay).toHaveLength(DAYS);
  const day0 = perDay[0]!;
  console.log(
    `[wal-e2e multi-day outage] per-day max WAL / local-segment bytes: ` +
      perDay.map((d) => `${d.wal}/${d.local}`).join('  '),
  );
  expect(day0.wal).toBeGreaterThan(0); // the measurement is live, not a no-op
  expect(day0.local).toBeGreaterThan(0);
  for (const day of perDay) {
    // A CONSTANT bound — a few rollovers' worth — held on the last day as on day
    // one, and never a function of the outage's length.
    // The on-disk WAL contains a 32-byte header plus a 24-byte header per
    // database page. Bound frame count, not just payload bytes: an 8 KiB page
    // makes twelve frames 98,624 bytes even though their payload is 98,304.
    // Daily rotation can write eleven fixed metadata/data frames; twelve keeps
    // the bound independent of outage length without relying on byte payloads.
    expect(day.wal).toBeLessThanOrEqual(WAL_HEADER_BYTES + 12 * WAL_FRAME_BYTES);
    expect(day.wal).toBeLessThanOrEqual(day0.wal * 2);
    expect(day.local).toBeLessThanOrEqual(day0.local * 2);
  }

  // The outage ends MID-DAY, as one does — the last tick above was a
  // day-boundary roll, which leaves the fresh generation at offset 0 with
  // nothing yet captured. Two more ticks of ordinary work, so what reconnect
  // has to drain is a real, partially-filled generation.
  const TAIL_TICKS = 2;
  for (let t = 0; t < TAIL_TICKS; t++) {
    const title = `outage-tail-${t}`;
    invoke(f.plane, 'schedule.add_task', { title });
    written.push(title);
    insertVault(f.plane, 30, 400, title);
    f.plane.db.journal
      .prepare('INSERT INTO _wale2e_jprobe (v) VALUES (?)')
      .run(`${title}-${'y'.repeat(200)}`);
    clock += 4 * HOUR_MS;
    reports.push(f.shipper.tick());
    expect(walSize(f.plane, 'vault.db')).toBeLessThanOrEqual(2 * WAL_THRESHOLD);
    await f.service.drainWal();
  }

  // (3) The daily base cadence ACTUALLY FIRED — one roll per day boundary —
  // and every break is a cadence roll: nothing detected a violation, and the
  // budget was never breached.
  const breaks = reports.flatMap((r) => r.breaks);
  const cadence = breaks.filter((b) => /base-cadence/.test(b.reason));
  const vaultRolls = cadence.filter((b) => b.db === 'vault').length;
  expect(vaultRolls).toBeGreaterThanOrEqual(DAYS - 1); // one per day-boundary crossed
  expect(vaultRolls).toBeLessThanOrEqual(DAYS);
  expect(breaks).toHaveLength(cadence.length); // no local-budget, no detector break
  expect(f.shipper.status().dbs.vault!.generation).not.toBe(gen0);
  // …and the pair broke TOGETHER every time (a manifest may never pair two ticks).
  expect(f.shipper.basesCoordinated()).toBe(true);

  // (4) Nothing reached the provider; segments really did pile up locally.
  expect(Object.keys(await f.service.status())).toHaveLength(0);
  expect(f.shipper.listUploadable().length).toBeGreaterThan(0);
  expect(f.shipper.status().dbs.vault!.basePending).toBe(true);

  // ── Reconnect ────────────────────────────────────────────────────────────
  const service2 = new BackupService({
    config: f.config,
    backupDir: f.backupDir,
    vaults: f.registry,
    health: new HealthRegistry(),
    logger: silentLogger,
    now: () => clock,
  });
  cleanups.push(() => service2.stop());
  await service2.runBackup(f.vaultId);
  await service2.drainWal();

  // (5) EVERYTHING drains — not "most of it", not "the last group".
  expect(f.shipper.listUploadable()).toHaveLength(0);
  expect(f.shipper.status().dbs.vault!.basePending).toBe(false);
  expect(f.shipper.status().dbs.journal!.basePending).toBe(false);

  // (6) Zero data loss: every row from every simulated day is back.
  // (PITR *depth* into the outage is the documented trade — each daily roll
  // drops the never-registered predecessor's segments — but no row is ever
  // lost, because the roll's fresh base clone carries all of them.)
  const dest = path.join(await tempDir('wal-e2e-dest'), 'restored');
  await service2.restore({ vaultId: f.vaultId, destDir: dest });
  const rv = openRestored(dest, 'vault.db');
  const rj = openRestored(dest, 'journal.db');
  const titles = vaultTitles(rv);
  for (const title of written) expect(titles).toContain(title);
  expect(titles).toEqual(vaultTitles(f.plane.db.vault));
  expect(probeCount(rv, '_wale2e_probe')).toBe(probeCount(f.plane.db.vault, '_wale2e_probe'));
  expect(probeCount(rj, '_wale2e_jprobe')).toBe(DAYS * TICKS_PER_DAY + TAIL_TICKS);
  const pair = verifyRestoredPair(dest);
  expect(pair.vault.integrity).toBe('ok');
  expect(pair.journal.integrity).toBe('ok');
  expect(pair.danglingReceipts).toEqual([]);
  await service2.runRestoreVerify(f.vaultId); // and the G9 job agrees
}, 120_000);

// ── 4c. PITR at an ARBITRARY instant, against a recorded content digest ────

/**
 * A stable digest of the CONTENT of a vault/journal pair — rows, not file
 * bytes. The file bytes of a restored database are never identical to the live
 * one's (different page churn, a checkpointed WAL), so bytes cannot answer
 * "did point-in-time restore reproduce this state"; the rows can, and they are
 * what the user actually loses.
 */
function contentDigest(vault: DatabaseSync, journal: DatabaseSync): string {
  const col = (db: DatabaseSync, sql: string): string[] =>
    (db.prepare(sql).all() as Record<string, unknown>[]).map((r) => String(Object.values(r)[0]));
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        tasks: col(vault, 'SELECT title FROM schedule_task ORDER BY title'),
        probe: col(vault, 'SELECT v FROM _wale2e_probe ORDER BY id'),
        jprobe: col(journal, 'SELECT v FROM _wale2e_jprobe ORDER BY id'),
        receipts: col(journal, 'SELECT receipt_id FROM consent_receipt ORDER BY receipt_id'),
      }),
    )
    .digest('hex');
}

test('PITR at an ARBITRARY instant between two capture ticks restores the recorded content digest EXACTLY', async () => {
  // The existing PITR test restores AT the tick instants it collected, which
  // proves the segments replay but not that the point-in-time CUT is right: an
  // implementation that ignored `pointInTimeMs` and always returned the newest
  // state would still pass it for the last point. This one restores to an
  // instant that is provably not any tick — with more rows committed after that
  // instant's restore point — and holds the result to a content digest recorded
  // when the live database WAS that state. Nothing later may leak in, and
  // nothing earlier may be missing.
  //
  // The clock starts at the real one and steps forward deterministically: PITR
  // first picks the newest SNAPSHOT at or before T, and a simulated instant in
  // the past would predate the manifest that anchors every segment.
  let clock = Date.now();
  const f = await fx({ now: () => clock });
  await f.service.runBackup(f.vaultId);

  const points: { tickMs: number; digest: string; rows: number }[] = [];
  for (let i = 0; i < 8; i++) {
    // Continuous writes, in both databases, between every capture.
    invoke(f.plane, 'schedule.add_task', { title: `pitr-arb-${i}` });
    insertVault(f.plane, 12, 220, `arb-${i}`);
    f.plane.db.journal
      .prepare('INSERT INTO _wale2e_jprobe (v) VALUES (?)')
      .run(`arb-${i}-${'y'.repeat(160)}`);
    clock += 10 * 60 * 1000; // ten minutes between ticks — room for an arbitrary instant
    const report = f.shipper.tick();
    expect(report.errors).toEqual([]);
    expect(report.breaks).toEqual([]); // a break would write a receipt and move the digest
    // The digest of the state this tick just CAPTURED: taken now, before the
    // next round's writes, so the live pair IS the restore point.
    points.push({
      tickMs: report.tickMs,
      digest: contentDigest(f.plane.db.vault, f.plane.db.journal),
      rows: probeCount(f.plane.db.vault, '_wale2e_probe'),
    });
  }
  await f.service.drainWal();

  // Every point is genuinely distinct, or the assertions below prove nothing.
  expect(new Set(points.map((p) => p.digest)).size).toBe(points.length);

  const ticks = new Set(points.map((p) => p.tickMs));
  for (const i of [2, 4, 6]) {
    const at = points[i]!;
    const next = points[i + 1]!;
    // An ARBITRARY instant strictly inside the interval — 37% of the way to the
    // next capture, on no boundary of anything.
    const t = at.tickMs + Math.floor((next.tickMs - at.tickMs) * 0.37);
    expect(ticks.has(t)).toBe(false);
    expect(t).toBeGreaterThan(at.tickMs);
    expect(t).toBeLessThan(next.tickMs);

    const dest = await restoreTo(f, { pointInTimeMs: t });
    const rv = openRestored(dest, 'vault.db');
    const rj = openRestored(dest, 'journal.db');
    // THE assertion: byte-for-byte the same CONTENT as the recorded digest.
    expect(contentDigest(rv, rj)).toBe(at.digest);
    // …which means the newest restore point at or before `t`, and NOT the
    // rows committed after it (they exist, and they are excluded).
    expect(probeCount(rv, '_wale2e_probe')).toBe(at.rows);
    expect(next.rows).toBeGreaterThan(at.rows);
    expect(contentDigest(rv, rj)).not.toBe(next.digest);
    expect(verifyRestoredPair(dest).danglingReceipts).toEqual([]);
  }

  // And an instant BEFORE the first tick of the loop still restores the base
  // pair coherently — the floor of the ladder, not an error.
  const early = await restoreTo(f, { pointInTimeMs: points[0]!.tickMs - 1 });
  expect(verifyRestoredPair(early).vault.integrity).toBe('ok');
  expect(
    contentDigest(openRestored(early, 'vault.db'), openRestored(early, 'journal.db')),
  ).not.toBe(points[0]!.digest);
}, 60_000);

// ── 4b. A base is "registered" only when a MANIFEST names its generation ───

/** Every walGeneration named by any authenticated manifest on the provider. */
async function anchoredGenerations(f: Fx): Promise<Set<string>> {
  const targetId = (await f.service.status())[f.vaultId]?.targetId;
  if (!targetId) return new Set();
  const provider = openLocalBackupProvider({ rootDir: f.providerDir });
  const keyring = await loadKeyring(path.join(f.backupDir, 'keyring.json'));
  const store = await provider.openDataPlane(targetId, 'backup', 'read');
  const out = new Set<string>();
  for (const row of await provider.listSnapshots(targetId)) {
    const opened = openManifest(
      await store.get(row.manifestKey),
      keyring,
      f.vaultId,
      row.manifestHash,
    );
    for (const entry of opened.entries) {
      if (entry.walGeneration !== undefined) out.add(entry.walGeneration);
    }
  }
  return out;
}

test('a run that registers NOTHING must not mark the base registered — no manifest, no anchor', async () => {
  // `basePending` is the flag that makes the drain pass keep RETRYING
  // registration. Clearing it for a generation no manifest names is the
  // quietest data loss in the system: the retries stop, the generation's
  // segments keep uploading under a generation nothing references, and the
  // next prune — whose keep-set is built from AUTHENTICATED MANIFESTS — deletes
  // them. Every restore point since the last real manifest is gone, and the
  // health surface still reads green.
  //
  // The registration seam is what makes the state reachable at all: no
  // arrangement of real sources forces `createSnapshot` to return null while a
  // base is unanchored, because the engine's no-change test compares the sealed
  // `walGeneration`. That is a predicate in ANOTHER PACKAGE, added for an
  // unrelated reason (the walTipTickMs floor). This service must hold the
  // invariant on its own, so it is held to it on its own.
  let registerNothing = false;
  const f = await fx({
    snapshot: async (o) => (registerNothing ? null : createSnapshot(o)),
  });
  invoke(f.plane, 'schedule.add_task', { title: 'anchored' });
  await f.service.runBackup(f.vaultId);
  const gen0 = f.shipper.status().dbs.vault!.generation;
  expect(await anchoredGenerations(f)).toContain(gen0);
  expect(f.shipper.pendingBases()).toEqual([]); // a manifest names it — correctly cleared

  // A fresh generation pair, with nothing on the provider naming it.
  insertVault(f.plane, 20, 200, 'post-roll');
  f.shipper.rollGeneration('vault', 'test-roll');
  const gen1 = f.shipper.status().dbs.vault!.generation;
  const jgen1 = f.shipper.status().dbs.journal!.generation;
  expect(gen1).not.toBe(gen0);
  expect(
    f.shipper
      .pendingBases()
      .map((b) => b.db)
      .sort(),
  ).toEqual(['journal', 'vault']);

  // The run registers NOTHING.
  registerNothing = true;
  await f.service.runBackup(f.vaultId);

  // Ground truth: no manifest anywhere on the provider names the live pair…
  const anchored = await anchoredGenerations(f);
  expect(anchored.has(gen1)).toBe(false);
  expect(anchored.has(jgen1)).toBe(false);
  // …so the bases are STILL PENDING, and the drain pass will keep trying.
  expect(f.shipper.status().dbs.vault!.basePending).toBe(true);
  expect(f.shipper.status().dbs.journal!.basePending).toBe(true);
  expect(
    f.shipper
      .pendingBases()
      .map((b) => b.generation)
      .sort(),
  ).toEqual([gen1, jgen1].sort());
  expect(f.logs.some((l) => /no manifest anchors/.test(l))).toBe(true);

  // And the retry HEALS it: the moment a manifest names the pair, and only
  // then, the bases stop being pending.
  registerNothing = false;
  await f.service.runBackup(f.vaultId);
  const healed = await anchoredGenerations(f);
  expect(healed.has(gen1)).toBe(true);
  expect(healed.has(jgen1)).toBe(true);
  expect(f.shipper.pendingBases()).toEqual([]);

  // …and the whole history restores, across both generations.
  await f.service.drainWal();
  const dest = await restoreTo(f);
  const rv = openRestored(dest, 'vault.db');
  expect(vaultTitles(rv)).toContain('anchored');
  expect(probeCount(rv, '_wale2e_probe')).toBe(probeCount(f.plane.db.vault, '_wale2e_probe'));
  expect(verifyRestoredPair(dest).danglingReceipts).toEqual([]);
}, 45_000);

test('a no-change run whose PREVIOUS manifest still anchors the live pair DOES clear the base (no pending livelock)', async () => {
  // The other direction, and it matters just as much: a base wrongly left
  // PENDING is dropped by the next generation break (`mintBase`: "never
  // uploaded ⇒ never restorable ⇒ its local segments are dead weight"), taking
  // the un-drained tail of a generation a manifest DOES name with it. So the
  // gate cannot be "no row ⇒ never clear" — it has to be "no MANIFEST ⇒ never
  // clear", which is what the service reads back. This is the crash-window
  // shape: the manifest registered, the shipper's `basePending` write did not.
  let registerNothing = false;
  const f = await fx({
    snapshot: async (o) => (registerNothing ? null : createSnapshot(o)),
  });
  invoke(f.plane, 'schedule.add_task', { title: 'anchored-then-forgotten' });
  await f.service.runBackup(f.vaultId);
  const target = (await f.service.status())[f.vaultId]!;

  // A fresh pair, then a manifest that names it registered OUT OF BAND — the
  // shipper is never told, so its flag still says PENDING while the provider
  // holds a perfectly good anchor. That is precisely the on-disk state a crash
  // between `registerSnapshot` and the shipper's state write leaves behind.
  insertVault(f.plane, 20, 200, 'pre-crash');
  f.shipper.rollGeneration('vault', 'test-roll');
  const gen = f.shipper.status().dbs.vault!.generation;
  const jgen = f.shipper.status().dbs.journal!.generation;
  const provider = openLocalBackupProvider({ rootDir: f.providerDir });
  const keyring = await loadKeyring(path.join(f.backupDir, 'keyring.json'));
  const entries = await assembleSourceEntries({
    plane: f.plane,
    bundleDir: await tempDir('wal-e2e-oob-bundle'),
    log: {},
  });
  await createSnapshot({
    provider,
    targetId: target.targetId,
    keyring,
    vaultId: f.vaultId,
    entries,
    generation: target.generation,
    appMeta: { gatewayVersion: '0.0.0', vaultUserVersion: '1', ontologyVersion: '1.2' },
  });
  const anchored = await anchoredGenerations(f);
  expect(anchored.has(gen)).toBe(true); // the provider HAS the anchor…
  expect(anchored.has(jgen)).toBe(true);
  expect(
    f.shipper
      .pendingBases()
      .map((b) => b.db)
      .sort(),
  ).toEqual(['journal', 'vault']); // …the shipper doesn't know

  // A run that registers nothing (the manifest is already there, unchanged)
  // must still clear the flag: the anchor exists, and the service READ it.
  registerNothing = true;
  await f.service.runBackup(f.vaultId);
  expect(f.shipper.status().dbs.vault!.basePending).toBe(false);
  expect(f.shipper.status().dbs.journal!.basePending).toBe(false);
  expect(f.shipper.pendingBases()).toEqual([]);
}, 45_000);

// ── 5. G9: scheduled restore-verification + the loud damage signal ─────────

test('G9 restore-verify: succeeds against a real snapshot+segments, THROWS loudly on a damaged remote segment, and stales at 14 days', async () => {
  const f = await fx();
  invoke(f.plane, 'schedule.add_task', { title: 'verify-me' });
  await f.service.runBackup(f.vaultId);
  insertVault(f.plane, 20, 300, 'post-base');
  f.plane.walTick();
  await f.service.drainWal();

  const beforeVerifyMs = Date.now();
  await f.service.runRestoreVerify(f.vaultId);
  const state = (await f.service.status())[f.vaultId]!;
  expect(state.lastRestoreVerifiedAt).toBeTruthy();
  // A lower bound, not a wall-clock window (TESTING.md: no real-time races)
  // — the timestamp must simply be from THIS verify run, not a stale row.
  expect(Date.parse(state.lastRestoreVerifiedAt!)).toBeGreaterThanOrEqual(beforeVerifyMs - 1000);

  // Flip one byte of a REAL remote segment object (GCM tag now fails).
  const segments = (await walObjectFiles(f, state.targetId)).filter((file) =>
    /^\d{12}-\d{12}-\d{13}$/.test(path.basename(file)),
  );
  expect(segments.length).toBeGreaterThan(0);
  const victim = segments[segments.length - 1]!;
  const original = await fs.readFile(victim);
  const flipped = Buffer.from(original);
  flipped[Math.floor(flipped.length / 2)]! ^= 0xff;
  await fs.writeFile(victim, flipped);

  // Damage degrades the restore to an earlier consistent state — but the
  // verification job's contract is to be LOUD about it, not to shrug.
  await expect(f.service.runRestoreVerify(f.vaultId)).rejects.toThrow(/damaged wal object/);
  expect((await f.service.status())[f.vaultId]!.lastRestoreVerifyError).toMatch(
    /damaged wal object/,
  );
  // The probe recomputes from persisted state at snapshot time (and its
  // status wins) — the persisted failure keeps the health surface red, not
  // just the one pushed report.
  const snap = await f.health.snapshot();
  const backups = snap.components.find((c) => c.component === 'backups');
  expect(backups?.status).toBe('error');
  expect(backups?.detail).toMatch(/restore-verification failed/);
  expect(backups?.lastError).toMatch(/restore-verify failed/);

  // Heal: put the original sealed object back (uploads are idempotent
  // byte-identical PUTs) — the next verification succeeds and clears it.
  await fs.writeFile(victim, original);
  await f.service.runRestoreVerify(f.vaultId);
  expect((await f.service.status())[f.vaultId]!.lastRestoreVerifyError).toBeUndefined();
  const healed = await f.health.snapshot();
  expect(healed.components.find((c) => c.component === 'backups')?.status).toBe('ok');

  // Staleness alarm (unit-level, same module the probe uses): 15 days
  // without a successful restore-verification is an ERROR, not a shrug.
  const now = Date.now();
  const iso = (agoMs: number): string => new Date(now - agoMs).toISOString();
  const health = evaluateBackupHealth({
    state: {
      targets: {
        [f.vaultId]: {
          targetId: state.targetId,
          label: state.label,
          generation: 1,
          lastSeq: 1,
          lastBackupAt: iso(30 * 60 * 1000),
          lastVerifiedAt: iso(30 * 60 * 1000),
          lastRestoreVerifiedAt: iso(15 * 24 * 60 * 60 * 1000),
        },
      },
      casReconciliations: {},
      sourceInstanceId: 'test',
      recoveryKit: { confirmedAt: null },
    },
    policyForVault: () => readBackupPolicy(f.plane.db.vault),
    now,
  });
  expect(health.status).toBe('error');
  expect(health.detail).toMatch(/restore-verification/);
}, 45_000);

test('G8/G9 restore-verify: dangling receipts leave health DEGRADED, and the probe KEEPS it degraded', async () => {
  const f = await fx();
  invoke(f.plane, 'schedule.add_task', { title: 'receipted' });
  await f.service.runBackup(f.vaultId);

  // Every terminal report the service pushes for this component, in order —
  // the bug being pinned down was a degrade followed by an unconditional ok,
  // which is invisible in the final status alone once a probe re-runs.
  // Record the ORDER of health pushes: the bug this guards was a reportDegraded
  // immediately overwritten by a reportOk, so only the sequence exposes it.
  // The three report methods have different signatures (`reportOk`'s detail is
  // optional, the other two require it), so they are wrapped individually —
  // one shared generic wrapper cannot be typed against all three.
  const pushed: string[] = [];
  const baseOk = f.health.reportOk.bind(f.health);
  const baseDegraded = f.health.reportDegraded.bind(f.health);
  const baseError = f.health.reportError.bind(f.health);
  f.health.reportOk = (component, detail) => {
    if (component === 'backups') pushed.push('ok');
    baseOk(component, detail);
  };
  f.health.reportDegraded = (component, detail) => {
    if (component === 'backups') pushed.push('degraded');
    baseDegraded(component, detail);
  };
  f.health.reportError = (component, message) => {
    if (component === 'backups') pushed.push('error');
    baseError(component, message);
  };

  // A clean run first: no dangling receipts, health ok.
  await f.service.runRestoreVerify(f.vaultId);
  expect(pushed).toEqual(['ok']);
  expect((await f.service.status())[f.vaultId]!.lastRestoreVerifyDangling).toBeUndefined();
  expect(
    (await f.health.snapshot()).components.find((c) => c.component === 'backups')?.status,
  ).toBe('ok');

  // Hard-delete the vault row a receipt names — the app-uninstall shape: the
  // command registry row goes, its receipts stay (history outlives its row).
  // The restored pair therefore carries a receipt pointing at nothing, which
  // is a signal for human review, NOT a failed restore.
  const { object_id: commandId } = f.plane.db.journal
    .prepare(
      `SELECT object_id FROM consent_receipt
        WHERE object_type = 'agent.command' AND object_id IS NOT NULL AND decision = 'allow'
        LIMIT 1`,
    )
    .get() as { object_id: string };
  f.plane.db.vault.prepare('DELETE FROM agent_capability WHERE command_id = ?').run(commandId);
  f.plane.db.vault.prepare('DELETE FROM agent_command WHERE command_id = ?').run(commandId);
  f.plane.walTick();
  await f.service.drainWal();

  await f.service.runRestoreVerify(f.vaultId); // must NOT throw
  // Terminal report for this run is the degrade — nothing paints over it.
  expect(pushed).toEqual(['ok', 'degraded']);

  const state = (await f.service.status())[f.vaultId]!;
  expect(state.lastRestoreVerifiedAt).toBeTruthy(); // the restore itself succeeded
  expect(state.lastRestoreVerifyError).toBeUndefined();
  expect(state.lastRestoreVerifyDangling).toBeGreaterThan(0); // …and it is PERSISTED

  // The probe recomputes from persisted state and its verdict overrides the
  // pushed one: without persistence this snapshot would flip back to green —
  // the same erasure one level down.
  const snap = await f.health.snapshot();
  const backups = snap.components.find((c) => c.component === 'backups');
  expect(backups?.status).toBe('degraded');
  expect(backups?.detail).toMatch(/receipt\(s\) referencing absent vault rows/);

  // Unit-level, same module the probe uses: the count alone is what degrades,
  // and its absence is what clears.
  const now = Date.now();
  const iso = (agoMs: number): string => new Date(now - agoMs).toISOString();
  const target: BackupTargetState = {
    targetId: state.targetId,
    label: state.label,
    generation: 1,
    lastSeq: 1,
    lastBackupAt: iso(30 * 60 * 1000),
    // Keep the new policy-derived RPO signal healthy so this unit-level
    // assertion isolates the restore-verification dangling-receipt verdict.
    lastWalDrainAt: iso(30 * 1000),
    lastVerifiedAt: iso(30 * 60 * 1000),
    lastRestoreVerifiedAt: iso(30 * 60 * 1000),
  };
  const evaluate = (t: BackupTargetState): ReturnType<typeof evaluateBackupHealth> =>
    evaluateBackupHealth({
      state: {
        targets: { [f.vaultId]: t },
        casReconciliations: {},
        sourceInstanceId: 'test',
        recoveryKit: { confirmedAt: null },
      },
      policyForVault: () => readBackupPolicy(f.plane.db.vault),
      now,
    });
  expect(evaluate({ ...target, lastRestoreVerifyDangling: 3 }).status).toBe('degraded');
  expect(evaluate(target).status).toBe('ok');
}, 45_000);

// ── 6. G8: receipts never dangle, at any PITR point, under a live co-writer ─

test('G8: with a second journal connection appending between gateway writes, every PITR point restores with ZERO dangling receipts', async () => {
  const f = await fx();
  await f.service.runBackup(f.vaultId);

  // A well-behaved out-of-process ledger writer stand-in (the tolerated
  // journal multi-writer case): its OWN connection, autocheckpoint off.
  const second = new DatabaseSync(path.join(f.plane.dir, 'journal.db'));
  cleanups.push(() => second.close());
  second.exec('PRAGMA busy_timeout = 10000');
  second.exec('PRAGMA wal_autocheckpoint = 0');
  second.exec(
    'CREATE TABLE IF NOT EXISTS _wale2e_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)',
  );
  const append = second.prepare('INSERT INTO _wale2e_ledger (v) VALUES (?)');

  const points: { tickMs: number; ledger: number; titles: string[] }[] = [];
  for (let i = 0; i < 6; i++) {
    append.run(`pre-${i}-${'z'.repeat(120)}`);
    invoke(f.plane, 'schedule.add_task', { title: `g8-task-${i}` }); // vault row + journal receipt
    append.run(`post-${i}-${'z'.repeat(120)}`);
    const report = f.shipper.tick();
    expect(report.breaks).toEqual([]);
    expect(report.errors).toEqual([]);
    points.push({
      tickMs: report.tickMs,
      ledger: probeCount(f.plane.db.journal, '_wale2e_ledger'),
      titles: vaultTitles(f.plane.db.vault),
    });
  }
  await f.service.drainWal();

  for (const point of [points[1]!, points[3]!, points[5]!]) {
    const dest = await restoreTo(f, { pointInTimeMs: point.tickMs });
    const pair = verifyRestoredPair(dest);
    expect(pair.vault.integrity).toBe('ok');
    expect(pair.journal.integrity).toBe('ok');
    expect(pair.receiptsChecked).toBeGreaterThan(0);
    expect(pair.danglingReceipts).toEqual([]); // the G8 acceptance criterion
    const rv = openRestored(dest, 'vault.db');
    const rj = openRestored(dest, 'journal.db');
    expect(vaultTitles(rv)).toEqual(point.titles);
    expect(probeCount(rj, '_wale2e_ledger')).toBe(point.ledger);
  }

  // Now LOSE the vault's newest segment objects. There is no hole and no
  // damage — the vault's listing simply ENDS, exactly as it would if the vault
  // had gone idle — so nothing in the stream itself can tell the difference.
  // Only the pair markers can, and every PITR point must STILL come back with
  // zero dangling receipts: the pair walks back to the newest tick the vault
  // can still PROVE it reached, rather than handing back a journal that runs
  // ahead of its vault.
  const targetId = (await f.service.status())[f.vaultId]!.targetId;
  const vaultSegments = (await walObjectFiles(f, targetId))
    .filter((file) => /wal[/\\]vault[/\\]/.test(file))
    .filter((file) => /^\d{12}-\d{12}-\d{13}$/.test(path.basename(file)))
    .sort();
  expect(vaultSegments.length).toBeGreaterThan(2);
  for (const victim of vaultSegments.slice(-2)) await fs.rm(victim);

  for (const point of points) {
    const dest = await restoreTo(f, { pointInTimeMs: point.tickMs });
    const pair = verifyRestoredPair(dest);
    expect(pair.vault.integrity).toBe('ok');
    expect(pair.journal.integrity).toBe('ok');
    expect(pair.danglingReceipts).toEqual([]);
    // Whatever tick each restore lands on, the ledger it hands back never runs
    // ahead of the vault state it is paired with.
    const rj = openRestored(dest, 'journal.db');
    expect(probeCount(rj, '_wale2e_ledger')).toBeLessThanOrEqual(point.ledger);
  }
}, 60_000);

// ── 8. G9: an entirely-lost segment stream must be LOUD, not green ─────────

test("G9: deleting the vault's ENTIRE segment stream fails restore-verify (it used to verify green)", async () => {
  const f = await fx();
  invoke(f.plane, 'schedule.add_task', { title: 'before-the-loss' });
  await f.service.runBackup(f.vaultId);

  // Real post-base history in BOTH databases, drained to the remote.
  for (let i = 0; i < 3; i++) {
    invoke(f.plane, 'schedule.add_task', { title: `lost-stream-${i}` });
    insertVault(f.plane, 10, 200, `lost-${i}`);
    f.plane.walTick();
  }
  await f.service.drainWal();
  await f.service.runRestoreVerify(f.vaultId); // healthy first
  expect((await f.service.status())[f.vaultId]!.lastRestoreVerifyError).toBeUndefined();

  // Delete EVERY vault segment object. No hole, no damage, no corruption — the
  // listing is simply empty, which is indistinguishable from "this database
  // never wrote anything" unless something else vouches for what it shipped.
  // That something is the pair marker. Without it (the old code) verify found
  // nothing missing, nothing corrupt, and reported OK over a backup whose
  // newest hours were unrecoverable.
  const state = (await f.service.status())[f.vaultId]!;
  const vaultSegments = (await walObjectFiles(f, state.targetId))
    .filter((file) => /wal[/\\]vault[/\\]/.test(file))
    .filter((file) => /^\d{12}-\d{12}-\d{13}$/.test(path.basename(file)));
  expect(vaultSegments.length).toBeGreaterThan(0);
  for (const file of vaultSegments) await fs.rm(file);

  await expect(f.service.runRestoreVerify(f.vaultId)).rejects.toThrow(
    /not restorable at their newest registered point/,
  );
  expect((await f.service.status())[f.vaultId]!.lastRestoreVerifyError).toMatch(
    /not restorable at their newest registered point/,
  );

  // The cheap scheduled verifier sees it too — it plans the same coordinated
  // cut restore does, rather than trusting a per-stream hole check that an
  // empty listing can never trip.
  const verify = await f.service.runVerify(f.vaultId);
  expect(verify!.missing.some((m) => /cannot be reassembled/.test(m))).toBe(true);
}, 60_000);

// ── 7. Measured: drained bytes are O(change), not O(database) ───────────────

test('measurement: drained sealed bytes for a known write volume are O(change), an order of magnitude story, not a DB re-upload', async () => {
  const f = await fx();
  // Bloat the database FIRST so "O(change)" is distinguishable from "O(db)":
  // the seed lands in the base snapshot, never in segments.
  insertVault(f.plane, 400, 8000, 'seed');
  await f.service.runBackup(f.vaultId);
  await f.service.drainWal();
  const logMark = f.logs.length;

  // The measured delta: ~256KB of committed rows, one transaction.
  const payloadBytes = insertVault(f.plane, 64, 4096, 'measured');
  f.plane.walTick();
  await f.service.drainWal();

  const drained = drainedBytes(f.logs, logMark);
  const dbBytes =
    statSync(path.join(f.plane.dir, 'vault.db')).size +
    statSync(path.join(f.plane.dir, 'journal.db')).size;
  console.log(
    `[wal-e2e measurement] payload=${payloadBytes}B drained=${drained.bytes}B ` +
      `(${drained.objects} object(s)) liveDbs=${dbBytes}B ` +
      `ratio drained/payload=${(drained.bytes / payloadBytes).toFixed(2)} ` +
      `drained/db=${(drained.bytes / dbBytes).toFixed(3)}`,
  );
  expect(drained.objects).toBeGreaterThan(0);
  // Within an order of magnitude of the change (WAL page images cost a
  // constant factor over row bytes)…
  expect(drained.bytes).toBeGreaterThanOrEqual(payloadBytes / 10);
  expect(drained.bytes).toBeLessThanOrEqual(payloadBytes * 10);
  // …and decisively smaller than the databases themselves.
  expect(drained.bytes).toBeLessThan(dbBytes / 2);
}, 30_000);

// ── 9. Marker deletion is DETECTED, and an interrupted drain never flaps ────

/**
 * A provider whose data plane refuses to accept pair markers while `blocked.on`
 * — the shape of a drain interrupted between a tick's segments and its marker
 * (the markers drain LAST). Everything else delegates to the real provider.
 */
function markerBlockingProvider(
  get: () => BackupProvider,
  blocked: { on: boolean },
): BackupProvider {
  const inner = {
    get p(): BackupProvider {
      return get();
    },
  };
  return {
    capabilities: () => inner.p.capabilities(),
    createTarget: (o) => inner.p.createTarget(o),
    deleteTarget: (t) => inner.p.deleteTarget(t),
    undeleteTarget: (t) => inner.p.undeleteTarget(t),
    purgeTarget: (t) => inner.p.purgeTarget(t),
    registerSnapshot: (t, r) => inner.p.registerSnapshot(t, r),
    listSnapshots: (t, o) => inner.p.listSnapshots(t, o),
    getSnapshot: (t, s) => inner.p.getSnapshot(t, s),
    getTarget: (t) => inner.p.getTarget(t),
    usage: (t) => inner.p.usage(t),
    openDataPlane: async (targetId, storeClass, mode) => {
      const store = await inner.p.openDataPlane(targetId, storeClass, mode);
      const wrapped: ObjectStore = {
        put: async (key, data) => {
          if (blocked.on && key.startsWith('wal/tick/')) {
            throw new Error('simulated drain interruption before the pair marker landed');
          }
          return store.put(key, data);
        },
        get: (key) => store.get(key),
        getStream: (key) => store.getStream(key),
        head: (key) => store.head(key),
        list: (prefix) => store.list(prefix),
        delete: (key) => store.delete(key),
      };
      return wrapped;
    },
  };
}

/** Every remote pair-marker object file for one target. */
async function markerObjectFiles(f: Fx, targetId: string): Promise<string[]> {
  return (await walObjectFiles(f, targetId)).filter((file) =>
    file.includes(`${path.sep}wal${path.sep}tick${path.sep}`),
  );
}

test('deleting ONLY the pair markers is DETECTED — restore degrades coherently, and says so', async () => {
  const f = await fx();
  invoke(f.plane, 'schedule.add_task', { title: 'before-marker-loss' });
  await f.service.runBackup(f.vaultId);

  // Real post-base history, drained — so markers actually LAND remotely.
  for (let i = 0; i < 3; i++) {
    invoke(f.plane, 'schedule.add_task', { title: `marker-loss-${i}` });
    insertVault(f.plane, 10, 200, `mloss-${i}`);
    f.plane.walTick();
  }
  await f.service.drainWal();

  // A second registration stamps the CONFIRMED-uploaded marker tip into the
  // manifest. That is the whole trick: the manifest only ever claims markers we
  // watched the provider accept, so the claim can never outrun reality.
  await f.service.runBackup(f.vaultId);
  const manifest = await openNewestManifest(f);
  const dbEntries = manifest.entries.filter((e) => e.kind === 'db');
  const tip = dbEntries[0]!.walTipTickMs!;
  expect(tip).toBeGreaterThan(0);
  expect(dbEntries.map((e) => e.walTipTickMs)).toEqual([tip, tip]);

  await f.service.runRestoreVerify(f.vaultId); // healthy while the markers exist
  expect((await f.service.status())[f.vaultId]!.lastRestoreVerifyError).toBeUndefined();

  // Now delete ONLY `wal/tick/`. Every segment and every closer survives. With
  // nothing vouching for what was shipped, a restore quietly falls back to the
  // base pair — coherent, correct, and SILENTLY hours stale. That is the
  // quietest possible data loss, and the manifest's tip is what makes it loud.
  const state = (await f.service.status())[f.vaultId]!;
  const markers = await markerObjectFiles(f, state.targetId);
  expect(markers.length).toBeGreaterThan(0);
  for (const file of markers) await fs.rm(file);
  expect(await markerObjectFiles(f, state.targetId)).toEqual([]);
  expect((await walObjectFiles(f, state.targetId)).length).toBeGreaterThan(0); // segments intact

  // The scheduled verifier sees it.
  const verify = await f.service.runVerify(f.vaultId);
  expect(verify!.missing.some((m) => /pair marker/.test(m))).toBe(true);

  // The weekly restore-verification goes RED rather than green…
  await expect(f.service.runRestoreVerify(f.vaultId)).rejects.toThrow(
    /not restorable at their newest registered point/,
  );

  // …and the restore itself still SUCCEEDS at the older coordinated point (G6:
  // degrade to an earlier consistent state, never refuse) — it is simply no
  // longer silent about having done so.
  const dest = await restoreTo(f);
  const pair = verifyRestoredPair(dest);
  expect(pair.vault.integrity).toBe('ok');
  expect(pair.journal.integrity).toBe('ok');
  expect(pair.danglingReceipts).toEqual([]);
  const rv = openRestored(dest, 'vault.db');
  expect(vaultTitles(rv)).toContain('before-marker-loss'); // the base pair survived
}, 60_000);

test('an INTERRUPTED drain (segments up, marker not) does NOT flap the check red', async () => {
  // The property that makes the check safe to ship. The manifest's tip names
  // only markers the provider CONFIRMED — so a drain that dies after a tick's
  // segments and before its marker simply yields a lower tip, never a claim the
  // store cannot honour.
  const blocked = { on: false };
  // The proxy resolves its inner provider LAZILY: `fx` mints the provider dir,
  // and every read helper in this file (walObjectFiles, openNewestManifest)
  // reads that same dir — a second root would be a different world.
  let inner: BackupProvider | undefined;
  const f = await fx({ provider: markerBlockingProvider(() => inner!, blocked) });
  inner = openLocalBackupProvider({ rootDir: f.providerDir });

  invoke(f.plane, 'schedule.add_task', { title: 'drain-interrupt' });
  await f.service.runBackup(f.vaultId);
  insertVault(f.plane, 10, 200, 'confirmed');
  f.plane.walTick();
  await f.service.drainWal(); // clean drain: segments AND markers land
  await f.service.runBackup(f.vaultId); // stamps the confirmed tip
  const confirmedTip = (await openNewestManifest(f)).entries.find(
    (e) => e.kind === 'db',
  )!.walTipTickMs!;
  expect(confirmedTip).toBeGreaterThan(0);

  // Now write more, and interrupt the drain exactly where it hurts: the tick's
  // segments upload, its marker does not.
  insertVault(f.plane, 10, 200, 'unconfirmed');
  const interrupted = f.shipper.tick();
  expect(interrupted.markers).toHaveLength(1);
  blocked.on = true;
  await f.service.drainWal(); // swallows the failure and retries later, by design
  blocked.on = false;
  // The marker is still sitting locally, un-uploaded — the interrupted state.
  expect(f.shipper.listUploadable().filter((i) => i.kind === 'marker').length).toBeGreaterThan(0);

  // A registration in THAT window must not claim the marker that never landed.
  await f.service.runBackup(f.vaultId);
  const tipAfter = (await openNewestManifest(f)).entries.find((e) => e.kind === 'db')!.walTipTickMs;
  expect(tipAfter).toBe(confirmedTip);
  expect(tipAfter).toBeLessThan(interrupted.tickMs);

  // …and everything stays GREEN: verify finds nothing missing, restore-verify
  // passes. A false red here would train the operator to ignore the one signal
  // that matters.
  const verify = await f.service.runVerify(f.vaultId);
  expect(verify!.missing).toEqual([]);
  expect(verify!.corrupt).toEqual([]);
  await f.service.runRestoreVerify(f.vaultId);
  expect((await f.service.status())[f.vaultId]!.lastRestoreVerifyError).toBeUndefined();

  // The retry lands the marker, and the next registration advances the tip.
  await f.service.drainWal();
  expect(f.shipper.listUploadable().filter((i) => i.kind === 'marker')).toEqual([]);
  await f.service.runBackup(f.vaultId);
  const healed = (await openNewestManifest(f)).entries.find((e) => e.kind === 'db')!.walTipTickMs!;
  expect(healed).toBeGreaterThanOrEqual(interrupted.tickMs);
}, 60_000);
