import { createHash } from "node:crypto";
// File custody (§10): `backupVault` is the user-facing export ramp — VACUUM
// INTO copies of the two SQLite files plus the blob CAS, hashed so the copy
// is verifiable with standard tools. (`stageVaultDbs`, the old offsite
// staging half, left with issue #408 — the backup path ships WAL segments
// via wal-shipper.ts instead of rewriting the database per snapshot.)
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { tempDirSync } from "@centraid/test-kit/temp-dir";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { sharedDiskFullTracker, VaultDiskFullError } from "../errors.js";
import { backupVault, checkpointVault, sha256File } from "./custody.js";

let root: string;
let vaultDir: string;
let db: VaultDb;

describe("custody", () => {
  beforeEach(() => {
    root = tempDirSync("custody-stage-");
    vaultDir = path.join(root, "vault-a");
    db = openVaultDb({ dir: vaultDir });
    bootstrapVault(db, { ownerName: "Priya" });
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("backupVault writes openable copies, blobs, and shasum-reproducible hashes", () => {
    checkpointVault(db); // truncate the WAL so VACUUM INTO sees committed rows
    db.blobs.ingestSync(Buffer.from("hello export ramp"));
    const destDir = path.join(root, "full-backup");
    mkdirSync(destDir, { recursive: true });

    const result = backupVault(db, destDir);

    expect(result.vaultPath).toBe(path.join(destDir, "vault.backup.db"));
    expect(existsSync(result.vaultPath)).toBe(true);
    expect(existsSync(result.journalPath)).toBe(true);
    expect(result.blobsCopied).toBe(1);
    expect(existsSync(path.join(destDir, "blobs"))).toBe(true);
    expect(result.receiptId).toBeTruthy();

    // "Verifiable independently" means the recorded hash IS the file's
    // SHA-256 — what `shasum -a 256` prints — not an implementation artifact.
    const rawHash = createHash("sha256")
      .update(readFileSync(result.vaultPath))
      .digest("hex");
    expect(result.vaultSha256).toBe(rawHash);
    expect(sha256File(result.journalPath)).toBe(result.journalSha256);

    // The copy is a real, independently openable SQLite file carrying the
    // vault's own row — not just bytes that happen to exist.
    const copy = new DatabaseSync(result.vaultPath, { readOnly: true });
    try {
      const row = copy
        .prepare("SELECT display_name FROM core_vault LIMIT 1")
        .get() as { display_name: string } | undefined;
      expect(row?.display_name).toBe("Priya's vault");
    } finally {
      copy.close();
    }

    // The receipt landed in the journal (appended, not overwritten).
    const receiptRow = db.journal
      .prepare("SELECT action FROM consent_receipt WHERE receipt_id = ?")
      .get(result.receiptId) as { action: string } | undefined;
    expect(receiptRow?.action).toBe("act consent.backup_vault");
  });

  test("backupVault refuses an in-memory vault (no files to copy)", () => {
    const mem = openVaultDb();
    try {
      expect(() => backupVault(mem, root)).toThrow(/file-backed vault/u);
    } finally {
      mem.close();
    }
  });

  test("SQLITE_FULL during a WAL checkpoint preserves the files and raises gateway disk health", () => {
    sharedDiskFullTracker.clear();
    const sqliteFull = Object.assign(new Error("database or disk is full"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 13,
      errstr: "database or disk is full",
    });
    const vaultExec = vi.fn<(sql: string) => void>(() => {
      throw sqliteFull;
    });
    const journalExec = vi.fn<(sql: string) => void>();
    const checkpointDb = {
      dir: path.join(root, "checkpoint-full"),
      vault: { exec: vaultExec },
      journal: { exec: journalExec },
    } as unknown as VaultDb;

    expect(() => checkpointVault(checkpointDb)).toThrow(VaultDiskFullError);
    expect(vaultExec).toHaveBeenCalledExactlyOnceWith(
      "PRAGMA wal_checkpoint(TRUNCATE)"
    );
    expect(journalExec).not.toHaveBeenCalled();
    expect(sharedDiskFullTracker.current()).toMatchObject({
      context: "vault WAL checkpoint",
    });
    sharedDiskFullTracker.clear();
  });
});
