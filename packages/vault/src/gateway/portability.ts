// Export & portability (§10, GDPR art.20): whole model out verifiable, back
// lossless — §11 gates every new domain on this.

import type { VaultDb } from "../db.js";
import { nowIso, sha256Hex, uuidv7 } from "../ids.js";
import { beginReplicaCommit, endReplicaCommit } from "../replica/change-log.js";
import { ONTOLOGY_VERSION } from "../schema/migrate.js";
import { listVaultEntities, resolveEntity } from "../schema/tables.js";
import { writeReceipt } from "./evidence.js";
import { recreateExtTables } from "./ext.js";
import { clearColumnCache, tableColumns } from "./filters.js";
import type { Identity } from "./types.js";

export interface VaultExport {
  format: "jsonld";
  ontologyVersion: string;
  exportedAt: string;
  /** Logical entity → rows, PK-ordered; the hash covers exactly this. */
  tables: Record<string, Record<string, unknown>[]>;
  /** sha256 over the canonical `tables`. */
  verifyHash: string;
  /**
   * Entities a poisoned row knocked out of this export (#374 tier 4.3);
   * absent means all made it in. Skips never desync round-trip verification.
   */
  skippedTables?: { entity: string; error: string }[];
}

/** Deterministic JSON: keys sorted at every level. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function primaryKeyColumn(db: VaultDb, physical: string): string {
  const rows = db.vault
    .prepare(`PRAGMA table_info(${JSON.stringify(physical)})`)
    .all() as {
    name: string;
    pk: number;
  }[];
  return rows.find((r) => r.pk === 1)?.name ?? rows[0]?.name ?? "rowid";
}

/**
 * Assemble the artifact; the job row is written *after* assembly so an
 * export never contains its own job.
 */
export function exportVault(
  db: VaultDb,
  owner: Identity
): { artifact: VaultExport; exportId: string; receiptId: string } {
  const requestedAt = nowIso();
  const tables: Record<string, Record<string, unknown>[]> = {};
  const skippedTables: { entity: string; error: string }[] = [];
  for (const logical of listVaultEntities(db.vault)) {
    const ref = resolveEntity(logical, db.vault);
    if (!ref) continue;
    // Per-table isolation (#374 4.3): a poisoned row skips its table; others continue.
    try {
      const pk = primaryKeyColumn(db, ref.physical);
      tables[logical] = db.vault
        .prepare(`SELECT * FROM "${ref.physical}" ORDER BY "${pk}"`)
        .all() as Record<string, unknown>[];
    } catch (error) {
      skippedTables.push({
        entity: logical,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // Hash over `tables` as assembled; skipped tables never counted.
  const verifyHash = sha256Hex(canonicalJson(tables));
  const artifact: VaultExport = {
    format: "jsonld",
    ontologyVersion: ONTOLOGY_VERSION,
    exportedAt: requestedAt,
    tables,
    verifyHash,
    ...(skippedTables.length > 0 ? { skippedTables } : {}),
  };
  const exportId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO consent_export_job
         (export_id, requested_by_party_id, scope_json, format, requested_at, completed_at, artifact_content_id, verify_hash)
       VALUES (?, ?, ?, 'jsonld', ?, ?, NULL, ?)`
    )
    .run(
      exportId,
      owner.partyId,
      JSON.stringify({ schemas: "all" }),
      requestedAt,
      nowIso(),
      verifyHash
    );
  const receiptId = writeReceipt(db.journal, {
    grantId: null,
    invocationId: null,
    action: "act consent.export_vault",
    objectType: "consent.export_job",
    objectId: exportId,
    purpose: null,
    decision: "allow",
    detail: {
      verifyHash,
      rowCount: Object.values(tables).reduce((n, rows) => n + rows.length, 0),
      ...(skippedTables.length > 0
        ? { skippedTableCount: skippedTables.length, skippedTables }
        : {}),
    },
  });
  return { artifact, exportId, receiptId };
}

/**
 * Rebuild a fresh vault from an export, identities intact; FKs checked
 * wholesale after load (per-row ordering impossible in general).
 */
export function importVaultExport(
  db: VaultDb,
  artifact: VaultExport,
  options: { replaceBootstrap?: boolean } = {}
): { imported: number } {
  const actual = sha256Hex(canonicalJson(artifact.tables));
  if (actual !== artifact.verifyHash) {
    throw new Error(
      `export artifact hash mismatch: expected ${artifact.verifyHash}, got ${actual}`
    );
  }
  const existing = db.vault
    .prepare("SELECT count(*) AS n FROM core_party")
    .get() as { n: number };
  if (existing.n > 0 && !options.replaceBootstrap)
    throw new Error("import target is not a fresh vault");
  if (existing.n > 0 && options.replaceBootstrap) {
    const growthTables = [
      "core_content_item",
      "core_event",
      "locker_item",
      "media_asset",
      "schedule_task",
      "sync_import_batch",
      "tally_expense",
    ];
    const populated = growthTables.filter((table) => {
      const row = db.vault
        .prepare(`SELECT count(*) AS n FROM "${table}"`)
        .get() as { n: number };
      return row.n > 0;
    });
    if (populated.length > 0) {
      throw new Error(
        `portable import target contains user data (${populated.join(", ")}); replacement is allowed only on a fresh bootstrap`
      );
    }
  }
  let imported = 0;
  db.vault.exec("PRAGMA foreign_keys = OFF");
  db.vault.exec("BEGIN");
  let replicaCommit!: ReturnType<typeof beginReplicaCommit>;
  try {
    replicaCommit = beginReplicaCommit(db.vault);
    if (existing.n > 0) {
      const physical = new Set(
        listVaultEntities(db.vault)
          .map((logical) => resolveEntity(logical, db.vault)?.physical)
          .filter((value): value is string => Boolean(value))
      );
      for (const table of [...physical].toReversed())
        db.vault.exec(`DELETE FROM "${table}"`);
    }
    const load = (logical: string): number => {
      const rows = artifact.tables[logical];
      if (!rows || rows.length === 0) return 0;
      const ref = resolveEntity(logical, db.vault);
      if (!ref) throw new Error(`unknown entity in artifact: ${logical}`);
      clearColumnCache(ref.physical);
      const cols = tableColumns(db.vault, ref.physical);
      let n = 0;
      for (const row of rows) {
        const names = Object.keys(row).filter((c) => cols.has(c));
        const sql = `INSERT INTO "${ref.physical}" (${names.map((c) => `"${c}"`).join(", ")})
                     VALUES (${names.map(() => "?").join(", ")})`;
        db.vault
          .prepare(sql)
          .run(...names.map((c) => row[c] as string | number | null));
        n += 1;
      }
      return n;
    };
    // Canonical entities first: loads consent_app_ext, planting ext-band tables.
    for (const logical of listVaultEntities()) imported += load(logical);
    recreateExtTables(db);
    for (const logical of listVaultEntities(db.vault)) {
      if (logical.startsWith("ext.")) imported += load(logical);
    }
    const violations = db.vault.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `import broke referential integrity: ${JSON.stringify(violations.slice(0, 3))}`
      );
    }
    endReplicaCommit(db.vault, replicaCommit);
    db.vault.exec("COMMIT");
  } catch (error) {
    db.vault.exec("ROLLBACK");
    throw error;
  } finally {
    db.vault.exec("PRAGMA foreign_keys = ON");
  }
  return { imported };
}
