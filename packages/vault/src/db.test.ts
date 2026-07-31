import { rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test, vi } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { openVaultDb } from "./db.js";
import { applyVaultFootprint } from "./vault-footprint.js";

const cleanups: (() => void)[] = [];
describe("db", () => {
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });
  test("openVaultDb: file-backed vault.db and journal.db open with PRAGMA synchronous = FULL", () => {
    const dir = tempDirSync();
    const db = openVaultDb({ dir });
    cleanups.push(() => db.close());
    const vaultSync = db.vault.prepare("PRAGMA synchronous").get() as {
      synchronous: number;
    };
    const journalSync = db.journal.prepare("PRAGMA synchronous").get() as {
      synchronous: number;
    };
    // SQLite's synchronous enum: OFF=0, NORMAL=1, FULL=2, EXTRA=3.
    expect(vaultSync.synchronous).toBe(2);
    expect(journalSync.synchronous).toBe(2);
  });

  test("openVaultDb: NORMAL applies only to vault.db; journal proof remains FULL", () => {
    const db = openVaultDb({ dir: tempDirSync(), synchronous: "NORMAL" });
    cleanups.push(() => db.close());
    // node:sqlite hands back null-prototype rows; spreading compares the column
    // data (which is the contract) without asserting the driver's prototype.
    expect({ ...db.vault.prepare("PRAGMA synchronous").get() }).toStrictEqual({
      synchronous: 1,
    });
    expect({ ...db.journal.prepare("PRAGMA synchronous").get() }).toStrictEqual(
      {
        synchronous: 2,
      }
    );
  });

  test("openVaultDb: file-backed handles use the bounded low-end read pragmas (#456 S1)", () => {
    const dir = tempDirSync();
    const db = openVaultDb({ dir });
    cleanups.push(() => db.close());
    for (const handle of [db.vault, db.journal]) {
      expect({ ...handle.prepare("PRAGMA cache_size").get() }).toStrictEqual({
        cache_size: -16000,
      });
      expect({ ...handle.prepare("PRAGMA mmap_size").get() }).toStrictEqual({
        mmap_size: 67_108_864,
      });
      expect({ ...handle.prepare("PRAGMA temp_store").get() }).toStrictEqual({
        temp_store: 2,
      });
    }
  });

  test("openVaultDb: in-memory vaults still open fine (pragma is file-backed only)", () => {
    const db = openVaultDb();
    cleanups.push(() => db.close());
    expect(db.dir).toBe(":memory:");
  });

  test("close() runs PRAGMA optimize on both handles without throwing (issue #374 tier 5a)", () => {
    const db = openVaultDb();
    const vaultExec = vi.spyOn(db.vault, "exec");
    const journalExec = vi.spyOn(db.journal, "exec");
    expect(() => db.close()).not.toThrow();
    expect(vaultExec).toHaveBeenCalledWith("PRAGMA optimize");
    expect(journalExec).toHaveBeenCalledWith("PRAGMA optimize");
  });

  test("close() still closes both handles when PRAGMA optimize itself throws", () => {
    const db = openVaultDb();
    const vaultExec = vi
      .spyOn(db.vault, "exec")
      .mockImplementation((sql: string) => {
        if (sql === "PRAGMA optimize") throw new Error("boom");
      });
    expect(() => db.close()).not.toThrow();
    vaultExec.mockRestore();
    // A closed handle throws on any further statement — proves close() ran.
    expect(() => db.vault.prepare("SELECT 1")).toThrow("database is not open");
  });

  test("close() on a file-backed vault also survives PRAGMA optimize without error", () => {
    const dir = tempDirSync("vault-db-optimize-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const db = openVaultDb({ dir });
    expect(() => db.close()).not.toThrow();
  });

  test("openVaultDb: fresh vault.db and journal.db are auto_vacuum=INCREMENTAL (issue #438)", () => {
    const dir = tempDirSync();
    const db = openVaultDb({ dir });
    cleanups.push(() => db.close());
    // SQLite auto_vacuum enum: NONE=0, FULL=1, INCREMENTAL=2. Both files must be
    // incremental so the #438 archival prune can reclaim freed pages to the OS.
    const vaultAv = db.vault.prepare("PRAGMA auto_vacuum").get() as {
      auto_vacuum: number;
    };
    const journalAv = db.journal.prepare("PRAGMA auto_vacuum").get() as {
      auto_vacuum: number;
    };
    expect(vaultAv.auto_vacuum).toBe(2);
    expect(journalAv.auto_vacuum).toBe(2);
  });

  test("openVaultDb: fresh databases use 8 KiB pages (#456 S7)", () => {
    const dir = tempDirSync();
    const db = openVaultDb({ dir });
    cleanups.push(() => db.close());
    expect(
      (db.vault.prepare("PRAGMA page_size").get() as { page_size: number })
        .page_size
    ).toBe(8192);
    expect(
      (db.journal.prepare("PRAGMA page_size").get() as { page_size: number })
        .page_size
    ).toBe(8192);
  });

  test("openVaultDb: a journal.db created WITHOUT auto_vacuum converts to INCREMENTAL on next open (issue #438)", () => {
    const dir = tempDirSync();
    // Pre-#438 file: WAL, freelist mode (auto_vacuum=0), non-empty.
    const seed = new DatabaseSync(path.join(dir, "journal.db"));
    seed.exec("PRAGMA journal_mode=WAL");
    seed.exec("CREATE TABLE legacy(a TEXT)");
    const ins = seed.prepare("INSERT INTO legacy VALUES (?)");
    for (let i = 0; i < 500; i++) ins.run("z".repeat(400));
    seed.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(
      (seed.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number })
        .auto_vacuum
    ).toBe(0);
    seed.close();

    const db = openVaultDb({ dir });
    cleanups.push(() => db.close());
    // The one-time conversion VACUUM in openFile rewrites the file into
    // incremental mode; the file stays in WAL.
    expect(
      (
        db.journal.prepare("PRAGMA auto_vacuum").get() as {
          auto_vacuum: number;
        }
      ).auto_vacuum
    ).toBe(2);
    expect(
      (
        db.journal.prepare("PRAGMA journal_mode").get() as {
          journal_mode: string;
        }
      ).journal_mode
    ).toBe("wal");
  });

  // ── issue #659 L8: the per-vault footprint is a divisible budget ──────

  function footprintOf(db: {
    vault: DatabaseSync;
    journal: DatabaseSync;
  }): { mmapBytes: number; cacheKib: number }[] {
    return [db.vault, db.journal].map((handle) => ({
      mmapBytes: Number(
        (handle.prepare("PRAGMA mmap_size").get() as { mmap_size: number })
          .mmap_size
      ),
      // A negative cache_size is kibibytes; SQLite reports back what was set.
      cacheKib: -Number(
        (handle.prepare("PRAGMA cache_size").get() as { cache_size: number })
          .cache_size
      ),
    }));
  }

  test("an unset footprint keeps the pre-#659 per-file pragmas exactly", () => {
    const db = openVaultDb({ dir: tempDirSync() });
    cleanups.push(() => db.close());
    for (const file of footprintOf(db)) {
      expect(file.mmapBytes).toBe(67_108_864);
      expect(file.cacheKib).toBe(16_000);
    }
  });

  test("a footprint budget is a per-vault TOTAL split across its databases", () => {
    // What a host mounting 5 planes under a 320 MiB ceiling would pass.
    const db = openVaultDb({
      dir: tempDirSync(),
      footprint: {
        mmapBytes: 64 * 1024 * 1024,
        cacheBytes: 8 * 1024 * 1024,
      },
    });
    cleanups.push(() => db.close());
    const files = footprintOf(db);
    for (const file of files) {
      expect(file.mmapBytes).toBe(32 * 1024 * 1024);
      expect(file.cacheKib).toBe(4 * 1024);
    }
    // The load-bearing property: the two handles together stay inside the
    // budget the caller named, rather than each taking it.
    expect(files.reduce((n, f) => n + f.mmapBytes, 0)).toBeLessThanOrEqual(
      64 * 1024 * 1024
    );
    expect(
      files.reduce((n, f) => n + f.cacheKib * 1024, 0)
    ).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  test("a budget divided too far still leaves each database a usable cache", () => {
    const db = openVaultDb({
      dir: tempDirSync(),
      footprint: { mmapBytes: 0, cacheBytes: 1024 },
    });
    cleanups.push(() => db.close());
    for (const file of footprintOf(db)) {
      // mmap can go to zero — it is address space, and SQLite falls back to
      // ordinary reads.
      expect(file.mmapBytes).toBe(0);
      // The cache cannot: a plane starved into thrashing is worse for the
      // owner than one that overshoots by a few hundred kibibytes.
      expect(file.cacheKib).toBe(512);
    }
  });

  test("a negative budget is refused rather than silently clamped", () => {
    expect(() =>
      openVaultDb({ dir: tempDirSync(), footprint: { mmapBytes: -1 } })
    ).toThrow(/footprint/u);
  });

  test("re-applying a smaller budget changes the pragmas of a LIVE connection", () => {
    const db = openVaultDb({ dir: tempDirSync() });
    cleanups.push(() => db.close());
    for (const file of footprintOf(db)) {
      expect(file.mmapBytes).toBe(67_108_864);
      expect(file.cacheKib).toBe(16_000);
    }

    // What a host's rebalance does when a second vault is mounted: re-divide
    // the SAME total across the now-larger set, on connections that are
    // already open and serving.
    const applied = [db.vault, db.journal].map((handle) =>
      applyVaultFootprint(handle, {
        mmapBytes: 32 * 1024 * 1024,
        cacheBytes: 4 * 1024 * 1024,
      })
    );
    for (const file of applied) {
      expect(file.mmapBytes).toBe(16 * 1024 * 1024);
      expect(file.cacheBytes).toBe(2 * 1024 * 1024);
    }
    // The live handles report the new numbers, not the ones they opened with.
    for (const file of footprintOf(db)) {
      expect(file.mmapBytes).toBe(16 * 1024 * 1024);
      expect(file.cacheKib).toBe(2 * 1024);
    }
    // Still usable afterwards — a rebalance is a tuning change, not a reopen.
    expect(
      (
        db.vault.prepare("SELECT count(*) AS n FROM core_vault").get() as {
          n: number;
        }
      ).n
    ).toBeGreaterThanOrEqual(0);
  });

  test("rebalancing keeps a household's total flat where opening alone does not", () => {
    const HOUSEHOLD = 5;
    /** `vault.db` + `journal.db` — what one vault's budget is split across. */
    const VAULT_DB_FILES_IN_A_VAULT = 2;
    const CEILING_MMAP = 128 * 1024 * 1024;
    const CEILING_CACHE = 32 * 1024 * 1024;
    const vaults = Array.from({ length: HOUSEHOLD }, () => {
      const db = openVaultDb({ dir: tempDirSync() });
      cleanups.push(() => db.close());
      return db;
    });
    const totalMmap = (): number =>
      vaults.reduce(
        (sum, db) =>
          sum + footprintOf(db).reduce((n, file) => n + file.mmapBytes, 0),
        0
      );
    const totalCache = (): number =>
      vaults.reduce(
        (sum, db) =>
          sum +
          footprintOf(db).reduce((n, file) => n + file.cacheKib * 1024, 0),
        0
      );

    // THE CONTROL. Without a budget, five vaults cost exactly five times one
    // vault — so the budgeted case below is proven to have a different SHAPE,
    // not to have passed by coincidence.
    const one = footprintOf(vaults[0]!).reduce(
      (n, file) => n + file.mmapBytes,
      0
    );
    expect(totalMmap()).toBe(HOUSEHOLD * one);
    expect(totalMmap()).toBeGreaterThan(CEILING_MMAP);

    // The rebalance: re-divide one ceiling across every open plane. This is
    // the call a host makes on each mount/create/delete — dividing only at
    // open time leaves vault 1 holding the whole budget forever.
    for (const db of vaults)
      for (const handle of [db.vault, db.journal])
        applyVaultFootprint(handle, {
          mmapBytes: CEILING_MMAP / HOUSEHOLD,
          cacheBytes: CEILING_CACHE / HOUSEHOLD,
        });

    expect(totalMmap()).toBeLessThanOrEqual(CEILING_MMAP);
    expect(totalCache()).toBeLessThanOrEqual(CEILING_CACHE);
    // Flat, not merely smaller: the household consumes essentially the whole
    // ceiling and no more, rather than a fifth of it or five times it. The
    // few bytes of slack are the two floor divisions (budget → per vault →
    // per file), which round DOWN so the ceiling can never be exceeded.
    expect(CEILING_MMAP - totalMmap()).toBeLessThan(
      HOUSEHOLD * 2 * VAULT_DB_FILES_IN_A_VAULT
    );
  });
});
