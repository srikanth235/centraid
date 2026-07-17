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
import { loadSealKey, readSealKeyFingerprint, sealKeyFingerprint } from './schema/sealed.js';
import { resolveEntity } from './schema/tables.js';

/**
 * Seal-key custody verdict for a restored pair (issue #439 R5). FORMAT.md calls
 * a restore whose sealed columns can't be opened "a placebo"; this proves it or
 * catches it:
 *   - `not-sealed`: the vault never sealed a value (no stamped fingerprint) — no
 *     key is expected, nothing to prove.
 *   - `ok`: the vault has sealed secrets and the restored `seal.key` matches the
 *     fingerprint stamped in `core_vault` — it would actually unseal.
 *   - `missing`: the vault has sealed secrets but the restore carries no `seal.key`.
 *   - `mismatch`: a `seal.key` is present but is not the key those secrets were
 *     sealed with (regenerated/foreign/corrupt) — GCM garbage on every reveal.
 */
export type SealKeyVerdict = 'not-sealed' | 'ok' | 'missing' | 'mismatch';

export interface RestoredPairReport {
  vault: { integrity: string; foreignKeyViolations: number };
  journal: { integrity: string; foreignKeyViolations: number };
  /** Receipts whose (object_type, object_id) names a vault table row that is absent. */
  receiptsChecked: number;
  danglingReceipts: { receiptId: string; action: string; objectType: string; objectId: string }[];
  /** Whether the restored seal key is present and unseals (issue #439 R5). */
  sealKey: { verdict: SealKeyVerdict; expected?: string };
}

/** Prove the restored `seal.key` matches the vault's stamped fingerprint. */
function checkSealKey(destDir: string, vault: DatabaseSync): RestoredPairReport['sealKey'] {
  const expected = readSealKeyFingerprint(vault);
  if (expected === null) return { verdict: 'not-sealed' };
  let key: Buffer | null;
  try {
    key = loadSealKey(path.join(destDir, 'seal.key'));
  } catch {
    // Present but the wrong length — a corrupt key file, not an absent one.
    return { verdict: 'mismatch', expected };
  }
  if (!key) return { verdict: 'missing', expected };
  return { verdict: sealKeyFingerprint(key) === expected ? 'ok' : 'mismatch', expected };
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
  const sealKey = checkSealKey(destDir, vault.db);
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
    sealKey,
  };
}
