import fss, { promises as fs } from "node:fs";
// governance: allow-repo-hygiene file-size-limit (#408) the replay e2e suite drives one real mini-shipper fixture through every damage/PITR/marker case; sharding would duplicate the shipper per file
/*
 * End-to-end WAL replay (FORMAT.md § WAL segments — /1, #408) over the REAL
 * pipeline. Row sets are compared against capture-time snapshots: the restore
 * must equal what the live database ACTUALLY held, not merely pass an integrity
 * check. The damage cases are the point — a corrupt, missing or forged object
 * degrades to an EARLIER CONSISTENT state (G6) the tick markers can still
 * PROVE, never a corrupt or half-applied one.
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
  sealWalSegment,
  sealWalTickMarker,
  WAL_DB_FILES,
  walGroupCloserKey,
  walSegmentKey,
  walTickMarkerKey,
} from "./wal-format.js";
import type {
  WalGroupCloser,
  WalSegmentAddress,
  WalTickMarker,
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
  /** One per tick that moved the stream — what the real shipper writes. */
  readonly markers: WalTickMarker[] = [];
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
    public generation: string,
    private readonly clock: TickClock
  ) {
    this.dbPath = path.join(dir, WAL_DB_FILES.vault);
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

  /** What a tick marker records; after `rollover()`, `(g+1, 0)` — where a
   * replay chain normalizes at group g's authentic closer. */
  position(): { group: number; endOffset: number } {
    return { group: this.group, endOffset: this.offset };
  }

  /** `[offset, lastCommitBoundary)` of the live WAL as one segment, then the
   * end-of-tick marker: the shipper writes both or the tick is not selectable. */
  tick(tickMs: number = this.clock.next()): number {
    this.capture(tickMs);
    this.mark(tickMs);
    return tickMs;
  }

  /** Capture the tail, then TRUNCATE-checkpoint: the WAL must actually reach
   * 0 bytes, which is the closer's invariant. The marker lands AFTER the group
   * advance, so it records `(g+1, 0)`. */
  rollover(tickMs: number = this.clock.next()): number {
    this.capture(tickMs);
    this.checkpointTruncate();
    if (fss.statSync(this.walPath).size !== 0) {
      throw new Error("TRUNCATE checkpoint left a non-empty WAL");
    }
    this.closers.push({
      db: "vault",
      generation: this.generation,
      group: this.group,
      endOffset: this.offset,
    });
    this.group += 1;
    this.offset = 0;
    this.mark(tickMs);
    return tickMs;
  }

  private capture(tickMs: number): void {
    if (!this.baseTaken) throw new Error("tick() before base()");
    const wal = new Uint8Array(fss.readFileSync(this.walPath));
    const boundary = lastCommitBoundary(wal, 0, this.pageSize);
    if (boundary <= this.offset)
      throw new Error("tick() with no new committed WAL bytes");
    const addr: WalSegmentAddress = {
      db: "vault",
      generation: this.generation,
      group: this.group,
      startOffset: this.offset,
      endOffset: boundary,
      tickMs,
    };
    this.captured.push({ addr, bytes: wal.slice(this.offset, boundary) });
    this.offset = boundary;
    this.rowsAtTick.set(tickMs, this.rows());
  }

  /** A tick that moved no bytes still records where the stream stands — that
   * repeat is what keeps an idle vault from reading as a truncated one. */
  markIdle(tickMs: number): void {
    this.mark(tickMs);
  }

  private mark(tickMs: number): void {
    this.markers.push({
      generation: this.generation,
      tickMs,
      position: this.position(),
    });
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
    ...ship.markers.map((marker) =>
      store.put(
        walTickMarkerKey(marker),
        sealWalTickMarker(DATA_KEY, VAULT_ID, marker)
      )
    ),
  ]);
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
  const ship = new MiniShipper(await tempDir("backup-wal-ship-"), gen, clock);
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
    generation: sc.gen,
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
    const vault = outcome;
    expect(vault.integrityCheck).toBe("ok");
    expect(vault.foreignKeyViolations).toBe(0);
    expect(vault.segmentsApplied).toBe(5);
    expect(vault.groupsApplied).toBe(2);
    expect(vault.lastTickMs).toBe(sc.ticks[4]);
    expect(vault.truncated).toBe(false);
    expect(vault.generation).toBe(sc.gen);
    expect(outcome.damaged).toStrictEqual([]);
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
    expect(atT2.outcome.segmentsApplied).toBe(2);
    expect(atT2.outcome.groupsApplied).toBe(1);
    expect(atT2.outcome.truncated).toBe(false);
    expect(atT2.outcome.integrityCheck).toBe("ok");

    const atT3 = await restoreVault(sc, t3);
    expect(atT3.rows).toStrictEqual(sc.rowsAt.get(t3));
    expect(atT3.outcome.segmentsApplied).toBe(3);
    expect(atT3.outcome.groupsApplied).toBe(1);

    const atT4 = await restoreVault(sc, t4);
    expect(atT4.rows).toStrictEqual(sc.rowsAt.get(t4));
    expect(atT4.outcome.segmentsApplied).toBe(4);
    expect(atT4.outcome.groupsApplied).toBe(2);

    // Before the first tick: the base alone.
    const atBase = await restoreVault(sc, t1 - 500);
    expect(atBase.rows).toStrictEqual(sc.baseRows);
    expect(atBase.outcome.segmentsApplied).toBe(0);
    expect(atBase.outcome.lastTickMs).toBe(-1);
    expect(atBase.outcome.integrityCheck).toBe("ok");
  });

  test("an empty stream (base only, no segments) restores the base intact", async () => {
    const store = new FsObjectStore(await tempDir("backup-wal-store-"));
    const clock = new TickClock();
    const gen = "f1".repeat(16);
    const ship = new MiniShipper(await tempDir("backup-wal-ship-"), gen, clock);
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
      generation: gen,
    });
    expect(readRows(path.join(destDir, WAL_DB_FILES.vault))).toStrictEqual([
      "only-1",
      "only-2",
    ]);
    expect(outcome).toMatchObject({
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
        generation: gen,
      })
    ).rejects.toThrow(/vault\.db failed foreign_key_check .*1 violation/u);
  });

  test("the same base WITHOUT the violating write restores cleanly (the check is not vacuous)", async () => {
    const store = new FsObjectStore(await tempDir("backup-wal-store-"));
    const gen = "c4".repeat(16);
    const ship = new MiniShipper(
      await tempDir("backup-wal-ship-"),
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
      generation: gen,
    });
    expect(outcome.foreignKeyViolations).toBe(0);
    expect(outcome.integrityCheck).toBe("ok");
    expect(outcome.segmentsApplied).toBe(1);
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
    const vault = outcome;
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
    expect(outcome.truncated).toBe(true);
    expect(outcome.segmentsApplied).toBe(1);
    expect(outcome.lastTickMs).toBe(t1);
    expect(outcome.integrityCheck).toBe("ok");
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
    expect(outcome.segmentsApplied).toBe(0);
    expect(outcome.lastTickMs).toBe(-1);
    expect(outcome.truncated).toBe(true);
    expect(outcome.integrityCheck).toBe("ok");
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
    const vault = outcome;
    expect(vault.segmentsApplied).toBe(2);
    expect(vault.groupsApplied).toBe(1);
    expect(vault.lastTickMs).toBe(t2);
    expect(vault.truncated).toBe(true);
    expect(vault.integrityCheck).toBe("ok");
    expect(outcome.damaged).toContain(tailKey);
  });

  test("a bit-flipped (forged) group CLOSER never advances past its group", async () => {
    const sc = await buildVaultScenario();
    const t2 = sc.ticks[1]!;
    await flipByteInStore(sc.store, sc.closerKeys[0]!);

    const { outcome, rows } = await restoreVault(sc);
    // Group 0's segments all authenticate, but with no AUTHENTIC closer the
    // group is unclosed: group 1 is never applied, intact or not. The t3 marker
    // records the post-rollover (1, 0), which an unclosed chain cannot reach —
    // so the restore lands on t2, the newest tick it can still PROVE.
    expect(rows).toStrictEqual(sc.rowsAt.get(t2));
    expect(outcome.segmentsApplied).toBe(2);
    expect(outcome.groupsApplied).toBe(1);
    expect(outcome.lastTickMs).toBe(t2);
    expect(outcome.truncated).toBe(true);
    expect(outcome.integrityCheck).toBe("ok");
    // A rejected closer is an unclosed group, not segment damage.
    expect(outcome.damaged).toStrictEqual([]);
  });

  test("a DELETED group closer behaves identically to a forged one", async () => {
    const sc = await buildVaultScenario();
    const t2 = sc.ticks[1]!;
    await sc.store.delete(sc.closerKeys[0]!);

    const { outcome, rows } = await restoreVault(sc);
    expect(rows).toStrictEqual(sc.rowsAt.get(t2));
    expect(outcome.groupsApplied).toBe(1);
    expect(outcome.lastTickMs).toBe(t2);
    expect(outcome.truncated).toBe(true);
    expect(outcome.integrityCheck).toBe("ok");
  });
});

// ─── tick markers: what a LISTING cannot tell you (#408) ───────

/**
 * A listing that simply ends is indistinguishable from an idle vault, so the
 * marker — sealed by the producer, per tick — is the only thing that can say
 * which. These are the cases where every named object is present and the
 * restore is still wrong without it.
 */
describe("replayWalSegments — the marker decides the cut, not the listing", () => {
  const GEN = "10".repeat(16);

  interface Stream {
    store: FsObjectStore;
    ship: MiniShipper;
    base: Uint8Array;
  }

  async function newStream(): Promise<Stream> {
    const store = new FsObjectStore(await tempDir("backup-wal-store-"));
    const ship = new MiniShipper(
      await tempDir("backup-wal-ship-"),
      GEN,
      new TickClock()
    );
    return { store, ship, base: ship.base() };
  }

  async function restore(
    stream: Stream,
    opts: { walTipTickMs?: number; pointInTimeMs?: number } = {}
  ): Promise<{
    destDir: string;
    rows: string[];
    outcome: Awaited<ReturnType<typeof replayWalSegments>>;
  }> {
    const destDir = await tempDir("backup-wal-dest-");
    await fs.writeFile(path.join(destDir, WAL_DB_FILES.vault), stream.base);
    const outcome = await replayWalSegments({
      store: stream.store,
      dataKey: DATA_KEY,
      vaultId: VAULT_ID,
      destDir,
      generation: GEN,
      ...(opts.walTipTickMs === undefined
        ? {}
        : { walTipTickMs: opts.walTipTickMs }),
      ...(opts.pointInTimeMs === undefined
        ? {}
        : { pointInTimeMs: opts.pointInTimeMs }),
    });
    return {
      destDir,
      rows: readRows(path.join(destDir, WAL_DB_FILES.vault)),
      outcome,
    };
  }

  test("a LOST TAIL of segments (no hole, no damage) cuts back to the last provable tick", async () => {
    const stream = await newStream();
    const ticks: number[] = [];
    for (let round = 1; round <= 5; round++) {
      stream.ship.insert(`v${round}`);
      ticks.push(stream.ship.tick());
    }
    await shipToStore(stream.store, stream.ship);
    // Drop the two newest segments — the listing simply ends.
    await Promise.all(
      stream.ship.captured
        .slice(-2)
        .map((capture) => stream.store.delete(walSegmentKey(capture.addr)))
    );
    stream.ship.close();

    const { rows, outcome } = await restore(stream);
    expect(outcome.cutTickMs).toBe(ticks[2]);
    expect(outcome.lastTickMs).toBe(ticks[2]);
    // …and says so — the signal restore-verify escalates on.
    expect(outcome.newestMarkerTickMs).toBe(ticks[4]);
    expect(outcome.truncated).toBe(true);
    expect(rows).toStrictEqual(["v1", "v2", "v3"]);
  });

  test("an IDLE vault is not a truncated one — later markers repeat its position", async () => {
    const stream = await newStream();
    stream.ship.insert("v1");
    stream.ship.tick();
    stream.ship.insert("v2");
    const busyTick = stream.ship.tick();
    const liveRows = stream.ship.rows();
    // Quiet afternoon: ticks with no new bytes ship no segment, only a marker
    // repeating the position the stream already reached.
    let idleTick = busyTick;
    for (let round = 0; round < 5; round++) {
      idleTick = busyTick + 1000 * (round + 1);
      stream.ship.markIdle(idleTick);
    }
    await shipToStore(stream.store, stream.ship);
    stream.ship.close();

    const { rows, outcome } = await restore(stream);
    expect(outcome.cutTickMs).toBe(idleTick);
    expect(outcome.newestMarkerTickMs).toBe(idleTick);
    expect(outcome.lastTickMs).toBe(busyTick);
    expect(outcome.truncated).toBe(false);
    expect(rows).toStrictEqual(liveRows);
  });

  test("DELETED markers: the restore still succeeds, and reports itself TRUNCATED", async () => {
    // The QUIETEST failure: no hole, no damage, and a silently hours-old vault.
    // `walTipTickMs` closes it — the restore degrades (G6) but must say so.
    const stream = await newStream();
    const ticks: number[] = [];
    for (let round = 1; round <= 3; round++) {
      stream.ship.insert(`v${round}`);
      ticks.push(stream.ship.tick());
    }
    await shipToStore(stream.store, stream.ship);
    // ONLY the markers; every segment and closer survives.
    await Promise.all(
      stream.ship.markers.map((marker) =>
        stream.store.delete(walTickMarkerKey(marker))
      )
    );
    stream.ship.close();
    const registeredTip = ticks[2]!;

    const { rows, outcome } = await restore(stream, {
      walTipTickMs: registeredTip,
    });
    expect(outcome.cutTickMs).toBe(-1);
    expect(rows).toStrictEqual([]); // the base, empty
    // LOUD: the store acknowledged the tip and cannot honour it.
    expect(outcome.newestMarkerTickMs).toBe(-1); // nothing left to even ask
    expect(outcome.expectedCutMs).toBe(registeredTip);
    expect(outcome.truncated).toBe(true);
  });

  test("an intact store MEETS its registered tip — no false truncation", async () => {
    const stream = await newStream();
    const ticks: number[] = [];
    for (let round = 1; round <= 3; round++) {
      stream.ship.insert(`v${round}`);
      ticks.push(stream.ship.tick());
    }
    await shipToStore(stream.store, stream.ship);
    stream.ship.close();

    const { outcome } = await restore(stream, { walTipTickMs: ticks[2]! });
    expect(outcome.cutTickMs).toBe(ticks[2]);
    expect(outcome.expectedCutMs).toBe(ticks[2]);
    expect(outcome.truncated).toBe(false);
  });

  test("a tip NEWER than the requested point-in-time is not a truncation", async () => {
    // A PITR cuts early on purpose: held to a tip outside its own window, every
    // historical restore would report itself damaged.
    const stream = await newStream();
    const ticks: number[] = [];
    for (let round = 1; round <= 3; round++) {
      stream.ship.insert(`v${round}`);
      ticks.push(stream.ship.tick());
    }
    await shipToStore(stream.store, stream.ship);
    stream.ship.close();

    const { outcome } = await restore(stream, {
      walTipTickMs: ticks[2]!,
      pointInTimeMs: ticks[0]!,
    });
    expect(outcome.cutTickMs).toBe(ticks[0]);
    expect(outcome.expectedCutMs).toBe(ticks[0]);
    expect(outcome.truncated).toBe(false);
  });

  test("a lost TAIL group closer makes its marker unsatisfiable and walks the cut back", async () => {
    // Invisible to everything else: the marker says `(N+1, 0)` where the chain
    // can only claim `(N, end)`.
    const stream = await newStream();
    stream.ship.insert("v1");
    const t1 = stream.ship.tick();
    stream.ship.insert("v2");
    const t2 = stream.ship.rollover();
    await shipToStore(stream.store, stream.ship);
    await stream.store.delete(walGroupCloserKey(stream.ship.closers[0]!));
    stream.ship.close();

    const { rows, outcome } = await restore(stream);
    expect(outcome.cutTickMs).toBe(t1);
    expect(outcome.newestMarkerTickMs).toBe(t2);
    expect(outcome.truncated).toBe(true);
    expect(rows).toStrictEqual(["v1"]);
  });
});
