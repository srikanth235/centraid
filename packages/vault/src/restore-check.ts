/*
 * Restored-pair verification (#408, G8/G9) over a RESTORED directory — never
 * a live vault. Dangling receipts are REPORTED, not thrown: rows may
 * legitimately be hard-deleted after a receipt referenced them.
 */

import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  loadSealKey,
  readSealKeyFingerprint,
  sealKeyFingerprint,
} from "./schema/sealed.js";
import { resolveEntity } from "./schema/tables.js";

/**
 * Seal-key custody verdict (#439): `not-sealed` | `ok` | `missing` |
 * `mismatch` (foreign/corrupt key).
 */
export type SealKeyVerdict = "not-sealed" | "ok" | "missing" | "mismatch";

export interface RestoredPairReport {
  vault: { integrity: string; foreignKeyViolations: number };
  journal: { integrity: string; foreignKeyViolations: number };
  /** Receipts naming a vault table row absent from the restore. */
  receiptsChecked: number;
  danglingReceipts: {
    receiptId: string;
    action: string;
    objectType: string;
    objectId: string;
  }[];
  /** Restored seal key present and unsealing (#439). */
  sealKey: { verdict: SealKeyVerdict; expected?: string };
}

/** DEK must match the restored vault fingerprint. */
function checkSealKey(
  destDir: string,
  vault: DatabaseSync,
  recoveryKey: Buffer | null | undefined
): RestoredPairReport["sealKey"] {
  const expected = readSealKeyFingerprint(vault);
  if (expected === null) return { verdict: "not-sealed" };
  let key: Buffer | null;
  if (recoveryKey === undefined) {
    // Pre-DEK snapshots carried a loose seal.key entry.
    try {
      key = loadSealKey(path.join(destDir, "seal.key"));
    } catch {
      return { verdict: "mismatch", expected };
    }
  } else {
    key = recoveryKey;
  }
  if (!key) return { verdict: "missing", expected };
  return {
    verdict: sealKeyFingerprint(key) === expected ? "ok" : "mismatch",
    expected,
  };
}

function checkFile(file: string): {
  db: DatabaseSync;
  integrity: string;
  foreignKeyViolations: number;
} {
  const db = new DatabaseSync(file, { readOnly: true });
  const integ = db.prepare("PRAGMA integrity_check").get() as
    | { integrity_check: string }
    | undefined;
  const fks = db.prepare("PRAGMA foreign_key_check").all();
  return {
    db,
    integrity: integ?.integrity_check ?? "no result",
    foreignKeyViolations: fks.length,
  };
}

function pkOf(db: DatabaseSync, physical: string): string | undefined {
  const cols = db.prepare(`PRAGMA table_info("${physical}")`).all() as {
    name: string;
    pk: number;
  }[];
  return cols.find((c) => c.pk === 1)?.name;
}

/** Verify a restored vault directory. */
export function verifyRestoredPair(
  destDir: string,
  recoveryKey?: Buffer | null
): RestoredPairReport {
  const vault = checkFile(path.join(destDir, "vault.db"));
  const journal = checkFile(path.join(destDir, "journal.db"));
  const sealKey = checkSealKey(destDir, vault.db, recoveryKey);
  const danglingReceipts: RestoredPairReport["danglingReceipts"] = [];
  let receiptsChecked = 0;
  try {
    const rows = journal.db
      .prepare(
        `SELECT receipt_id, action, object_type, object_id FROM consent_receipt
         WHERE object_id IS NOT NULL AND decision = 'allow'`
      )
      .all() as {
      receipt_id: string;
      action: string;
      object_type: string;
      object_id: string;
    }[];
    const existsStmt = new Map<
      string,
      { pk: string; physical: string } | null
    >();
    for (const row of rows) {
      const ref = resolveEntity(row.object_type, vault.db);
      if (!ref || ref.file !== "vault") continue; // journal-side or abstract object
      receiptsChecked++;
      let target = existsStmt.get(ref.physical);
      if (target === undefined) {
        const pk = pkOf(vault.db, ref.physical);
        target = pk ? { pk, physical: ref.physical } : null;
        existsStmt.set(ref.physical, target);
      }
      if (!target) continue;
      const live = vault.db
        .prepare(
          `SELECT 1 AS x FROM "${target.physical}" WHERE "${target.pk}" = ?`
        )
        .get(row.object_id);
      if (!live) {
        danglingReceipts.push({
          receiptId: row.receipt_id,
          action: row.action,
          objectType: row.object_type,
          objectId: row.object_id,
        });
      }
    }
  } finally {
    vault.db.close();
    journal.db.close();
  }
  return {
    vault: {
      integrity: vault.integrity,
      foreignKeyViolations: vault.foreignKeyViolations,
    },
    journal: {
      integrity: journal.integrity,
      foreignKeyViolations: journal.foreignKeyViolations,
    },
    receiptsChecked,
    danglingReceipts,
    sealKey,
  };
}
