// File custody (§10) for file-backed vaults. R09: vault never references ext tables. Backup path is WAL shipper; `backupVault` is the user-facing export — do not VACUUM on a cadence.

import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, rmSync } from "node:fs";
import path from "node:path";

import type { VaultDb } from "../db.js";
import { asVaultDiskFullError } from "../errors.js";
import { writeReceipt } from "./evidence.js";
import { GatewayError } from "./types.js";

function requireDir(db: VaultDb, action: string): string {
  if (db.dir === ":memory:") {
    throw new GatewayError("execution", `${action} needs a file-backed vault`);
  }
  return db.dir;
}

/** With a WAL shipper (#408) MUST NOT be called directly (I2). Hosts use `WalShipper.checkpointNow()`. */
export function checkpointVault(db: VaultDb): { vault: string } {
  requireDir(db, "checkpoint");
  try {
    // ONE FILE (#916): the audit band is in `vault.db`, so there is one WAL to
    // truncate and no ordering between two of them to get wrong.
    db.vault.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (error) {
    throw asVaultDiskFullError("vault WAL checkpoint", error);
  }
  return { vault: "truncated" };
}

/** Streamed SHA-256; must match `shasum -a 256` — do not hash a latin1 string. */
export function sha256File(file: string): string {
  const hash = createHash("sha256");
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(4 * 1024 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

export interface BackupResult {
  vaultPath: string;
  vaultSha256: string;
  blobsCopied: number;
  receiptId: string;
}

export function backupVault(db: VaultDb, destDir: string): BackupResult {
  requireDir(db, "backup");
  const vaultPath = path.join(destDir, "vault.backup.db");
  rmSync(vaultPath, { force: true });
  // One file carries the life data and its evidence, so one copy is the whole
  // backup — and the two halves can no longer be copied at different instants.
  db.vault.exec(`VACUUM INTO '${vaultPath.replaceAll("'", "''")}'`);
  const vaultSha256 = sha256File(vaultPath);
  const { copied } = db.blobs.exportTo(destDir);
  const receiptId = writeReceipt(db.audit, {
    grantId: null,
    invocationId: null,
    action: "act access.backup_vault",
    objectType: "core.vault",
    objectId: null,
    purpose: null,
    decision: "allow",
    detail: { vaultSha256, destDir, blobsCopied: copied },
  });
  return { vaultPath, vaultSha256, blobsCopied: copied, receiptId };
}
