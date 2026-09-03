import { createHash } from "node:crypto";
// governance: allow-repo-hygiene file-size-limit (#408) one real-vault capture suite — every case drives the same openVaultDb + bootstrapVault + real-WAL fixture through a different guarantee; sharding it would clone that fixture per file and let the copies drift
// WAL shipper capture correctness (#408): G1/G2/G3 capture, G4
// backpressure, rollover + closers, and the end-to-end capture→seal→replay
// round-trip over a REAL vault (openVaultDb + bootstrapVault, real
// node:sqlite, real files — no mocks). Detector (G5), crash-ordering (G7)
// and generation-lifecycle tests live in wal-shipper-detectors.test.ts.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
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
  walGroupCloserKey,
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

describe("wal-shipper", () => {
  beforeEach(() => {
    root = tempDirSync("wal-ship-");
    vaultDir = path.join(root, "vault-a");
    db = openVaultDb({ dir: vaultDir });
    bootstrapVault(db, { ownerName: "Priya" });
    // Scratch tables the tests write through — created BEFORE the shipper so
    // they are part of the first-run base snapshot.
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

  /** Local segment files in replay (offset) order. */
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

  /** A well-behaved second connection (out-of-process writer stand-in). */
  function openSecondWriter(): DatabaseSync {
    const c = new DatabaseSync(path.join(vaultDir, "vault.db"));
    c.exec("PRAGMA busy_timeout = 5000");
    c.exec("PRAGMA wal_autocheckpoint = 0");
    return c;
  }

  // ─────────────────────────────────────────────────────────────── G1/G2/G3

  test("[G1] a committed write ships a segment byte-identical to the live WAL range", () => {
    const shipper = makeShipper();
    const first = shipper.tick();
    expect(first.breaks.map((b) => b.reason)).toStrictEqual(["first-run"]);

    insertVault(3);
    clock += 1000;
    const report = shipper.tick();
    expect(report.errors).toStrictEqual([]);
    expect(
      report.shipped.filter((k) => k.startsWith("wal/vault/"))
    ).toHaveLength(1);

    const segs = segsOf(shipper);
    expect(segs).toHaveLength(1);
    const seg = segs[0]!;
    expect(seg.addr!.startOffset).toBe(0); // first segment carries the WAL header
    expect(seg.addr!.endOffset).toBe(walSize()); // everything was committed
    const fileBytes = readFileSync(seg.file);
    const walBytes = readFileSync(walPath()).subarray(
      seg.addr!.startOffset,
      seg.addr!.endOffset
    );
    expect(fileBytes).toHaveLength(seg.addr!.endOffset - seg.addr!.startOffset);
    expect(Buffer.compare(fileBytes, walBytes)).toBe(0);
  });

  test("[G2] interleaved writes and ticks chain gaplessly and reconstruct the WAL prefix exactly", () => {
    const shipper = makeShipper();
    shipper.tick();

    for (const marker of ["alpha", "beta", "gamma"]) {
      insertVault(2, 150, marker);
      clock += 1000;
      const r = shipper.tick();
      expect(r.errors).toStrictEqual([]);
      expect(r.breaks).toStrictEqual([]);
      expect(r.shipped.some((k) => k.startsWith("wal/vault/"))).toBe(true);
    }

    const segs = segsOf(shipper);
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
    expect(at).toBe(walSize());
    const wal = readFileSync(walPath()).subarray(0, at);
    expect(Buffer.compare(concat, wal)).toBe(0);

    // A tick with no new writes ships nothing (and breaks nothing).
    clock += 1000;
    const idle = shipper.tick();
    expect(idle.shipped).toStrictEqual([]);
    expect(idle.breaks).toStrictEqual([]);
    expect(idle.errors).toStrictEqual([]);
  });

  test("[G3] an uncommitted second-writer tail never ships; it ships after COMMIT", () => {
    const shipper = makeShipper();
    shipper.tick();

    insertAudit(2, 100, "committed");
    const committedHead = walSize(); // last COMMIT boundary right now

    const c2 = openSecondWriter();
    try {
      c2.exec("PRAGMA cache_size = 10"); // force mid-transaction spill into the WAL
      c2.exec("BEGIN IMMEDIATE");
      const ins = c2.prepare("INSERT INTO _walship_jprobe (v) VALUES (?)");
      for (let i = 0; i < 200; i++)
        ins.run(`uncommitted-${i}-${"u".repeat(1000)}`);
      // The open transaction's frames really are in the WAL file...
      expect(walSize()).toBeGreaterThan(committedHead);

      clock += 1000;
      const r1 = shipper.tick();
      expect(r1.errors).toStrictEqual([]);
      // ...but the shipped boundary stopped at the last COMMIT.
      const segs1 = segsOf(shipper);
      expect(segs1).toHaveLength(1);
      expect(segs1[0]!.addr!.endOffset).toBe(committedHead);

      c2.exec("COMMIT");
      clock += 1000;
      const r2 = shipper.tick();
      expect(r2.errors).toStrictEqual([]);
      const segs2 = segsOf(shipper);
      expect(segs2).toHaveLength(2);
      expect(segs2[1]!.addr!.startOffset).toBe(committedHead);
      expect(segs2[1]!.addr!.endOffset).toBe(walSize());
      // Both segments together still equal the WAL prefix byte for byte.
      const concat = Buffer.concat(segs2.map((s) => readFileSync(s.file)));
      const wal = readFileSync(walPath()).subarray(
        0,
        segs2[1]!.addr!.endOffset
      );
      expect(Buffer.compare(concat, wal)).toBe(0);
    } finally {
      c2.close();
    }
  });

  test("[G3] rolled-back bytes are never shipped and later commits still chain gaplessly", () => {
    const shipper = makeShipper();
    shipper.tick();

    insertAudit(2, 100, "before");
    clock += 1000;
    shipper.tick();
    const e1 = segsOf(shipper).at(-1)!.addr!.endOffset;

    const c2 = openSecondWriter();
    try {
      c2.exec("PRAGMA cache_size = 10");
      c2.exec("BEGIN IMMEDIATE");
      const ins = c2.prepare("INSERT INTO _walship_jprobe (v) VALUES (?)");
      for (let i = 0; i < 200; i++)
        ins.run(`ROLLBACKME-${i}-${"r".repeat(1000)}`);
      expect(walSize()).toBeGreaterThan(e1); // spilled past the last commit
      c2.exec("ROLLBACK");
    } finally {
      c2.close();
    }
    // The next transaction overwrites the rolled-back frames in place.
    insertAudit(3, 100, "KEEPME");

    clock += 1000;
    const r = shipper.tick();
    expect(r.errors).toStrictEqual([]);
    expect(r.breaks).toStrictEqual([]);
    const segs = segsOf(shipper);
    expect(segs).toHaveLength(2);
    const seg2 = segs[1]!;
    expect(seg2.addr!.startOffset).toBe(e1); // still chains gaplessly
    // Decoded latin1 so `toContain` gets a string haystack: on a Buffer it
    // would compare against the byte elements and never match a string needle.
    // latin1 (not utf8) because the WAL is binary — every byte maps 1:1 and no
    // invalid sequence is replaced, so a needle present in the bytes is present
    // in the decoding.
    const seg2Bytes = readFileSync(seg2.file).toString("latin1");
    expect(seg2Bytes).not.toContain("ROLLBACKME");
    expect(seg2Bytes).toContain("KEEPME");
    // And the shipped prefix still matches the live file exactly.
    const concat = Buffer.concat(segs.map((s) => readFileSync(s.file)));
    const wal = readFileSync(walPath()).subarray(0, seg2.addr!.endOffset);
    expect(Buffer.compare(concat, wal)).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────── G4

  test("[G4] a failed segment write reports an error, moves nothing, and retries the same range", () => {
    const shipper = makeShipper();
    shipper.tick();
    insertVault(2);
    clock += 1000;
    shipper.tick(); // establishes the group dir + a nonzero offset
    const status = shipper.status().stream!;
    const offsetBefore = status.offset;
    expect(offsetBefore).toBeGreaterThan(0);

    insertVault(2, 200, "second");
    const walSizeBefore = walSize();
    const groupDir = path.join(
      shipDir(),
      "segments",
      status.generation,
      "00000000"
    );
    // Fault injection that no uid can bypass: stash the group dir aside and
    // leave a regular FILE in its place. The shipper's durable segment write
    // starts with `mkdirSync(dirname(file), { recursive: true })`, which
    // refuses to treat a non-directory as a directory for root exactly as for
    // anyone else. A permission bit would not do: root ignores directory mode
    // bits, so the write the assertions below expect to fail would succeed.
    const stashedGroupDir = `${groupDir}.stashed`;
    renameSync(groupDir, stashedGroupDir);
    writeFileSync(groupDir, "");
    try {
      clock += 1000;
      const r = shipper.tick();
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]!.message).toMatch(/segment write failed/u);
      expect(r.shipped.filter((k) => k.startsWith("wal/vault/"))).toStrictEqual(
        []
      );
      expect(r.markers).toStrictEqual([]); // a one-sided/error cut is never certified
      // Offset did not advance, and the WAL keeps every byte (no checkpoint).
      expect(shipper.status().stream!.offset).toBe(offsetBefore);
      expect(walSize()).toBe(walSizeBefore);
    } finally {
      rmSync(groupDir, { force: true });
      renameSync(stashedGroupDir, groupDir);
    }

    // With the group dir back, the SAME range ships.
    clock += 1000;
    const r2 = shipper.tick();
    expect(r2.errors).toStrictEqual([]);
    expect(r2.shipped.filter((k) => k.startsWith("wal/vault/"))).toHaveLength(
      1
    );
    const last = segsOf(shipper).at(-1)!;
    expect(last.addr!.startOffset).toBe(offsetBefore);
    expect(shipper.status().stream!.offset).toBe(last.addr!.endOffset);
  });

  // ──────────────────────────────────────────────────────── rollover + closers

  test("rollover: exceeding walSizeThresholdBytes closes the group with a closer and truncates the WAL", () => {
    const shipper = makeShipper({ walSizeThresholdBytes: 8192 });
    shipper.tick();
    const gen = shipper.status().stream!.generation;

    insertVault(3, 4000); // ≥ 3 frames ⇒ WAL > 8192
    clock += 1000;
    const r = shipper.tick();
    expect(r.errors).toStrictEqual([]);
    expect(r.breaks).toStrictEqual([]);
    const rolled = r.rolled[0];
    expect(rolled).toBeDefined();
    expect(rolled!.group).toBe(0);
    expect(rolled!.endOffset).toBeGreaterThan(8192);

    const after = shipper.status().stream!;
    expect(after.generation).toBe(gen); // rollover, not a generation break
    expect(after.group).toBe(1);
    expect(after.offset).toBe(0);
    expect(walSize()).toBe(0); // live WAL truncated

    // The closer marker sits in the OLD group dir and lists as kind 'closer'
    // under its exact object key.
    const closerFile = path.join(
      shipDir(),
      "segments",
      gen,
      "00000000",
      `closed-${String(rolled!.endOffset).padStart(12, "0")}.mrk`
    );
    expect(existsSync(closerFile)).toBe(true);
    const closers = shipper.listUploadable().filter((i) => i.kind === "closer");
    expect(closers).toHaveLength(1);
    expect(closers[0]!.key).toBe(
      walGroupCloserKey({
        db: "vault",
        generation: gen,
        group: 0,
        endOffset: rolled!.endOffset,
      })
    );
    // The closed group's segments end exactly at the closer's offset.
    const group0 = segsOf(shipper).filter((s) => s.addr!.group === 0);
    expect(group0.at(-1)!.addr!.endOffset).toBe(rolled!.endOffset);
  });

  test("roll thresholds are read dynamically so a live BackupPolicy change takes effect", () => {
    let threshold = Number.MAX_SAFE_INTEGER;
    let baseInterval = Number.MAX_SAFE_INTEGER;
    const shipper = makeShipper({
      walSizeThresholdBytes: () => threshold,
      baseIntervalMs: () => baseInterval,
    });
    shipper.tick();

    insertVault(3, 4000);
    clock += 1000;
    expect(shipper.tick().rolled).toStrictEqual([]);

    threshold = 8192;
    clock += 1000;
    expect(shipper.tick().rolled).toHaveLength(1);

    baseInterval = 1;
    clock += 2;
    expect(shipper.tick().breaks.map((row) => row.reason)).toContain(
      "base-cadence"
    );
  });

  test("rollover edge: uncommitted-only WAL over threshold reports busy, then truncates without advancing the group", () => {
    const shipper = makeShipper({ walSizeThresholdBytes: 8192 });
    shipper.tick();
    clock += 1000;
    shipper.checkpointNow(); // flush the first-run receipt ⇒ group 1, offset 0
    const before = shipper.status().stream!;
    expect(before.offset).toBe(0);

    const c2 = openSecondWriter();
    try {
      c2.exec("PRAGMA cache_size = 10");
      c2.exec("BEGIN IMMEDIATE");
      const ins = c2.prepare("INSERT INTO _walship_jprobe (v) VALUES (?)");
      for (let i = 0; i < 200; i++) ins.run(`held-${i}-${"h".repeat(1000)}`);
      expect(walSize()).toBeGreaterThan(8192);

      // Active writer ⇒ TRUNCATE returns busy; nothing advances, nothing rolls.
      clock += 1000;
      const r1 = shipper.tick();
      expect(r1.busy).toBe(true);
      expect(r1.shipped).toStrictEqual([]);
      expect(r1.rolled).toStrictEqual([]);
      expect(shipper.status().stream!.group).toBe(before.group);

      c2.exec("ROLLBACK");
    } finally {
      c2.close();
    }

    // Now the truncate succeeds — but offset was 0 (nothing shipped in this
    // group), so the group MUST NOT advance and no closer may exist for it.
    clock += 1000;
    const r2 = shipper.tick();
    expect(r2.busy).toBe(false);
    expect(r2.breaks).toStrictEqual([]);
    expect(r2.rolled).toStrictEqual([]);
    const after = shipper.status().stream!;
    expect(after.group).toBe(before.group);
    expect(after.offset).toBe(0);
    expect(walSize()).toBe(0); // WAL did truncate
    const closers = shipper
      .listUploadable()
      .filter((i) => i.kind === "closer" && i.closer!.group === before.group);
    expect(closers).toStrictEqual([]);
  });

  test("checkpointNow ships the remainder, truncates, and closes the group", () => {
    const shipper = makeShipper();
    shipper.tick();
    insertVault(2, 300, "tail");
    clock += 1000;
    const r = shipper.checkpointNow();
    expect(r.errors).toStrictEqual([]);
    expect(r.busy).toBe(false);
    expect(r.shipped.some((k) => k.startsWith("wal/vault/"))).toBe(true);
    const rolled = r.rolled[0];
    expect(rolled).toBeDefined();
    expect(walSize()).toBe(0);
    const closers = shipper
      .listUploadable()
      .filter(
        (i) =>
          i.kind === "closer" &&
          i.closer!.db === "vault" &&
          i.closer!.group === 0
      );
    expect(closers).toHaveLength(1);
    expect(closers[0]!.closer!.endOffset).toBe(rolled!.endOffset);
    expect(shipper.status().stream!.group).toBe(1);
  });

  // ───────────────────────────────────────────────── end-to-end (the money test)

  test("end-to-end: capture → seal → replay round-trips the real vault byte-exactly", async () => {
    const shipper = makeShipper({ walSizeThresholdBytes: 8192 }); // force multi-group streams
    shipper.tick(); // first-run: mints generations + bases
    const generation = shipper.status().stream!.generation;
    const basePath = shipper.currentBase()!.file;
    expect(shipper.baseReady()).toBe(true);

    insertVault(3, 500, "alpha");
    insertAudit(2, 200, "jalpha");
    clock += 1000;
    shipper.tick();
    insertVault(4, 2000, "beta");
    insertAudit(3, 900, "jbeta");
    clock += 1000;
    shipper.tick();
    insertVault(1, 10, "gamma");
    clock += 1000;
    const closeReport = shipper.close(); // ships the remainder + final closers
    expect(closeReport.errors).toStrictEqual([]);
    expect(closeReport.busy).toBe(false);

    // The whole run stayed inside one generation (no breaks after first-run).
    expect(shipper.status().stream!.generation).toBe(generation);
    // The rollovers actually happened — the replay below crosses group closers.
    expect(shipper.status().stream!.group).toBeGreaterThan(1);

    const liveVaultRows = db.vault
      .prepare("SELECT id, v FROM _walship_probe ORDER BY id")
      .all();
    const liveAuditRows = db.audit
      .prepare("SELECT id, v FROM _walship_jprobe ORDER BY id")
      .all();
    expect(liveVaultRows).toHaveLength(8);

    // Seal every uploadable exactly as the gateway uploader would.
    const dataKey = new Uint8Array(32).fill(7);
    const store = new FsObjectStore(path.join(root, "objects"));
    const uploadables = shipper.listUploadable();
    expect(
      uploadables.filter((i) => i.kind === "segment").length
    ).toBeGreaterThan(2);
    expect(
      uploadables.filter((i) => i.kind === "closer").length
    ).toBeGreaterThan(1);
    // Tick markers ride the same drain — without them the restore has no
    // proved point to cut at and lands on the base.
    expect(
      uploadables.filter((i) => i.kind === "marker").length
    ).toBeGreaterThan(0);
    await Promise.all(
      uploadables.map((item) => {
        const sealed =
          item.kind === "segment"
            ? sealWalSegment(dataKey, "v1", item.addr!, readFileSync(item.file))
            : item.kind === "closer"
              ? sealWalCloser(dataKey, "v1", item.closer!)
              : sealWalTickMarker(dataKey, "v1", item.marker!);
        return store.put(item.key, sealed);
      })
    );

    // Materialize the bases into a fresh directory and let SQLite replay.
    const destDir = path.join(root, "restore");
    mkdirSync(destDir, { recursive: true });
    copyFileSync(basePath, path.join(destDir, "vault.db"));
    db.close({ skipOptimize: true });

    const outcome = await replayWalSegments({
      store,
      dataKey,
      vaultId: "v1",
      destDir,
      generation,
    });
    expect(outcome.damaged).toStrictEqual([]);
    expect(outcome.integrityCheck).toBe("ok");
    expect(outcome.truncated).toBe(false);
    expect(outcome.foreignKeyViolations).toBe(0);
    expect(outcome.segmentsApplied).toBeGreaterThan(0);

    const restored = new DatabaseSync(path.join(destDir, "vault.db"), {
      readOnly: true,
    });
    try {
      expect(
        restored.prepare("SELECT id, v FROM _walship_probe ORDER BY id").all()
      ).toStrictEqual(liveVaultRows);
      // The audit band rode the same stream and comes back with it — one file,
      // so a receipt can never be restored without the row it names.
      expect(
        restored.prepare("SELECT id, v FROM _walship_jprobe ORDER BY id").all()
      ).toStrictEqual(liveAuditRows);
      // The recorded base sha256 marker verifies against the exact bytes the
      // restore started from (what a real engine checks before replaying).
      const base = shipper.currentBase()!;
      expect(base.sha256).toBe(
        createHash("sha256").update(readFileSync(base.file)).digest("hex")
      );
    } finally {
      restored.close();
    }
  });
});
