// governance: allow-repo-hygiene file-size-limit (#408) one real-vault capture suite — every case drives the same openVaultDb + bootstrapVault + real-WAL fixture through a different guarantee; sharding it would clone that fixture per file and let the copies drift
// WAL shipper capture correctness (issue #408): G1/G2/G3 capture, G4
// backpressure, rollover + closers, and the end-to-end capture→seal→replay
// round-trip over a REAL vault (openVaultDb + bootstrapVault, real
// node:sqlite, real files — no mocks). Detector (G5), crash-ordering (G7)
// and generation-lifecycle tests live in wal-shipper-detectors.test.ts.

import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  FsObjectStore,
  replayWalSegments,
  sealWalCloser,
  sealWalPairMarker,
  sealWalSegment,
  walGroupCloserKey,
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
  root = mkdtempSync(path.join(tmpdir(), 'wal-ship-'));
  vaultDir = path.join(root, 'vault-a');
  db = openVaultDb({ dir: vaultDir });
  bootstrapVault(db, { ownerName: 'Priya' });
  // Scratch tables the tests write through — created BEFORE the shipper so
  // they are part of the first-run base snapshot.
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

/** Local segment files for one db, in replay (offset) order. */
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

// --------------------------------------------------------------- G1/G2/G3

test('[G1] a committed write ships a segment byte-identical to the live WAL range', () => {
  const shipper = makeShipper();
  const first = shipper.tick();
  expect(first.breaks.map((b) => b.reason)).toEqual(['first-run', 'first-run']);

  insertVault(3);
  clock += 1000;
  const report = shipper.tick();
  expect(report.errors).toEqual([]);
  expect(report.shipped.filter((k) => k.startsWith('wal/vault/'))).toHaveLength(1);

  const segs = segsOf(shipper, 'vault');
  expect(segs).toHaveLength(1);
  const seg = segs[0]!;
  expect(seg.addr!.startOffset).toBe(0); // first segment carries the WAL header
  expect(seg.addr!.endOffset).toBe(walSize('vault')); // everything was committed
  const fileBytes = readFileSync(seg.file);
  const walBytes = readFileSync(walPath('vault')).subarray(
    seg.addr!.startOffset,
    seg.addr!.endOffset,
  );
  expect(fileBytes.length).toBe(seg.addr!.endOffset - seg.addr!.startOffset);
  expect(Buffer.compare(fileBytes, walBytes)).toBe(0);
});

test('[G2] interleaved writes and ticks chain gaplessly and reconstruct the WAL prefix exactly', () => {
  const shipper = makeShipper();
  shipper.tick();

  for (const marker of ['alpha', 'beta', 'gamma']) {
    insertVault(2, 150, marker);
    clock += 1000;
    const r = shipper.tick();
    expect(r.errors).toEqual([]);
    expect(r.breaks).toEqual([]);
    expect(r.shipped.some((k) => k.startsWith('wal/vault/'))).toBe(true);
  }

  const segs = segsOf(shipper, 'vault');
  expect(segs).toHaveLength(3);
  // Gapless chain: start of each == end of previous, from 0 — so every
  // committed byte appears exactly once across the segments.
  let at = 0;
  for (const seg of segs) {
    expect(seg.addr!.startOffset).toBe(at);
    at = seg.addr!.endOffset;
  }
  // Concatenation is byte-identical to the WAL file prefix.
  const concat = Buffer.concat(segs.map((s) => readFileSync(s.file)));
  expect(at).toBe(walSize('vault'));
  const wal = readFileSync(walPath('vault')).subarray(0, at);
  expect(Buffer.compare(concat, wal)).toBe(0);

  // A tick with no new writes ships nothing (and breaks nothing).
  clock += 1000;
  const idle = shipper.tick();
  expect(idle.shipped).toEqual([]);
  expect(idle.breaks).toEqual([]);
  expect(idle.errors).toEqual([]);
});

test('[G3] an uncommitted second-writer tail never ships; it ships after COMMIT', () => {
  const shipper = makeShipper();
  shipper.tick();

  insertJournal(2, 100, 'committed');
  const committedHead = walSize('journal'); // last COMMIT boundary right now

  const c2 = openSecondJournal();
  try {
    c2.exec('PRAGMA cache_size = 10'); // force mid-transaction spill into the WAL
    c2.exec('BEGIN IMMEDIATE');
    const ins = c2.prepare('INSERT INTO _walship_jprobe (v) VALUES (?)');
    for (let i = 0; i < 200; i++) ins.run(`uncommitted-${i}-${'u'.repeat(1000)}`);
    // The open transaction's frames really are in the WAL file...
    expect(walSize('journal')).toBeGreaterThan(committedHead);

    clock += 1000;
    const r1 = shipper.tick();
    expect(r1.errors).toEqual([]);
    // ...but the shipped boundary stopped at the last COMMIT.
    const segs1 = segsOf(shipper, 'journal');
    expect(segs1).toHaveLength(1);
    expect(segs1[0]!.addr!.endOffset).toBe(committedHead);

    c2.exec('COMMIT');
    clock += 1000;
    const r2 = shipper.tick();
    expect(r2.errors).toEqual([]);
    const segs2 = segsOf(shipper, 'journal');
    expect(segs2).toHaveLength(2);
    expect(segs2[1]!.addr!.startOffset).toBe(committedHead);
    expect(segs2[1]!.addr!.endOffset).toBe(walSize('journal'));
    // Both segments together still equal the WAL prefix byte for byte.
    const concat = Buffer.concat(segs2.map((s) => readFileSync(s.file)));
    const wal = readFileSync(walPath('journal')).subarray(0, segs2[1]!.addr!.endOffset);
    expect(Buffer.compare(concat, wal)).toBe(0);
  } finally {
    c2.close();
  }
});

test('[G3] rolled-back bytes are never shipped and later commits still chain gaplessly', () => {
  const shipper = makeShipper();
  shipper.tick();

  insertJournal(2, 100, 'before');
  clock += 1000;
  shipper.tick();
  const e1 = segsOf(shipper, 'journal').at(-1)!.addr!.endOffset;

  const c2 = openSecondJournal();
  try {
    c2.exec('PRAGMA cache_size = 10');
    c2.exec('BEGIN IMMEDIATE');
    const ins = c2.prepare('INSERT INTO _walship_jprobe (v) VALUES (?)');
    for (let i = 0; i < 200; i++) ins.run(`ROLLBACKME-${i}-${'r'.repeat(1000)}`);
    expect(walSize('journal')).toBeGreaterThan(e1); // spilled past the last commit
    c2.exec('ROLLBACK');
  } finally {
    c2.close();
  }
  // The next transaction overwrites the rolled-back frames in place.
  insertJournal(3, 100, 'KEEPME');

  clock += 1000;
  const r = shipper.tick();
  expect(r.errors).toEqual([]);
  expect(r.breaks).toEqual([]);
  const segs = segsOf(shipper, 'journal');
  expect(segs).toHaveLength(2);
  const seg2 = segs[1]!;
  expect(seg2.addr!.startOffset).toBe(e1); // still chains gaplessly
  const seg2Bytes = readFileSync(seg2.file);
  expect(seg2Bytes.includes('ROLLBACKME')).toBe(false);
  expect(seg2Bytes.includes('KEEPME')).toBe(true);
  // And the shipped prefix still matches the live file exactly.
  const concat = Buffer.concat(segs.map((s) => readFileSync(s.file)));
  const wal = readFileSync(walPath('journal')).subarray(0, seg2.addr!.endOffset);
  expect(Buffer.compare(concat, wal)).toBe(0);
});

// --------------------------------------------------------------------- G4

test('[G4] a failed segment write reports an error, moves nothing, and retries the same range', () => {
  const shipper = makeShipper();
  shipper.tick();
  insertVault(2);
  clock += 1000;
  shipper.tick(); // establishes the group dir + a nonzero offset
  const status = shipper.status().dbs.vault!;
  const offsetBefore = status.offset;
  expect(offsetBefore).toBeGreaterThan(0);

  insertVault(2, 200, 'second');
  const walSizeBefore = walSize('vault');
  const groupDir = path.join(shipDir(), 'segments', 'vault', status.generation, '00000000');
  chmodSync(groupDir, 0o500);
  try {
    clock += 1000;
    const r = shipper.tick();
    const err = r.errors.find((e) => e.db === 'vault');
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/segment write failed/);
    expect(r.shipped.filter((k) => k.startsWith('wal/vault/'))).toEqual([]);
    expect(r.markers).toEqual([]); // a one-sided/error cut is never certified
    // Offset did not advance, and the WAL keeps every byte (no checkpoint).
    expect(shipper.status().dbs.vault!.offset).toBe(offsetBefore);
    expect(walSize('vault')).toBe(walSizeBefore);
  } finally {
    chmodSync(groupDir, 0o755);
  }

  // After fixing permissions, the SAME range ships.
  clock += 1000;
  const r2 = shipper.tick();
  expect(r2.errors).toEqual([]);
  expect(r2.shipped.filter((k) => k.startsWith('wal/vault/'))).toHaveLength(1);
  const last = segsOf(shipper, 'vault').at(-1)!;
  expect(last.addr!.startOffset).toBe(offsetBefore);
  expect(shipper.status().dbs.vault!.offset).toBe(last.addr!.endOffset);
});

// -------------------------------------------------------- rollover + closers

test('rollover: exceeding walSizeThresholdBytes closes the group with a closer and truncates the WAL', () => {
  const shipper = makeShipper({ walSizeThresholdBytes: 8192 });
  shipper.tick();
  const gen = shipper.status().dbs.vault!.generation;

  insertVault(3, 4000); // ≥ 3 frames ⇒ WAL > 8192
  clock += 1000;
  const r = shipper.tick();
  expect(r.errors).toEqual([]);
  expect(r.breaks).toEqual([]);
  const rolled = r.rolled.find((x) => x.db === 'vault');
  expect(rolled).toBeDefined();
  expect(rolled!.group).toBe(0);
  expect(rolled!.endOffset).toBeGreaterThan(8192);

  const after = shipper.status().dbs.vault!;
  expect(after.generation).toBe(gen); // rollover, not a generation break
  expect(after.group).toBe(1);
  expect(after.offset).toBe(0);
  expect(walSize('vault')).toBe(0); // live WAL truncated

  // The closer marker sits in the OLD group dir and lists as kind 'closer'
  // under its exact object key.
  const closerFile = path.join(
    shipDir(),
    'segments',
    'vault',
    gen,
    '00000000',
    `closed-${String(rolled!.endOffset).padStart(12, '0')}.mrk`,
  );
  expect(existsSync(closerFile)).toBe(true);
  const closers = shipper
    .listUploadable()
    .filter((i) => i.kind === 'closer' && i.closer!.db === 'vault');
  expect(closers).toHaveLength(1);
  expect(closers[0]!.key).toBe(
    walGroupCloserKey({ db: 'vault', generation: gen, group: 0, endOffset: rolled!.endOffset }),
  );
  // The closed group's segments end exactly at the closer's offset.
  const group0 = segsOf(shipper, 'vault').filter((s) => s.addr!.group === 0);
  expect(group0.at(-1)!.addr!.endOffset).toBe(rolled!.endOffset);
});

test('roll thresholds are read dynamically so a live BackupPolicy change takes effect', () => {
  let threshold = Number.MAX_SAFE_INTEGER;
  let baseInterval = Number.MAX_SAFE_INTEGER;
  const shipper = makeShipper({
    walSizeThresholdBytes: () => threshold,
    baseIntervalMs: () => baseInterval,
  });
  shipper.tick();

  insertVault(3, 4000);
  clock += 1000;
  expect(shipper.tick().rolled).toEqual([]);

  threshold = 8192;
  clock += 1000;
  expect(shipper.tick().rolled.some((row) => row.db === 'vault')).toBe(true);

  baseInterval = 1;
  clock += 2;
  expect(shipper.tick().breaks.map((row) => row.reason)).toContain('base-cadence');
});

test('rollover edge: uncommitted-only WAL over threshold reports busy, then truncates without advancing the group', () => {
  const shipper = makeShipper({ walSizeThresholdBytes: 8192 });
  shipper.tick();
  clock += 1000;
  shipper.checkpointNow(); // flush first-run receipts ⇒ journal group 1, offset 0
  const before = shipper.status().dbs.journal!;
  expect(before.offset).toBe(0);

  const c2 = openSecondJournal();
  try {
    c2.exec('PRAGMA cache_size = 10');
    c2.exec('BEGIN IMMEDIATE');
    const ins = c2.prepare('INSERT INTO _walship_jprobe (v) VALUES (?)');
    for (let i = 0; i < 200; i++) ins.run(`held-${i}-${'h'.repeat(1000)}`);
    expect(walSize('journal')).toBeGreaterThan(8192);

    // Active writer ⇒ TRUNCATE returns busy; nothing advances, nothing rolls.
    clock += 1000;
    const r1 = shipper.tick();
    expect(r1.busy).toContain('journal');
    expect(r1.shipped.filter((k) => k.startsWith('wal/journal/'))).toEqual([]);
    expect(r1.rolled.filter((x) => x.db === 'journal')).toEqual([]);
    expect(shipper.status().dbs.journal!.group).toBe(before.group);

    c2.exec('ROLLBACK');
  } finally {
    c2.close();
  }

  // Now the truncate succeeds — but offset was 0 (nothing shipped in this
  // group), so the group MUST NOT advance and no closer may exist for it.
  clock += 1000;
  const r2 = shipper.tick();
  expect(r2.busy).toEqual([]);
  expect(r2.breaks).toEqual([]);
  expect(r2.rolled.filter((x) => x.db === 'journal')).toEqual([]);
  const after = shipper.status().dbs.journal!;
  expect(after.group).toBe(before.group);
  expect(after.offset).toBe(0);
  expect(walSize('journal')).toBe(0); // WAL did truncate
  const closers = shipper
    .listUploadable()
    .filter(
      (i) => i.kind === 'closer' && i.closer!.db === 'journal' && i.closer!.group === before.group,
    );
  expect(closers).toEqual([]);
});

test('checkpointNow ships the remainder, truncates, and closes the group', () => {
  const shipper = makeShipper();
  shipper.tick();
  insertVault(2, 300, 'tail');
  clock += 1000;
  const r = shipper.checkpointNow();
  expect(r.errors).toEqual([]);
  expect(r.busy).toEqual([]);
  expect(r.shipped.some((k) => k.startsWith('wal/vault/'))).toBe(true);
  const rolled = r.rolled.find((x) => x.db === 'vault');
  expect(rolled).toBeDefined();
  expect(walSize('vault')).toBe(0);
  const closers = shipper
    .listUploadable()
    .filter((i) => i.kind === 'closer' && i.closer!.db === 'vault' && i.closer!.group === 0);
  expect(closers).toHaveLength(1);
  expect(closers[0]!.closer!.endOffset).toBe(rolled!.endOffset);
  expect(shipper.status().dbs.vault!.group).toBe(1);
});

// ------------------------------------------------- end-to-end (the money test)

test('end-to-end: capture → seal → replay round-trips the real vault byte-exactly', async () => {
  const shipper = makeShipper({ walSizeThresholdBytes: 8192 }); // force multi-group streams
  shipper.tick(); // first-run: mints generations + bases
  const gens = {
    vault: shipper.status().dbs.vault!.generation,
    journal: shipper.status().dbs.journal!.generation,
  };
  const bases = shipper.currentBases();
  const basePaths = new Map(bases.map((b) => [b.db, b.file]));
  // The first-run break is COORDINATED: both bases were cloned in one tick, and
  // restore asserts that before it touches a byte.
  expect(shipper.basesCoordinated()).toBe(true);
  const baseTicks = {
    vault: bases.find((b) => b.db === 'vault')!.createdAtMs,
    journal: bases.find((b) => b.db === 'journal')!.createdAtMs,
  };
  expect(baseTicks.vault).toBe(baseTicks.journal);

  insertVault(3, 500, 'alpha');
  insertJournal(2, 200, 'jalpha');
  clock += 1000;
  shipper.tick();
  insertVault(4, 2000, 'beta');
  insertJournal(3, 900, 'jbeta');
  clock += 1000;
  shipper.tick();
  insertVault(1, 10, 'gamma');
  clock += 1000;
  const closeReport = shipper.close(); // ships the remainder + final closers
  expect(closeReport.errors).toEqual([]);
  expect(closeReport.busy).toEqual([]);

  // The whole run stayed inside one generation (no breaks after first-run).
  expect(shipper.status().dbs.vault!.generation).toBe(gens.vault);
  expect(shipper.status().dbs.journal!.generation).toBe(gens.journal);
  // The rollovers actually happened — the replay below crosses group closers.
  expect(shipper.status().dbs.vault!.group).toBeGreaterThan(1);

  const liveVaultRows = db.vault.prepare('SELECT id, v FROM _walship_probe ORDER BY id').all();
  const liveJournalRows = db.journal.prepare('SELECT id, v FROM _walship_jprobe ORDER BY id').all();
  expect(liveVaultRows).toHaveLength(8);

  // Seal every uploadable exactly as the gateway uploader would.
  const dataKey = new Uint8Array(32).fill(7);
  const store = new FsObjectStore(path.join(root, 'objects'));
  const uploadables = shipper.listUploadable();
  expect(uploadables.filter((i) => i.kind === 'segment').length).toBeGreaterThan(2);
  expect(uploadables.filter((i) => i.kind === 'closer').length).toBeGreaterThan(1);
  // Pair markers ride the same drain — without them the restore has no
  // coordinated point to cut at and lands on the base pair.
  expect(uploadables.filter((i) => i.kind === 'marker').length).toBeGreaterThan(0);
  for (const item of uploadables) {
    let sealed: Uint8Array;
    if (item.kind === 'segment') {
      sealed = sealWalSegment(dataKey, 'v1', item.addr!, readFileSync(item.file));
    } else if (item.kind === 'closer') {
      sealed = sealWalCloser(dataKey, 'v1', item.closer!);
    } else {
      sealed = sealWalPairMarker(dataKey, 'v1', item.marker!);
    }
    await store.put(item.key, sealed);
  }

  // Materialize the bases into a fresh directory and let SQLite replay.
  const destDir = path.join(root, 'restore');
  mkdirSync(destDir, { recursive: true });
  copyFileSync(basePaths.get('vault')!, path.join(destDir, 'vault.db'));
  copyFileSync(basePaths.get('journal')!, path.join(destDir, 'journal.db'));
  db.close({ skipOptimize: true });

  const outcome = await replayWalSegments({
    store,
    dataKey,
    vaultId: 'v1',
    destDir,
    generationByDb: gens,
    baseTickMsByDb: baseTicks,
  });
  expect(outcome.damaged).toEqual([]);
  expect(outcome.perDb.vault.integrityCheck).toBe('ok');
  expect(outcome.perDb.journal.integrityCheck).toBe('ok');
  expect(outcome.perDb.vault.truncated).toBe(false);
  expect(outcome.perDb.journal.truncated).toBe(false);
  expect(outcome.perDb.vault.foreignKeyViolations).toBe(0);
  expect(outcome.perDb.vault.segmentsApplied).toBeGreaterThan(0);

  const restored = new DatabaseSync(path.join(destDir, 'vault.db'), { readOnly: true });
  const restoredJournal = new DatabaseSync(path.join(destDir, 'journal.db'), { readOnly: true });
  try {
    expect(restored.prepare('SELECT id, v FROM _walship_probe ORDER BY id').all()).toEqual(
      liveVaultRows,
    );
    expect(restoredJournal.prepare('SELECT id, v FROM _walship_jprobe ORDER BY id').all()).toEqual(
      liveJournalRows,
    );
    // The recorded base sha256 markers verify against the exact bytes the
    // restore started from (what a real engine checks before replaying).
    for (const base of shipper.currentBases()) {
      expect(base.sha256).toBe(createHash('sha256').update(readFileSync(base.file)).digest('hex'));
    }
  } finally {
    restored.close();
    restoredJournal.close();
  }
});
