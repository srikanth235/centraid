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
  sealWalSegment,
  sealWalTickMarker,
  WAL_HEADER_BYTES,
  walSalts,
} from "@centraid/backup";
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
    db.audit.exec(
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

  /** The audit band, written through its own handle — ONE FILE, one WAL. */
  function insertAudit(rows: number, size = 100, marker = "j"): void {
    const stmt = db.audit.prepare("INSERT INTO _walship_jprobe (v) VALUES (?)");
    for (let i = 0; i < rows; i++)
      stmt.run(`${marker}-${i}-${"x".repeat(size)}`);
  }

  function walPath(): string {
    return path.join(vaultDir, "vault.db-wal");
  }

  function walSize(): number {
    return existsSync(walPath()) ? statSync(walPath()).size : 0;
  }

  function readWalSalts(): { salt1: number; salt2: number } {
    const fd = openSync(walPath(), "r");
    try {
      const header = Buffer.alloc(WAL_HEADER_BYTES);
      readSync(fd, header, 0, WAL_HEADER_BYTES, 0);
      return walSalts(header);
    } finally {
      closeSync(fd);
    }
  }

  function segsOf(shipper: WalShipper): UploadableWalFile[] {
    return shipper
      .listUploadable()
      .filter((i) => i.kind === "segment")
      .sort(
        (a, b) =>
          a.addr!.group - b.addr!.group ||
          a.addr!.startOffset - b.addr!.startOffset
      );
  }

  /** A well-behaved out-of-process writer stand-in (app-engine workers). */
  function openSecondWriter(): DatabaseSync {
    const c = new DatabaseSync(path.join(vaultDir, "vault.db"));
    c.exec("PRAGMA busy_timeout = 5000");
    c.exec("PRAGMA wal_autocheckpoint = 0");
    return c;
  }

  /** Foreign commit inside the shipper's checkpoint: hook `prepare()` of
   *  `when`, once. */
  function raceForeignCommitAt(
    writer: DatabaseSync,
    when: string,
    value: string
  ): { fired: () => number; undo: () => void } {
    const real = db.audit.prepare.bind(db.audit);
    let fired = 0;
    db.audit.prepare = ((sql: string) => {
      if (fired === 0 && sql.includes(when)) {
        fired += 1;
        writer.prepare("INSERT INTO _walship_jprobe (v) VALUES (?)").run(value);
      }
      return real(sql);
    }) as typeof db.audit.prepare;
    return { fired: () => fired, undo: () => void (db.audit.prepare = real) };
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
              : sealWalTickMarker(dataKey, "v1", item.marker!);
        return store.put(item.key, sealed);
      })
    );
    const destDir = path.join(root, `restore-${name}`);
    mkdirSync(destDir, { recursive: true });
    const base = shipper.currentBase()!;
    copyFileSync(base.file, path.join(destDir, "vault.db"));
    await replayWalSegments({
      store,
      dataKey,
      vaultId: "v1",
      destDir,
      generation: base.generation,
    });
    return destDir;
  }

  function restoredAuditRows(destDir: string): string[] {
    const conn = new DatabaseSync(path.join(destDir, "vault.db"), {
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
    insertAudit(2, 200, "shipped");
    clock += 1000;
    shipper.tick();
    const before = shipper.status().stream!;

    // Unshipped frames, then a foreign checkpoint folds them into vault.db.
    insertAudit(2, 200, "folded");
    const c2 = new DatabaseSync(path.join(vaultDir, "vault.db"));
    try {
      c2.exec("PRAGMA busy_timeout = 5000");
      c2.exec("PRAGMA wal_checkpoint(RESTART)");
    } finally {
      c2.close();
    }

    clock += 1000;
    const r = shipper.tick();
    expect(r.breaks).toHaveLength(1);
    expect(r.breaks[0]!.reason).toMatch(/main-db|salt|shrank/u);

    const after = shipper.status().stream!;
    expect(after.generation).not.toBe(before.generation);
    expect(after.generation).toMatch(/^[0-9a-f]{32}$/u);
    expect(after.group).toBe(0);
    expect(after.offset).toBe(0);
    expect(after.basePending).toBe(true);
    const base = shipper.pendingBase();
    expect(base).not.toBeNull();
    expect(base!.generation).toBe(after.generation);
    expect(existsSync(base!.file)).toBe(true);

    // Writes ship under the NEW generation.
    insertAudit(1, 100, "post-break");
    clock += 1000;
    const r2 = shipper.tick();
    expect(r2.breaks).toStrictEqual([]);
    expect(r2.errors).toStrictEqual([]);
    expect(
      r2.shipped.some((k) => k.startsWith(`wal/vault/${after.generation}/`))
    ).toBe(true);
  });

  test("[G5][#411] a foreign checkpoint increments foreignCheckpointCount, and it survives a restart", () => {
    const shipper = makeShipper();
    shipper.tick();
    expect(shipper.status().foreignCheckpointCount).toBe(0);
    expect(shipper.status().lastForeignCheckpoint).toBeUndefined();

    insertAudit(2, 200, "shipped");
    clock += 1000;
    shipper.tick();

    // A foreign actor checkpoints vault.db behind the shipper's back.
    insertAudit(2, 200, "folded");
    const c2 = new DatabaseSync(path.join(vaultDir, "vault.db"));
    try {
      c2.exec("PRAGMA busy_timeout = 5000");
      c2.exec("PRAGMA wal_checkpoint(RESTART)");
    } finally {
      c2.close();
    }

    clock += 1000;
    const r = shipper.tick();
    expect(r.breaks).toHaveLength(1);

    const status = shipper.status();
    expect(status.foreignCheckpointCount).toBe(1);
    expect(status.lastForeignCheckpoint).toMatchObject({ atMs: clock });
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
    // The first tick mints the generation — a deliberate first-run break.
    const r0 = shipper.tick();
    expect(r0.breaks.map((b) => b.reason)).toStrictEqual(["first-run"]);
    expect(shipper.status().foreignCheckpointCount).toBe(0);

    insertVault(2);
    clock += 1000;
    shipper.tick();

    // An explicitly requested roll is deliberate — not a foreign checkpoint.
    clock += 1000;
    const rolled = shipper.rollGeneration("key-epoch-rotation");
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
    expect(shipper.status().stream!.offset).toBeGreaterThan(0);

    rmSync(walPath()); // no writes between the delete and the tick
    clock += 1000;
    const r = shipper.tick();
    expect(r.breaks[0]?.reason).toBe("wal-file-vanished");
    expect(shipper.status().stream!.basePending).toBe(true);
  });

  test("[G5] a mutated main-db file breaks the generation", () => {
    const shipper = makeShipper();
    shipper.tick();
    const genBefore = shipper.status().stream!.generation;

    const t = new Date(Date.now() + 5000);
    utimesSync(path.join(vaultDir, "vault.db"), t, t);

    clock += 1000;
    const r = shipper.tick();
    expect(r.breaks[0]?.reason).toBe(
      "main-db-file-changed-without-our-checkpoint"
    );
    expect(shipper.status().stream!.generation).not.toBe(genBefore);
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
    expect(report.breaks[0]?.reason).toBe(
      "main-db-file-changed-without-our-checkpoint"
    );
  });

  // G5: capture → TRUNCATE race (P0)

  test("[G5] a writer that races the TRUNCATE is DETECTED, and its row survives the restore", async () => {
    // The forbidden hole: a foreign commit folded into vault.db between capture
    // and the checkpoint lock is ZEROED from the WAL; frame counts never fire
    // ({busy:0,log:0}). Only a restore proves the row survived.
    const shipper = makeShipper();
    shipper.tick();
    insertAudit(2, 200, "shipped-before-the-race");
    clock += 1000;
    shipper.tick();
    const before = shipper.status().stream!;
    expect(before.offset).toBeGreaterThan(0);

    const writer = openSecondWriter();
    const hook = raceForeignCommitAt(
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
      ...db.audit
        .prepare(
          "SELECT count(*) AS n FROM _walship_jprobe WHERE v = 'RACED-THE-CHECKPOINT'"
        )
        .get(),
    }).toStrictEqual({ n: 1 });

    // THE assertion: the restore carries the row — frames were zeroed; the race
    // is DETECTED and healed with a fresh base. Detection is the entire fix.
    const restored = restoredAuditRows(await restoreCurrent(shipper, "raced"));
    expect(restored).toContain("RACED-THE-CHECKPOINT");
    expect(
      restored.filter((v) => v.startsWith("shipped-before-the-race"))
    ).toHaveLength(2);

    // …and the healing is exactly the generation break.
    expect(report.breaks).toStrictEqual([
      { reason: "checkpoint-raced-writer" },
    ]);
    const after = shipper.status().stream!;
    expect(after.generation).not.toBe(before.generation);
    expect(after.basePending).toBe(true);
    expect(shipper.baseReady()).toBe(true);
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
    insertAudit(2, 200, "before");
    clock += 1000;
    shipper.tick();
    const before = shipper.status().stream!;

    const writer = openSecondWriter();
    const hook = raceForeignCommitAt(
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
    expect(shipper.status().stream!.generation).toBe(before.generation);
    const carried = segsOf(shipper).some((s) =>
      readFileSync(s.file).includes("CAPTURED-NOT-FOLDED")
    );
    expect(carried).toBe(true);
    expect(restoredAuditRows(await restoreCurrent(shipper, "cheap"))).toContain(
      "CAPTURED-NOT-FOLDED"
    );
  });

  test("[G5] a foreign commit plus checkpoint inside data_version cannot disappear silently", async () => {
    const shipper = makeShipper();
    shipper.tick();
    insertAudit(1, 200, "before");
    clock += 1000;
    shipper.tick();

    const writer = openSecondWriter();
    const real = db.audit.prepare.bind(db.audit);
    let fired = 0;
    db.audit.prepare = ((sql: string) => {
      if (fired === 0 && sql.includes("data_version")) {
        fired++;
        writer
          .prepare("INSERT INTO _walship_jprobe (v) VALUES (?)")
          .run("COMMIT-AND-CHECKPOINT");
        writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      }
      return real(sql);
    }) as typeof db.audit.prepare;
    let report;
    try {
      clock += 1000;
      report = shipper.checkpointNow();
    } finally {
      db.audit.prepare = real;
      writer.close();
    }

    expect(fired).toBe(1);
    // Either detector may name it first — the preflight main-file compare or
    // the `data_version` bracket. What must never happen is neither firing.
    expect(report.breaks).toHaveLength(1);
    expect(report.breaks[0]!.reason).toMatch(
      /checkpoint-raced-writer|main-db-file-changed-without-our-checkpoint/u
    );
    expect(report.markers).toStrictEqual([]);
    expect(
      restoredAuditRows(await restoreCurrent(shipper, "commit-checkpoint"))
    ).toContain("COMMIT-AND-CHECKPOINT");
  });

  test("[G5] the quiet path does NOT break: our own TRUNCATE and our own writes never look like a race", () => {
    // Guard on the detector: data_version must stay stable across OUR checkpoints
    // and writes — otherwise every rollover looks like a race and each group
    // clones the whole db. Here it stays quiet.
    const shipper = makeShipper({ walSizeThresholdBytes: 8192 });
    shipper.tick();
    const before = {
      vault: shipper.status().stream!.generation,
      journal: shipper.status().stream!.generation,
    };

    // A foreign connection stays OPEN, READING (reads must not count); every WRITE goes through the shipper.
    const reader = openSecondWriter();
    let rolled = 0;
    try {
      for (let i = 0; i < 3; i++) {
        insertAudit(3, 4000, `quiet-${i}`);
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
    expect(shipper.status().stream!.generation).toBe(before.vault);
    expect(shipper.status().stream!.generation).toBe(before.journal);
  });

  // I2: capture micro read-lock (#411)

  test("[I2] the capture read-mark pins the WAL: a foreign TRUNCATE/RESTART busys, no reset", () => {
    // Action 2 of #411: capture() holds a short read snapshot over the byte copy;
    // while held, NO checkpointer in ANY process may reset/truncate past the mark.
    // Proves the mechanism on this exact node:sqlite runtime.
    insertAudit(6, 200, "pinned"); // WAL now carries a header + committed frames
    expect(walSize()).toBeGreaterThan(WAL_HEADER_BYTES);
    const saltsBefore = readWalSalts();
    const sizeBefore = walSize();

    const lock = new DatabaseSync(path.join(vaultDir, "vault.db"), {
      readOnly: true,
    });
    lock.exec("BEGIN");
    lock.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get();

    const foreign = openSecondWriter();
    foreign.exec("PRAGMA busy_timeout = 100"); // don't block the test on the pin
    try {
      for (const mode of ["TRUNCATE", "RESTART"]) {
        const row = foreign.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as {
          busy: number;
        };
        expect(row.busy).toBe(1); // pinned — the checkpoint cannot proceed
      }
      // The WAL is byte-for-byte unchanged: nothing reset it under the reader.
      expect(walSize()).toBe(sizeBefore);
      expect(readWalSalts()).toStrictEqual(saltsBefore);
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
    expect(walSize()).toBe(0);
    foreign.close();
  });

  test("[I2] capture ships correct committed bytes with the read-lock in place", async () => {
    // The lock wraps every real capture; the copy it protects must stay byte-correct.
    const shipper = makeShipper();
    shipper.tick();
    insertAudit(3, 200, "locked-capture");
    clock += 1000;
    const r = shipper.tick();
    expect(r.breaks).toStrictEqual([]);
    expect(r.errors).toStrictEqual([]);
    expect(r.shipped.length).toBeGreaterThan(0);

    const rows = restoredAuditRows(await restoreCurrent(shipper, "locked"));
    expect(rows.filter((v) => v.startsWith("locked-capture"))).toHaveLength(3);
  });

  test("[I2] the read-lock never blocks the shipper OWN truncate — a rollover still cuts", () => {
    // Scoping invariant: released BEFORE the shipper's own TRUNCATE, or the
    // rollover checkpoint is busy against our own reader — widening the lock turns this red.
    const shipper = makeShipper({ walSizeThresholdBytes: 8192 });
    shipper.tick();
    insertAudit(4, 4000, "roll-under-lock");
    clock += 1000;
    const r = shipper.tick();
    expect(r.busy).toBe(false);
    expect(r.breaks).toStrictEqual([]);
    expect(r.errors).toStrictEqual([]);
    expect(r.rolled).toHaveLength(1);
    expect(walSize()).toBe(0); // truncated cleanly by our own checkpoint
  });

  test("[G7] a fresh shipper over the same dir continues the stream without a break", () => {
    const shipper = makeShipper();
    shipper.tick();
    insertVault(2);
    clock += 1000;
    shipper.tick();
    const before = shipper.status().stream!;

    const shipper2 = makeShipper();
    expect(shipper2.status().stream).toStrictEqual(before); // same generation/group/offset

    insertVault(1, 100, "after-restart");
    clock += 1000;
    const r = shipper2.tick();
    expect(r.breaks).toStrictEqual([]);
    expect(r.errors).toStrictEqual([]);
    const seg = segsOf(shipper2).at(-1)!;
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
    const offX = shipper.status().stream!.offset;

    insertVault(2, 100, "more");
    const savedState = readFileSync(stateFile); // state BEFORE the next tick
    clock += 1000;
    shipper.tick(); // writes segment [offX, offY) AND advances state
    const offY = shipper.status().stream!.offset;
    expect(offY).toBeGreaterThan(offX);
    const stray = segsOf(shipper).find((s) => s.addr!.startOffset === offX);
    expect(stray).toBeDefined();

    // "Crash" after segment fsync, before state fsync: state still says offX
    // while the segment file exists.
    writeFileSync(stateFile, savedState);
    const shipper2 = makeShipper();
    // Startup hygiene deleted the unacknowledged segment (end > persisted offset)...
    expect(existsSync(stray!.file)).toBe(false);
    expect(shipper2.status().stream!.offset).toBe(offX);

    // ...and the next tick re-ships from the old offset — prefix-extension:
    // same start, end >= old end (byte-identity lives in @centraid/backup's wal-format tests).
    clock += 1000;
    const r = shipper2.tick();
    expect(r.breaks).toStrictEqual([]);
    expect(r.errors).toStrictEqual([]);
    const reshipped = segsOf(shipper2).find(
      (s) => s.addr!.startOffset === offX
    );
    expect(reshipped).toBeDefined();
    expect(reshipped!.addr!.endOffset).toBeGreaterThanOrEqual(offY);
  });

  test("first-ever tick mints generations whose base clones hash-verify, reported as first-run", () => {
    const shipper = makeShipper();
    const r = shipper.tick();
    expect(r.breaks).toStrictEqual([{ reason: "first-run" }]);
    const base = shipper.pendingBase()!;
    expect(existsSync(base.file)).toBe(true);
    const recomputed = createHash("sha256")
      .update(readFileSync(base.file))
      .digest("hex");
    expect(base.sha256).toBe(recomputed);
    expect(statSync(base.file).size).toBeGreaterThan(0);
  });

  test("base cadence: an expired baseIntervalMs breaks the generation on the next tick", () => {
    const shipper = makeShipper({ baseIntervalMs: 10 });
    shipper.tick();
    const genBefore = shipper.status().stream!.generation;

    clock += 50; // past the 10ms cadence
    const r = shipper.tick();
    expect(r.breaks.map((b) => b.reason)).toStrictEqual(["base-cadence"]);
    expect(shipper.status().stream!.generation).not.toBe(genBefore);
  });

  test("rollGeneration ships the old generation's pending bytes, then breaks", () => {
    const shipper = makeShipper();
    shipper.tick();
    const genBefore = shipper.status().stream!.generation;
    insertVault(2, 200, "pending");

    clock += 1000;
    const r = shipper.rollGeneration("test-reason");
    // The pending committed bytes shipped under the OLD generation first…
    expect(r.shipped.some((k) => k.startsWith(`wal/vault/${genBefore}/`))).toBe(
      true
    );
    // …and only then did the base re-clone.
    expect(r.breaks).toStrictEqual([{ reason: "test-reason" }]);
    const after = shipper.status().stream!;
    expect(after.generation).not.toBe(genBefore);
    expect(after.group).toBe(0);
    expect(after.offset).toBe(0);
    expect(shipper.baseReady()).toBe(true);
    expect(shipper.currentBase()!.createdAtMs).toBe(r.tickMs);
  });

  test("a busy checkpoint DEFERS the break — no base is minted over an uncut WAL", () => {
    const shipper = makeShipper();
    shipper.tick();
    const before = shipper.status().stream!.generation;
    const baseTickBefore = shipper.currentBase()!.createdAtMs;
    insertVault(2, 200, "pre-break");
    clock += 1000;
    shipper.tick();

    // Hold the write lock so the TRUNCATE comes back busy. Cloning anyway would
    // anchor a base while the old WAL still holds unshipped committed frames.
    const reader = new DatabaseSync(path.join(vaultDir, "vault.db"));
    try {
      reader.exec("PRAGMA busy_timeout = 5000");
      reader.exec("BEGIN IMMEDIATE");
      reader
        .prepare("INSERT INTO _walship_probe (v) VALUES (?)")
        .run("holding-the-write-lock");

      clock += 1000;
      const r = shipper.rollGeneration("forced-roll");
      expect(r.busy).toBe(true);
      expect(r.breaks).toStrictEqual([]); // NO base minted
      expect(shipper.status().stream!.generation).toBe(before);
      // Not registerable while a break is mid-flight.
      expect(shipper.baseReady()).toBe(false);
      reader.exec("ROLLBACK");
    } finally {
      reader.close();
    }

    // The retry lands, carrying the deferred reason.
    clock += 1000;
    const r2 = shipper.tick();
    expect(r2.breaks.map((b) => b.reason)).toStrictEqual(["forced-roll"]);
    expect(shipper.status().stream!.generation).not.toBe(before);
    expect(shipper.baseReady()).toBe(true);
    expect(shipper.currentBase()!.createdAtMs).toBeGreaterThan(baseTickBefore);
  });

  test("a deferred break survives a RESTART — the frozen stream never resumes shipping", () => {
    const shipper = makeShipper();
    shipper.tick();
    const before = shipper.status().stream!.generation;

    const reader = new DatabaseSync(path.join(vaultDir, "vault.db"));
    try {
      reader.exec("PRAGMA busy_timeout = 5000");
      reader.exec("BEGIN IMMEDIATE");
      reader.prepare("INSERT INTO _walship_probe (v) VALUES (?)").run("lock");
      clock += 1000;
      expect(shipper.rollGeneration("forced-roll").busy).toBe(true);
      reader.exec("ROLLBACK");
    } finally {
      reader.close();
    }

    // Fresh shipper reads breakPending off state; without it the next boot
    // resumes a stream whose base was never re-cloned.
    const shipper2 = makeShipper();
    expect(shipper2.baseReady()).toBe(false);
    insertAudit(2, 200, "must-not-ship-under-the-old-generation");
    clock += 1000;
    const r = shipper2.tick();
    expect(
      r.shipped.filter((k) => k.startsWith(`wal/vault/${before}/`))
    ).toStrictEqual([]);
    expect(r.breaks.map((b) => b.reason)).toStrictEqual(["forced-roll"]);
    expect(shipper2.baseReady()).toBe(true);
  });

  test("tick markers: a tick that changes nothing emits NO marker", () => {
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

  test("tick markers: a tick that ends in a BREAK emits none (the stream is at its base)", () => {
    const shipper = makeShipper({ baseIntervalMs: 10 });
    const first = shipper.tick();
    expect(first.breaks.map((b) => b.reason)).toStrictEqual(["first-run"]);
    expect(first.markers).toStrictEqual([]);

    insertVault(2, 200, "v");
    clock += 50; // past the base cadence
    const r = shipper.tick();
    expect(r.breaks.map((b) => b.reason)).toStrictEqual(["base-cadence"]);
    // The stream is at (0, 0) of a fresh generation — that IS its base, the
    // floor a restore falls back to.
    expect(r.markers).toStrictEqual([]);
    expect(shipper.status().stream!.offset).toBe(0);
  });

  test("listUploadable orders a marker AFTER the segments and closers it describes", () => {
    const shipper = makeShipper({ walSizeThresholdBytes: 8192 });
    shipper.tick();
    insertVault(3, 4000, "roll-me");
    clock += 1000;
    const r = shipper.tick();
    expect(r.rolled).toHaveLength(1);
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

  test("noteBaseRegistered clears the pending base but keeps the current one", () => {
    const shipper = makeShipper();
    shipper.tick();
    const gen = shipper.status().stream!.generation;
    expect(shipper.pendingBase()?.generation).toBe(gen);

    shipper.noteBaseRegistered(gen);
    expect(shipper.pendingBase()).toBeNull();
    expect(shipper.currentBase()?.generation).toBe(gen);
    expect(shipper.status().stream!.basePending).toBe(false);

    // A stale-generation registration is a no-op.
    shipper.rollGeneration("test-roll");
    const rolled = shipper.status().stream!.generation;
    shipper.noteBaseRegistered("f".repeat(32));
    expect(shipper.pendingBase()?.generation).toBe(rolled);
  });

  test("close() then reopen: the next shipper's first tick does NOT break the generation", () => {
    const shipper = makeShipper();
    shipper.tick();
    insertVault(2);
    clock += 1000;
    shipper.tick();

    const closeReport = shipper.close();
    expect(closeReport.busy).toBe(false);
    expect(closeReport.errors).toStrictEqual([]);
    expect(walSize()).toBe(0); // WAL empty after the final ship+truncate
    const closed = shipper.status().stream!;
    const state = JSON.parse(
      readFileSync(path.join(shipDir(), "state.json"), "utf8")
    ) as { stream: { closedClean: boolean } };
    expect(state.stream.closedClean).toBe(true);
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
    expect(r.busy).toBe(false);
    expect(shipper2.status().stream!.generation).toBe(closed.generation);
    expect(shipper2.status().stream!.group).toBe(closed.group);

    // Subsequent writes ship under the SAME generation, next group.
    insertVault(1, 100, "after-reopen");
    clock += 1000;
    const r2 = shipper2.tick();
    expect(r2.breaks).toStrictEqual([]);
    const seg = segsOf(shipper2).at(-1)!;
    expect(seg.addr!.generation).toBe(closed.generation);
    expect(seg.addr!.group).toBe(closed.group);
  });

  test("local budget: over-budget segments break the generations and drop never-restorable history", () => {
    const shipper = makeShipper({ localBudgetBytes: 1000 });
    const first = shipper.tick(); // first-run; nothing local yet
    expect(first.breaks.map((b) => b.reason)).toStrictEqual(["first-run"]);
    const genBefore = shipper.status().stream!.generation;

    insertVault(2, 500, "bulky"); // one segment already exceeds 1000 bytes
    clock += 1000;
    const r = shipper.tick();
    expect(r.shipped.some((k) => k.startsWith(`wal/vault/${genBefore}/`))).toBe(
      true
    );
    expect(r.breaks.map((b) => b.reason)).toStrictEqual(["local-budget"]);
    expect(shipper.status().stream!.generation).not.toBe(genBefore);
    expect(shipper.status().stream!.basePending).toBe(true);

    // The old generation was never registered (basePending): its segments are gone.
    expect(existsSync(path.join(shipDir(), "segments", genBefore))).toBe(false);
    expect(
      shipper
        .listUploadable()
        .filter((i) => i.kind === "segment" && i.addr!.generation === genBefore)
    ).toStrictEqual([]);
  });
});
