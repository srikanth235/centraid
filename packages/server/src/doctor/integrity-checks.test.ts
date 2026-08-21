/*
 * Integrity-scrub check library (issue #839 W1.2). Every check is exercised
 * BOTH ways over a real on-disk vault: clean (passes) and against an injected
 * REAL fault (a flipped CAS byte, an extra hardlink, a foreign-epoch change
 * row), so a green here means the check detects the corruption it claims to.
 */

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

const open: (() => void)[] = [];
afterEach(() => {
  while (open.length) open.pop()!();
});

/** A bootstrapped on-disk vault with a few real CAS blobs. */
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

describe("checkDatabaseIntegrity", () => {
  test("passes on a healthy vault", () => {
    const { db } = seededVault();
    const finding = checkDatabaseIntegrity({ label: "vault.db", db: db.vault });
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

describe("checkCasRehash", () => {
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
    // Re-open the vault handles are irrelevant to on-disk CAS files — flip a
    // byte directly under the content address, exactly a bit-rot event.
    const victim = shas[0]!;
    const file = casFile(dir, victim);
    const bytes = readFileSync(file);
    bytes[0] = bytes[0]! ^ 0xff;
    writeFileSync(file, bytes);
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

describe("checkHardlinkRefcounts", () => {
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
    // Place vault A's first blob into vault B's CAS by hardlink — the
    // share-by-placement primitive. Now nlink === 2, and both entries are
    // accounted for across the two owned vaults.
    const sha = a.shas[0]!;
    const source = casFile(a.dir, sha);
    const dest = casFile(b.dir, sha);
    mkdirSync(path.dirname(dest), { recursive: true });
    // Both vaults seeded identical bytes, so B already holds its OWN copy of
    // this address (a distinct inode). Replace it with a hardlink to A's inode
    // — now the single inode is claimed by exactly two accounted CAS entries.
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
    // A directory entry OUTSIDE any owned vault points at the same inode:
    // nlink becomes 2 but only 1 CAS entry is accounted, so those bytes can
    // never be reclaimed — a GC-contract violation.
    const stray = tempDirSync("doctor-stray-");
    linkSync(casFile(dir, shas[0]!), path.join(stray, "leaked"));
    const finding = checkHardlinkRefcounts([
      { vaultId, casRoot: path.join(dir, "blobs") },
    ]);
    expect(finding.level).toBe("error");
    expect(finding.detail).toContain("link count 2 != 1");
  });
});

describe("checkReplicaJournalConsistency", () => {
  test("passes on a healthy vault", () => {
    const { db, vaultId } = seededVault();
    const finding = checkReplicaJournalConsistency({
      vaultId,
      vault: db.vault,
      journal: db.journal,
    });
    expect(finding.level).toBe("ok");
    expect(finding.detail).toContain("change-log consistent");
  });

  test("detects a replica_change row from a foreign epoch", () => {
    const { db, vaultId } = seededVault();
    // The retention prune deletes every row whose epoch != current, so a
    // surviving foreign-epoch row is unrepresentable in a healthy log.
    db.vault
      .prepare(
        `INSERT INTO replica_change (epoch, commit_id, entity, row_id, op, old_values_json, changed_at)
         VALUES ('foreign-epoch-xyz', 'commit-1', 'core.party', '999', 'insert', NULL, '2020-01-01T00:00:00Z')`
      )
      .run();
    const finding = checkReplicaJournalConsistency({
      vaultId,
      vault: db.vault,
      journal: db.journal,
    });
    expect(finding.level).toBe("error");
    expect(finding.detail).toContain("foreign epoch");
  });

  test("detects an autoincrement watermark rewound below the max change seq", () => {
    const { db, vaultId } = seededVault();
    // Bootstrap + blob ingests fire replica triggers, so there are rows and a
    // sqlite_sequence entry. Rewinding it below the max seq is a rowid-reuse
    // hazard the log's monotonic autoincrement is meant to prevent.
    db.vault
      .prepare(
        "UPDATE sqlite_sequence SET seq = 0 WHERE name = 'replica_change'"
      )
      .run();
    const finding = checkReplicaJournalConsistency({
      vaultId,
      vault: db.vault,
      journal: db.journal,
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
      journal: db.journal,
    });
    expect(finding.level).toBe("error");
    expect(finding.detail).toContain("still marked active");
  });
});

describe("runIntegrityScrub", () => {
  test("clean vault yields all-ok findings and no error", () => {
    const { db, dir, vaultId } = seededVault();
    const findings = runIntegrityScrub({
      vaults: [
        {
          vaultId,
          vault: db.vault,
          journal: db.journal,
          local: db.blobs.local,
          casRoot: path.join(dir, "blobs"),
        },
      ],
      full: true,
    });
    expect(hasError(findings)).toBe(false);
    // vault.db + journal.db integrity, cas-rehash, replica-journal, + 1
    // cross-vault refcount audit.
    expect(findings).toHaveLength(5);
    expect(findings.map((f) => f.check)).toContain("hardlink-refcount");
  });

  test("surfaces an injected fault as an error finding", () => {
    const { db, dir, vaultId, shas } = seededVault();
    const file = casFile(dir, shas[0]!);
    const bytes = readFileSync(file);
    bytes[0] = bytes[0]! ^ 0xff;
    writeFileSync(file, bytes);
    const findings = runIntegrityScrub({
      vaults: [
        {
          vaultId,
          vault: db.vault,
          journal: db.journal,
          local: db.blobs.local,
          casRoot: path.join(dir, "blobs"),
        },
      ],
      full: true,
    });
    expect(hasError(findings)).toBe(true);
    expect(findings.find((f) => f.check === "cas-rehash")?.level).toBe("error");
  });
});
