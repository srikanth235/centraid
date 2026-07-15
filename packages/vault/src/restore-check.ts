/*
 * Restored-pair verification (issue #408, G8/G9): structural and
 * cross-database checks over a RESTORED `vault.db` + `journal.db` directory
 * — never a live vault. The restore-verification job (BackupService) and
 * the acceptance tests both run this after a real restore from the remote.
 *
 * The cross-database check ("no journal receipt references a vault row
 * absent from the restored vault") is reported, not thrown: receipts are
 * history and vault rows may be legitimately hard-deleted AFTER a receipt
 * referenced them, so in production a non-zero count is a DEGRADED signal
 * to investigate. In controlled test workloads (no deletions), the caller
 * asserts zero — that is the G8 acceptance criterion: a write landing
 * between the two databases' capture instants must never produce a receipt
 * whose row is missing, and capture order (journal head first, then vault)
 * plus receipts-after-commit makes it structurally impossible.
 */

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveEntity } from './schema/tables.js';

export interface RestoredPairReport {
  vault: { integrity: string; foreignKeyViolations: number };
  journal: { integrity: string; foreignKeyViolations: number };
  /** Receipts whose (object_type, object_id) names a vault table row that is absent. */
  receiptsChecked: number;
  danglingReceipts: { receiptId: string; action: string; objectType: string; objectId: string }[];
}

function checkFile(file: string): {
  db: DatabaseSync;
  integrity: string;
  foreignKeyViolations: number;
} {
  const db = new DatabaseSync(file, { readOnly: true });
  const integ = db.prepare('PRAGMA integrity_check').get() as
    | { integrity_check: string }
    | undefined;
  const fks = db.prepare('PRAGMA foreign_key_check').all();
  return { db, integrity: integ?.integrity_check ?? 'no result', foreignKeyViolations: fks.length };
}

function pkOf(db: DatabaseSync, physical: string): string | undefined {
  const cols = db.prepare(`PRAGMA table_info("${physical}")`).all() as {
    name: string;
    pk: number;
  }[];
  return cols.find((c) => c.pk === 1)?.name;
}

/** Verify a restored vault directory (both files + the G8 cross-check). */
export function verifyRestoredPair(destDir: string): RestoredPairReport {
  const vault = checkFile(path.join(destDir, 'vault.db'));
  const journal = checkFile(path.join(destDir, 'journal.db'));
  const danglingReceipts: RestoredPairReport['danglingReceipts'] = [];
  let receiptsChecked = 0;
  try {
    const rows = journal.db
      .prepare(
        `SELECT receipt_id, action, object_type, object_id FROM consent_receipt
         WHERE object_id IS NOT NULL AND decision = 'allow'`,
      )
      .all() as { receipt_id: string; action: string; object_type: string; object_id: string }[];
    const existsStmt = new Map<string, { pk: string; physical: string } | null>();
    for (const row of rows) {
      const ref = resolveEntity(row.object_type, vault.db);
      if (!ref || ref.file !== 'vault') continue; // journal-side or abstract object
      receiptsChecked++;
      let target = existsStmt.get(ref.physical);
      if (target === undefined) {
        const pk = pkOf(vault.db, ref.physical);
        target = pk ? { pk, physical: ref.physical } : null;
        existsStmt.set(ref.physical, target);
      }
      if (!target) continue;
      const live = vault.db
        .prepare(`SELECT 1 AS x FROM "${target.physical}" WHERE "${target.pk}" = ?`)
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
    vault: { integrity: vault.integrity, foreignKeyViolations: vault.foreignKeyViolations },
    journal: { integrity: journal.integrity, foreignKeyViolations: journal.foreignKeyViolations },
    receiptsChecked,
    danglingReceipts,
  };
}
