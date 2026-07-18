import { tempDir } from '@centraid/test-kit/temp-dir';
// governance: allow-repo-hygiene file-size-limit (#408) the replay e2e suite drives one real mini-shipper fixture through every damage/PITR/coordination case; sharding would duplicate the shipper per file
/*
 * End-to-end WAL replay tests (FORMAT.md § WAL segments — /1, issue #408).
 *
 * These tests run the REAL pipeline: a mini shipper drives a real
 * `node:sqlite` database in WAL mode (autocheckpoint off, TRUNCATE-only
 * checkpoints — the shipper invariants), captures committed WAL byte ranges
 * exactly the way the production shipper does, seals them with
 * `sealWalSegment`/`sealWalCloser` into a real `FsObjectStore`, and then
 * `replayWalSegments` restores from base + segments. Row sets are compared
 * against snapshots recorded at capture time — the restored database must
 * equal what the live database ACTUALLY contained at each tick, not merely
 * pass an integrity check.
 *
 * The damage cases are the reason this feature exists: a corrupted, missing,
 * or forged object must degrade the restore to an EARLIER CONSISTENT state
 * (G6), coordinated across both databases (G8) — never a corrupt or mixed
 * database.
 */

import fss, { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test, vi } from 'vitest';
import { FsObjectStore, type ObjectStore } from './object-store.js';
import {
  lastCommitBoundary,
  openWalSegment,
  parseWalSegmentKey,
  sealWalCloser,
  sealWalPairMarker,
  sealWalSegment,
  type WalDbName,
  type WalGroupCloser,
  type WalPairMarker,
  type WalSegmentAddress,
  WAL_DB_FILES,
  walGroupCloserKey,
  walPairMarkerKey,
  walSegmentKey,
} from './wal-format.js';
import { replayWalSegments } from './wal-restore.js';

vi.setConfig({ testTimeout: 15_000 });
const DATA_KEY = new Uint8Array(32).fill(0x6b);
const VAULT_ID = 'vault-restore-test';

/* eslint-disable max-classes-per-file -- (#354) TickClock is a tiny clock stub
   colocated with the MiniShipper test rig it drives. */
/** Deterministic monotonic capture clock — segments of one round share a tick. */
class TickClock {
  private t = 0;
  next(): number {
    this.t += 1000;
    return this.t;
  }
}

interface CapturedSegment {
  addr: WalSegmentAddress;
  bytes: Uint8Array;
}

/**
 * A REAL mini WAL shipper: owns a `node:sqlite` connection under the shipper
 * invariants (WAL, synchronous=FULL, wal_autocheckpoint=0, TRUNCATE-only
 * checkpoints) and captures committed byte ranges of the live `-wal` file,
 * exactly like the production capture side.
 */
class MiniShipper {
  readonly captured: CapturedSegment[] = [];
  readonly closers: WalGroupCloser[] = [];
  /** Committed row set recorded at each tick — PITR ground truth. */
  readonly rowsAtTick = new Map<number, string[]>();
  private readonly conn: DatabaseSync;
  private readonly dbPath: string;
  private readonly walPath: string;
  private readonly pageSize: number;
  private group = 0;
  private offset = 0;
  private baseTaken = false;

  constructor(
    dir: string,
    readonly dbName: WalDbName,
    public generation: string,
    private readonly clock: TickClock,
  ) {
    this.dbPath = path.join(dir, WAL_DB_FILES[dbName]);
    this.walPath = `${this.dbPath}-wal`;
    this.conn = new DatabaseSync(this.dbPath);
    this.conn.exec('PRAGMA journal_mode=WAL');
    this.conn.exec('PRAGMA synchronous=FULL');
    this.conn.exec('PRAGMA wal_autocheckpoint=0');
    this.conn.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, val TEXT NOT NULL)');
    const { page_size: pageSize } = this.conn.prepare('PRAGMA page_size').get() as {
      page_size: number;
    };
    this.pageSize = pageSize;
  }

  insert(...vals: string[]): void {
    const stmt = this.conn.prepare('INSERT INTO rows (val) VALUES (?)');
    for (const val of vals) stmt.run(val);
  }

  /** Arbitrary SQL on the shipped connection — the FK-violation fixture needs its own tables. */
  exec(sql: string): void {
    this.conn.exec(sql);
  }

  rows(): string[] {
    return (this.conn.prepare('SELECT val FROM rows ORDER BY id').all() as { val: string }[]).map(
      (r) => r.val,
    );
  }

  /**
   * TRUNCATE-checkpoint, then copy the WAL-quiet main file: the base snapshot
   * that anchors this generation. Must precede all captures.
   */
  base(): Uint8Array {
    if (this.captured.length > 0) throw new Error('base() must precede captures');
    this.checkpointTruncate();
    this.baseTaken = true;
    this.group = 0;
    this.offset = 0;
    return new Uint8Array(fss.readFileSync(this.dbPath));
  }

  /**
   * Break to a fresh generation the way the real shipper does: TRUNCATE (which
   * folds every committed frame into the main file), pin the WAL-quiet main
   * file as the new base, restart at group 0 / offset 0. Already-captured
   * segments keep the OLD generation inside their address, so a rig can ship
   * both eras into one store — exactly what a real break leaves behind.
   */
  rebase(generation: string): Uint8Array {
    this.checkpointTruncate();
    this.generation = generation;
    this.group = 0;
    this.offset = 0;
    this.baseTaken = true;
    return new Uint8Array(fss.readFileSync(this.dbPath));
  }

  /**
   * The shipper's `(group, endOffset)` right now — what a pair marker records.
   * After a `rollover()` this is `(g+1, 0)`, which is exactly the position a
   * replay chain normalizes to once it reaches group g's authenticated closer.
   */
  position(): { group: number; endOffset: number } {
    return { group: this.group, endOffset: this.offset };
  }

  /** Capture `[offset, lastCommitBoundary)` of the live WAL as one segment. */
  tick(tickMs: number = this.clock.next()): number {
    if (!this.baseTaken) throw new Error('tick() before base()');
    const wal = new Uint8Array(fss.readFileSync(this.walPath));
    const boundary = lastCommitBoundary(wal, 0, this.pageSize);
    if (boundary <= this.offset) throw new Error('tick() with no new committed WAL bytes');
    const addr: WalSegmentAddress = {
      db: this.dbName,
      generation: this.generation,
      group: this.group,
      startOffset: this.offset,
      endOffset: boundary,
      tickMs,
    };
    this.captured.push({ addr, bytes: wal.slice(this.offset, boundary) });
    this.offset = boundary;
    this.rowsAtTick.set(tickMs, this.rows());
    return tickMs;
  }

  /**
   * Close the group: capture the tail segment, TRUNCATE-checkpoint (the WAL
   * file must actually reach 0 bytes — the invariant the closer asserts),
   * write the group closer, advance to the next group.
   */
  rollover(tickMs?: number): number {
    const usedTick = this.tick(tickMs);
    this.checkpointTruncate();
    if (fss.statSync(this.walPath).size !== 0) {
      throw new Error('TRUNCATE checkpoint left a non-empty WAL');
    }
    this.closers.push({
      db: this.dbName,
      generation: this.generation,
      group: this.group,
      endOffset: this.offset,
    });
    this.group += 1;
    this.offset = 0;
    return usedTick;
  }

  close(): void {
    this.conn.close();
  }

  private checkpointTruncate(): void {
    const row = this.conn.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number };
    if (row.busy !== 0) throw new Error('wal_checkpoint(TRUNCATE) reported busy');
  }
}

async function shipToStore(store: ObjectStore, ship: MiniShipper): Promise<void> {
  for (const { addr, bytes } of ship.captured) {
    await store.put(walSegmentKey(addr), sealWalSegment(DATA_KEY, VAULT_ID, addr, bytes));
  }
  for (const c of ship.closers) {
    await store.put(walGroupCloserKey(c), sealWalCloser(DATA_KEY, VAULT_ID, c));
  }
}

/**
 * The bases are taken before the clock's first tick, so the pair's base tick is
 * 0 — the real shipper's coordinated break stamps both with the same
 * `report.tickMs`, and the manifest carries it as `baseTickMs`.
 */
const BASE_TICK = 0;

/**
 * Record what BOTH databases have shipped at `tickMs` — the end-of-tick pair
 * marker the real shipper writes. Called AFTER both databases have ticked: a
 * marker that mixed one database's post-tick position with the other's pre-tick
 * one would be a lie every later restore has to walk back from.
 */
function markPair(
  markers: WalPairMarker[],
  vault: MiniShipper,
  journal: MiniShipper,
  tickMs: number,
): void {
  markers.push({
    vaultGeneration: vault.generation,
    journalGeneration: journal.generation,
    tickMs,
    vault: vault.position(),
    journal: journal.position(),
  });
}

async function shipMarkers(store: ObjectStore, markers: WalPairMarker[]): Promise<void> {
  for (const m of markers) {
    await store.put(walPairMarkerKey(m), sealWalPairMarker(DATA_KEY, VAULT_ID, m));
  }
}

function readRows(dbPath: string): string[] {
  const conn = new DatabaseSync(dbPath);
  try {
    return (conn.prepare('SELECT val FROM rows ORDER BY id').all() as { val: string }[]).map(
      (r) => r.val,
    );
  } finally {
    conn.close();
  }
}

async function flipByteInStore(store: ObjectStore, key: string): Promise<void> {
  const bytes = new Uint8Array(await store.get(key));
  bytes[Math.floor(bytes.length / 2)]! ^= 0x01;
  await store.put(key, bytes);
}

async function forgeChecksumInvalidSegment(store: ObjectStore, key: string): Promise<void> {
  const addr = parseWalSegmentKey(key);
  if (!addr) throw new Error(`bad test segment key: ${key}`);
  const plain = openWalSegment(DATA_KEY, VAULT_ID, addr, await store.get(key));
  // Re-encrypt under the legitimate key after corrupting a frame byte. GCM
  // authenticates this object; only SQLite's rolling WAL checksum rejects it.
  plain[plain.length - 1]! ^= 0x01;
  await store.put(key, sealWalSegment(DATA_KEY, VAULT_ID, addr, plain));
}

// ---------------------------------------------------------------------------
// Single-database scenario: 2 groups, 5 segments, 5 ticks.
// ---------------------------------------------------------------------------

interface VaultScenario {
  store: FsObjectStore;
  gen: string;
  base: Uint8Array;
  /** Segment keys in capture order: [t1, t2, t3(=group-0 tail), t4, t5]. */
  segKeys: string[];
  closerKeys: string[];
  ticks: number[];
  rowsAt: Map<number, string[]>;
  baseRows: string[];
  liveRows: string[];
}

async function buildVaultScenario(): Promise<VaultScenario> {
  const store = new FsObjectStore(await tempDir('backup-wal-store-'));
  const clock = new TickClock();
  const gen = 'e7'.repeat(16);
  const ship = new MiniShipper(await tempDir('backup-wal-ship-'), 'vault', gen, clock);
  ship.insert('r1', 'r2');
  const base = ship.base();
  const baseRows = ship.rows();

  ship.insert('r3');
  const t1 = ship.tick();
  ship.insert('r4');
  const t2 = ship.tick();
  ship.insert('r5');
  const t3 = ship.rollover(); // closes group 0 after three chained segments
  ship.insert('r6');
  const t4 = ship.tick();
  ship.insert('r7');
  const t5 = ship.tick();
  const liveRows = ship.rows();

  await shipToStore(store, ship);
  ship.close();
  return {
    store,
    gen,
    base,
    segKeys: ship.captured.map((c) => walSegmentKey(c.addr)),
    closerKeys: ship.closers.map((c) => walGroupCloserKey(c)),
    ticks: [t1, t2, t3, t4, t5],
    rowsAt: ship.rowsAtTick,
    baseRows,
    liveRows,
  };
}

async function restoreVault(sc: VaultScenario, pointInTimeMs?: number) {
  const destDir = await tempDir('backup-wal-dest-');
  await fs.writeFile(path.join(destDir, WAL_DB_FILES.vault), sc.base);
  const outcome = await replayWalSegments({
    store: sc.store,
    dataKey: DATA_KEY,
    vaultId: VAULT_ID,
    destDir,
    generationByDb: { vault: sc.gen },
    ...(pointInTimeMs !== undefined ? { pointInTimeMs } : {}),
  });
  return { outcome, destDir, rows: readRows(path.join(destDir, WAL_DB_FILES.vault)) };
}

describe('replayWalSegments — tip and point-in-time restore', () => {
  test('restore-to-tip reproduces EXACTLY the live row set across a group rollover', async () => {
    const sc = await buildVaultScenario();
    const { outcome, destDir, rows } = await restoreVault(sc);

    expect(rows).toEqual(sc.liveRows);
    expect(rows).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']);
    const vault = outcome.perDb.vault;
    expect(vault.integrityCheck).toBe('ok');
    expect(vault.foreignKeyViolations).toBe(0);
    expect(vault.segmentsApplied).toBe(5);
    expect(vault.groupsApplied).toBe(2);
    expect(vault.lastTickMs).toBe(sc.ticks[4]);
    expect(vault.truncated).toBe(false);
    expect(vault.generation).toBe(sc.gen);
    expect(outcome.damaged).toEqual([]);
    // journal had no generation: skipped, never assumed to be SQLite.
    expect(outcome.perDb.journal.integrityCheck).toBe('skipped');
    expect(outcome.perDb.journal.generation).toBeNull();
    // The spool directory is cleaned up.
    await expect(fs.access(path.join(destDir, '.wal-restore-spool'))).rejects.toThrow();
    // No stray -wal/-shm left behind.
    await expect(fs.access(path.join(destDir, 'vault.db-wal'))).rejects.toThrow();
  });

  test('point-in-time restores reproduce the exact rows recorded at each tick', async () => {
    const sc = await buildVaultScenario();
    const [t1, t2, t3, t4] = sc.ticks as [number, number, number, number];

    const atT2 = await restoreVault(sc, t2);
    expect(atT2.rows).toEqual(sc.rowsAt.get(t2));
    expect(atT2.outcome.perDb.vault.segmentsApplied).toBe(2);
    expect(atT2.outcome.perDb.vault.groupsApplied).toBe(1);
    expect(atT2.outcome.perDb.vault.truncated).toBe(false);
    expect(atT2.outcome.perDb.vault.integrityCheck).toBe('ok');

    // Exactly at the group-0 rollover tick.
    const atT3 = await restoreVault(sc, t3);
    expect(atT3.rows).toEqual(sc.rowsAt.get(t3));
    expect(atT3.outcome.perDb.vault.segmentsApplied).toBe(3);
    expect(atT3.outcome.perDb.vault.groupsApplied).toBe(1);

    // Mid-group-1.
    const atT4 = await restoreVault(sc, t4);
    expect(atT4.rows).toEqual(sc.rowsAt.get(t4));
    expect(atT4.outcome.perDb.vault.segmentsApplied).toBe(4);
    expect(atT4.outcome.perDb.vault.groupsApplied).toBe(2);

    // Before the first tick: the base alone.
    const atBase = await restoreVault(sc, t1 - 500);
    expect(atBase.rows).toEqual(sc.baseRows);
    expect(atBase.outcome.perDb.vault.segmentsApplied).toBe(0);
    expect(atBase.outcome.perDb.vault.lastTickMs).toBe(-1);
    expect(atBase.outcome.perDb.vault.integrityCheck).toBe('ok');
  });

  test('an empty stream (base only, no segments) restores the base intact', async () => {
    const store = new FsObjectStore(await tempDir('backup-wal-store-'));
    const clock = new TickClock();
    const gen = 'f1'.repeat(16);
    const ship = new MiniShipper(await tempDir('backup-wal-ship-'), 'vault', gen, clock);
    ship.insert('only-1', 'only-2');
    const base = ship.base();
    ship.close();

    const destDir = await tempDir('backup-wal-dest-');
    await fs.writeFile(path.join(destDir, WAL_DB_FILES.vault), base);
    const outcome = await replayWalSegments({
      store,
      dataKey: DATA_KEY,
      vaultId: VAULT_ID,
      destDir,
      generationByDb: { vault: gen },
    });
    expect(readRows(path.join(destDir, WAL_DB_FILES.vault))).toEqual(['only-1', 'only-2']);
    expect(outcome.perDb.vault).toMatchObject({
      segmentsApplied: 0,
      groupsApplied: 0,
      lastTickMs: -1,
      truncated: false,
      integrityCheck: 'ok',
    });
    expect(outcome.damaged).toEqual([]);
  });
});

describe('replayWalSegments — a logically inconsistent restore is a FAILED restore', () => {
  test('a foreign_key_check violation throws, however clean integrity_check comes back', async () => {
    const store = new FsObjectStore(await tempDir('backup-wal-store-'));
    const gen = 'c3'.repeat(16);
    const ship = new MiniShipper(await tempDir('backup-wal-ship-'), 'vault', gen, new TickClock());
    ship.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (id INTEGER PRIMARY KEY,
                          parent_id INTEGER NOT NULL REFERENCES parent(id));
      INSERT INTO parent (id) VALUES (1);
      INSERT INTO child (id, parent_id) VALUES (1, 1);
    `);
    const base = ship.base();

    // Manufacture the state no honest cut can produce: FKs are enforced on
    // every real writer of vault.db/journal.db, so no committed state ever
    // held a dangling child and a plan only ever replays committed states.
    // A restored file carrying one is therefore NOT a state this database
    // ever had — physically intact, logically fictional (page mixing, a
    // mis-ordered plan, a spoofed offset) — and must be a FAILED restore, not
    // a note in the outcome. Disabling the pragma is how the fixture forges
    // that state; it takes a deliberate act, which is the point.
    ship.exec('PRAGMA foreign_keys = OFF');
    ship.exec('INSERT INTO child (id, parent_id) VALUES (2, 404)');
    ship.tick();
    await shipToStore(store, ship);
    ship.close();

    const destDir = await tempDir('backup-wal-dest-');
    await fs.writeFile(path.join(destDir, WAL_DB_FILES.vault), base);
    await expect(
      replayWalSegments({
        store,
        dataKey: DATA_KEY,
        vaultId: VAULT_ID,
        destDir,
        generationByDb: { vault: gen },
      }),
    ).rejects.toThrow(/vault\.db failed foreign_key_check .*1 violation/);
  });

  test('the same base WITHOUT the violating write restores cleanly (the check is not vacuous)', async () => {
    const store = new FsObjectStore(await tempDir('backup-wal-store-'));
    const gen = 'c4'.repeat(16);
    const ship = new MiniShipper(await tempDir('backup-wal-ship-'), 'vault', gen, new TickClock());
    ship.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (id INTEGER PRIMARY KEY,
                          parent_id INTEGER NOT NULL REFERENCES parent(id));
      INSERT INTO parent (id) VALUES (1);
    `);
    const base = ship.base();
    ship.exec('INSERT INTO child (id, parent_id) VALUES (1, 1)');
    ship.tick();
    await shipToStore(store, ship);
    ship.close();

    const destDir = await tempDir('backup-wal-dest-');
    await fs.writeFile(path.join(destDir, WAL_DB_FILES.vault), base);
    const outcome = await replayWalSegments({
      store,
      dataKey: DATA_KEY,
      vaultId: VAULT_ID,
      destDir,
      generationByDb: { vault: gen },
    });
    expect(outcome.perDb.vault.foreignKeyViolations).toBe(0);
    expect(outcome.perDb.vault.integrityCheck).toBe('ok');
    expect(outcome.perDb.vault.segmentsApplied).toBe(1);
  });
});

describe('replayWalSegments — damage degrades to an earlier consistent state (G6)', () => {
  test('an AEAD-valid segment with an invalid SQLite rolling checksum is refused', async () => {
    const sc = await buildVaultScenario();
    await forgeChecksumInvalidSegment(sc.store, sc.segKeys[1]!);

    await expect(restoreVault(sc)).rejects.toThrow(/checksum/i);
  });

  test('a corrupted MIDDLE segment lands the restore at the last pre-damage tick', async () => {
    const sc = await buildVaultScenario();
    const [t1] = sc.ticks as [number];
    const damagedKey = sc.segKeys[1]!; // the t2 segment
    await flipByteInStore(sc.store, damagedKey);

    const { outcome, rows } = await restoreVault(sc);
    expect(rows).toEqual(sc.rowsAt.get(t1)); // earlier CONSISTENT state, not tip
    const vault = outcome.perDb.vault;
    expect(vault.integrityCheck).toBe('ok');
    expect(vault.truncated).toBe(true);
    expect(vault.segmentsApplied).toBe(1);
    expect(vault.lastTickMs).toBe(t1);
    expect(outcome.damaged).toContain(damagedKey);
  });

  test('a MISSING middle segment restores the same earlier state as a corrupted one', async () => {
    const sc = await buildVaultScenario();
    const [t1] = sc.ticks as [number];
    const missingKey = sc.segKeys[1]!;
    await sc.store.delete(missingKey);

    const { outcome, rows } = await restoreVault(sc);
    expect(rows).toEqual(sc.rowsAt.get(t1));
    expect(outcome.perDb.vault.truncated).toBe(true);
    expect(outcome.perDb.vault.segmentsApplied).toBe(1);
    expect(outcome.perDb.vault.lastTickMs).toBe(t1);
    expect(outcome.perDb.vault.integrityCheck).toBe('ok');
    // Unlike corruption (detected at spool/authenticate time → `damaged`),
    // a deleted object never appears in the LIST: the planner sees the hole
    // up front and nothing is ever attempted, so `damaged` stays empty.
    expect(outcome.damaged).toEqual([]);
  });

  test('a damaged FIRST segment degrades all the way to the base', async () => {
    const sc = await buildVaultScenario();
    const firstKey = sc.segKeys[0]!;
    await flipByteInStore(sc.store, firstKey);

    const { outcome, rows } = await restoreVault(sc);
    expect(rows).toEqual(sc.baseRows);
    expect(outcome.perDb.vault.segmentsApplied).toBe(0);
    expect(outcome.perDb.vault.lastTickMs).toBe(-1);
    expect(outcome.perDb.vault.truncated).toBe(true);
    expect(outcome.perDb.vault.integrityCheck).toBe('ok');
    expect(outcome.damaged).toContain(firstKey);
  });

  test('a corrupted group-TAIL segment stops the plan before the next group (never mixes)', async () => {
    const sc = await buildVaultScenario();
    const [, t2] = sc.ticks as [number, number];
    const tailKey = sc.segKeys[2]!; // group 0's closing segment (t3)
    await flipByteInStore(sc.store, tailKey);

    const { outcome, rows } = await restoreVault(sc);
    // Group 0 is incomplete → group 1's page images must NOT be applied.
    expect(rows).toEqual(sc.rowsAt.get(t2));
    const vault = outcome.perDb.vault;
    expect(vault.segmentsApplied).toBe(2);
    expect(vault.groupsApplied).toBe(1);
    expect(vault.lastTickMs).toBe(t2);
    expect(vault.truncated).toBe(true);
    expect(vault.integrityCheck).toBe('ok');
    expect(outcome.damaged).toContain(tailKey);
  });

  test('a bit-flipped (forged) group CLOSER keeps the group but never advances past it', async () => {
    const sc = await buildVaultScenario();
    const t3 = sc.ticks[2]!;
    await flipByteInStore(sc.store, sc.closerKeys[0]!);

    const { outcome, rows } = await restoreVault(sc);
    // Group 0's segments all authenticate — applied through t3 — but with no
    // AUTHENTIC closer the plan must treat the group as unclosed: group 1 is
    // never applied even though every one of its objects is intact.
    expect(rows).toEqual(sc.rowsAt.get(t3));
    const vault = outcome.perDb.vault;
    expect(vault.segmentsApplied).toBe(3);
    expect(vault.groupsApplied).toBe(1);
    expect(vault.lastTickMs).toBe(t3);
    expect(vault.truncated).toBe(true);
    expect(vault.integrityCheck).toBe('ok');
    // A rejected closer is not segment damage — it is an unclosed group.
    expect(outcome.damaged).toEqual([]);
  });

  test('a DELETED group closer behaves identically to a forged one', async () => {
    const sc = await buildVaultScenario();
    const t3 = sc.ticks[2]!;
    await sc.store.delete(sc.closerKeys[0]!);

    const { outcome, rows } = await restoreVault(sc);
    expect(rows).toEqual(sc.rowsAt.get(t3));
    expect(outcome.perDb.vault.groupsApplied).toBe(1);
    expect(outcome.perDb.vault.truncated).toBe(true);
    expect(outcome.perDb.vault.integrityCheck).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Two databases, one store: coordinated damage cut (G8)
// ---------------------------------------------------------------------------

describe('replayWalSegments — coordinated two-database restore (G8)', () => {
  interface PairScenario {
    store: FsObjectStore;
    genVault: string;
    genJournal: string;
    baseVault: Uint8Array;
    baseJournal: Uint8Array;
    ticks: number[];
    vaultSegKeys: string[];
    journalSegKeys: string[];
    vaultRowsAt: Map<number, string[]>;
    journalRowsAt: Map<number, string[]>;
    markers: WalPairMarker[];
  }

  async function buildPairScenario(): Promise<PairScenario> {
    const store = new FsObjectStore(await tempDir('backup-wal-store-'));
    const clock = new TickClock();
    const genVault = 'aa'.repeat(16);
    const genJournal = 'bb'.repeat(16);
    const vault = new MiniShipper(await tempDir('backup-wal-shipv-'), 'vault', genVault, clock);
    const journal = new MiniShipper(
      await tempDir('backup-wal-shipj-'),
      'journal',
      genJournal,
      clock,
    );
    vault.insert('v-base');
    journal.insert('j-base');
    const baseVault = vault.base();
    const baseJournal = journal.base();

    const ticks: number[] = [];
    const markers: WalPairMarker[] = [];
    for (let round = 1; round <= 3; round++) {
      vault.insert(`v${round}`);
      journal.insert(`j${round}`);
      // One capture instant: both databases' segments share the tick, and the
      // pair marker — written once both have settled — is what makes that
      // instant SELECTABLE at restore time.
      const tickMs = clock.next();
      vault.tick(tickMs);
      journal.tick(tickMs);
      markPair(markers, vault, journal, tickMs);
      ticks.push(tickMs);
    }
    await shipToStore(store, vault);
    await shipToStore(store, journal);
    await shipMarkers(store, markers);
    const scenario: PairScenario = {
      store,
      genVault,
      genJournal,
      baseVault,
      baseJournal,
      ticks,
      vaultSegKeys: vault.captured.map((c) => walSegmentKey(c.addr)),
      journalSegKeys: journal.captured.map((c) => walSegmentKey(c.addr)),
      vaultRowsAt: vault.rowsAtTick,
      journalRowsAt: journal.rowsAtTick,
      markers,
    };
    vault.close();
    journal.close();
    return scenario;
  }

  async function restorePair(sc: PairScenario) {
    const destDir = await tempDir('backup-wal-dest-');
    await fs.writeFile(path.join(destDir, WAL_DB_FILES.vault), sc.baseVault);
    await fs.writeFile(path.join(destDir, WAL_DB_FILES.journal), sc.baseJournal);
    const outcome = await replayWalSegments({
      store: sc.store,
      dataKey: DATA_KEY,
      vaultId: VAULT_ID,
      destDir,
      generationByDb: { vault: sc.genVault, journal: sc.genJournal },
      baseTickMsByDb: { vault: BASE_TICK, journal: BASE_TICK },
    });
    return {
      outcome,
      vaultRows: readRows(path.join(destDir, WAL_DB_FILES.vault)),
      journalRows: readRows(path.join(destDir, WAL_DB_FILES.journal)),
    };
  }

  test('intact streams restore both databases to the shared tip tick', async () => {
    const sc = await buildPairScenario();
    const t3 = sc.ticks[2]!;
    const { outcome, vaultRows, journalRows } = await restorePair(sc);
    expect(vaultRows).toEqual(sc.vaultRowsAt.get(t3));
    expect(journalRows).toEqual(sc.journalRowsAt.get(t3));
    expect(outcome.perDb.vault.lastTickMs).toBe(t3);
    expect(outcome.perDb.journal.lastTickMs).toBe(t3);
    expect(outcome.perDb.vault.integrityCheck).toBe('ok');
    expect(outcome.perDb.journal.integrityCheck).toBe('ok');
    expect(outcome.damaged).toEqual([]);
  });

  test("damage in vault's stream re-cuts the INTACT journal to the same tick", async () => {
    const sc = await buildPairScenario();
    const [t1] = sc.ticks as [number];
    const damagedKey = sc.vaultSegKeys[1]!; // vault's t2 segment
    await flipByteInStore(sc.store, damagedKey);

    const { outcome, vaultRows, journalRows } = await restorePair(sc);
    // Vault reaches only t1…
    expect(vaultRows).toEqual(sc.vaultRowsAt.get(t1));
    expect(outcome.perDb.vault.lastTickMs).toBe(t1);
    // …and the journal — every one of whose objects is INTACT and extends to
    // t3 — must be re-cut to t1 too: the pair corresponds to ONE capture
    // instant, never a mixed pair.
    expect(journalRows).toEqual(sc.journalRowsAt.get(t1));
    expect(outcome.perDb.journal.lastTickMs).toBe(t1);
    expect(outcome.perDb.journal.segmentsApplied).toBe(1);
    expect(outcome.perDb.vault.truncated).toBe(true);
    expect(outcome.perDb.journal.truncated).toBe(true);
    expect(outcome.perDb.vault.integrityCheck).toBe('ok');
    expect(outcome.perDb.journal.integrityCheck).toBe('ok');
    expect(outcome.damaged).toEqual([damagedKey]);
  });

  test("damage in vault's FIRST segment forces both databases back to their bases", async () => {
    const sc = await buildPairScenario();
    await sc.store.delete(sc.vaultSegKeys[0]!);

    const { outcome, vaultRows, journalRows } = await restorePair(sc);
    expect(vaultRows).toEqual(['v-base']);
    expect(journalRows).toEqual(['j-base']);
    expect(outcome.perDb.vault.lastTickMs).toBe(-1);
    expect(outcome.perDb.journal.lastTickMs).toBe(-1);
    expect(outcome.perDb.journal.segmentsApplied).toBe(0);
    expect(outcome.perDb.vault.integrityCheck).toBe('ok');
    expect(outcome.perDb.journal.integrityCheck).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// The receipt pair: what coordination is actually FOR (issue #408 G8).
// ---------------------------------------------------------------------------

/**
 * A journal row `receipt:X` is a receipt naming vault row `X`. A restored pair
 * in which some `receipt:X` survives but `X` does not is a DANGLING RECEIPT —
 * history asserting a fact the data does not contain, and the single outcome
 * the whole two-database coordination exists to make unconstructible.
 *
 * `@centraid/vault`'s `verifyRestoredPair` runs exactly this cross-check
 * against the real schema; this package cannot call it (vault depends on
 * backup, not the reverse), so the shape is modelled here on the same rig the
 * damage tests already drive.
 */
function danglingReceipts(destDir: string): string[] {
  const vaultRows = new Set(readRows(path.join(destDir, WAL_DB_FILES.vault)));
  return readRows(path.join(destDir, WAL_DB_FILES.journal))
    .filter((v) => v.startsWith('receipt:'))
    .map((v) => v.slice('receipt:'.length))
    .filter((named) => !vaultRows.has(named));
}

describe('replayWalSegments — a dangling receipt must be unconstructible (G8)', () => {
  const V0 = '10'.repeat(16);
  const J0 = '20'.repeat(16);
  const J1 = '21'.repeat(16);

  interface ReceiptPair {
    store: FsObjectStore;
    vault: MiniShipper;
    journal: MiniShipper;
    clock: TickClock;
    markers: WalPairMarker[];
  }

  async function newPair(genVault: string, genJournal: string): Promise<ReceiptPair> {
    const store = new FsObjectStore(await tempDir('backup-wal-store-'));
    const clock = new TickClock();
    return {
      store,
      clock,
      markers: [],
      vault: new MiniShipper(await tempDir('backup-wal-shipv-'), 'vault', genVault, clock),
      journal: new MiniShipper(await tempDir('backup-wal-shipj-'), 'journal', genJournal, clock),
    };
  }

  /**
   * One coordinated write: a vault row and the receipt that names it, captured
   * in ONE tick, JOURNAL FIRST — production's capture order, the ordering the
   * whole no-dangling-receipt argument rests on — and then the pair marker,
   * once both have settled.
   */
  function writePair(p: ReceiptPair, row: string): number {
    p.vault.insert(row);
    p.journal.insert(`receipt:${row}`);
    const tickMs = p.clock.next();
    p.journal.tick(tickMs);
    p.vault.tick(tickMs);
    markPair(p.markers, p.vault, p.journal, tickMs);
    return tickMs;
  }

  /** A tick in which only the JOURNAL moved — the vault's position is carried unchanged. */
  function journalOnlyTick(p: ReceiptPair, row: string): number {
    p.journal.insert(row);
    const tickMs = p.journal.tick();
    markPair(p.markers, p.vault, p.journal, tickMs);
    return tickMs;
  }

  async function ship(p: ReceiptPair): Promise<void> {
    await shipToStore(p.store, p.vault);
    await shipToStore(p.store, p.journal);
    await shipMarkers(p.store, p.markers);
  }

  async function restorePair(
    p: ReceiptPair,
    bases: { vault: Uint8Array; journal: Uint8Array },
    generations: { vault: string; journal: string },
    opts: {
      baseTicks?: { vault: number; journal: number };
      walTipTickMs?: number;
      pointInTimeMs?: number;
    } = {},
  ): Promise<{ destDir: string; outcome: Awaited<ReturnType<typeof replayWalSegments>> }> {
    const destDir = await tempDir('backup-wal-dest-');
    await fs.writeFile(path.join(destDir, WAL_DB_FILES.vault), bases.vault);
    await fs.writeFile(path.join(destDir, WAL_DB_FILES.journal), bases.journal);
    const outcome = await replayWalSegments({
      store: p.store,
      dataKey: DATA_KEY,
      vaultId: VAULT_ID,
      destDir,
      generationByDb: generations,
      baseTickMsByDb: opts.baseTicks ?? { vault: BASE_TICK, journal: BASE_TICK },
      ...(opts.walTipTickMs !== undefined ? { walTipTickMs: opts.walTipTickMs } : {}),
      ...(opts.pointInTimeMs !== undefined ? { pointInTimeMs: opts.pointInTimeMs } : {}),
    });
    return { destDir, outcome };
  }

  /**
   * The reviewer's sequence. The journal breaks its generation ALONE — a
   * TRUNCATE that folds the receipt into a base minted AFTER the vault's — and
   * the provider then loses the vault's only segment. The vault's listing comes
   * back EMPTY, so nothing in the plan is "hole-truncated": the coordination
   * that keyed off `truncatedByHole` never fired, and the restore handed back
   * base(V0) — which has no row — beside base(J1), which has its receipt.
   *
   * Coordinated bases are what forbid this. The producer now breaks BOTH
   * generations in one tick, so a pair like this cannot be produced; a pair like
   * this that somehow EXISTS (a hand-built manifest, a pre-coordination
   * artifact) is refused before a byte moves, because with bases from two
   * instants there is no coordinated point to degrade to.
   */
  async function buildIndependentBreakPair(): Promise<{
    p: ReceiptPair;
    bases: { vault: Uint8Array; journal: Uint8Array };
    baseTicks: { vault: number; journal: number };
  }> {
    const p = await newPair(V0, J0);
    const baseVault = p.vault.base();
    p.journal.base();
    writePair(p, 'v42');
    // The journal alone re-bases: J1's main file already contains the receipt,
    // and its base tick is AFTER the vault's.
    const baseJournal = p.journal.rebase(J1);
    await ship(p);
    return {
      p,
      bases: { vault: baseVault, journal: baseJournal },
      baseTicks: { vault: BASE_TICK, journal: 1000 },
    };
  }

  test('an independently-broken journal base + a LOST vault segment is REFUSED, never restored', async () => {
    const { p, bases, baseTicks } = await buildIndependentBreakPair();
    await p.store.delete(walSegmentKey(p.vault.captured[0]!.addr));

    await expect(restorePair(p, bases, { vault: V0, journal: J1 }, { baseTicks })).rejects.toThrow(
      /bases are from DIFFERENT ticks/,
    );
  });

  test('the DAMAGED variant is refused identically — `truncatedByHole` was never the fix', async () => {
    const { p, bases, baseTicks } = await buildIndependentBreakPair();
    await flipByteInStore(p.store, walSegmentKey(p.vault.captured[0]!.addr));

    await expect(restorePair(p, bases, { vault: V0, journal: J1 }, { baseTicks })).rejects.toThrow(
      /bases are from DIFFERENT ticks/,
    );
  });

  test('a pair that cannot even PROVE its bases share a tick is refused too', async () => {
    const { p, bases } = await buildIndependentBreakPair();
    const destDir = await tempDir('backup-wal-dest-');
    await fs.writeFile(path.join(destDir, WAL_DB_FILES.vault), bases.vault);
    await fs.writeFile(path.join(destDir, WAL_DB_FILES.journal), bases.journal);
    await expect(
      replayWalSegments({
        store: p.store,
        dataKey: DATA_KEY,
        vaultId: VAULT_ID,
        destDir,
        generationByDb: { vault: V0, journal: J1 },
      }),
    ).rejects.toThrow(/does not record a base tick for both databases/);
  });

  /**
   * Coordinated bases are NECESSARY BUT NOT SUFFICIENT — the case that kills
   * the obvious fix. Both bases are from one tick here and both streams are
   * gapless; the provider simply lost the vault's NEWEST TWO segments. The
   * vault's listing just ENDS: no hole, no damage, nothing to detect. From a
   * listing alone you cannot tell "this database stopped changing" from "this
   * database's newest objects are gone", so without a pair marker the journal
   * sails on two ticks ahead of the vault, carrying receipts for rows that are
   * not there.
   */
  test('a LOST TAIL of vault segments (no hole, no damage) cuts BOTH databases back', async () => {
    const p = await newPair(V0, J0);
    const bases = { vault: p.vault.base(), journal: p.journal.base() };
    const ticks: number[] = [];
    for (let round = 1; round <= 5; round++) ticks.push(writePair(p, `v${round}`));
    await ship(p);

    // Drop the vault's two newest segment objects — the listing simply ends.
    for (const addr of p.vault.captured.slice(-2).map((c) => c.addr)) {
      await p.store.delete(walSegmentKey(addr));
    }

    const { destDir, outcome } = await restorePair(p, bases, { vault: V0, journal: J0 });
    expect(danglingReceipts(destDir)).toEqual([]);
    // The pair landed on ONE instant: the newest tick the vault can still PROVE
    // it reached (marker t3), not the newest tick the journal reached.
    expect(outcome.coordinatedCutMs).toBe(ticks[2]);
    expect(outcome.perDb.vault.lastTickMs).toBe(ticks[2]);
    expect(outcome.perDb.journal.lastTickMs).toBe(ticks[2]);
    // …and the restore says so: the producer proved tick 5000 and we could not
    // get there. That is the signal restore-verify escalates on.
    expect(outcome.newestMarkerTickMs).toBe(ticks[4]);
    expect(outcome.perDb.vault.truncated).toBe(true);
    expect(outcome.perDb.journal.truncated).toBe(true);
    expect(readRows(path.join(destDir, WAL_DB_FILES.vault))).toEqual(['v1', 'v2', 'v3']);
  });

  /**
   * The constraint the fix must not break. An idle database is NOT a missing
   * one: a vault that stops writing pins nothing, and the journal must still
   * restore to its own tip. Any "no segments ⇒ this db is stuck at its base
   * tick" rule silently discards every hour of journal history a quiet
   * afternoon produces — which is why the pair marker, not the listing, decides.
   */
  test('an IDLE vault does not hold a busy journal back (the regression guard)', async () => {
    const p = await newPair(V0, J0);
    const bases = { vault: p.vault.base(), journal: p.journal.base() };
    for (let round = 1; round <= 2; round++) writePair(p, `v${round}`);
    const vaultRowsAtIdle = p.vault.rows();

    let lastTick = 0;
    for (let round = 3; round <= 10; round++) lastTick = journalOnlyTick(p, `j${round}`);
    const liveJournalRows = p.journal.rows();
    await ship(p);

    const { destDir, outcome } = await restorePair(p, bases, { vault: V0, journal: J0 });
    expect(outcome.coordinatedCutMs).toBe(lastTick);
    expect(outcome.perDb.journal.lastTickMs).toBe(lastTick);
    expect(outcome.perDb.journal.truncated).toBe(false);
    expect(readRows(path.join(destDir, WAL_DB_FILES.journal))).toEqual(liveJournalRows);
    expect(readRows(path.join(destDir, WAL_DB_FILES.vault))).toEqual(vaultRowsAtIdle);
    expect(danglingReceipts(destDir)).toEqual([]);
  });

  test('a vault that NEVER ships a segment does not hold the journal back either', async () => {
    const p = await newPair(V0, J0);
    const bases = { vault: p.vault.base(), journal: p.journal.base() };
    let lastTick = 0;
    for (let round = 1; round <= 10; round++) lastTick = journalOnlyTick(p, `j${round}`);
    const liveJournalRows = p.journal.rows();
    await ship(p);

    const { destDir, outcome } = await restorePair(p, bases, { vault: V0, journal: J0 });
    expect(outcome.coordinatedCutMs).toBe(lastTick);
    expect(outcome.perDb.journal.lastTickMs).toBe(lastTick);
    expect(outcome.perDb.vault.segmentsApplied).toBe(0);
    expect(outcome.perDb.vault.truncated).toBe(false);
    expect(readRows(path.join(destDir, WAL_DB_FILES.journal))).toEqual(liveJournalRows);
  });

  /**
   * The markers themselves are deletable, and that is the QUIETEST failure in
   * the whole format: no hole, no damage, every object the manifest names still
   * present — the restore simply falls back to the base pair and returns an
   * hours-old vault without a word. `walTipTickMs` is the floor that closes it:
   * the newest marker tick the producer WATCHED the provider accept. Restore
   * still succeeds at the older coordinated point (G6 — degrade, never refuse),
   * but it must say so.
   */
  test('DELETED pair markers: the restore still succeeds, and reports itself TRUNCATED', async () => {
    const p = await newPair(V0, J0);
    const bases = { vault: p.vault.base(), journal: p.journal.base() };
    const ticks: number[] = [];
    for (let round = 1; round <= 3; round++) ticks.push(writePair(p, `v${round}`));
    await ship(p);
    const registeredTip = ticks[2]!;

    // Delete ONLY the markers. Every segment and closer survives.
    for (const m of p.markers) await p.store.delete(walPairMarkerKey(m));

    const { destDir, outcome } = await restorePair(
      p,
      bases,
      { vault: V0, journal: J0 },
      { walTipTickMs: registeredTip },
    );
    // Coherent, and correct as far as it goes…
    expect(danglingReceipts(destDir)).toEqual([]);
    expect(outcome.coordinatedCutMs).toBe(-1);
    expect(readRows(path.join(destDir, WAL_DB_FILES.vault))).toEqual([]); // the base pair, empty
    // …and LOUD: the store acknowledged tick 3000 and cannot honour it.
    expect(outcome.newestMarkerTickMs).toBe(-1); // nothing left to even ask
    expect(outcome.expectedCutMs).toBe(registeredTip); // but the tip still holds it to account
    expect(outcome.perDb.vault.truncated).toBe(true);
    expect(outcome.perDb.journal.truncated).toBe(true);
  });

  test('an intact store MEETS its registered tip — no false truncation', async () => {
    const p = await newPair(V0, J0);
    const bases = { vault: p.vault.base(), journal: p.journal.base() };
    const ticks: number[] = [];
    for (let round = 1; round <= 3; round++) ticks.push(writePair(p, `v${round}`));
    await ship(p);

    const { outcome } = await restorePair(
      p,
      bases,
      { vault: V0, journal: J0 },
      { walTipTickMs: ticks[2]! },
    );
    expect(outcome.coordinatedCutMs).toBe(ticks[2]);
    expect(outcome.expectedCutMs).toBe(ticks[2]);
    expect(outcome.perDb.vault.truncated).toBe(false);
    expect(outcome.perDb.journal.truncated).toBe(false);
  });

  test('a tip NEWER than the requested point-in-time is not a truncation', async () => {
    // A PITR deliberately cuts early. Holding it to a tip outside the window it
    // asked for would make every historical restore report itself damaged.
    const p = await newPair(V0, J0);
    const bases = { vault: p.vault.base(), journal: p.journal.base() };
    const ticks: number[] = [];
    for (let round = 1; round <= 3; round++) ticks.push(writePair(p, `v${round}`));
    await ship(p);

    const { outcome } = await restorePair(
      p,
      bases,
      { vault: V0, journal: J0 },
      { walTipTickMs: ticks[2]!, pointInTimeMs: ticks[0]! },
    );
    expect(outcome.coordinatedCutMs).toBe(ticks[0]);
    expect(outcome.expectedCutMs).toBe(ticks[0]);
    expect(outcome.perDb.vault.truncated).toBe(false);
  });

  /**
   * A lost GROUP CLOSER at the tail. Nothing else in the format can see this:
   * the chain reaches the group's last byte either way, and a closed final group
   * has no successor segments to prove it was finished. The marker says the
   * shipper had moved on to `(N+1, 0)`; the chain can only claim `(N, end)`.
   */
  test('a lost TAIL group closer makes its marker unsatisfiable and walks the pair back', async () => {
    const p = await newPair(V0, J0);
    const bases = { vault: p.vault.base(), journal: p.journal.base() };
    const t1 = writePair(p, 'v1');

    // Both roll their group at t2 — the vault's closer is the one that vanishes.
    p.vault.insert('v2');
    p.journal.insert('receipt:v2');
    const t2 = p.clock.next();
    p.journal.rollover(t2);
    p.vault.rollover(t2);
    markPair(p.markers, p.vault, p.journal, t2);
    await ship(p);
    await p.store.delete(walGroupCloserKey(p.vault.closers[0]!));

    const { destDir, outcome } = await restorePair(p, bases, { vault: V0, journal: J0 });
    expect(outcome.coordinatedCutMs).toBe(t1);
    expect(outcome.newestMarkerTickMs).toBe(t2);
    expect(danglingReceipts(destDir)).toEqual([]);
    expect(readRows(path.join(destDir, WAL_DB_FILES.vault))).toEqual(['v1']);
  });
});
