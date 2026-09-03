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
  test("openVaultDb: the file-backed vault opens with PRAGMA synchronous = FULL", () => {
    const dir = tempDirSync();
    const db = openVaultDb({ dir });
    cleanups.push(() => db.close());
    const vaultSync = db.vault.prepare("PRAGMA synchronous").get() as {
      synchronous: number;
    };
    expect(vaultSync.synchronous).toBe(2);
    expect(db.audit).toBe(db.vault);
  });

  test("openVaultDb: NORMAL is the whole vault's choice, evidence included", () => {
    const db = openVaultDb({ dir: tempDirSync(), synchronous: "NORMAL" });
    cleanups.push(() => db.close());
    expect({ ...db.vault.prepare("PRAGMA synchronous").get() }).toStrictEqual({
      synchronous: 1,
    });
  });

  test("openVaultDb: file-backed handles use the bounded low-end read pragmas (#456 S1)", () => {
    const dir = tempDirSync();
    const db = openVaultDb({ dir });
    cleanups.push(() => db.close());
    for (const handle of [db.vault, db.audit]) {
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

  test("close() runs PRAGMA optimize before closing (issue #374 tier 5a)", () => {
    const db = openVaultDb();
    const vaultExec = vi.spyOn(db.vault, "exec");
    expect(() => db.close()).not.toThrow();
    expect(vaultExec).toHaveBeenCalledWith("PRAGMA optimize");
  });

  test("close() still closes the handle when PRAGMA optimize itself throws", () => {
    const db = openVaultDb();
    const vaultExec = vi
      .spyOn(db.vault, "exec")
      .mockImplementation((sql: string) => {
        if (sql === "PRAGMA optimize") throw new Error("boom");
      });
    expect(() => db.close()).not.toThrow();
    vaultExec.mockRestore();
    expect(() => db.vault.prepare("SELECT 1")).toThrow("database is not open");
  });

  test("close() on a file-backed vault also survives PRAGMA optimize without error", () => {
    const dir = tempDirSync("vault-db-optimize-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const db = openVaultDb({ dir });
    expect(() => db.close()).not.toThrow();
  });

  test("openVaultDb: a fresh vault.db is auto_vacuum=INCREMENTAL (issue #438)", () => {
    const dir = tempDirSync();
    const db = openVaultDb({ dir });
    cleanups.push(() => db.close());
    const vaultAv = db.vault.prepare("PRAGMA auto_vacuum").get() as {
      auto_vacuum: number;
    };
    expect(vaultAv.auto_vacuum).toBe(2);
  });

  test("openVaultDb: fresh databases use 8 KiB pages (#456 S7)", () => {
    const dir = tempDirSync();
    const db = openVaultDb({ dir });
    cleanups.push(() => db.close());
    expect(
      (db.vault.prepare("PRAGMA page_size").get() as { page_size: number })
        .page_size
    ).toBe(8192);
  });

  test("openVaultDb: a vault.db created WITHOUT auto_vacuum converts to INCREMENTAL on next open (issue #438)", () => {
    const dir = tempDirSync();
    const seed = new DatabaseSync(path.join(dir, "vault.db"));
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
    expect(
      (
        db.audit.prepare("PRAGMA auto_vacuum").get() as {
          auto_vacuum: number;
        }
      ).auto_vacuum
    ).toBe(2);
    expect(
      (
        db.audit.prepare("PRAGMA journal_mode").get() as {
          journal_mode: string;
        }
      ).journal_mode
    ).toBe("wal");
  });

  function footprintOf(db: {
    vault: DatabaseSync;
  }): { mmapBytes: number; cacheKib: number }[] {
    return [db.vault].map((handle) => ({
      mmapBytes: Number(
        (handle.prepare("PRAGMA mmap_size").get() as { mmap_size: number })
          .mmap_size
      ),
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

  test("a footprint budget is the per-vault TOTAL, applied whole to its one file", () => {
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
      expect(file.mmapBytes).toBe(64 * 1024 * 1024);
      expect(file.cacheKib).toBe(8 * 1024);
    }
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
      expect(file.mmapBytes).toBe(0);
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

    const applied = [db.vault].map((handle) =>
      applyVaultFootprint(handle, {
        mmapBytes: 16 * 1024 * 1024,
        cacheBytes: 2 * 1024 * 1024,
      })
    );
    for (const file of applied) {
      expect(file.mmapBytes).toBe(16 * 1024 * 1024);
      expect(file.cacheBytes).toBe(2 * 1024 * 1024);
    }
    for (const file of footprintOf(db)) {
      expect(file.mmapBytes).toBe(16 * 1024 * 1024);
      expect(file.cacheKib).toBe(2 * 1024);
    }
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
    const VAULT_DB_FILES_IN_A_VAULT = 1;
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

    const one = footprintOf(vaults[0]!).reduce(
      (n, file) => n + file.mmapBytes,
      0
    );
    expect(totalMmap()).toBe(HOUSEHOLD * one);
    expect(totalMmap()).toBeGreaterThan(CEILING_MMAP);

    for (const db of vaults)
      for (const handle of [db.vault])
        applyVaultFootprint(handle, {
          mmapBytes: CEILING_MMAP / HOUSEHOLD,
          cacheBytes: CEILING_CACHE / HOUSEHOLD,
        });

    expect(totalMmap()).toBeLessThanOrEqual(CEILING_MMAP);
    expect(totalCache()).toBeLessThanOrEqual(CEILING_CACHE);
    expect(CEILING_MMAP - totalMmap()).toBeLessThan(
      HOUSEHOLD * 2 * VAULT_DB_FILES_IN_A_VAULT
    );
  });
});
