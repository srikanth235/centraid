import { createHash } from "node:crypto";
// governance: allow-repo-hygiene file-size-limit (#408) the detector suite shares real SQLite race hooks, restore helpers, and restart fixtures whose correctness depends on one common lifecycle harness
// WAL shipper detectors (#408): real sqlite, no mocks; capture correctness lives in wal-shipper.test.ts.
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
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  FsObjectStore,
  replayWalSegments,
  sealWalCloser,
  sealWalPairMarker,
  sealWalSegment,
  WAL_HEADER_BYTES,
  walSalts,
} from "@centraid/backup";
import type { WalDbName } from "@centraid/backup";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { bootstrapVault } from "./bootstrap.js";
import { openVaultDb } from "./db.js";
import type { VaultDb } from "./db.js";
import { WalShipper } from "./wal-shipper.js";
import type { UploadableWalFile, WalShipperOptions } from "./wal-shipper.js";

let root: string;
let vaultDir: string;
let db: VaultDb;
let clock: number;
const now = () => clock;

describe("wal-shipper-detectors", () => {
  beforeEach(() => {
    root = tempDirSync("wal-det-");
    vaultDir = path.join(root, "vault-a");
    db = openVaultDb({ dir: vaultDir });
    bootstrapVault(db, { ownerName: "Priya" });
    db.vault.exec(
      "CREATE TABLE _walship_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)"
    );
    db.journal.exec(
      "CREATE TABLE _walship_jprobe (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)"
    );
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

  const shipDir = () => path.join(root, "ship");

  function makeShipper(opts: Partial<WalShipperOptions> = {}): WalShipper {
    return new WalShipper({ db, dir: shipDir(), now, ...opts });
  }

  function insertVault(rows: number, size = 100, marker = "v"): void {
    const stmt = db.vault.prepare("INSERT INTO _walship_probe (v) VALUES (?)");
    for (let i = 0; i < rows; i++)
      stmt.run(`${marker}-${i}-${"x".repeat(size)}`);
  }

  function insertJournal(rows: number, size = 100, marker = "j"): void {
    const stmt = db.journal.prepare(
      "INSERT INTO _walship_jprobe (v) VALUES (?)"
    );
    for (let i = 0; i < rows; i++)
      stmt.run(`${marker}-${i}-${"x".repeat(size)}`);
  }

  function walPath(name: WalDbName): string {
    return path.join(vaultDir, `${name}.db-wal`);
  }

  function walSize(name: WalDbName): number {
    return existsSync(walPath(name)) ? statSync(walPath(name)).size : 0;
  }

  function readWalSalts(name: WalDbName): { salt1: number; salt2: number } {
    const fd = openSync(walPath(name), "r");
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
      .filter((i) => i.kind === "segment" && i.addr!.db === name)
      .sort(
        (a, b) =>
          a.addr!.group - b.addr!.group ||
          a.addr!.startOffset - b.addr!.startOffset
      );
  }

  /** A well-behaved out-of-process writer stand-in for journal.db. */
  function openSecondJournal(): DatabaseSync {
    const c = new DatabaseSync(path.join(vaultDir, "journal.db"));
    c.exec("PRAGMA busy_timeout = 5000");
    c.exec("PRAGMA wal_autocheckpoint = 0");
    return c;
  }

  /** Foreign commit inside the shipper's checkpoint: hook `prepare()` of
   *  `when`, once. */
  function raceJournalCommitAt(
    writer: DatabaseSync,
    when: string,
    value: string
  ): { fired: () => number; undo: () => void } {
    const real = db.journal.prepare.bind(db.journal);
    let fired = 0;
    db.journal.prepare = ((sql: string) => {
      if (fired === 0 && sql.includes(when)) {
        fired += 1;
        writer.prepare("INSERT INTO _walship_jprobe (v) VALUES (?)").run(value);
      }
      return real(sql);
    }) as typeof db.journal.prepare;
    return { fired: () => fired, undo: () => void (db.journal.prepare = real) };
  }

  /** Seal every uploadable and replay it over the shipper's CURRENT bases
   *  into a fresh dir. */
  async function restoreCurrent(
    shipper: WalShipper,
    name: string
  ): Promise<string> {
    const dataKey = new Uint8Array(32).fill(7);
    const store = new FsObjectStore(path.join(root, `objects-${name}`));
    await Promise.all(
      shipper.listUploadable().map((item) => {
        const sealed =
          item.kind === "segment"
            ? sealWalSegment(dataKey, "v1", item.addr!, readFileSync(item.file))
            : item.kind === "closer"
              ? sealWalCloser(dataKey, "v1", item.closer!)
              : sealWalPairMarker(dataKey, "v1", item.marker!);
        return store.put(item.key, sealed);
      })
    );
    const destDir = path.join(root, `restore-${name}`);
    mkdirSync(destDir, { recursive: true });
    const bases = shipper.currentBases();
    for (const base of bases)
      copyFileSync(base.file, path.join(destDir, `${base.db}.db`));
    const by = <T>(
      pick: (b: (typeof bases)[number]) => T
    ): Partial<Record<WalDbName, T>> =>
      Object.fromEntries(bases.map((b) => [b.db, pick(b)])) as Partial<
        Record<WalDbName, T>
      >;
    await replayWalSegments({
      store,
      dataKey,
      vaultId: "v1",
      destDir,
      generationByDb: by((b) => b.generation),
      baseTickMsByDb: by((b) => b.createdAtMs),
    });
    return destDir;
  }

  function restoredJournalRows(destDir: string): string[] {
    const conn = new DatabaseSync(path.join(destDir, "journal.db"), {
      readOnly: true,
    });
    try {
      return (
        conn.prepare("SELECT v FROM _walship_jprobe ORDER BY id").all() as {
          v: string;
        }[]
      ).map((r) => r.v);
    } finally {
      conn.close();
    }
  }

  test("[G5] a foreign checkpoint breaks the generation and mints a fresh pending base", () => {
    const shipper = makeShipper();
    shipper.tick();
    insertJournal(2, 200, "shipped");
    clock += 1000;
    shipper.tick();
    const before = shipper.status().dbs.journal!;

    // Unshipped frames, then a foreign checkpoint folds them into journal.db.
    insertJournal(2, 200, "folded");
    const c2 = new DatabaseSync(path.join(vaultDir, "journal.db"));
    try {
      c2.exec("PRAGMA busy_timeout = 5000");
      c2.exec("PRAGMA wal_checkpoint(RESTART)");
    } finally {
      c2.close();
    }

    clock += 1000;
    const r = shipper.tick();
    const brk = r.breaks.find((b) => b.db === "journal");
    expect(brk).toBeDefined();
    expect(brk!.reason).toMatch(/main-db|salt|shrank/u);

    const after = shipper.status().dbs.journal!;
    expect(after.generation).not.toBe(before.generation);
    expect(after.generation).toMatch(/^[0-9a-f]{32}$/u);
    expect(after.group).toBe(0);
    expect(after.offset).toBe(0);
    expect(after.basePending).toBe(true);
    const base = shipper.pendingBases().find((b) => b.db === "journal");
    expect(base).toBeDefined();
    expect(base!.generation).toBe(after.generation);
    expect(existsSync(base!.file)).toBe(true);

    // Writes ship under the NEW generation.
    insertJournal(1, 100, "post-break");
    clock += 1000;
    const r2 = shipper.tick();
    expect(r2.breaks).toStrictEqual([]);
    expect(r2.errors).toStrictEqual([]);
    expect(
      r2.shipped.some((k) => k.startsWith(`wal/journal/${after.generation}/`))
    ).toBe(true);
  });

  test("[G5][#411] a foreign checkpoint increments foreignCheckpointCount, and it survives a restart", () => {
    const shipper = makeShipper();
    shipper.tick();
    expect(shipper.status().foreignCheckpointCount).toBe(0);
    expect(shipper.status().lastForeignCheckpoint).toBeUndefined();

    insertJournal(2, 200, "shipped");
    clock += 1000;
    shipper.tick();

    // A foreign actor checkpoints journal.db behind the shipper's back.
    insertJournal(2, 200, "folded");
    const c2 = new DatabaseSync(path.join(vaultDir, "journal.db"));
    try {
      c2.exec("PRAGMA busy_timeout = 5000");
      c2.exec("PRAGMA wal_checkpoint(RESTART)");
    } finally {
      c2.close();
    }

    clock += 1000;
    const r = shipper.tick();
    expect(r.breaks.find((b) => b.db === "journal")).toBeDefined();

    const status = shipper.status();
    // Counted once: journal carried the foreign reason; `coordinated:*` must NOT count.
    expect(status.foreignCheckpointCount).toBe(1);
    expect(status.lastForeignCheckpoint).toMatchObject({
      atMs: clock,
      db: "journal",
    });
    expect(status.lastForeignCheckpoint!.reason).toMatch(
      /main-db|salt|shrank/u
    );

    // Persisted top-level, not per-stream: a fresh shipper reads it straight back.
    const shipper2 = makeShipper();
    expect(shipper2.status().foreignCheckpointCount).toBe(1);
    expect(shipper2.status().lastForeignCheckpoint).toStrictEqual(
      status.lastForeignCheckpoint
    );
  });

  test("[G5][#411] deliberate breaks (first-run, rollGeneration) do NOT increment the counter", () => {
    const shipper = makeShipper();
    // First tick mints both generations — a deliberate first-run break.
    const r0 = shipper.tick();
    expect(r0.breaks.map((b) => b.reason).sort()).toStrictEqual([
      "first-run",
      "first-run",
    ]);
    expect(shipper.status().foreignCheckpointCount).toBe(0);

    insertVault(2);
    clock += 1000;
    shipper.tick();

    // An explicitly requested roll is deliberate — not a foreign checkpoint.
    clock += 1000;
    const rolled = shipper.rollGeneration("vault", "key-epoch-rotation");
    expect(rolled.breaks.length).toBeGreaterThan(0);
    expect(shipper.status().foreignCheckpointCount).toBe(0);
    expect(shipper.status().lastForeignCheckpoint).toBeUndefined();
  });

  test("[G5] a vanished WAL file (with shipped offset) breaks the generation", () => {
    const shipper = makeShipper();
    shipper.tick();
    insertVault(2);
    clock += 1000;
    shipper.tick();
    expect(shipper.status().dbs.vault!.offset).toBeGreaterThan(0);

    rmSync(walPath("vault")); // no writes between the delete and the tick
    clock += 1000;
    const r = shipper.tick();
    expect(r.breaks.find((b) => b.db === "vault")?.reason).toBe(
      "wal-file-vanished"
    );
    expect(shipper.status().dbs.vault!.basePending).toBe(true);
  });

  test("[G5] a mutated main-db file breaks the generation", () => {
    const shipper = makeShipper();
    shipper.tick();
    const genBefore = shipper.status().dbs.vault!.generation;

    const t = new Date(Date.now() + 5000);
    utimesSync(path.join(vaultDir, "vault.db"), t, t);

    clock += 1000;
    const r = shipper.tick();
    expect(r.breaks.find((b) => b.db === "vault")?.reason).toBe(
      "main-db-file-changed-without-our-checkpoint"
    );
    expect(shipper.status().dbs.vault!.generation).not.toBe(genBefore);
  });

  test("[G5] the database-header fingerprint catches a checkpoint hidden by stable size and mtime", () => {
    const shipper = makeShipper();
    shipper.tick();
    const dbPath = path.join(vaultDir, "vault.db");
    const before = statSync(dbPath);

    insertVault(1, 200, "foreign-fold");
    const foreign = new DatabaseSync(dbPath);
    try {
      foreign.exec("PRAGMA busy_timeout = 5000");
      foreign.exec("PRAGMA wal_checkpoint(RESTART)");
    } finally {
      foreign.close();
    }
    expect(statSync(dbPath).size).toBe(before.size);
    utimesSync(dbPath, before.atime, before.mtime);

    clock += 1000;
    const report = shipper.tick();
    expect(report.breaks.find((entry) => entry.db === "vault")?.reason).toBe(
      "main-db-file-changed-without-our-checkpoint"
    );
  });

  // G5: capture → TRUNCATE race (P0)

  test("[G5] a writer that races the TRUNCATE is DETECTED, and its row survives the restore", async () => {
    // The forbidden hole: a foreign commit folded into journal.db between capture
    // and the checkpoint lock is ZEROED from the WAL; frame counts never fire
    // ({busy:0,log:0}). Only a restore proves the row survived.
    const shipper = makeShipper();
    shipper.tick();
    insertJournal(2, 200, "shipped-before-the-race");
    clock += 1000;
    shipper.tick();
    const before = shipper.status().dbs.journal!;
    expect(before.offset).toBeGreaterThan(0);

    const writer = openSecondJournal();
    const hook = raceJournalCommitAt(
      writer,
      "wal_checkpoint(TRUNCATE)",
      "RACED-THE-CHECKPOINT"
    );
    let report;
    try {
      clock += 1000;
      report = shipper.checkpointNow();
    } finally {
      hook.undo();
      writer.close();
    }
    expect(hook.fired()).toBe(1); // the racer really committed inside the window
    expect(report.errors).toStrictEqual([]);
    // The row IS in the live db; spread compares column data without asserting node:sqlite's null-prototype rows.
    expect({
      ...db.journal
        .prepare(
          "SELECT count(*) AS n FROM _walship_jprobe WHERE v = 'RACED-THE-CHECKPOINT'"
        )
        .get(),
    }).toStrictEqual({ n: 1 });

    // THE assertion: the restore carries the row — frames were zeroed; the race
    // is DETECTED and healed with a fresh base. Detection is the entire fix.
    const restored = restoredJournalRows(
      await restoreCurrent(shipper, "raced")
    );
    expect(restored).toContain("RACED-THE-CHECKPOINT");
    expect(
      restored.filter((v) => v.startsWith("shipped-before-the-race"))
    ).toHaveLength(2);

    // …and the healing is exactly the coordinated generation break.
    expect(report.breaks).toStrictEqual([
      { db: "journal", reason: "checkpoint-raced-writer" },
      { db: "vault", reason: "coordinated:checkpoint-raced-writer" },
    ]);
    const after = shipper.status().dbs.journal!;
    expect(after.generation).not.toBe(before.generation);
    expect(after.basePending).toBe(true);
    expect(shipper.basesCoordinated()).toBe(true);
    // A condemned stream gets NO group closer: one would forge "group N ends at
    // exactly `offset`" over folded-away frames — a forgery a restore trusts.
    expect(
      shipper
        .listUploadable()
        .filter(
          (i) =>
            i.kind === "closer" && i.closer!.generation === before.generation
        )
    ).toStrictEqual([]);
  });

  test("[G5] a commit landing BEFORE the pre-truncate stat is CAPTURED — the cheap path, no break", async () => {
    // Commoner race: a writer commits between capture and checkpoint — frames
    // still IN the WAL, so capture them. `data_version` is read BEFORE the stat,
    // so such a commit is visible to it.
    const shipper = makeShipper();
    shipper.tick();
    insertJournal(2, 200, "before");
    clock += 1000;
    shipper.tick();
    const before = shipper.status().dbs.journal!;

    const writer = openSecondJournal();
    const hook = raceJournalCommitAt(
      writer,
      "data_version",
      "CAPTURED-NOT-FOLDED"
    );
    let report;
    try {
      clock += 1000;
      report = shipper.checkpointNow();
    } finally {
      hook.undo();
      writer.close();
    }
    expect(hook.fired()).toBe(1);
    expect(report.errors).toStrictEqual([]);
    // Cheap path: SHIPPED, not folded — same generation, no break.
    expect(report.breaks).toStrictEqual([]);
    expect(shipper.status().dbs.journal!.generation).toBe(before.generation);
    const carried = segsOf(shipper, "journal").some((s) =>
      readFileSync(s.file).includes("CAPTURED-NOT-FOLDED")
    );
    expect(carried).toBe(true);
    expect(
      restoredJournalRows(await restoreCurrent(shipper, "cheap"))
    ).toContain("CAPTURED-NOT-FOLDED");
  });

  test("[G5] a foreign commit plus checkpoint inside data_version cannot disappear silently", async () => {
    const shipper = makeShipper();
    shipper.tick();
    insertJournal(1, 200, "before");
    clock += 1000;
    shipper.tick();

    const writer = openSecondJournal();
    const real = db.journal.prepare.bind(db.journal);
    let fired = 0;
    db.journal.prepare = ((sql: string) => {
      if (fired === 0 && sql.includes("data_version")) {
        fired++;
        writer
          .prepare("INSERT INTO _walship_jprobe (v) VALUES (?)")
          .run("COMMIT-AND-CHECKPOINT");
        writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
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
    expect(report.breaks.map((entry) => entry.db)).toStrictEqual([
      "journal",
      "vault",
    ]);
    expect(report.markers).toStrictEqual([]);
    expect(
      restoredJournalRows(await restoreCurrent(shipper, "commit-checkpoint"))
    ).toContain("COMMIT-AND-CHECKPOINT");
  });

  test("[G5] the quiet path does NOT break: our own TRUNCATE and our own writes never look like a race", () => {
    // Guard on the detector: data_version must stay stable across OUR checkpoints
    // and writes — otherwise every rollover looks like a race and each group
    // clones the whole db. Here it stays quiet.
    const shipper = makeShipper({ walSizeThresholdBytes: 8192 });
    shipper.tick();
    const before = {
      vault: shipper.status().dbs.vault!.generation,
      journal: shipper.status().dbs.journal!.generation,
    };

    // A foreign connection stays OPEN, READING (reads must not count); every WRITE goes through the shipper.
    const reader = openSecondJournal();
    let rolled = 0;
    try {
      for (let i = 0; i < 3; i++) {
        insertJournal(3, 4000, `quiet-${i}`);
        insertVault(3, 4000, `quiet-${i}`);
        reader.prepare("SELECT count(*) AS n FROM _walship_jprobe").get();
        clock += 1000;
        const r = shipper.tick();
        expect(r.breaks).toStrictEqual([]);
        expect(r.errors).toStrictEqual([]);
        rolled += r.rolled.length;
      }
    } finally {
      reader.close();
    }
    expect(rolled).toBeGreaterThan(0); // rollovers really ran, so TRUNCATE really ran
    expect(shipper.status().dbs.vault!.generation).toBe(before.vault);
    expect(shipper.status().dbs.journal!.generation).toBe(before.journal);
  });

  // I2: capture micro read-lock (#411)

  test("[I2] the capture read-mark pins the WAL: a foreign TRUNCATE/RESTART busys, no reset", () => {
    // Action 2 of #411: capture() holds a short read snapshot over the byte copy;
    // while held, NO checkpointer in ANY process may reset/truncate past the mark.
    // Proves the mechanism on this exact node:sqlite runtime.
    insertJournal(6, 200, "pinned"); // WAL now carries a header + committed frames
    expect(walSize("journal")).toBeGreaterThan(WAL_HEADER_BYTES);
    const saltsBefore = readWalSalts("journal");
    const sizeBefore = walSize("journal");

    const lock = new DatabaseSync(path.join(vaultDir, "journal.db"), {
      readOnly: true,
    });
    lock.exec("BEGIN");
    lock.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get();

    const foreign = openSecondJournal();
    foreign.exec("PRAGMA busy_timeout = 100"); // don't block the test on the pin
    try {
      for (const mode of ["TRUNCATE", "RESTART"]) {
        const row = foreign.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as {
          busy: number;
        };
        expect(row.busy).toBe(1); // pinned — the checkpoint cannot proceed
      }
      // The WAL is byte-for-byte unchanged: nothing reset it under the reader.
      expect(walSize("journal")).toBe(sizeBefore);
      expect(readWalSalts("journal")).toStrictEqual(saltsBefore);
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }

    // Once released the SAME TRUNCATE succeeds — proving the read mark, not some unrelated lock, held it.
    foreign.exec("PRAGMA busy_timeout = 5000");
    const after = foreign.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
      busy: number;
    };
    expect(after.busy).toBe(0);
    expect(walSize("journal")).toBe(0);
    foreign.close();
  });

  test("[I2] capture ships correct committed bytes with the read-lock in place", async () => {
    // The lock wraps every real capture; the copy it protects must stay byte-correct.
    const shipper = makeShipper();
    shipper.tick();
    insertJournal(3, 200, "locked-capture");
    clock += 1000;
    const r = shipper.tick();
    expect(r.breaks).toStrictEqual([]);
    expect(r.errors).toStrictEqual([]);
    expect(r.shipped.length).toBeGreaterThan(0);

    const rows = restoredJournalRows(await restoreCurrent(shipper, "locked"));
    expect(rows.filter((v) => v.startsWith("locked-capture"))).toHaveLength(3);
  });

  test("[I2] the read-lock never blocks the shipper OWN truncate — a rollover still cuts", () => {
    // Scoping invariant: released BEFORE the shipper's own TRUNCATE, or the
    // rollover checkpoint is busy against our own reader — widening the lock turns this red.
    const shipper = makeShipper({ walSizeThresholdBytes: 8192 });
    shipper.tick();
    insertJournal(4, 4000, "roll-under-lock");
    clock += 1000;
    const r = shipper.tick();
    expect(r.busy).toStrictEqual([]);
    expect(r.breaks).toStrictEqual([]);
    expect(r.errors).toStrictEqual([]);
    expect(r.rolled.some((x) => x.db === "journal")).toBe(true);
    expect(walSize("journal")).toBe(0); // truncated cleanly by our own checkpoint
  });

  test("[G7] a fresh shipper over the same dir continues the stream without a break", () => {
    const shipper = makeShipper();
    shipper.tick();
    insertVault(2);
    clock += 1000;
    shipper.tick();
    const before = shipper.status().dbs.vault!;

    const shipper2 = makeShipper();
    expect(shipper2.status().dbs.vault).toStrictEqual(before); // same generation/group/offset

    insertVault(1, 100, "after-restart");
    clock += 1000;
    const r = shipper2.tick();
    expect(r.breaks).toStrictEqual([]);
    expect(r.errors).toStrictEqual([]);
    const seg = segsOf(shipper2, "vault").at(-1)!;
    expect(seg.addr!.generation).toBe(before.generation);
    expect(seg.addr!.startOffset).toBe(before.offset);
  });

  test("[G7] crash between segment-fsync and offset-fsync: hygiene drops the stray, re-ship extends the same start", () => {
    const stateFile = path.join(shipDir(), "state.json");
    const shipper = makeShipper();
    shipper.tick();
    insertVault(2);
    clock += 1000;
    shipper.tick();
    const offX = shipper.status().dbs.vault!.offset;

    insertVault(2, 100, "more");
    const savedState = readFileSync(stateFile); // state BEFORE the next tick
    clock += 1000;
    shipper.tick(); // writes segment [offX, offY) AND advances state
    const offY = shipper.status().dbs.vault!.offset;
    expect(offY).toBeGreaterThan(offX);
    const stray = segsOf(shipper, "vault").find(
      (s) => s.addr!.startOffset === offX
    );
    expect(stray).toBeDefined();

    // "Crash" after segment fsync, before state fsync: state still says offX
    // while the segment file exists.
    writeFileSync(stateFile, savedState);
    const shipper2 = makeShipper();
    // Startup hygiene deleted the unacknowledged segment (end > persisted offset)...
    expect(existsSync(stray!.file)).toBe(false);
    expect(shipper2.status().dbs.vault!.offset).toBe(offX);

    // ...and the next tick re-ships from the old offset — prefix-extension:
    // same start, end >= old end (byte-identity lives in @centraid/backup's wal-format tests).
    clock += 1000;
    const r = shipper2.tick();
    expect(r.breaks).toStrictEqual([]);
    expect(r.errors).toStrictEqual([]);
    const reshipped = segsOf(shipper2, "vault").find(
      (s) => s.addr!.startOffset === offX
    );
    expect(reshipped).toBeDefined();
    expect(reshipped!.addr!.endOffset).toBeGreaterThanOrEqual(offY);
  });

  test("first-ever tick mints generations whose base clones hash-verify, reported as first-run", () => {
    const shipper = makeShipper();
    const r = shipper.tick();
    expect(r.breaks).toStrictEqual([
      { db: "journal", reason: "first-run" },
      { db: "vault", reason: "first-run" },
    ]);
    const bases = shipper.pendingBases();
    expect(
      bases.map((b) => b.db).sort((a, b) => a.localeCompare(b))
    ).toStrictEqual(["journal", "vault"]);
    for (const base of bases) {
      expect(existsSync(base.file)).toBe(true);
      const recomputed = createHash("sha256")
        .update(readFileSync(base.file))
        .digest("hex");
      expect(base.sha256).toBe(recomputed);
      expect(statSync(base.file).size).toBeGreaterThan(0);
    }
  });

  test("base cadence: an expired baseIntervalMs breaks the generation on the next tick", () => {
    const shipper = makeShipper({ baseIntervalMs: 10 });
    shipper.tick();
    const genBefore = shipper.status().dbs.vault!.generation;

    clock += 50; // past the 10ms cadence
    const r = shipper.tick();
    expect(
      r.breaks
        .filter((b) => b.reason === "base-cadence")
        .map((b) => b.db)
        .sort((a, b) => a.localeCompare(b))
    ).toStrictEqual(["journal", "vault"]);
    expect(shipper.status().dbs.vault!.generation).not.toBe(genBefore);
  });

  test("rollGeneration ships the old generation's pending bytes, then breaks BOTH databases", () => {
    const shipper = makeShipper();
    shipper.tick();
    const genBefore = {
      vault: shipper.status().dbs.vault!.generation,
      journal: shipper.status().dbs.journal!.generation,
    };
    insertVault(2, 200, "pending");

    clock += 1000;
    const r = shipper.rollGeneration("vault", "test-reason");
    // The pending committed bytes shipped under the OLD generation first...
    expect(
      r.shipped.some((k) => k.startsWith(`wal/vault/${genBefore.vault}/`))
    ).toBe(true);
    // ...and the break took BOTH databases, journal first: re-basing one db
    // alone leaves bases from two ticks — no coordinated restore point.
    expect(r.breaks).toStrictEqual([
      { db: "journal", reason: "coordinated:test-reason" },
      { db: "vault", reason: "test-reason" },
    ]);
    const after = shipper.status().dbs.vault!;
    expect(after.generation).not.toBe(genBefore.vault);
    expect(shipper.status().dbs.journal!.generation).not.toBe(
      genBefore.journal
    );
    expect(after.group).toBe(0);
    expect(after.offset).toBe(0);
    expect(shipper.basesCoordinated()).toBe(true);
    const bases = shipper.currentBases();
    expect(bases[0]!.createdAtMs).toBe(bases[1]!.createdAtMs);
  });

  test("a JOURNAL-only break reason re-bases the VAULT too, in the same tick", () => {
    const shipper = makeShipper();
    shipper.tick();
    const before = {
      vault: shipper.status().dbs.vault!.generation,
      journal: shipper.status().dbs.journal!.generation,
    };
    insertVault(2, 200, "vault-history");
    clock += 1000;
    shipper.tick();

    // Foreign checkpoint of journal.db — the classic journal-only break.
    insertJournal(2, 200, "folded");
    const c2 = new DatabaseSync(path.join(vaultDir, "journal.db"));
    try {
      c2.exec("PRAGMA busy_timeout = 5000");
      c2.exec("PRAGMA wal_checkpoint(RESTART)");
    } finally {
      c2.close();
    }

    clock += 1000;
    const r = shipper.tick();
    // Journal broke for its own reason; the vault broke WITH it.
    expect(r.breaks.map((b) => b.db)).toStrictEqual(["journal", "vault"]);
    expect(r.breaks.find((b) => b.db === "journal")!.reason).toMatch(
      /main-db|salt|shrank/u
    );
    expect(r.breaks.find((b) => b.db === "vault")!.reason).toMatch(
      /^coordinated:/u
    );
    expect(shipper.status().dbs.vault!.generation).not.toBe(before.vault);
    expect(shipper.status().dbs.journal!.generation).not.toBe(before.journal);

    // The two bases are ONE instant — the property every restore asserts.
    const bases = shipper.currentBases();
    expect(bases[0]!.createdAtMs).toBe(bases[1]!.createdAtMs);
    expect(shipper.basesCoordinated()).toBe(true);
  });

  test("[G8] the coordinated break TRUNCATES the journal before the vault — observed, not inferred", () => {
    // The ordering crux — looks right when wrong. A base's instant is its
    // TRUNCATE instant, NOT its clone instant: commits after the truncate land
    // in the new generation's WAL. Cloning journal first while truncating vault
    // first is BACKWARDS, safe only by accident.
    const order: string[] = [];
    const spy = (conn: DatabaseSync, name: string): void => {
      const real = conn.prepare.bind(conn);
      conn.prepare = (sql: string) => {
        if (sql.includes("wal_checkpoint(TRUNCATE)")) order.push(name);
        return real(sql);
      };
    };
    spy(db.vault, "vault");
    spy(db.journal, "journal");

    const shipper = makeShipper();
    shipper.tick(); // first-run: the coordinated break that mints both generations
    expect(order).toStrictEqual(["journal", "vault"]);

    // …and both bases carry the SAME tick — asserted by every restore.
    const bases = shipper.currentBases();
    expect(bases[0]!.createdAtMs).toBe(bases[1]!.createdAtMs);
  });

  test("busy sibling: the break DEFERS — no base is minted for either database", () => {
    const shipper = makeShipper();
    shipper.tick();
    const before = {
      vault: shipper.status().dbs.vault!.generation,
      journal: shipper.status().dbs.journal!.generation,
    };
    const baseTickBefore = shipper.currentBases()[0]!.createdAtMs;
    insertVault(2, 200, "pre-break");
    clock += 1000;
    shipper.tick();

    // Hold vault.db's checkpoint open so its TRUNCATE comes back busy; journal
    // cut FIRST — truncates before clones keeps it reversible.
    const reader = new DatabaseSync(path.join(vaultDir, "vault.db"));
    try {
      reader.exec("PRAGMA busy_timeout = 5000");
      reader.exec("BEGIN IMMEDIATE");
      reader
        .prepare("INSERT INTO _walship_probe (v) VALUES (?)")
        .run("holding-the-write-lock");

      clock += 1000;
      const r = shipper.rollGeneration("journal", "forced-roll");
      expect(r.busy).toContain("vault");
      expect(r.breaks).toStrictEqual([]); // NO base minted, for either database
      expect(shipper.status().dbs.vault!.generation).toBe(before.vault);
      expect(shipper.status().dbs.journal!.generation).toBe(before.journal);
      // The pair is not registerable while a break is mid-flight.
      expect(shipper.basesCoordinated()).toBe(false);
      reader.exec("ROLLBACK");
    } finally {
      reader.close();
    }

    // The retry lands: BOTH re-base in one tick, carrying the deferred reason.
    clock += 1000;
    const r2 = shipper.tick();
    expect(r2.breaks.map((b) => b.db)).toStrictEqual(["journal", "vault"]);
    expect(shipper.status().dbs.vault!.generation).not.toBe(before.vault);
    expect(shipper.status().dbs.journal!.generation).not.toBe(before.journal);
    expect(shipper.basesCoordinated()).toBe(true);
    const bases = shipper.currentBases();
    expect(bases[0]!.createdAtMs).toBe(bases[1]!.createdAtMs);
    expect(bases[0]!.createdAtMs).toBeGreaterThan(baseTickBefore);
  });

  test("a deferred break survives a RESTART — the frozen stream never resumes shipping", () => {
    const shipper = makeShipper();
    shipper.tick();
    const before = shipper.status().dbs.journal!.generation;

    const reader = new DatabaseSync(path.join(vaultDir, "vault.db"));
    try {
      reader.exec("PRAGMA busy_timeout = 5000");
      reader.exec("BEGIN IMMEDIATE");
      reader.prepare("INSERT INTO _walship_probe (v) VALUES (?)").run("lock");
      clock += 1000;
      expect(shipper.rollGeneration("journal", "forced-roll").busy).toContain(
        "vault"
      );
      reader.exec("ROLLBACK");
    } finally {
      reader.close();
    }

    // Fresh shipper reads breakPending off state; without it the next boot
    // resumes a mid-break stream — the eventual pair would be two instants.
    const shipper2 = makeShipper();
    expect(shipper2.basesCoordinated()).toBe(false);
    insertJournal(2, 200, "must-not-ship-under-the-old-generation");
    clock += 1000;
    const r = shipper2.tick();
    expect(
      r.shipped.filter((k) => k.startsWith(`wal/journal/${before}/`))
    ).toStrictEqual([]);
    expect(r.breaks.map((b) => b.db)).toStrictEqual(["journal", "vault"]);
    expect(shipper2.basesCoordinated()).toBe(true);
  });

  test("pair markers: a JOURNAL-only tick still emits ONE marker, carrying the vault position", () => {
    const shipper = makeShipper();
    shipper.tick();
    insertVault(2, 200, "v");
    clock += 1000;
    shipper.tick();
    const vaultAt = shipper.status().dbs.vault!;

    // The vault is idle; the marker MUST still record its unchanged position — how a restore tells "idle" from "segments gone".
    insertJournal(2, 200, "j");
    clock += 1000;
    const r = shipper.tick();
    expect(r.shipped.every((k) => k.startsWith("wal/journal/"))).toBe(true);
    expect(r.markers).toHaveLength(1);

    const written = shipper.listUploadable().filter((i) => i.kind === "marker");
    const newest = written.at(-1)!;
    expect(newest.key).toBe(r.markers[0]);
    expect(newest.marker!.tickMs).toBe(r.tickMs);
    expect(newest.marker!.vault).toStrictEqual({
      group: vaultAt.group,
      endOffset: vaultAt.offset,
    });
    expect(newest.marker!.journal.endOffset).toBe(
      shipper.status().dbs.journal!.offset
    );
  });

  test("pair markers: a tick that changes nothing emits NO marker", () => {
    const shipper = makeShipper();
    shipper.tick();
    insertVault(1, 100, "v");
    clock += 1000;
    expect(shipper.tick().markers).toHaveLength(1);

    clock += 1000;
    const idle = shipper.tick();
    expect(idle.shipped).toStrictEqual([]);
    expect(idle.markers).toStrictEqual([]);
    // Nothing moved: restoring "at this tick" equals the previous marker — an object would be pure cost.
  });

  test("pair markers: a tick that ends in a BREAK emits none (both databases are at their base)", () => {
    const shipper = makeShipper({ baseIntervalMs: 10 });
    const first = shipper.tick();
    expect(first.breaks.map((b) => b.reason)).toStrictEqual([
      "first-run",
      "first-run",
    ]);
    expect(first.markers).toStrictEqual([]);

    insertVault(2, 200, "v");
    clock += 50; // past the base cadence
    const r = shipper.tick();
    expect(r.breaks.map((b) => b.db)).toStrictEqual(["journal", "vault"]);
    // Both streams are at (0, 0) of fresh generations — that IS the base pair, the floor a restore falls back to.
    expect(r.markers).toStrictEqual([]);
    expect(shipper.status().dbs.vault!.offset).toBe(0);
  });

  test("listUploadable orders a marker AFTER the segments and closers it describes", () => {
    const shipper = makeShipper({ walSizeThresholdBytes: 8192 });
    shipper.tick();
    insertVault(3, 4000, "roll-me");
    clock += 1000;
    const r = shipper.tick();
    expect(r.rolled.some((x) => x.db === "vault")).toBe(true);
    expect(r.markers).toHaveLength(1);

    const items = shipper.listUploadable();
    const lastNonMarker = items.map((i) => i.kind).lastIndexOf("closer");
    const firstMarker = items.findIndex((i) => i.kind === "marker");
    expect(firstMarker).toBeGreaterThan(lastNonMarker);
    expect(items.findLastIndex((i) => i.kind === "segment")).toBeLessThan(
      firstMarker
    );
    // An orphan marker is merely unsatisfiable; reverse order costs a tick of RPO.
  });

  test("noteBaseRegistered clears pendingBases but keeps currentBases", () => {
    const shipper = makeShipper();
    shipper.tick();
    const gen = shipper.status().dbs.vault!.generation;
    expect(shipper.pendingBases()).toHaveLength(2);

    shipper.noteBaseRegistered("vault", gen);
    expect(shipper.pendingBases().map((b) => b.db)).toStrictEqual(["journal"]);
    expect(
      shipper
        .currentBases()
        .map((b) => b.db)
        .sort((a, b) => a.localeCompare(b))
    ).toStrictEqual(["journal", "vault"]);
    expect(shipper.status().dbs.vault!.basePending).toBe(false);

    // A stale-generation registration is a no-op.
    shipper.noteBaseRegistered("journal", "f".repeat(32));
    expect(shipper.pendingBases().map((b) => b.db)).toStrictEqual(["journal"]);
  });

  test("close() then reopen: the next shipper's first tick does NOT break the generation", () => {
    const shipper = makeShipper();
    shipper.tick();
    insertVault(2);
    clock += 1000;
    shipper.tick();

    const closeReport = shipper.close();
    expect(closeReport.busy).toStrictEqual([]);
    expect(closeReport.errors).toStrictEqual([]);
    expect(walSize("vault")).toBe(0); // WAL empty after the final ship+truncate
    expect(walSize("journal")).toBe(0);
    const closed = shipper.status().dbs;
    const state = JSON.parse(
      readFileSync(path.join(shipDir(), "state.json"), "utf8")
    ) as {
      dbs: Record<string, { closedClean: boolean }>;
    };
    expect(state.dbs["vault"]!.closedClean).toBe(true);
    expect(state.dbs["journal"]!.closedClean).toBe(true);
    expect(() => shipper.tick()).toThrow(/closed/u);

    // Reopen the vault the way gateway shutdown/startup does.
    db.close({ skipOptimize: true });
    db = openVaultDb({ dir: vaultDir });
    const shipper2 = makeShipper();
    clock += 1000;
    const r = shipper2.tick();
    // THE restart-cleanliness property: no spurious break.
    expect(r.breaks).toStrictEqual([]);
    expect(r.errors).toStrictEqual([]);
    expect(r.busy).toStrictEqual([]);
    expect(shipper2.status().dbs.vault!.generation).toBe(
      closed.vault!.generation
    );
    expect(shipper2.status().dbs.vault!.group).toBe(closed.vault!.group);

    // Subsequent writes ship under the SAME generation, next group.
    insertVault(1, 100, "after-reopen");
    clock += 1000;
    const r2 = shipper2.tick();
    expect(r2.breaks).toStrictEqual([]);
    const seg = segsOf(shipper2, "vault").at(-1)!;
    expect(seg.addr!.generation).toBe(closed.vault!.generation);
    expect(seg.addr!.group).toBe(closed.vault!.group);
  });

  test("local budget: over-budget segments break the generations and drop never-restorable history", () => {
    const shipper = makeShipper({ localBudgetBytes: 1000 });
    const first = shipper.tick(); // first-run; nothing local yet
    expect(first.breaks.map((b) => b.reason)).toStrictEqual([
      "first-run",
      "first-run",
    ]);
    const genBefore = shipper.status().dbs.vault!.generation;

    insertVault(2, 500, "bulky"); // one segment already exceeds 1000 bytes
    clock += 1000;
    const r = shipper.tick();
    expect(r.shipped.some((k) => k.startsWith(`wal/vault/${genBefore}/`))).toBe(
      true
    );
    expect(
      r.breaks
        .filter((b) => b.reason === "local-budget")
        .map((b) => b.db)
        .sort((a, b) => a.localeCompare(b))
    ).toStrictEqual(["journal", "vault"]);
    expect(shipper.status().dbs.vault!.generation).not.toBe(genBefore);
    expect(shipper.status().dbs.vault!.basePending).toBe(true);

    // The old generation was never registered (basePending): its segments are gone.
    expect(
      existsSync(path.join(shipDir(), "segments", "vault", genBefore))
    ).toBe(false);
    expect(
      shipper
        .listUploadable()
        .filter((i) => i.kind === "segment" && i.addr!.generation === genBefore)
    ).toStrictEqual([]);
  });
});
