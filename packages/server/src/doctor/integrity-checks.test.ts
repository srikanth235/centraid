import {
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";
import { bootstrapVault, openVaultDb } from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

import {
  checkCasRehash,
  checkDatabaseIntegrity,
  checkHardlinkRefcounts,
  checkReplicaJournalConsistency,
  hasError,
  runIntegrityScrub,
} from "./integrity-checks.js";

describe("integrity check library", () => {
  const open: (() => void)[] = [];
  afterEach(() => {
    while (open.length) open.pop()!();
  });

  function seededVault(vaultId?: string): {
    db: VaultDb;
    dir: string;
    vaultId: string;
    shas: string[];
  } {
    const dir = tempDirSync("doctor-vault-");
    const db = openVaultDb({ dir });
    open.push(() => db.close());
    const boot = bootstrapVault(
      db,
      vaultId === undefined
        ? { ownerName: "Test owner" }
        : { ownerName: "Test owner", vaultId }
    );
    const shas = ["alpha", "beta", "gamma", "delta"].map(
      (word) => db.blobs.ingestSync(Buffer.from(`blob-${word}-payload`)).sha256
    );
    return { db, dir, vaultId: boot.vaultId, shas };
  }

  function casFile(dir: string, sha: string): string {
    return path.join(dir, "blobs", "sha256", sha.slice(0, 2), sha);
  }

  function corruptCasFile(file: string): void {
    const bytes = readFileSync(file);
    bytes.writeUInt8(bytes.readUInt8(0) ^ 0xff, 0);
    writeFileSync(file, bytes);
  }

  describe("database integrity", () => {
    test("passes on a healthy vault", () => {
      const { db } = seededVault();
      const finding = checkDatabaseIntegrity({
        label: "vault.db",
        db: db.vault,
      });
      expect(finding.level).toBe("ok");
      expect(finding.detail).toContain("integrity_check ok");
    });

    test("errors when the handle is not a database", () => {
      const dir = tempDirSync("doctor-notdb-");
      const file = path.join(dir, "garbage.db");
      writeFileSync(file, "this is not a sqlite file at all");
      const db = new DatabaseSync(file);
      open.push(() => db.close());
      const finding = checkDatabaseIntegrity({ label: "garbage.db", db });
      expect(finding.level).toBe("error");
    });
  });

  describe("CAS re-hash", () => {
    test("passes clean, hashing every object in full mode", () => {
      const { db, vaultId, shas } = seededVault();
      const finding = checkCasRehash({
        vaultId,
        local: db.blobs.local,
        full: true,
      });
      expect(finding.level).toBe("ok");
      expect(finding.detail).toContain(`all ${shas.length}`);
    });

    test("detects a flipped CAS byte (content no longer hashes to its address)", () => {
      const { db, dir, vaultId, shas } = seededVault();
      const victim = shas[0]!;
      corruptCasFile(casFile(dir, victim));
      const finding = checkCasRehash({
        vaultId,
        local: db.blobs.local,
        full: true,
      });
      expect(finding.level).toBe("error");
      expect(finding.detail).toContain("hash mismatch");
      expect(finding.detail).toContain(victim.slice(0, 12));
    });

    test("samples a bounded subset when not full", () => {
      const { db, vaultId } = seededVault();
      let calls = 0;
      const finding = checkCasRehash({
        vaultId,
        local: db.blobs.local,
        sampleSize: 2,
        random: () => {
          calls += 1;
          return 0.5;
        },
      });
      expect(finding.level).toBe("ok");
      expect(finding.detail).toContain("2 of 4 sampled");
      expect(calls).toBeGreaterThan(0);
    });
  });

  describe("hardlink refcount audit", () => {
    test("passes when every CAS entry's link count matches the owned set", () => {
      const { dir, vaultId } = seededVault();
      const finding = checkHardlinkRefcounts([
        { vaultId, casRoot: path.join(dir, "blobs") },
      ]);
      expect(finding.level).toBe("ok");
    });

    test("reconciles a blob shared (hardlinked) across two owned vaults", () => {
      const a = seededVault();
      const b = seededVault();
      const sha = a.shas[0]!;
      const source = casFile(a.dir, sha);
      const dest = casFile(b.dir, sha);
      mkdirSync(path.dirname(dest), { recursive: true });
      rmSync(dest, { force: true });
      linkSync(source, dest);
      const finding = checkHardlinkRefcounts([
        { vaultId: a.vaultId, casRoot: path.join(a.dir, "blobs") },
        { vaultId: b.vaultId, casRoot: path.join(b.dir, "blobs") },
      ]);
      expect(finding.level).toBe("ok");
    });

    test("detects an unaccounted external hardlink (a byte no sweep can free)", () => {
      const { dir, vaultId, shas } = seededVault();
      const stray = tempDirSync("doctor-stray-");
      linkSync(casFile(dir, shas[0]!), path.join(stray, "leaked"));
      const finding = checkHardlinkRefcounts([
        { vaultId, casRoot: path.join(dir, "blobs") },
      ]);
      expect(finding.level).toBe("error");
      expect(finding.detail).toContain("link count 2 != 1");
    });
  });

  describe("replica change-log consistency", () => {
    test("passes on a healthy vault", () => {
      const { db, vaultId } = seededVault();
      const finding = checkReplicaJournalConsistency({
        vaultId,
        vault: db.vault,
      });
      expect(finding.level).toBe("ok");
      expect(finding.detail).toContain("change-log consistent");
    });

    test("detects a replica_change row from a foreign epoch", () => {
      const { db, vaultId } = seededVault();
      db.vault
        .prepare(
          `INSERT INTO replica_change (epoch, commit_id, entity, row_id, op, old_values_json, changed_at)
           VALUES ('foreign-epoch-xyz', 'commit-1', 'core.party', '999', 'insert', NULL, '2020-01-01T00:00:00Z')`
        )
        .run();
      const finding = checkReplicaJournalConsistency({
        vaultId,
        vault: db.vault,
      });
      expect(finding.level).toBe("error");
      expect(finding.detail).toContain("foreign epoch");
    });

    test("detects an autoincrement watermark rewound below the max change seq", () => {
      const { db, vaultId } = seededVault();
      db.vault
        .prepare(
          "UPDATE sqlite_sequence SET seq = 0 WHERE name = 'replica_change'"
        )
        .run();
      const finding = checkReplicaJournalConsistency({
        vaultId,
        vault: db.vault,
      });
      expect(finding.level).toBe("error");
      expect(finding.detail).toContain("rewound");
    });

    test("detects a commit group left marked active at rest", () => {
      const { db, vaultId } = seededVault();
      db.vault
        .prepare(
          "UPDATE replica_meta SET active_commit_id = 'orphaned-commit' WHERE singleton = 1"
        )
        .run();
      const finding = checkReplicaJournalConsistency({
        vaultId,
        vault: db.vault,
      });
      expect(finding.level).toBe("error");
      expect(finding.detail).toContain("still marked active");
    });
  });

  describe("full scrub orchestration", () => {
    test("clean vault yields all-ok findings and no error", () => {
      const { db, dir, vaultId } = seededVault();
      const findings = runIntegrityScrub({
        vaults: [
          {
            vaultId,
            vault: db.vault,
            local: db.blobs.local,
            casRoot: path.join(dir, "blobs"),
          },
        ],
        full: true,
      });
      expect(hasError(findings)).toBe(false);
      expect(findings).toHaveLength(4);
      expect(findings.map((f) => f.check)).toContain("hardlink-refcount");
    });

    test("surfaces an injected fault as an error finding", () => {
      const { db, dir, vaultId, shas } = seededVault();
      corruptCasFile(casFile(dir, shas[0]!));
      const findings = runIntegrityScrub({
        vaults: [
          {
            vaultId,
            vault: db.vault,
            local: db.blobs.local,
            casRoot: path.join(dir, "blobs"),
          },
        ],
        full: true,
      });
      expect(hasError(findings)).toBe(true);
      expect(findings.find((f) => f.check === "cas-rehash")?.level).toBe(
        "error"
      );
    });
  });
});
