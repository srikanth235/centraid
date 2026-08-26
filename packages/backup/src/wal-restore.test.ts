import fss, { promises as fs } from "node:fs";
// governance: allow-repo-hygiene file-size-limit (#408) the replay e2e suite drives one real mini-shipper fixture through every damage/PITR/coordination case; sharding would duplicate the shipper per file
/*
 * End-to-end WAL replay (FORMAT.md § WAL segments — /1, #408) over the REAL
 * pipeline. Row sets are compared against capture-time snapshots: the restore
 * must equal what the live database ACTUALLY held, not merely pass an integrity
 * check. The damage cases are the point — a corrupt, missing or forged object
 * degrades to an EARLIER CONSISTENT state (G6), coordinated across both
 * databases (G8), never a corrupt or mixed one.
 */
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { FsObjectStore } from "./object-store.js";
import type { ObjectStore } from "./object-store.js";
import {
  lastCommitBoundary,
  openWalSegment,
  parseWalSegmentKey,
  sealWalCloser,
  sealWalPairMarker,
  sealWalSegment,
  WAL_DB_FILES,
  walGroupCloserKey,
  walPairMarkerKey,
  walSegmentKey,
} from "./wal-format.js";
import type {
  WalDbName,
  WalGroupCloser,
  WalPairMarker,
  WalSegmentAddress,
} from "./wal-format.js";
import { replayWalSegments } from "./wal-restore.js";

const DATA_KEY = new Uint8Array(32).fill(0x6b);
const VAULT_ID = "vault-restore-test";

/* oxlint-disable max-classes-per-file -- (#354) TickClock is a tiny clock stub
   colocated with the MiniShipper test rig it drives. */
/** Segments of one round share a tick. */
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

/** A REAL mini shipper under the production invariants, capturing committed
 * `-wal` ranges. */
class MiniShipper {
  readonly captured: CapturedSegment[] = [];
  readonly closers: WalGroupCloser[] = [];
  /** PITR ground truth. */
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
    private readonly clock: TickClock
  ) {
    this.dbPath = path.join(dir, WAL_DB_FILES[dbName]);
    this.walPath = `${this.dbPath}-wal`;
    this.conn = new DatabaseSync(this.dbPath);
    this.conn.exec("PRAGMA journal_mode=WAL");
    this.conn.exec("PRAGMA synchronous=FULL");
    this.conn.exec("PRAGMA wal_autocheckpoint=0");
    this.conn.exec(
      "CREATE TABLE rows (id INTEGER PRIMARY KEY, val TEXT NOT NULL)"
    );
    const { page_size: pageSize } = this.conn
      .prepare("PRAGMA page_size")
      .get() as {
      page_size: number;
    };
    this.pageSize = pageSize;
  }

  insert(...vals: string[]): void {
    const stmt = this.conn.prepare("INSERT INTO rows (val) VALUES (?)");
    for (const val of vals) stmt.run(val);
  }

  /** Arbitrary SQL — the FK-violation fixture needs its own tables. */
  exec(sql: string): void {
    this.conn.exec(sql);
  }

  rows(): string[] {
    return (
      this.conn.prepare("SELECT val FROM rows ORDER BY id").all() as {
        val: string;
      }[]
    ).map((r) => r.val);
  }

  /** Must precede all captures. */
  base(): Uint8Array {
    if (this.captured.length > 0)
      throw new Error("base() must precede captures");
    this.checkpointTruncate();
    this.baseTaken = true;
    this.group = 0;
    this.offset = 0;
    return new Uint8Array(fss.readFileSync(this.dbPath));
  }

  /** Already-captured segments keep the OLD generation in their address, so
   * both eras live in one store — what a real break leaves behind. */
  rebase(generation: string): Uint8Array {
    this.checkpointTruncate();
    this.generation = generation;
    this.group = 0;
    this.offset = 0;
    this.baseTaken = true;
    return new Uint8Array(fss.readFileSync(this.dbPath));
  }

  /** What a pair marker records; after `rollover()`, `(g+1, 0)` — where a
   * replay chain normalizes at group g's authentic closer. */
  position(): { group: number; endOffset: number } {
    return { group: this.group, endOffset: this.offset };
  }

  /** `[offset, lastCommitBoundary)` of the live WAL as one segment. */
  tick(tickMs: number = this.clock.next()): number {
    if (!this.baseTaken) throw new Error("tick() before base()");
    const wal = new Uint8Array(fss.readFileSync(this.walPath));
    const boundary = lastCommitBoundary(wal, 0, this.pageSize);
    if (boundary <= this.offset)
      throw new Error("tick() with no new committed WAL bytes");
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

  /** Capture the tail, then TRUNCATE-checkpoint: the WAL must actually reach
   * 0 bytes, which is the closer's invariant. */
  rollover(tickMs?: number): number {
    const usedTick = this.tick(tickMs);
    this.checkpointTruncate();
    if (fss.statSync(this.walPath).size !== 0) {
      throw new Error("TRUNCATE checkpoint left a non-empty WAL");
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
    const row = this.conn.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
      busy: number;
    };
    if (row.busy !== 0)
      throw new Error("wal_checkpoint(TRUNCATE) reported busy");
  }
}

async function shipToStore(
  store: ObjectStore,
  ship: MiniShipper
): Promise<void> {
  await Promise.all([
    ...ship.captured.map(({ addr, bytes }) =>
      store.put(
        walSegmentKey(addr),
        sealWalSegment(DATA_KEY, VAULT_ID, addr, bytes)
      )
    ),
    ...ship.closers.map((closer) =>
      store.put(
        walGroupCloserKey(closer),
        sealWalCloser(DATA_KEY, VAULT_ID, closer)
      )
    ),
  ]);
}

/** Bases precede the first tick, so the pair's base tick is 0. */
const BASE_TICK = 0;

/** Call AFTER both databases have ticked: mixing one's post-tick position with
 * the other's pre-tick one is a lie every later restore walks back from. */
function markPair(
  markers: WalPairMarker[],
  vault: MiniShipper,
  journal: MiniShipper,
  tickMs: number
): void {
  markers.push({
    vaultGeneration: vault.generation,
    journalGeneration: journal.generation,
    tickMs,
    vault: vault.position(),
    journal: journal.position(),
  });
}

async function shipMarkers(
  store: ObjectStore,
  markers: WalPairMarker[]
): Promise<void> {
  await Promise.all(
    markers.map((marker) =>
      store.put(
        walPairMarkerKey(marker),
        sealWalPairMarker(DATA_KEY, VAULT_ID, marker)
      )
    )
  );
}

function readRows(dbPath: string): string[] {
  const conn = new DatabaseSync(dbPath);
  try {
    return (
      conn.prepare("SELECT val FROM rows ORDER BY id").all() as {
        val: string;
      }[]
    ).map((r) => r.val);
  } finally {
    conn.close();
  }
}

async function flipByteInStore(store: ObjectStore, key: string): Promise<void> {
  const bytes = new Uint8Array(await store.get(key));
  bytes[Math.floor(bytes.length / 2)]! ^= 0x01;
  await store.put(key, bytes);
}

async function forgeChecksumInvalidSegment(
  store: ObjectStore,
  key: string
): Promise<void> {
  const addr = parseWalSegmentKey(key);
  if (!addr) throw new Error(`bad test segment key: ${key}`);
  const plain = openWalSegment(DATA_KEY, VAULT_ID, addr, await store.get(key));
  // Re-encrypted under the legitimate key: GCM authenticates it, so only
  // SQLite's rolling WAL checksum rejects it.
  plain[plain.length - 1]! ^= 0x01;
  await store.put(key, sealWalSegment(DATA_KEY, VAULT_ID, addr, plain));
}

// ─── single database: 2 groups, 5 segments, 5 ticks ───────

interface VaultScenario {
  store: FsObjectStore;
  gen: string;
  base: Uint8Array;
  /** Capture order: [t1, t2, t3(=group-0 tail), t4, t5]. */
  segKeys: string[];
  closerKeys: string[];
  ticks: number[];
  rowsAt: Map<number, string[]>;
  baseRows: string[];
  liveRows: string[];
}

async function buildVaultScenario(): Promise<VaultScenario> {
  const store = new FsObjectStore(await tempDir("backup-wal-store-"));
  const clock = new TickClock();
  const gen = "e7".repeat(16);
  const ship = new MiniShipper(
    await tempDir("backup-wal-ship-"),
    "vault",
    gen,
    clock
  );
  ship.insert("r1", "r2");
  const base = ship.base();
  const baseRows = ship.rows();

  ship.insert("r3");
  const t1 = ship.tick();
  ship.insert("r4");
  const t2 = ship.tick();
  ship.insert("r5");
  const t3 = ship.rollover(); // closes group 0
  ship.insert("r6");
  const t4 = ship.tick();
  ship.insert("r7");
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
  const destDir = await tempDir("backup-wal-dest-");
  await fs.writeFile(path.join(destDir, WAL_DB_FILES.vault), sc.base);
  const outcome = await replayWalSegments({
    store: sc.store,
    dataKey: DATA_KEY,
    vaultId: VAULT_ID,
    destDir,
    generationByDb: { vault: sc.gen },
    ...(pointInTimeMs === undefined ? {} : { pointInTimeMs }),
  });
  return {
    outcome,
    destDir,
    rows: readRows(path.join(destDir, WAL_DB_FILES.vault)),
  };
}

describe("replayWalSegments — tip and point-in-time restore", () => {
  test("restore-to-tip reproduces EXACTLY the live row set across a group rollover", async () => {
    const sc = await buildVaultScenario();
    const { outcome, destDir, rows } = await restoreVault(sc);

    expect(rows).toStrictEqual(sc.liveRows);
    expect(rows).toStrictEqual(["r1", "r2", "r3", "r4", "r5", "r6", "r7"]);
    const vault = outcome.perDb.vault;
    expect(vault.integrityCheck).toBe("ok");
    expect(vault.foreignKeyViolations).toBe(0);
    expect(vault.segmentsApplied).toBe(5);
    expect(vault.groupsApplied).toBe(2);
    expect(vault.lastTickMs).toBe(sc.ticks[4]);
    expect(vault.truncated).toBe(false);
    expect(vault.generation).toBe(sc.gen);
    expect(outcome.damaged).toStrictEqual([]);
    // No generation: skipped, never assumed to be SQLite.
    expect(outcome.perDb.journal.integrityCheck).toBe("skipped");
    expect(outcome.perDb.journal.generation).toBeNull();
    await expect(
      fs.access(path.join(destDir, ".wal-restore-spool"))
    ).rejects.toThrow(/ENOENT/u);
    await expect(fs.access(path.join(destDir, "vault.db-wal"))).rejects.toThrow(
      /ENOENT/u
    );
  });

  test("point-in-time restores reproduce the exact rows recorded at each tick", async () => {
    const sc = await buildVaultScenario();
    const [t1, t2, t3, t4] = sc.ticks as [number, number, number, number];

    const atT2 = await restoreVault(sc, t2);
    expect(atT2.rows).toStrictEqual(sc.rowsAt.get(t2));
    expect(atT2.outcome.perDb.vault.segmentsApplied).toBe(2);
    expect(atT2.outcome.perDb.vault.groupsApplied).toBe(1);
    expect(atT2.outcome.perDb.vault.truncated).toBe(false);
    expect(atT2.outcome.perDb.vault.integrityCheck).toBe("ok");

    const atT3 = await restoreVault(sc, t3);
    expect(atT3.rows).toStrictEqual(sc.rowsAt.get(t3));
    expect(atT3.outcome.perDb.vault.segmentsApplied).toBe(3);
    expect(atT3.outcome.perDb.vault.groupsApplied).toBe(1);

    const atT4 = await restoreVault(sc, t4);
    expect(atT4.rows).toStrictEqual(sc.rowsAt.get(t4));
    expect(atT4.outcome.perDb.vault.segmentsApplied).toBe(4);
    expect(atT4.outcome.perDb.vault.groupsApplied).toBe(2);

    // Before the first tick: the base alone.
    const atBase = await restoreVault(sc, t1 - 500);
    expect(atBase.rows).toStrictEqual(sc.baseRows);
    expect(atBase.outcome.perDb.vault.segmentsApplied).toBe(0);
    expect(atBase.outcome.perDb.vault.lastTickMs).toBe(-1);
    expect(atBase.outcome.perDb.vault.integrityCheck).toBe("ok");
  });

  test("an empty stream (base only, no segments) restores the base intact", async () => {
    const store = new FsObjectStore(await tempDir("backup-wal-store-"));
    const clock = new TickClock();
    const gen = "f1".repeat(16);
    const ship = new MiniShipper(
      await tempDir("backup-wal-ship-"),
      "vault",
      gen,
      clock
    );
    ship.insert("only-1", "only-2");
    const base = ship.base();
    ship.close();

    const destDir = await tempDir("backup-wal-dest-");
    await fs.writeFile(path.join(destDir, WAL_DB_FILES.vault), base);
    const outcome = await replayWalSegments({
      store,
      dataKey: DATA_KEY,
      vaultId: VAULT_ID,
      destDir,
      generationByDb: { vault: gen },
    });
    expect(readRows(path.join(destDir, WAL_DB_FILES.vault))).toStrictEqual([
      "only-1",
      "only-2",
    ]);
    expect(outcome.perDb.vault).toMatchObject({
      segmentsApplied: 0,
      groupsApplied: 0,
      lastTickMs: -1,
      truncated: false,
      integrityCheck: "ok",
    });
    expect(outcome.damaged).toStrictEqual([]);
  });
});

describe("replayWalSegments — a logically inconsistent restore is a FAILED restore", () => {
  test("a foreign_key_check violation throws, however clean integrity_check comes back", async () => {
    const store = new FsObjectStore(await tempDir("backup-wal-store-"));
    const gen = "c3".repeat(16);
    const ship = new MiniShipper(
      await tempDir("backup-wal-ship-"),
      "vault",
      gen,
      new TickClock()
    );
    ship.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (id INTEGER PRIMARY KEY,
                          parent_id INTEGER NOT NULL REFERENCES parent(id));
      INSERT INTO parent (id) VALUES (1);
      INSERT INTO child (id, parent_id) VALUES (1, 1);
    `);
    const base = ship.base();

    // FKs are enforced on every real writer, so a restored dangling child is
    // logically fictional — a FAILED restore, never a note in the outcome.
    ship.exec("PRAGMA foreign_keys = OFF");
    ship.exec("INSERT INTO child (id, parent_id) VALUES (2, 404)");
    ship.tick();
    await shipToStore(store, ship);
    ship.close();

    const destDir = await tempDir("backup-wal-dest-");
    await fs.writeFile(path.join(destDir, WAL_DB_FILES.vault), base);
    await expect(
      replayWalSegments({
        store,
        dataKey: DATA_KEY,
        vaultId: VAULT_ID,
        destDir,
        generationByDb: { vault: gen },
      })
    ).rejects.toThrow(/vault\.db failed foreign_key_check .*1 violation/u);
  });

  test("the same base WITHOUT the violating write restores cleanly (the check is not vacuous)", async () => {
    const store = new FsObjectStore(await tempDir("backup-wal-store-"));
    const gen = "c4".repeat(16);
    const ship = new MiniShipper(
      await tempDir("backup-wal-ship-"),
      "vault",
      gen,
      new TickClock()
    );
    ship.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (id INTEGER PRIMARY KEY,
                          parent_id INTEGER NOT NULL REFERENCES parent(id));
      INSERT INTO parent (id) VALUES (1);
    `);
    const base = ship.base();
    ship.exec("INSERT INTO child (id, parent_id) VALUES (1, 1)");
    ship.tick();
    await shipToStore(store, ship);
    ship.close();

    const destDir = await tempDir("backup-wal-dest-");
    await fs.writeFile(path.join(destDir, WAL_DB_FILES.vault), base);
    const outcome = await replayWalSegments({
      store,
      dataKey: DATA_KEY,
      vaultId: VAULT_ID,
      destDir,
      generationByDb: { vault: gen },
    });
    expect(outcome.perDb.vault.foreignKeyViolations).toBe(0);
    expect(outcome.perDb.vault.integrityCheck).toBe("ok");
    expect(outcome.perDb.vault.segmentsApplied).toBe(1);
  });
});

describe("replayWalSegments — damage degrades to an earlier consistent state (G6)", () => {
  test("an AEAD-valid segment with an invalid SQLite rolling checksum is refused", async () => {
    const sc = await buildVaultScenario();
    await forgeChecksumInvalidSegment(sc.store, sc.segKeys[1]!);

    await expect(restoreVault(sc)).rejects.toThrow(/checksum/iu);
  });

  test("a corrupted MIDDLE segment lands the restore at the last pre-damage tick", async () => {
    const sc = await buildVaultScenario();
    const [t1] = sc.ticks as [number];
    const damagedKey = sc.segKeys[1]!; // the t2 segment
    await flipByteInStore(sc.store, damagedKey);

    const { outcome, rows } = await restoreVault(sc);
    expect(rows).toStrictEqual(sc.rowsAt.get(t1)); // earlier CONSISTENT state, not tip
    const vault = outcome.perDb.vault;
    expect(vault.integrityCheck).toBe("ok");
    expect(vault.truncated).toBe(true);
    expect(vault.segmentsApplied).toBe(1);
    expect(vault.lastTickMs).toBe(t1);
    expect(outcome.damaged).toContain(damagedKey);
  });

  test("a MISSING middle segment restores the same earlier state as a corrupted one", async () => {
    const sc = await buildVaultScenario();
    const [t1] = sc.ticks as [number];
    const missingKey = sc.segKeys[1]!;
    await sc.store.delete(missingKey);

    const { outcome, rows } = await restoreVault(sc);
    expect(rows).toStrictEqual(sc.rowsAt.get(t1));
    expect(outcome.perDb.vault.truncated).toBe(true);
    expect(outcome.perDb.vault.segmentsApplied).toBe(1);
    expect(outcome.perDb.vault.lastTickMs).toBe(t1);
    expect(outcome.perDb.vault.integrityCheck).toBe("ok");
    // A deleted object never appears in the LIST, so the planner sees the hole
    // up front and `damaged` stays empty.
    expect(outcome.damaged).toStrictEqual([]);
  });

  test("a damaged FIRST segment degrades all the way to the base", async () => {
    const sc = await buildVaultScenario();
    const firstKey = sc.segKeys[0]!;
    await flipByteInStore(sc.store, firstKey);

    const { outcome, rows } = await restoreVault(sc);
    expect(rows).toStrictEqual(sc.baseRows);
    expect(outcome.perDb.vault.segmentsApplied).toBe(0);
    expect(outcome.perDb.vault.lastTickMs).toBe(-1);
    expect(outcome.perDb.vault.truncated).toBe(true);
    expect(outcome.perDb.vault.integrityCheck).toBe("ok");
    expect(outcome.damaged).toContain(firstKey);
  });

  test("a corrupted group-TAIL segment stops the plan before the next group (never mixes)", async () => {
    const sc = await buildVaultScenario();
    const [, t2] = sc.ticks as [number, number];
    const tailKey = sc.segKeys[2]!; // group 0's closing segment
    await flipByteInStore(sc.store, tailKey);

    const { outcome, rows } = await restoreVault(sc);
    // Group 0 incomplete → group 1's pages must NOT be applied.
    expect(rows).toStrictEqual(sc.rowsAt.get(t2));
    const vault = outcome.perDb.vault;
    expect(vault.segmentsApplied).toBe(2);
    expect(vault.groupsApplied).toBe(1);
    expect(vault.lastTickMs).toBe(t2);
    expect(vault.truncated).toBe(true);
    expect(vault.integrityCheck).toBe("ok");
    expect(outcome.damaged).toContain(tailKey);
  });

  test("a bit-flipped (forged) group CLOSER keeps the group but never advances past it", async () => {
    const sc = await buildVaultScenario();
    const t3 = sc.ticks[2]!;
    await flipByteInStore(sc.store, sc.closerKeys[0]!);

    const { outcome, rows } = await restoreVault(sc);
    // Group 0 authenticates through t3, but with no AUTHENTIC closer the group
    // is unclosed: group 1 is never applied, intact or not.
    expect(rows).toStrictEqual(sc.rowsAt.get(t3));
    const vault = outcome.perDb.vault;
    expect(vault.segmentsApplied).toBe(3);
    expect(vault.groupsApplied).toBe(1);
    expect(vault.lastTickMs).toBe(t3);
    expect(vault.truncated).toBe(true);
    expect(vault.integrityCheck).toBe("ok");
    // A rejected closer is an unclosed group, not segment damage.
    expect(outcome.damaged).toStrictEqual([]);
  });

  test("a DELETED group closer behaves identically to a forged one", async () => {
    const sc = await buildVaultScenario();
    const t3 = sc.ticks[2]!;
    await sc.store.delete(sc.closerKeys[0]!);

    const { outcome, rows } = await restoreVault(sc);
    expect(rows).toStrictEqual(sc.rowsAt.get(t3));
    expect(outcome.perDb.vault.groupsApplied).toBe(1);
    expect(outcome.perDb.vault.truncated).toBe(true);
    expect(outcome.perDb.vault.integrityCheck).toBe("ok");
  });
});

// ─── two databases, one store: coordinated damage cut (G8) ───────

describe("replayWalSegments — coordinated two-database restore (G8)", () => {
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
    const store = new FsObjectStore(await tempDir("backup-wal-store-"));
    const clock = new TickClock();
    const genVault = "aa".repeat(16);
    const genJournal = "bb".repeat(16);
    const vault = new MiniShipper(
      await tempDir("backup-wal-shipv-"),
      "vault",
      genVault,
      clock
    );
    const journal = new MiniShipper(
      await tempDir("backup-wal-shipj-"),
      "journal",
      genJournal,
      clock
    );
    vault.insert("v-base");
    journal.insert("j-base");
    const baseVault = vault.base();
    const baseJournal = journal.base();

    const ticks: number[] = [];
    const markers: WalPairMarker[] = [];
    for (let round = 1; round <= 3; round++) {
      vault.insert(`v${round}`);
      journal.insert(`j${round}`);
      // One capture instant: the pair marker, written once both settle, is what
      // makes that instant SELECTABLE at restore time.
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
    const destDir = await tempDir("backup-wal-dest-");
    await fs.writeFile(path.join(destDir, WAL_DB_FILES.vault), sc.baseVault);
    await fs.writeFile(
      path.join(destDir, WAL_DB_FILES.journal),
      sc.baseJournal
    );
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

  test("intact streams restore both databases to the shared tip tick", async () => {
    const sc = await buildPairScenario();
    const t3 = sc.ticks[2]!;
    const { outcome, vaultRows, journalRows } = await restorePair(sc);
    expect(vaultRows).toStrictEqual(sc.vaultRowsAt.get(t3));
    expect(journalRows).toStrictEqual(sc.journalRowsAt.get(t3));
    expect(outcome.perDb.vault.lastTickMs).toBe(t3);
    expect(outcome.perDb.journal.lastTickMs).toBe(t3);
    expect(outcome.perDb.vault.integrityCheck).toBe("ok");
    expect(outcome.perDb.journal.integrityCheck).toBe("ok");
    expect(outcome.damaged).toStrictEqual([]);
  });

  test("damage in vault's stream re-cuts the INTACT journal to the same tick", async () => {
    const sc = await buildPairScenario();
    const [t1] = sc.ticks as [number];
    const damagedKey = sc.vaultSegKeys[1]!; // vault's t2 segment
    await flipByteInStore(sc.store, damagedKey);

    const { outcome, vaultRows, journalRows } = await restorePair(sc);
    expect(vaultRows).toStrictEqual(sc.vaultRowsAt.get(t1));
    expect(outcome.perDb.vault.lastTickMs).toBe(t1);
    // …and the journal, intact through t3, is re-cut to t1: ONE capture
    // instant, never a mixed pair.
    expect(journalRows).toStrictEqual(sc.journalRowsAt.get(t1));
    expect(outcome.perDb.journal.lastTickMs).toBe(t1);
    expect(outcome.perDb.journal.segmentsApplied).toBe(1);
    expect(outcome.perDb.vault.truncated).toBe(true);
    expect(outcome.perDb.journal.truncated).toBe(true);
    expect(outcome.perDb.vault.integrityCheck).toBe("ok");
    expect(outcome.perDb.journal.integrityCheck).toBe("ok");
    expect(outcome.damaged).toStrictEqual([damagedKey]);
  });

  test("damage in vault's FIRST segment forces both databases back to their bases", async () => {
    const sc = await buildPairScenario();
    await sc.store.delete(sc.vaultSegKeys[0]!);

    const { outcome, vaultRows, journalRows } = await restorePair(sc);
    expect(vaultRows).toStrictEqual(["v-base"]);
    expect(journalRows).toStrictEqual(["j-base"]);
    expect(outcome.perDb.vault.lastTickMs).toBe(-1);
    expect(outcome.perDb.journal.lastTickMs).toBe(-1);
    expect(outcome.perDb.journal.segmentsApplied).toBe(0);
    expect(outcome.perDb.vault.integrityCheck).toBe("ok");
    expect(outcome.perDb.journal.integrityCheck).toBe("ok");
  });
});

// ─── the receipt pair: what coordination is FOR (#408) ───────

/** A pair keeping `receipt:X` without `X` is a DANGLING RECEIPT: the one outcome
 * two-database coordination makes unconstructible. `verifyRestoredPair` does
 * this for real; backup cannot import vault, so it is modelled here. */
function danglingReceipts(destDir: string): string[] {
  const vaultRows = new Set(readRows(path.join(destDir, WAL_DB_FILES.vault)));
  return readRows(path.join(destDir, WAL_DB_FILES.journal))
    .filter((v) => v.startsWith("receipt:"))
    .map((v) => v.slice("receipt:".length))
    .filter((named) => !vaultRows.has(named));
}

describe("replayWalSegments — a dangling receipt must be unconstructible (G8)", () => {
  const V0 = "10".repeat(16);
  const J0 = "20".repeat(16);
  const J1 = "21".repeat(16);

  interface ReceiptPair {
    store: FsObjectStore;
    vault: MiniShipper;
    journal: MiniShipper;
    clock: TickClock;
    markers: WalPairMarker[];
  }

  async function newPair(
    genVault: string,
    genJournal: string
  ): Promise<ReceiptPair> {
    const store = new FsObjectStore(await tempDir("backup-wal-store-"));
    const clock = new TickClock();
    return {
      store,
      clock,
      markers: [],
      vault: new MiniShipper(
        await tempDir("backup-wal-shipv-"),
        "vault",
        genVault,
        clock
      ),
      journal: new MiniShipper(
        await tempDir("backup-wal-shipj-"),
        "journal",
        genJournal,
        clock
      ),
    };
  }

  /** ONE tick, JOURNAL FIRST — the capture order the no-dangling-receipt
   * argument rests on. */
  function writePair(p: ReceiptPair, row: string): number {
    p.vault.insert(row);
    p.journal.insert(`receipt:${row}`);
    const tickMs = p.clock.next();
    p.journal.tick(tickMs);
    p.vault.tick(tickMs);
    markPair(p.markers, p.vault, p.journal, tickMs);
    return tickMs;
  }

  /** Only the JOURNAL moved; the vault's position carries unchanged. */
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
    } = {}
  ): Promise<{
    destDir: string;
    outcome: Awaited<ReturnType<typeof replayWalSegments>>;
  }> {
    const destDir = await tempDir("backup-wal-dest-");
    await fs.writeFile(path.join(destDir, WAL_DB_FILES.vault), bases.vault);
    await fs.writeFile(path.join(destDir, WAL_DB_FILES.journal), bases.journal);
    const outcome = await replayWalSegments({
      store: p.store,
      dataKey: DATA_KEY,
      vaultId: VAULT_ID,
      destDir,
      generationByDb: generations,
      baseTickMsByDb: opts.baseTicks ?? {
        vault: BASE_TICK,
        journal: BASE_TICK,
      },
      ...(opts.walTipTickMs === undefined
        ? {}
        : { walTipTickMs: opts.walTipTickMs }),
      ...(opts.pointInTimeMs === undefined
        ? {}
        : { pointInTimeMs: opts.pointInTimeMs }),
    });
    return { destDir, outcome };
  }

  /**
   * The journal breaks its generation ALONE and the provider loses the vault's
   * only segment: nothing is hole-truncated and the pair mixes base(V0) with
   * base(J1). Coordinated bases forbid it — both generations break in one tick,
   * and a pair from two instants is refused before a byte moves.
   */
  async function buildIndependentBreakPair(): Promise<{
    p: ReceiptPair;
    bases: { vault: Uint8Array; journal: Uint8Array };
    baseTicks: { vault: number; journal: number };
  }> {
    const p = await newPair(V0, J0);
    const baseVault = p.vault.base();
    p.journal.base();
    writePair(p, "v42");
    // The journal alone re-bases, at a base tick AFTER the vault's.
    const baseJournal = p.journal.rebase(J1);
    await ship(p);
    return {
      p,
      bases: { vault: baseVault, journal: baseJournal },
      baseTicks: { vault: BASE_TICK, journal: 1000 },
    };
  }

  test("an independently-broken journal base + a LOST vault segment is REFUSED, never restored", async () => {
    const { p, bases, baseTicks } = await buildIndependentBreakPair();
    await p.store.delete(walSegmentKey(p.vault.captured[0]!.addr));

    await expect(
      restorePair(p, bases, { vault: V0, journal: J1 }, { baseTicks })
    ).rejects.toThrow(/bases are from DIFFERENT ticks/u);
  });

  test("the DAMAGED variant is refused identically — `truncatedByHole` was never the fix", async () => {
    const { p, bases, baseTicks } = await buildIndependentBreakPair();
    await flipByteInStore(p.store, walSegmentKey(p.vault.captured[0]!.addr));

    await expect(
      restorePair(p, bases, { vault: V0, journal: J1 }, { baseTicks })
    ).rejects.toThrow(/bases are from DIFFERENT ticks/u);
  });

  test("a pair that cannot even PROVE its bases share a tick is refused too", async () => {
    const { p, bases } = await buildIndependentBreakPair();
    const destDir = await tempDir("backup-wal-dest-");
    await fs.writeFile(path.join(destDir, WAL_DB_FILES.vault), bases.vault);
    await fs.writeFile(path.join(destDir, WAL_DB_FILES.journal), bases.journal);
    await expect(
      replayWalSegments({
        store: p.store,
        dataKey: DATA_KEY,
        vaultId: VAULT_ID,
        destDir,
        generationByDb: { vault: V0, journal: J1 },
      })
    ).rejects.toThrow(/does not record a base tick for both databases/u);
  });

  /**
   * Coordinated bases are NECESSARY BUT NOT SUFFICIENT: both streams are gapless
   * and the provider simply lost the vault's newest two segments. A listing
   * cannot tell "stopped changing" from "newest objects gone", so without a pair
   * marker the journal sails ahead, carrying receipts for absent rows.
   */
  test("a LOST TAIL of vault segments (no hole, no damage) cuts BOTH databases back", async () => {
    const p = await newPair(V0, J0);
    const bases = { vault: p.vault.base(), journal: p.journal.base() };
    const ticks: number[] = [];
    for (let round = 1; round <= 5; round++)
      ticks.push(writePair(p, `v${round}`));
    await ship(p);

    // Drop the vault's two newest segments — the listing simply ends.
    await Promise.all(
      p.vault.captured
        .slice(-2)
        .map((capture) => p.store.delete(walSegmentKey(capture.addr)))
    );

    const { destDir, outcome } = await restorePair(p, bases, {
      vault: V0,
      journal: J0,
    });
    expect(danglingReceipts(destDir)).toStrictEqual([]);
    // ONE instant: the newest tick the vault can still PROVE, not the journal's.
    expect(outcome.coordinatedCutMs).toBe(ticks[2]);
    expect(outcome.perDb.vault.lastTickMs).toBe(ticks[2]);
    expect(outcome.perDb.journal.lastTickMs).toBe(ticks[2]);
    // …and says so — the signal restore-verify escalates on.
    expect(outcome.newestMarkerTickMs).toBe(ticks[4]);
    expect(outcome.perDb.vault.truncated).toBe(true);
    expect(outcome.perDb.journal.truncated).toBe(true);
    expect(readRows(path.join(destDir, WAL_DB_FILES.vault))).toStrictEqual([
      "v1",
      "v2",
      "v3",
    ]);
  });

  /** An idle database is NOT a missing one: a "no segments ⇒ stuck at base" rule
   * discards a quiet afternoon of history, so the marker decides, not the list. */
  test("an IDLE vault does not hold a busy journal back (the regression guard)", async () => {
    const p = await newPair(V0, J0);
    const bases = { vault: p.vault.base(), journal: p.journal.base() };
    for (let round = 1; round <= 2; round++) writePair(p, `v${round}`);
    const vaultRowsAtIdle = p.vault.rows();

    let lastTick = 0;
    for (let round = 3; round <= 10; round++)
      lastTick = journalOnlyTick(p, `j${round}`);
    const liveJournalRows = p.journal.rows();
    await ship(p);

    const { destDir, outcome } = await restorePair(p, bases, {
      vault: V0,
      journal: J0,
    });
    expect(outcome.coordinatedCutMs).toBe(lastTick);
    expect(outcome.perDb.journal.lastTickMs).toBe(lastTick);
    expect(outcome.perDb.journal.truncated).toBe(false);
    expect(readRows(path.join(destDir, WAL_DB_FILES.journal))).toStrictEqual(
      liveJournalRows
    );
    expect(readRows(path.join(destDir, WAL_DB_FILES.vault))).toStrictEqual(
      vaultRowsAtIdle
    );
    expect(danglingReceipts(destDir)).toStrictEqual([]);
  });

  test("a vault that NEVER ships a segment does not hold the journal back either", async () => {
    const p = await newPair(V0, J0);
    const bases = { vault: p.vault.base(), journal: p.journal.base() };
    let lastTick = 0;
    for (let round = 1; round <= 10; round++)
      lastTick = journalOnlyTick(p, `j${round}`);
    const liveJournalRows = p.journal.rows();
    await ship(p);

    const { destDir, outcome } = await restorePair(p, bases, {
      vault: V0,
      journal: J0,
    });
    expect(outcome.coordinatedCutMs).toBe(lastTick);
    expect(outcome.perDb.journal.lastTickMs).toBe(lastTick);
    expect(outcome.perDb.vault.segmentsApplied).toBe(0);
    expect(outcome.perDb.vault.truncated).toBe(false);
    expect(readRows(path.join(destDir, WAL_DB_FILES.journal))).toStrictEqual(
      liveJournalRows
    );
  });

  /** Deleted markers are the QUIETEST failure: no hole, no damage, and a
   * silently hours-old vault. `walTipTickMs` closes it — the restore still
   * succeeds at the older point (G6), but it must say so. */
  test("DELETED pair markers: the restore still succeeds, and reports itself TRUNCATED", async () => {
    const p = await newPair(V0, J0);
    const bases = { vault: p.vault.base(), journal: p.journal.base() };
    const ticks: number[] = [];
    for (let round = 1; round <= 3; round++)
      ticks.push(writePair(p, `v${round}`));
    await ship(p);
    const registeredTip = ticks[2]!;

    // ONLY the markers; every segment and closer survives.
    await Promise.all(
      p.markers.map((marker) => p.store.delete(walPairMarkerKey(marker)))
    );

    const { destDir, outcome } = await restorePair(
      p,
      bases,
      { vault: V0, journal: J0 },
      { walTipTickMs: registeredTip }
    );
    expect(danglingReceipts(destDir)).toStrictEqual([]);
    expect(outcome.coordinatedCutMs).toBe(-1);
    expect(readRows(path.join(destDir, WAL_DB_FILES.vault))).toStrictEqual([]); // the base pair, empty
    // LOUD: the store acknowledged tick 3000 and cannot honour it.
    expect(outcome.newestMarkerTickMs).toBe(-1); // nothing left to even ask
    expect(outcome.expectedCutMs).toBe(registeredTip); // the tip still holds it to account
    expect(outcome.perDb.vault.truncated).toBe(true);
    expect(outcome.perDb.journal.truncated).toBe(true);
  });

  test("an intact store MEETS its registered tip — no false truncation", async () => {
    const p = await newPair(V0, J0);
    const bases = { vault: p.vault.base(), journal: p.journal.base() };
    const ticks: number[] = [];
    for (let round = 1; round <= 3; round++)
      ticks.push(writePair(p, `v${round}`));
    await ship(p);

    const { outcome } = await restorePair(
      p,
      bases,
      { vault: V0, journal: J0 },
      { walTipTickMs: ticks[2]! }
    );
    expect(outcome.coordinatedCutMs).toBe(ticks[2]);
    expect(outcome.expectedCutMs).toBe(ticks[2]);
    expect(outcome.perDb.vault.truncated).toBe(false);
    expect(outcome.perDb.journal.truncated).toBe(false);
  });

  test("a tip NEWER than the requested point-in-time is not a truncation", async () => {
    // A PITR cuts early on purpose: held to a tip outside its own window, every
    // historical restore would report itself damaged.
    const p = await newPair(V0, J0);
    const bases = { vault: p.vault.base(), journal: p.journal.base() };
    const ticks: number[] = [];
    for (let round = 1; round <= 3; round++)
      ticks.push(writePair(p, `v${round}`));
    await ship(p);

    const { outcome } = await restorePair(
      p,
      bases,
      { vault: V0, journal: J0 },
      { walTipTickMs: ticks[2]!, pointInTimeMs: ticks[0]! }
    );
    expect(outcome.coordinatedCutMs).toBe(ticks[0]);
    expect(outcome.expectedCutMs).toBe(ticks[0]);
    expect(outcome.perDb.vault.truncated).toBe(false);
  });

  /** A lost tail GROUP CLOSER is invisible to everything else: the marker says
   * `(N+1, 0)` where the chain can only claim `(N, end)`. */
  test("a lost TAIL group closer makes its marker unsatisfiable and walks the pair back", async () => {
    const p = await newPair(V0, J0);
    const bases = { vault: p.vault.base(), journal: p.journal.base() };
    const t1 = writePair(p, "v1");

    // Both roll at t2; the vault's closer vanishes.
    p.vault.insert("v2");
    p.journal.insert("receipt:v2");
    const t2 = p.clock.next();
    p.journal.rollover(t2);
    p.vault.rollover(t2);
    markPair(p.markers, p.vault, p.journal, t2);
    await ship(p);
    await p.store.delete(walGroupCloserKey(p.vault.closers[0]!));

    const { destDir, outcome } = await restorePair(p, bases, {
      vault: V0,
      journal: J0,
    });
    expect(outcome.coordinatedCutMs).toBe(t1);
    expect(outcome.newestMarkerTickMs).toBe(t2);
    expect(danglingReceipts(destDir)).toStrictEqual([]);
    expect(readRows(path.join(destDir, WAL_DB_FILES.vault))).toStrictEqual([
      "v1",
    ]);
  });
});
