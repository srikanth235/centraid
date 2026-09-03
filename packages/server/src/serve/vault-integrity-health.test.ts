import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  createVaultIntegrityHealthProbe,
  integrityIntervalFor,
} from "./vault-integrity-health.js";

const dbs: DatabaseSync[] = [];
function memDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (x INTEGER)");
  db.exec("INSERT INTO t VALUES (1)");
  dbs.push(db);
  return db;
}

describe("vault-integrity-health", () => {
  afterEach(() => {
    while (dbs.length > 0) dbs.pop()?.close();
  });

  describe(createVaultIntegrityHealthProbe, () => {
    it("scans at most one vault per tick, so N vaults never line up into one scan", async () => {
      const scanned: string[] = [];
      const traced = (id: string): DatabaseSync => {
        const db = memDb();
        const original = db.prepare.bind(db);
        db.prepare = ((sql: string) => {
          if (sql === "PRAGMA quick_check") scanned.push(id);
          return original(sql);
        }) as typeof db.prepare;
        return db;
      };
      let now = 0;
      const probe = createVaultIntegrityHealthProbe({
        vaults: () => [
          { vaultId: "vault-a", vault: traced("a"), journal: memDb() },
          { vaultId: "vault-b", vault: traced("b"), journal: memDb() },
          { vaultId: "vault-c", vault: traced("c"), journal: memDb() },
        ],
        intervalMs: 60_000,
        now: () => now,
      });
      await probe();
      expect(scanned).toHaveLength(1);
      now = 1;
      await probe();
      expect(scanned).toHaveLength(2);
    });

    it("does not scan anything inside the startup grace", async () => {
      let now = 0;
      let scans = 0;
      const db = memDb();
      const original = db.prepare.bind(db);
      db.prepare = ((sql: string) => {
        if (sql === "PRAGMA quick_check") scans += 1;
        return original(sql);
      }) as typeof db.prepare;
      const probe = createVaultIntegrityHealthProbe({
        vaults: () => [{ vaultId: "vault-a", vault: db, journal: memDb() }],
        intervalMs: 60_000,
        startupGraceMs: 300_000,
        now: () => now,
      });
      await probe();
      expect(scans).toBe(0);
      now = 300_001;
      await probe();
      expect(scans).toBe(1);
    });

    it("stretches the cadence with vault size and floors it for a small one", () => {
      const hour = 3_600_000;
      expect(integrityIntervalFor(1024, hour)).toBe(hour);
      expect(integrityIntervalFor(64 * 1024 * 1024, hour)).toBe(hour);
      expect(integrityIntervalFor(256 * 1024 * 1024, hour)).toBe(4 * hour);
      expect(integrityIntervalFor(500 * 1024 ** 3, hour)).toBe(24 * hour);
    });

    it("reports ok with no vaults mounted", async () => {
      const probe = createVaultIntegrityHealthProbe({ vaults: () => [] });
      const result = await probe();
      expect(result.status).toBe("ok");
      expect(result.detail).toContain("no vaults mounted");
    });

    it("reports ok for a healthy vault + journal pair", async () => {
      const probe = createVaultIntegrityHealthProbe({
        vaults: () => [
          { vaultId: "vault-aaaaaaaa", vault: memDb(), journal: memDb() },
        ],
      });
      const result = await probe();
      expect(result.status).toBe("ok");
      expect(result.detail).toContain("1 vault clean");
    });

    it("reports error with the failure lines when quick_check itself throws", async () => {
      const vault = memDb();
      vault.prepare = () => {
        throw new Error("database disk image is malformed");
      };
      const probe = createVaultIntegrityHealthProbe({
        vaults: () => [{ vaultId: "vault-bbbbbbbb", vault, journal: memDb() }],
      });
      const result = await probe();
      expect(result.status).toBe("error");
      expect(result.detail).toContain("vault-bb");
      expect(result.detail).toContain("malformed");
    });

    it("does not re-run quick_check within the interval — reuses the cached result", async () => {
      let checks = 0;
      const vault = memDb();
      const originalPrepare = vault.prepare.bind(vault);
      vault.prepare = ((sql: string) => {
        if (sql === "PRAGMA quick_check") checks += 1;
        return originalPrepare(sql);
      }) as typeof vault.prepare;

      let now = 0;
      const probe = createVaultIntegrityHealthProbe({
        vaults: () => [{ vaultId: "vault-cccccccc", vault, journal: memDb() }],
        intervalMs: 60_000,
        now: () => now,
      });

      await probe();
      expect(checks).toBe(1);
      now = 30_000; // still inside the interval
      await probe();
      expect(checks).toBe(1);
      now = 70_000; // past the interval — re-checks
      await probe();
      expect(checks).toBe(2);
    });

    it("keeps reporting a stale failure until the next scheduled re-check", async () => {
      const vault = memDb();
      vault.prepare = () => {
        throw new Error("database disk image is malformed");
      };
      let now = 0;
      const probe = createVaultIntegrityHealthProbe({
        vaults: () => [{ vaultId: "vault-dddddddd", vault, journal: memDb() }],
        intervalMs: 60_000,
        now: () => now,
      });
      expect((await probe()).status).toBe("error");
      now = 30_000;
      expect((await probe()).status).toBe("error");
    });
  });
});
