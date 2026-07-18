import { tempDirSync } from '@centraid/test-kit/temp-dir';
// governance: allow-repo-hygiene file-size-limit (#408) the detector suite shares real SQLite race hooks, restore helpers, and restart fixtures whose correctness depends on one common lifecycle harness
// WAL shipper detectors + lifecycle (issue #408): G5 foreign-actor
// detection (in-process stand-ins — the real second-process test lives in
// the gateway e2e rig), G7 crash-ordering/restart, generation lifecycle
// (first-run, cadence, explicit rolls, base registration, clean close +
// reopen), and the local disk budget. Real vaults, real sqlite, no mocks;
// capture-correctness tests live in wal-shipper.test.ts.

import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  FsObjectStore,
  replayWalSegments,
  sealWalCloser,
  sealWalPairMarker,
  sealWalSegment,
  WAL_HEADER_BYTES,
  walSalts,
  type WalDbName,
} from '@centraid/backup';
import { bootstrapVault } from './bootstrap.js';
import { openVaultDb, type VaultDb } from './db.js';
import { WalShipper, type UploadableWalFile, type WalShipperOptions } from './wal-shipper.js';

let root: string;
let vaultDir: string;
let db: VaultDb;
let clock: number;
const now = () => clock;

beforeEach(() => {
  root = tempDirSync('wal-det-');
  vaultDir = path.join(root, 'vault-a');
  db = openVaultDb({ dir: vaultDir });
  bootstrapVault(db, { ownerName: 'Priya' });
  db.vault.exec('CREATE TABLE _walship_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');
  db.journal.exec('CREATE TABLE _walship_jprobe (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');
  clock = 1_800_000_000_000;
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* some tests close the vault themselves */
  }
  rmSync(root, { recursive: true, force: true });
});

const shipDir = () => path.join(root, 'ship');

function makeShipper(opts: Partial<WalShipperOptions> = {}): WalShipper {
  return new WalShipper({ db, dir: shipDir(), now, ...opts });
}

function insertVault(rows: number, size = 100, marker = 'v'): void {
  const stmt = db.vault.prepare('INSERT INTO _walship_probe (v) VALUES (?)');
  for (let i = 0; i < rows; i++) stmt.run(`${marker}-${i}-${'x'.repeat(size)}`);
}

function insertJournal(rows: number, size = 100, marker = 'j'): void {
  const stmt = db.journal.prepare('INSERT INTO _walship_jprobe (v) VALUES (?)');
  for (let i = 0; i < rows; i++) stmt.run(`${marker}-${i}-${'x'.repeat(size)}`);
}

function walPath(name: WalDbName): string {
  return path.join(vaultDir, `${name}.db-wal`);
}

function walSize(name: WalDbName): number {
  return existsSync(walPath(name)) ? statSync(walPath(name)).size : 0;
}

/** The current WAL header's salts — the shipper's reset fingerprint. */
function readWalSalts(name: WalDbName): { salt1: number; salt2: number } {
  const fd = openSync(walPath(name), 'r');
  try {
    const header = Buffer.alloc(WAL_HEADER_BYTES);
    readSync(fd, header, 0, WAL_HEADER_BYTES, 0);
    return walSalts(header);
  } finally {
    closeSync(fd);
  }
}

function segsOf(shipper: WalShipper, name: WalDbName): UploadableWalFile[] {
  return shipper
    .listUploadable()
    .filter((i) => i.kind === 'segment' && i.addr!.db === name)
    .sort((a, b) => a.addr!.group - b.addr!.group || a.addr!.startOffset - b.addr!.startOffset);
}

/** A well-behaved second connection to journal.db (out-of-process writer stand-in). */
function openSecondJournal(): DatabaseSync {
  const c = new DatabaseSync(path.join(vaultDir, 'journal.db'));
  c.exec('PRAGMA busy_timeout = 5000');
  c.exec('PRAGMA wal_autocheckpoint = 0');
  return c;
}

/**
 * Commit a row from `writer` (a FOREIGN connection) at a chosen point INSIDE
 * the shipper's synchronous checkpoint path, by hooking the `prepare()` of the
 * pragma that runs there. `when` picks the window:
 *
 *  - `'wal_checkpoint(TRUNCATE)'` — after the pre-truncate stat has proven the
 *    WAL holds nothing past the captured offset, and before the checkpoint
 *    takes its writer lock. THE race: the frames are appended, then folded into
 *    the main database and zeroed from the WAL by the checkpoint that follows.
 *  - `'data_version'` — between the capture and that stat, where the frames are
 *    still in the WAL and can simply be CAPTURED (the cheap path).
 *
 * Fires exactly once. Returns the hook's fire count plus its undo.
 */
function raceJournalCommitAt(
  writer: DatabaseSync,
  when: string,
  value: string,
): { fired: () => number; undo: () => void } {
  const real = db.journal.prepare.bind(db.journal);
  let fired = 0;
  db.journal.prepare = ((sql: string) => {
    if (fired === 0 && sql.includes(when)) {
      fired += 1;
      writer.prepare('INSERT INTO _walship_jprobe (v) VALUES (?)').run(value);
    }
    return real(sql);
  }) as typeof db.journal.prepare;
  return { fired: () => fired, undo: () => void (db.journal.prepare = real) };
}

/**
 * Seal every uploadable and replay it over the shipper's CURRENT bases into a
 * fresh directory — the restore a real recovery performs, minus the provider.
 * Returns the destination dir.
 */
async function restoreCurrent(shipper: WalShipper, name: string): Promise<string> {
  const dataKey = new Uint8Array(32).fill(7);
  const store = new FsObjectStore(path.join(root, `objects-${name}`));
  for (const item of shipper.listUploadable()) {
    const sealed =
      item.kind === 'segment'
        ? sealWalSegment(dataKey, 'v1', item.addr!, readFileSync(item.file))
        : item.kind === 'closer'
          ? sealWalCloser(dataKey, 'v1', item.closer!)
          : sealWalPairMarker(dataKey, 'v1', item.marker!);
    await store.put(item.key, sealed);
  }
  const destDir = path.join(root, `restore-${name}`);
  mkdirSync(destDir, { recursive: true });
  const bases = shipper.currentBases();
  for (const base of bases) copyFileSync(base.file, path.join(destDir, `${base.db}.db`));
  const by = <T>(pick: (b: (typeof bases)[number]) => T): Partial<Record<WalDbName, T>> =>
    Object.fromEntries(bases.map((b) => [b.db, pick(b)])) as Partial<Record<WalDbName, T>>;
  await replayWalSegments({
    store,
    dataKey,
    vaultId: 'v1',
    destDir,
    generationByDb: by((b) => b.generation),
    baseTickMsByDb: by((b) => b.createdAtMs),
  });
  return destDir;
}

/** Rows of `_walship_jprobe` in a restored journal.db. */
function restoredJournalRows(destDir: string): string[] {
  const conn = new DatabaseSync(path.join(destDir, 'journal.db'), { readOnly: true });
  try {
    return (conn.prepare('SELECT v FROM _walship_jprobe ORDER BY id').all() as { v: string }[]).map(
      (r) => r.v,
    );
  } finally {
    conn.close();
  }
}

// --------------------------------------------------------------------- G5

test('[G5] a foreign checkpoint breaks the generation and mints a fresh pending base', () => {
  const shipper = makeShipper();
  shipper.tick();
  insertJournal(2, 200, 'shipped');
  clock += 1000;
  shipper.tick();
  const before = shipper.status().dbs.journal!;

  // Leave unshipped committed frames, then let a foreign actor checkpoint —
  // the frames get folded into journal.db behind the shipper's back.
  insertJournal(2, 200, 'folded');
  const c2 = new DatabaseSync(path.join(vaultDir, 'journal.db'));
  try {
    c2.exec('PRAGMA busy_timeout = 5000');
    c2.exec('PRAGMA wal_checkpoint(RESTART)');
  } finally {
    c2.close();
  }

  clock += 1000;
  const r = shipper.tick();
  const brk = r.breaks.find((b) => b.db === 'journal');
  expect(brk).toBeDefined();
  expect(brk!.reason).toMatch(/main-db|salt|shrank/);

  const after = shipper.status().dbs.journal!;
  expect(after.generation).not.toBe(before.generation);
  expect(after.generation).toMatch(/^[0-9a-f]{32}$/);
  expect(after.group).toBe(0);
  expect(after.offset).toBe(0);
  expect(after.basePending).toBe(true);
  const base = shipper.pendingBases().find((b) => b.db === 'journal');
  expect(base).toBeDefined();
  expect(base!.generation).toBe(after.generation);
  expect(existsSync(base!.file)).toBe(true);

  // The shipper keeps working: subsequent writes ship under the NEW generation.
  insertJournal(1, 100, 'post-break');
  clock += 1000;
  const r2 = shipper.tick();
  expect(r2.breaks).toEqual([]);
  expect(r2.errors).toEqual([]);
  expect(r2.shipped.some((k) => k.startsWith(`wal/journal/${after.generation}/`))).toBe(true);
});

test('[G5][#411] a foreign checkpoint increments foreignCheckpointCount, and it survives a restart', () => {
  const shipper = makeShipper();
  shipper.tick();
  // A clean stream has never seen a foreign checkpoint.
  expect(shipper.status().foreignCheckpointCount).toBe(0);
  expect(shipper.status().lastForeignCheckpoint).toBeUndefined();

  insertJournal(2, 200, 'shipped');
  clock += 1000;
  shipper.tick();

  // A foreign actor checkpoints journal.db behind the shipper's back.
  insertJournal(2, 200, 'folded');
  const c2 = new DatabaseSync(path.join(vaultDir, 'journal.db'));
  try {
    c2.exec('PRAGMA busy_timeout = 5000');
    c2.exec('PRAGMA wal_checkpoint(RESTART)');
  } finally {
    c2.close();
  }

  clock += 1000;
  const r = shipper.tick();
  expect(r.breaks.find((b) => b.db === 'journal')).toBeDefined();

  const status = shipper.status();
  // Counted exactly once: journal carried the foreign reason, vault re-based in
  // lockstep under a `coordinated:*` reason that must NOT be counted.
  expect(status.foreignCheckpointCount).toBe(1);
  expect(status.lastForeignCheckpoint).toMatchObject({ atMs: clock, db: 'journal' });
  expect(status.lastForeignCheckpoint!.reason).toMatch(/main-db|salt|shrank/);

  // Persisted on top-level state (not per-stream, which mintBase replaced): a
  // fresh shipper over the same dir reads the tally straight back.
  const shipper2 = makeShipper();
  expect(shipper2.status().foreignCheckpointCount).toBe(1);
  expect(shipper2.status().lastForeignCheckpoint).toEqual(status.lastForeignCheckpoint);
});

test('[G5][#411] deliberate breaks (first-run, rollGeneration) do NOT increment the counter', () => {
  const shipper = makeShipper();
  // The first tick mints both generations — a deliberate first-run break.
  const r0 = shipper.tick();
  expect(r0.breaks.map((b) => b.reason).sort()).toEqual(['first-run', 'first-run']);
  expect(shipper.status().foreignCheckpointCount).toBe(0);

  insertVault(2);
  clock += 1000;
  shipper.tick();

  // An explicit, requested generation roll (the key-epoch-rotation hook's path)
  // re-bases both databases — deliberate, so it is not a foreign checkpoint.
  clock += 1000;
  const rolled = shipper.rollGeneration('vault', 'key-epoch-rotation');
  expect(rolled.breaks.length).toBeGreaterThan(0);
  expect(shipper.status().foreignCheckpointCount).toBe(0);
  expect(shipper.status().lastForeignCheckpoint).toBeUndefined();
});

test('[G5] a vanished WAL file (with shipped offset) breaks the generation', () => {
  const shipper = makeShipper();
  shipper.tick();
  insertVault(2);
  clock += 1000;
  shipper.tick();
  expect(shipper.status().dbs.vault!.offset).toBeGreaterThan(0);

  rmSync(walPath('vault')); // no writes between the delete and the tick
  clock += 1000;
  const r = shipper.tick();
  expect(r.breaks.find((b) => b.db === 'vault')?.reason).toBe('wal-file-vanished');
  expect(shipper.status().dbs.vault!.basePending).toBe(true);
});

test('[G5] a mutated main-db file breaks the generation', () => {
  const shipper = makeShipper();
  shipper.tick();
  const genBefore = shipper.status().dbs.vault!.generation;

  const t = new Date(Date.now() + 5000);
  utimesSync(path.join(vaultDir, 'vault.db'), t, t);

  clock += 1000;
  const r = shipper.tick();
  expect(r.breaks.find((b) => b.db === 'vault')?.reason).toBe(
    'main-db-file-changed-without-our-checkpoint',
  );
  expect(shipper.status().dbs.vault!.generation).not.toBe(genBefore);
});

test('[G5] the database-header fingerprint catches a checkpoint hidden by stable size and mtime', () => {
  const shipper = makeShipper();
  shipper.tick();
  const dbPath = path.join(vaultDir, 'vault.db');
  const before = statSync(dbPath);

  insertVault(1, 200, 'foreign-fold');
  const foreign = new DatabaseSync(dbPath);
  try {
    foreign.exec('PRAGMA busy_timeout = 5000');
    foreign.exec('PRAGMA wal_checkpoint(RESTART)');
  } finally {
    foreign.close();
  }
  expect(statSync(dbPath).size).toBe(before.size);
  utimesSync(dbPath, before.atime, before.mtime);

  clock += 1000;
  const report = shipper.tick();
  expect(report.breaks.find((entry) => entry.db === 'vault')?.reason).toBe(
    'main-db-file-changed-without-our-checkpoint',
  );
});

// -------------------------------------- G5: the capture → TRUNCATE race (P0)

test('[G5] a writer that races the TRUNCATE is DETECTED, and its row survives the restore', async () => {
  // The hole this whole feature exists to forbid. A foreign connection commits
  // after the shipper has captured the WAL and before the checkpoint takes its
  // writer lock. The checkpoint folds those frames into journal.db and ZEROES
  // them from the WAL: they are in no segment, and the generation's base
  // predates them. Undetected, they are gone from the backup stream forever.
  //
  // The old detector compared SQLite's `checkpointed` frame count against what
  // we had shipped — but a SUCCESSFUL TRUNCATE returns {busy:0, log:0,
  // checkpointed:0} (it resets both counters), so it could never fire and this
  // restore came back SILENTLY missing the row.
  const shipper = makeShipper();
  shipper.tick();
  insertJournal(2, 200, 'shipped-before-the-race');
  clock += 1000;
  shipper.tick();
  const before = shipper.status().dbs.journal!;
  expect(before.offset).toBeGreaterThan(0);

  const writer = openSecondJournal();
  const hook = raceJournalCommitAt(writer, 'wal_checkpoint(TRUNCATE)', 'RACED-THE-CHECKPOINT');
  let report;
  try {
    clock += 1000;
    report = shipper.checkpointNow();
  } finally {
    hook.undo();
    writer.close();
  }
  expect(hook.fired()).toBe(1); // the racer really committed inside the window
  expect(report.errors).toEqual([]);
  // The row IS in the live database — the checkpoint folded it in there.
  expect(
    db.journal
      .prepare("SELECT count(*) AS n FROM _walship_jprobe WHERE v = 'RACED-THE-CHECKPOINT'")
      .get(),
  ).toEqual({ n: 1 });

  // THE assertion: a restore of the resulting stream must carry it. It does —
  // not because the frames were shipped (they cannot be; they were zeroed) but
  // because the race is DETECTED and healed with a fresh base cloned from the
  // main file the checkpoint just folded them into. Detection is the entire
  // fix; without it this list is missing the row.
  const restored = restoredJournalRows(await restoreCurrent(shipper, 'raced'));
  expect(restored).toContain('RACED-THE-CHECKPOINT');
  expect(restored.filter((v) => v.startsWith('shipped-before-the-race'))).toHaveLength(2);

  // …and the healing is exactly the coordinated generation break.
  expect(report.breaks).toEqual([
    { db: 'journal', reason: 'checkpoint-raced-writer' },
    { db: 'vault', reason: 'coordinated:checkpoint-raced-writer' },
  ]);
  const after = shipper.status().dbs.journal!;
  expect(after.generation).not.toBe(before.generation);
  expect(after.basePending).toBe(true);
  expect(shipper.basesCoordinated()).toBe(true);
  // A condemned stream gets NO group closer: one would assert "group N ends at
  // exactly `offset`" over frames that were folded away — a forgery a restore
  // trusts absolutely.
  expect(
    shipper
      .listUploadable()
      .filter((i) => i.kind === 'closer' && i.closer!.generation === before.generation),
  ).toEqual([]);
});

test('[G5] a commit landing BEFORE the pre-truncate stat is CAPTURED — the cheap path, no break', async () => {
  // The commoner race by far: a writer commits while the shipper is between its
  // capture and its checkpoint. Those frames are still IN the WAL — nothing has
  // truncated yet — so the right answer is to capture them, not to pay for a
  // whole fresh base. The `data_version` reading is taken BEFORE the stat that
  // proves the WAL is at the captured end, precisely so this commit is visible
  // to the stat rather than silently baked into the reading.
  const shipper = makeShipper();
  shipper.tick();
  insertJournal(2, 200, 'before');
  clock += 1000;
  shipper.tick();
  const before = shipper.status().dbs.journal!;

  const writer = openSecondJournal();
  const hook = raceJournalCommitAt(writer, 'data_version', 'CAPTURED-NOT-FOLDED');
  let report;
  try {
    clock += 1000;
    report = shipper.checkpointNow();
  } finally {
    hook.undo();
    writer.close();
  }
  expect(hook.fired()).toBe(1);
  expect(report.errors).toEqual([]);
  // Cheap path: SHIPPED, not folded — no generation break, same generation.
  expect(report.breaks).toEqual([]);
  expect(shipper.status().dbs.journal!.generation).toBe(before.generation);
  const carried = segsOf(shipper, 'journal').some((s) =>
    readFileSync(s.file).includes('CAPTURED-NOT-FOLDED'),
  );
  expect(carried).toBe(true);
  expect(restoredJournalRows(await restoreCurrent(shipper, 'cheap'))).toContain(
    'CAPTURED-NOT-FOLDED',
  );
});

test('[G5] a foreign commit plus checkpoint inside data_version cannot disappear silently', async () => {
  const shipper = makeShipper();
  shipper.tick();
  insertJournal(1, 200, 'before');
  clock += 1000;
  shipper.tick();

  const writer = openSecondJournal();
  const real = db.journal.prepare.bind(db.journal);
  let fired = 0;
  db.journal.prepare = ((sql: string) => {
    if (fired === 0 && sql.includes('data_version')) {
      fired++;
      writer.prepare('INSERT INTO _walship_jprobe (v) VALUES (?)').run('COMMIT-AND-CHECKPOINT');
      writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }
    return real(sql);
  }) as typeof db.journal.prepare;
  let report;
  try {
    clock += 1000;
    report = shipper.checkpointNow();
  } finally {
    db.journal.prepare = real;
    writer.close();
  }

  expect(fired).toBe(1);
  expect(report.breaks.map((entry) => entry.db)).toEqual(['journal', 'vault']);
  expect(report.markers).toEqual([]);
  expect(restoredJournalRows(await restoreCurrent(shipper, 'commit-checkpoint'))).toContain(
    'COMMIT-AND-CHECKPOINT',
  );
});

test('[G5] the quiet path does NOT break: our own TRUNCATE and our own writes never look like a race', () => {
  // The guard on the detector itself. `data_version` is only usable because it
  // is stable across OUR checkpoint and OUR connection's writes — if either
  // ever started bumping it, every rollover would look like a race and the
  // shipper would re-base (a whole-database clone) on every single group. That
  // failure would otherwise be silent and expensive; here it is loud.
  const shipper = makeShipper({ walSizeThresholdBytes: 8192 });
  shipper.tick();
  const before = {
    vault: shipper.status().dbs.vault!.generation,
    journal: shipper.status().dbs.journal!.generation,
  };

  // A foreign connection is OPEN throughout, reading (reads must not count) —
  // while every WRITE goes through the shipper's own handles.
  const reader = openSecondJournal();
  let rolled = 0;
  try {
    for (let i = 0; i < 3; i++) {
      insertJournal(3, 4000, `quiet-${i}`);
      insertVault(3, 4000, `quiet-${i}`);
      reader.prepare('SELECT count(*) AS n FROM _walship_jprobe').get();
      clock += 1000;
      const r = shipper.tick();
      expect(r.breaks).toEqual([]);
      expect(r.errors).toEqual([]);
      rolled += r.rolled.length;
    }
  } finally {
    reader.close();
  }
  expect(rolled).toBeGreaterThan(0); // rollovers really ran, so TRUNCATE really ran
  expect(shipper.status().dbs.vault!.generation).toBe(before.vault);
  expect(shipper.status().dbs.journal!.generation).toBe(before.journal);
});

// -------------------------------- I2: the capture micro read-lock (issue #411)

test('[I2] the capture read-mark pins the WAL: a foreign TRUNCATE/RESTART busys, no reset', () => {
  // Action 2 of issue #411, belt-and-suspenders to the after-the-fact detection.
  // capture() holds a short read snapshot over the byte copy — the SAME
  // acquisition the shipper uses: a read-only connection, BEGIN, then a read
  // that materializes the snapshot and grabs the WAL read mark. While that mark
  // is held, NO checkpointer in ANY process may reset or truncate the WAL past
  // it. This proves the mechanism the shipper leans on, on this exact
  // node:sqlite runtime, with real files (the real cross-process case lives in
  // the gateway e2e rig).
  insertJournal(6, 200, 'pinned'); // WAL now carries a header + committed frames
  expect(walSize('journal')).toBeGreaterThan(WAL_HEADER_BYTES);
  const saltsBefore = readWalSalts('journal');
  const sizeBefore = walSize('journal');

  const lock = new DatabaseSync(path.join(vaultDir, 'journal.db'), { readOnly: true });
  lock.exec('BEGIN');
  lock.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get();

  const foreign = openSecondJournal();
  foreign.exec('PRAGMA busy_timeout = 100'); // don't block the test on the pin
  try {
    for (const mode of ['TRUNCATE', 'RESTART']) {
      const row = foreign.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as { busy: number };
      expect(row.busy).toBe(1); // pinned — the checkpoint cannot proceed
    }
    // The WAL is byte-for-byte what it was: nothing reset it under the reader.
    expect(walSize('journal')).toBe(sizeBefore);
    expect(readWalSalts('journal')).toEqual(saltsBefore);
  } finally {
    lock.exec('ROLLBACK');
    lock.close();
  }

  // Once the mark is released the SAME TRUNCATE succeeds and resets the WAL —
  // proving the read mark, not some unrelated lock, was what held it.
  foreign.exec('PRAGMA busy_timeout = 5000');
  const after = foreign.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number };
  expect(after.busy).toBe(0);
  expect(walSize('journal')).toBe(0);
  foreign.close();
});

test('[I2] capture ships correct committed bytes with the read-lock in place', async () => {
  // The lock wraps every real capture now; the copy it protects must still be
  // byte-correct end to end. Insert, tick, and prove a full seal→replay
  // round-trip carries exactly the committed rows.
  const shipper = makeShipper();
  shipper.tick();
  insertJournal(3, 200, 'locked-capture');
  clock += 1000;
  const r = shipper.tick();
  expect(r.breaks).toEqual([]);
  expect(r.errors).toEqual([]);
  expect(r.shipped.length).toBeGreaterThan(0);

  const rows = restoredJournalRows(await restoreCurrent(shipper, 'locked'));
  expect(rows.filter((v) => v.startsWith('locked-capture')).length).toBe(3);
});

test('[I2] the read-lock never blocks the shipper OWN truncate — a rollover still cuts', () => {
  // The one scoping invariant the lock must honor: it is released BEFORE the
  // shipper's own TRUNCATE. capture() and truncate() are separate calls, and
  // capture()'s finally releases first — so a rollover checkpoint is NOT busy
  // against our own reader. Widening the lock to span the truncate would turn
  // this rollover busy and red.
  const shipper = makeShipper({ walSizeThresholdBytes: 8192 });
  shipper.tick();
  insertJournal(4, 4000, 'roll-under-lock');
  clock += 1000;
  const r = shipper.tick();
  expect(r.busy).toEqual([]);
  expect(r.breaks).toEqual([]);
  expect(r.errors).toEqual([]);
  expect(r.rolled.some((x) => x.db === 'journal')).toBe(true);
  expect(walSize('journal')).toBe(0); // truncated cleanly by our own checkpoint
});

// --------------------------------------------------------------------- G7

test('[G7] a fresh shipper over the same dir continues the stream without a break', () => {
  const shipper = makeShipper();
  shipper.tick();
  insertVault(2);
  clock += 1000;
  shipper.tick();
  const before = shipper.status().dbs.vault!;

  const shipper2 = makeShipper();
  expect(shipper2.status().dbs.vault).toEqual(before); // same generation/group/offset

  insertVault(1, 100, 'after-restart');
  clock += 1000;
  const r = shipper2.tick();
  expect(r.breaks).toEqual([]);
  expect(r.errors).toEqual([]);
  const seg = segsOf(shipper2, 'vault').at(-1)!;
  expect(seg.addr!.generation).toBe(before.generation);
  expect(seg.addr!.startOffset).toBe(before.offset);
});

test('[G7] crash between segment-fsync and offset-fsync: hygiene drops the stray, re-ship extends the same start', () => {
  const stateFile = path.join(shipDir(), 'state.json');
  const shipper = makeShipper();
  shipper.tick();
  insertVault(2);
  clock += 1000;
  shipper.tick();
  const offX = shipper.status().dbs.vault!.offset;

  insertVault(2, 100, 'more');
  const savedState = readFileSync(stateFile); // state BEFORE the next tick
  clock += 1000;
  shipper.tick(); // writes segment [offX, offY) AND advances state
  const offY = shipper.status().dbs.vault!.offset;
  expect(offY).toBeGreaterThan(offX);
  const stray = segsOf(shipper, 'vault').find((s) => s.addr!.startOffset === offX);
  expect(stray).toBeDefined();

  // "Crash" after the segment fsync but before the state fsync: the durable
  // state still says offX while the segment file for [offX, offY) exists.
  writeFileSync(stateFile, savedState);
  const shipper2 = makeShipper();
  // Startup hygiene deleted the unacknowledged segment (end > persisted offset)...
  expect(existsSync(stray!.file)).toBe(false);
  expect(shipper2.status().dbs.vault!.offset).toBe(offX);

  // ...and the next tick re-ships from the old offset. The re-captured range
  // is a prefix-extension: same start, end >= the old end (byte-identity of
  // retried SEALED objects is covered in @centraid/backup's wal-format tests).
  clock += 1000;
  const r = shipper2.tick();
  expect(r.breaks).toEqual([]);
  expect(r.errors).toEqual([]);
  const reshipped = segsOf(shipper2, 'vault').find((s) => s.addr!.startOffset === offX);
  expect(reshipped).toBeDefined();
  expect(reshipped!.addr!.endOffset).toBeGreaterThanOrEqual(offY);
});

// --------------------------------------------------- base/generation lifecycle

test('first-ever tick mints generations whose base clones hash-verify, reported as first-run', () => {
  const shipper = makeShipper();
  const r = shipper.tick();
  expect(r.breaks).toEqual([
    { db: 'journal', reason: 'first-run' },
    { db: 'vault', reason: 'first-run' },
  ]);
  const bases = shipper.pendingBases();
  expect(bases.map((b) => b.db).sort()).toEqual(['journal', 'vault']);
  for (const base of bases) {
    expect(existsSync(base.file)).toBe(true);
    const recomputed = createHash('sha256').update(readFileSync(base.file)).digest('hex');
    expect(base.sha256).toBe(recomputed);
    expect(statSync(base.file).size).toBeGreaterThan(0);
  }
});

test('base cadence: an expired baseIntervalMs breaks the generation on the next tick', () => {
  const shipper = makeShipper({ baseIntervalMs: 10 });
  shipper.tick();
  const genBefore = shipper.status().dbs.vault!.generation;

  clock += 50; // past the 10ms cadence
  const r = shipper.tick();
  expect(
    r.breaks
      .filter((b) => b.reason === 'base-cadence')
      .map((b) => b.db)
      .sort(),
  ).toEqual(['journal', 'vault']);
  expect(shipper.status().dbs.vault!.generation).not.toBe(genBefore);
});

test("rollGeneration ships the old generation's pending bytes, then breaks BOTH databases", () => {
  const shipper = makeShipper();
  shipper.tick();
  const genBefore = {
    vault: shipper.status().dbs.vault!.generation,
    journal: shipper.status().dbs.journal!.generation,
  };
  insertVault(2, 200, 'pending');

  clock += 1000;
  const r = shipper.rollGeneration('vault', 'test-reason');
  // The pending committed bytes shipped under the OLD generation first...
  expect(r.shipped.some((k) => k.startsWith(`wal/vault/${genBefore.vault}/`))).toBe(true);
  // ...and the break took BOTH databases with it, journal first. A roll that
  // re-based only the named database would leave two bases from two ticks —
  // a pair with no coordinated restore point between them, which the producer
  // then refuses to register at all.
  expect(r.breaks).toEqual([
    { db: 'journal', reason: 'coordinated:test-reason' },
    { db: 'vault', reason: 'test-reason' },
  ]);
  const after = shipper.status().dbs.vault!;
  expect(after.generation).not.toBe(genBefore.vault);
  expect(shipper.status().dbs.journal!.generation).not.toBe(genBefore.journal);
  expect(after.group).toBe(0);
  expect(after.offset).toBe(0);
  expect(shipper.basesCoordinated()).toBe(true);
  const bases = shipper.currentBases();
  expect(bases[0]!.createdAtMs).toBe(bases[1]!.createdAtMs);
});

// ------------------------------------------------- coordinated breaks (G8)

test('a JOURNAL-only break reason re-bases the VAULT too, in the same tick', () => {
  const shipper = makeShipper();
  shipper.tick();
  const before = {
    vault: shipper.status().dbs.vault!.generation,
    journal: shipper.status().dbs.journal!.generation,
  };
  insertVault(2, 200, 'vault-history');
  clock += 1000;
  shipper.tick();

  // A foreign actor checkpoints journal.db — the classic journal-only detector
  // (its subprocess writers make this the most plausible recurring break).
  insertJournal(2, 200, 'folded');
  const c2 = new DatabaseSync(path.join(vaultDir, 'journal.db'));
  try {
    c2.exec('PRAGMA busy_timeout = 5000');
    c2.exec('PRAGMA wal_checkpoint(RESTART)');
  } finally {
    c2.close();
  }

  clock += 1000;
  const r = shipper.tick();
  // Journal broke for its own detected reason; the vault broke WITH it.
  expect(r.breaks.map((b) => b.db)).toEqual(['journal', 'vault']);
  expect(r.breaks.find((b) => b.db === 'journal')!.reason).toMatch(/main-db|salt|shrank/);
  expect(r.breaks.find((b) => b.db === 'vault')!.reason).toMatch(/^coordinated:/);
  expect(shipper.status().dbs.vault!.generation).not.toBe(before.vault);
  expect(shipper.status().dbs.journal!.generation).not.toBe(before.journal);

  // The two bases are ONE instant — the property every restore asserts.
  const bases = shipper.currentBases();
  expect(bases[0]!.createdAtMs).toBe(bases[1]!.createdAtMs);
  expect(shipper.basesCoordinated()).toBe(true);
});

test('[G8] the coordinated break TRUNCATES the journal before the vault — observed, not inferred', () => {
  // The crux of the whole ordering argument, and the one that looks right when
  // it is wrong. A base's effective instant is its TRUNCATE instant, NOT its
  // copyFileSync instant: the clone reads the MAIN file, and everything
  // committed after the truncate lands in the new generation's WAL. So code
  // that carefully clones the journal first while truncating the vault first is
  // ordered BACKWARDS — and produces a journal base older than its vault base,
  // which is the SAFE direction only by accident. Watch the checkpoints
  // themselves.
  const order: string[] = [];
  const spy = (conn: DatabaseSync, name: string): void => {
    const real = conn.prepare.bind(conn);
    conn.prepare = (sql: string) => {
      if (sql.includes('wal_checkpoint(TRUNCATE)')) order.push(name);
      return real(sql);
    };
  };
  spy(db.vault, 'vault');
  spy(db.journal, 'journal');

  const shipper = makeShipper();
  shipper.tick(); // first-run: the coordinated break that mints both generations
  expect(order).toEqual(['journal', 'vault']);

  // …and the two bases it cloned carry the SAME tick, which is the property the
  // manifest records and every restore asserts.
  const bases = shipper.currentBases();
  expect(bases[0]!.createdAtMs).toBe(bases[1]!.createdAtMs);
});

test('busy sibling: the break DEFERS — no base is minted for either database', () => {
  const shipper = makeShipper();
  shipper.tick();
  const before = {
    vault: shipper.status().dbs.vault!.generation,
    journal: shipper.status().dbs.journal!.generation,
  };
  const baseTickBefore = shipper.currentBases()[0]!.createdAtMs;
  insertVault(2, 200, 'pre-break');
  clock += 1000;
  shipper.tick();

  // Hold vault.db's checkpoint open so its TRUNCATE comes back busy. The
  // journal is cut FIRST, so by then its WAL is already truncated — and the
  // whole point of doing both truncates before either CLONE is that nothing
  // irreversible has happened yet.
  const reader = new DatabaseSync(path.join(vaultDir, 'vault.db'));
  try {
    reader.exec('PRAGMA busy_timeout = 5000');
    reader.exec('BEGIN IMMEDIATE');
    reader.prepare('INSERT INTO _walship_probe (v) VALUES (?)').run('holding-the-write-lock');

    clock += 1000;
    const r = shipper.rollGeneration('journal', 'forced-roll');
    expect(r.busy).toContain('vault');
    expect(r.breaks).toEqual([]); // NO base minted, for either database
    expect(shipper.status().dbs.vault!.generation).toBe(before.vault);
    expect(shipper.status().dbs.journal!.generation).toBe(before.journal);
    // The pair is not registerable while a break is mid-flight.
    expect(shipper.basesCoordinated()).toBe(false);
    reader.exec('ROLLBACK');
  } finally {
    reader.close();
  }

  // The retry lands: BOTH databases re-base, in one tick, carrying the deferred
  // reason.
  clock += 1000;
  const r2 = shipper.tick();
  expect(r2.breaks.map((b) => b.db)).toEqual(['journal', 'vault']);
  expect(shipper.status().dbs.vault!.generation).not.toBe(before.vault);
  expect(shipper.status().dbs.journal!.generation).not.toBe(before.journal);
  expect(shipper.basesCoordinated()).toBe(true);
  const bases = shipper.currentBases();
  expect(bases[0]!.createdAtMs).toBe(bases[1]!.createdAtMs);
  expect(bases[0]!.createdAtMs).toBeGreaterThan(baseTickBefore);
});

test('a deferred break survives a RESTART — the frozen stream never resumes shipping', () => {
  const shipper = makeShipper();
  shipper.tick();
  const before = shipper.status().dbs.journal!.generation;

  const reader = new DatabaseSync(path.join(vaultDir, 'vault.db'));
  try {
    reader.exec('PRAGMA busy_timeout = 5000');
    reader.exec('BEGIN IMMEDIATE');
    reader.prepare('INSERT INTO _walship_probe (v) VALUES (?)').run('lock');
    clock += 1000;
    expect(shipper.rollGeneration('journal', 'forced-roll').busy).toContain('vault');
    reader.exec('ROLLBACK');
  } finally {
    reader.close();
  }

  // A fresh shipper over the same dir reads `breakPending` off the state file:
  // without it, the next boot would resume a stream whose sibling is mid-break,
  // and the pair of bases that eventually registered would be two instants.
  const shipper2 = makeShipper();
  expect(shipper2.basesCoordinated()).toBe(false);
  insertJournal(2, 200, 'must-not-ship-under-the-old-generation');
  clock += 1000;
  const r = shipper2.tick();
  expect(r.shipped.filter((k) => k.startsWith(`wal/journal/${before}/`))).toEqual([]);
  expect(r.breaks.map((b) => b.db)).toEqual(['journal', 'vault']);
  expect(shipper2.basesCoordinated()).toBe(true);
});

// ------------------------------------------------------------- pair markers

test('pair markers: a JOURNAL-only tick still emits ONE marker, carrying the vault position', () => {
  const shipper = makeShipper();
  shipper.tick();
  insertVault(2, 200, 'v');
  clock += 1000;
  shipper.tick();
  const vaultAt = shipper.status().dbs.vault!;

  // The vault goes idle; only the journal moves. The marker MUST still record
  // the vault's (unchanged) position — that is precisely how a restore later
  // tells "the vault was idle" from "the vault's segments are gone".
  insertJournal(2, 200, 'j');
  clock += 1000;
  const r = shipper.tick();
  expect(r.shipped.every((k) => k.startsWith('wal/journal/'))).toBe(true);
  expect(r.markers).toHaveLength(1);

  const written = shipper.listUploadable().filter((i) => i.kind === 'marker');
  const newest = written.at(-1)!;
  expect(newest.key).toBe(r.markers[0]);
  expect(newest.marker!.tickMs).toBe(r.tickMs);
  expect(newest.marker!.vault).toEqual({ group: vaultAt.group, endOffset: vaultAt.offset });
  expect(newest.marker!.journal.endOffset).toBe(shipper.status().dbs.journal!.offset);
});

test('pair markers: a tick that changes nothing emits NO marker', () => {
  const shipper = makeShipper();
  shipper.tick();
  insertVault(1, 100, 'v');
  clock += 1000;
  expect(shipper.tick().markers).toHaveLength(1);

  clock += 1000;
  const idle = shipper.tick();
  expect(idle.shipped).toEqual([]);
  expect(idle.markers).toEqual([]);
  // Nothing moved, so restoring "at this tick" is identical to restoring at the
  // previous marker — an object for it would be pure cost.
});

test('pair markers: a tick that ends in a BREAK emits none (both databases are at their base)', () => {
  const shipper = makeShipper({ baseIntervalMs: 10 });
  const first = shipper.tick();
  expect(first.breaks.map((b) => b.reason)).toEqual(['first-run', 'first-run']);
  expect(first.markers).toEqual([]);

  insertVault(2, 200, 'v');
  clock += 50; // past the base cadence
  const r = shipper.tick();
  expect(r.breaks.map((b) => b.db)).toEqual(['journal', 'vault']);
  // Both streams are at (0, 0) of fresh generations — that IS the base pair,
  // the floor a restore already falls back to.
  expect(r.markers).toEqual([]);
  expect(shipper.status().dbs.vault!.offset).toBe(0);
});

test('listUploadable orders a marker AFTER the segments and closers it describes', () => {
  const shipper = makeShipper({ walSizeThresholdBytes: 8192 });
  shipper.tick();
  insertVault(3, 4000, 'roll-me');
  clock += 1000;
  const r = shipper.tick();
  expect(r.rolled.some((x) => x.db === 'vault')).toBe(true);
  expect(r.markers).toHaveLength(1);

  const items = shipper.listUploadable();
  const lastNonMarker = items.map((i) => i.kind).lastIndexOf('closer');
  const firstMarker = items.findIndex((i) => i.kind === 'marker');
  expect(firstMarker).toBeGreaterThan(lastNonMarker);
  expect(items.findLastIndex((i) => i.kind === 'segment')).toBeLessThan(firstMarker);
  // An orphan marker is merely unsatisfiable (a safe walk-back), so this is not
  // a correctness rule — but the reverse order costs a tick of RPO on every
  // interrupted drain.
});

test('noteBaseRegistered clears pendingBases but keeps currentBases', () => {
  const shipper = makeShipper();
  shipper.tick();
  const gen = shipper.status().dbs.vault!.generation;
  expect(shipper.pendingBases()).toHaveLength(2);

  shipper.noteBaseRegistered('vault', gen);
  expect(shipper.pendingBases().map((b) => b.db)).toEqual(['journal']);
  expect(
    shipper
      .currentBases()
      .map((b) => b.db)
      .sort(),
  ).toEqual(['journal', 'vault']);
  expect(shipper.status().dbs.vault!.basePending).toBe(false);

  // A registration for a stale generation is a no-op.
  shipper.noteBaseRegistered('journal', 'f'.repeat(32));
  expect(shipper.pendingBases().map((b) => b.db)).toEqual(['journal']);
});

test("close() then reopen: the next shipper's first tick does NOT break the generation", () => {
  const shipper = makeShipper();
  shipper.tick();
  insertVault(2);
  clock += 1000;
  shipper.tick();

  const closeReport = shipper.close();
  expect(closeReport.busy).toEqual([]);
  expect(closeReport.errors).toEqual([]);
  expect(walSize('vault')).toBe(0); // WAL empty after the final ship+truncate
  expect(walSize('journal')).toBe(0);
  const closed = shipper.status().dbs;
  const state = JSON.parse(readFileSync(path.join(shipDir(), 'state.json'), 'utf8')) as {
    dbs: Record<string, { closedClean: boolean }>;
  };
  expect(state.dbs['vault']!.closedClean).toBe(true);
  expect(state.dbs['journal']!.closedClean).toBe(true);
  expect(() => shipper.tick()).toThrow(/closed/);

  // Reopen the vault the way the gateway shutdown/startup path does.
  db.close({ skipOptimize: true });
  db = openVaultDb({ dir: vaultDir });
  const shipper2 = makeShipper();
  clock += 1000;
  const r = shipper2.tick();
  // THE restart-cleanliness property: no spurious main-db/salt/shrink break.
  expect(r.breaks).toEqual([]);
  expect(r.errors).toEqual([]);
  expect(r.busy).toEqual([]);
  expect(shipper2.status().dbs.vault!.generation).toBe(closed.vault!.generation);
  expect(shipper2.status().dbs.vault!.group).toBe(closed.vault!.group);

  // Subsequent writes ship under the SAME generation, in the next group.
  insertVault(1, 100, 'after-reopen');
  clock += 1000;
  const r2 = shipper2.tick();
  expect(r2.breaks).toEqual([]);
  const seg = segsOf(shipper2, 'vault').at(-1)!;
  expect(seg.addr!.generation).toBe(closed.vault!.generation);
  expect(seg.addr!.group).toBe(closed.vault!.group);
});

// ------------------------------------------------------------- local budget

test('local budget: over-budget segments break the generations and drop never-restorable history', () => {
  const shipper = makeShipper({ localBudgetBytes: 1000 });
  const first = shipper.tick(); // first-run; nothing local yet
  expect(first.breaks.map((b) => b.reason)).toEqual(['first-run', 'first-run']);
  const genBefore = shipper.status().dbs.vault!.generation;

  insertVault(2, 500, 'bulky'); // one segment already exceeds 1000 bytes
  clock += 1000;
  const r = shipper.tick();
  expect(r.shipped.some((k) => k.startsWith(`wal/vault/${genBefore}/`))).toBe(true);
  expect(
    r.breaks
      .filter((b) => b.reason === 'local-budget')
      .map((b) => b.db)
      .sort(),
  ).toEqual(['journal', 'vault']);
  expect(shipper.status().dbs.vault!.generation).not.toBe(genBefore);
  expect(shipper.status().dbs.vault!.basePending).toBe(true);

  // The old generation was never registered (basePending) ⇒ its local
  // segments are gone; nothing uploadable remains from it.
  expect(existsSync(path.join(shipDir(), 'segments', 'vault', genBefore))).toBe(false);
  expect(
    shipper
      .listUploadable()
      .filter((i) => i.kind === 'segment' && i.addr!.generation === genBefore),
  ).toEqual([]);
});
