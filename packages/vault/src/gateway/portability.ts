// Export & portability (§10 standing duty; GDPR art.20): exit is a feature.
// The whole model out as a verifiable artifact, and back in with identities
// intact. §11 gates every new domain on this: "If export→reimport isn't
// lossless, ownership is theater."

import type { VaultDb } from '../db.js';
import { nowIso, sha256Hex, uuidv7 } from '../ids.js';
import { ONTOLOGY_VERSION } from '../schema/migrate.js';
import { listVaultEntities, resolveEntity } from '../schema/tables.js';
import { writeReceipt } from './evidence.js';
import { tableColumns } from './filters.js';
import type { Identity } from './types.js';

export interface VaultExport {
  format: 'jsonld';
  ontologyVersion: string;
  exportedAt: string;
  /** Logical entity → rows, PK-ordered. The hash covers exactly this. */
  tables: Record<string, Record<string, unknown>[]>;
  /** sha256 over the canonical form of `tables`. */
  verifyHash: string;
}

/** Deterministic JSON: object keys sorted at every level. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function primaryKeyColumn(db: VaultDb, physical: string): string {
  const rows = db.vault.prepare(`PRAGMA table_info(${JSON.stringify(physical)})`).all() as {
    name: string;
    pk: number;
  }[];
  return rows.find((r) => r.pk === 1)?.name ?? rows[0]?.name ?? 'rowid';
}

/**
 * Assemble the whole-model artifact, then record the consent.export_job row
 * and receipt. The job row is written *after* assembly so an export never
 * contains its own job — which is also what makes round-trip hashes
 * comparable.
 */
export function exportVault(
  db: VaultDb,
  owner: Identity,
): { artifact: VaultExport; exportId: string; receiptId: string } {
  const requestedAt = nowIso();
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const logical of listVaultEntities()) {
    const ref = resolveEntity(logical);
    if (!ref) continue;
    const pk = primaryKeyColumn(db, ref.physical);
    tables[logical] = db.vault
      .prepare(`SELECT * FROM "${ref.physical}" ORDER BY "${pk}"`)
      .all() as Record<string, unknown>[];
  }
  const verifyHash = sha256Hex(canonicalJson(tables));
  const artifact: VaultExport = {
    format: 'jsonld',
    ontologyVersion: ONTOLOGY_VERSION,
    exportedAt: requestedAt,
    tables,
    verifyHash,
  };
  const exportId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO consent_export_job
         (export_id, requested_by_party_id, scope_json, format, requested_at, completed_at, artifact_content_id, verify_hash)
       VALUES (?, ?, ?, 'jsonld', ?, ?, NULL, ?)`,
    )
    .run(
      exportId,
      owner.partyId,
      JSON.stringify({ schemas: 'all' }),
      requestedAt,
      nowIso(),
      verifyHash,
    );
  const receiptId = writeReceipt(db.journal, {
    grantId: null,
    invocationId: null,
    action: 'act consent.export_vault',
    objectType: 'consent.export_job',
    objectId: exportId,
    purpose: null,
    decision: 'allow',
    detail: { verifyHash, rowCount: Object.values(tables).reduce((n, rows) => n + rows.length, 0) },
  });
  return { artifact, exportId, receiptId };
}

/**
 * Rebuild a fresh vault from an export, identities intact. FKs are checked
 * wholesale after load (imports arrive in registry order, but polymorphic
 * and self-referencing rows make per-row ordering impossible in general).
 */
export function importVaultExport(db: VaultDb, artifact: VaultExport): { imported: number } {
  const actual = sha256Hex(canonicalJson(artifact.tables));
  if (actual !== artifact.verifyHash) {
    throw new Error(
      `export artifact hash mismatch: expected ${artifact.verifyHash}, got ${actual}`,
    );
  }
  const existing = db.vault.prepare('SELECT count(*) AS n FROM core_party').get() as { n: number };
  if (existing.n > 0) throw new Error('import target is not a fresh vault');
  let imported = 0;
  db.vault.exec('PRAGMA foreign_keys = OFF');
  db.vault.exec('BEGIN');
  try {
    for (const logical of listVaultEntities()) {
      const rows = artifact.tables[logical];
      if (!rows || rows.length === 0) continue;
      const ref = resolveEntity(logical);
      if (!ref) throw new Error(`unknown entity in artifact: ${logical}`);
      const cols = tableColumns(db.vault, ref.physical);
      for (const row of rows) {
        const names = Object.keys(row).filter((c) => cols.has(c));
        const sql = `INSERT INTO "${ref.physical}" (${names.map((c) => `"${c}"`).join(', ')})
                     VALUES (${names.map(() => '?').join(', ')})`;
        db.vault.prepare(sql).run(...names.map((c) => row[c] as string | number | null));
        imported += 1;
      }
    }
    const violations = db.vault.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) {
      throw new Error(
        `import broke referential integrity: ${JSON.stringify(violations.slice(0, 3))}`,
      );
    }
    db.vault.exec('COMMIT');
  } catch (err) {
    db.vault.exec('ROLLBACK');
    throw err;
  } finally {
    db.vault.exec('PRAGMA foreign_keys = ON');
  }
  return { imported };
}
