import type { VaultDb } from "../db.js";
import { nowIso, sha256Hex, uuidv7 } from "../ids.js";
import { beginReplicaCommit, endReplicaCommit } from "../replica/change-log.js";
import { ONTOLOGY_VERSION } from "../schema/migrate.js";
import {
  sealKeyFingerprint,
  stampSealKeyFingerprint,
} from "../schema/sealed.js";
import { listVaultEntities, resolveEntity } from "../schema/tables.js";
import { writeReceipt } from "./evidence.js";
import { recreateExtTables } from "./ext.js";
import { clearColumnCache, tableColumns } from "./filters.js";
import { resealSealedCells } from "./reseal.js";
import {
  auditArtifactSealedValues,
  sealedArtifactTotal,
} from "./sealed-artifact.js";
import type { Identity } from "./types.js";

export interface VaultExport {
  format: "jsonld";
  ontologyVersion: string;
  exportedAt: string;
  tables: Record<string, Record<string, unknown>[]>;
  verifyHash: string;
  skippedTables?: { entity: string; error: string }[];
}

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

export function exportVault(
  db: VaultDb,
  _owner: Identity
): { artifact: VaultExport; exportId: string; receiptId: string } {
  const requestedAt = nowIso();
  const tables: Record<string, Record<string, unknown>[]> = {};
  const skippedTables: { entity: string; error: string }[] = [];
  for (const logical of listVaultEntities(db.vault)) {
    const ref = resolveEntity(logical, db.vault);
    if (!ref) continue;
    try {
      const pk = primaryKeyColumn(db, ref.physical);
      tables[logical] = (
        db.vault
          .prepare(`SELECT * FROM "${ref.physical}" ORDER BY "${pk}"`)
          .all() as Record<string, unknown>[]
      ).map((row) => {
        const stripped = { ...row };
        for (const column of Object.keys(stripped))
          if (AUDIT_POINTER_COLUMNS.has(`${logical}.${column}`))
            stripped[column] = null;
        return stripped;
      });
    } catch (error) {
      skippedTables.push({
        entity: logical,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
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
  const vaultId = (
    db.vault.prepare("SELECT vault_id FROM core_vault LIMIT 1").get() as
      | { vault_id: string }
      | undefined
  )?.vault_id;
  const receiptId = writeReceipt(db.audit, {
    grantId: null,
    invocationId: null,
    action: "act access.export_vault",
    objectType: "core.vault",
    objectId: vaultId ?? exportId,
    purpose: null,
    decision: "allow",
    detail: {
      exportId,
      verifyHash,
      rowCount: Object.values(tables).reduce((n, rows) => n + rows.length, 0),
      ...(skippedTables.length > 0
        ? { skippedTableCount: skippedTables.length, skippedTables }
        : {}),
    },
  });
  return { artifact, exportId, receiptId };
}

const SEAL_KEY_SETTING = "seal_key";

const AUDIT_POINTER_COLUMNS: ReadonlySet<string> = new Set([
  "core.entity_revision.invocation_id",
]);

function clearImportedSealKeyStamp(vault: VaultDb["vault"]): void {
  const row = vault
    .prepare("SELECT settings_json FROM core_vault LIMIT 1")
    .get() as { settings_json: string | null } | undefined;
  if (!row?.settings_json) return;
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(row.settings_json) as Record<string, unknown>;
  } catch {
    return;
  }
  if (!(SEAL_KEY_SETTING in settings)) return;
  delete settings[SEAL_KEY_SETTING];
  vault
    .prepare("UPDATE core_vault SET settings_json = ?")
    .run(JSON.stringify(settings));
}

export interface ImportVaultExportOptions {
  replaceBootstrap?: boolean;
  sourceSealKey?: Buffer;
}

export function importVaultExport(
  db: VaultDb,
  artifact: VaultExport,
  options: ImportVaultExportOptions = {}
): { imported: number } {
  const actual = sha256Hex(canonicalJson(artifact.tables));
  if (actual !== artifact.verifyHash) {
    throw new Error(
      `export artifact hash mismatch: expected ${artifact.verifyHash}, got ${actual}`
    );
  }
  const sealed = auditArtifactSealedValues(artifact);
  if (sealed.unexpected.length > 0) {
    throw new Error(
      `import refused: sealed values in undeclared columns (${sealed.unexpected.join(", ")}) — the re-seal sweep cannot reach them, so importing would store unreadable ciphertext`
    );
  }
  const sealedTotal = sealedArtifactTotal(sealed);
  const sourceSealKey = options.sourceSealKey;
  if (sealedTotal > 0 && !sourceSealKey) {
    throw new Error(
      `import refused: this export carries ${sealedTotal} sealed value(s) and no seal key was supplied — provide the export's password-wrapped recovery kit and its passphrase. Nothing was written.`
    );
  }
  if (sourceSealKey && sourceSealKey.length !== db.sealKey.length) {
    throw new Error(
      `import refused: the supplied seal key is ${sourceSealKey.length} bytes, expected ${db.sealKey.length}`
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
        const names = Object.keys(row).filter(
          (c) => cols.has(c) && !AUDIT_POINTER_COLUMNS.has(`${logical}.${c}`)
        );
        const sql = `INSERT INTO "${ref.physical}" (${names.map((c) => `"${c}"`).join(", ")})
                     VALUES (${names.map(() => "?").join(", ")})`;
        db.vault
          .prepare(sql)
          .run(...names.map((c) => row[c] as string | number | null));
        n += 1;
      }
      return n;
    };

    for (const logical of listVaultEntities()) imported += load(logical);
    recreateExtTables(db);
    for (const logical of listVaultEntities(db.vault)) {
      if (logical.startsWith("ext.")) imported += load(logical);
    }
    clearImportedSealKeyStamp(db.vault);
    if (sealedTotal > 0 && sourceSealKey) {
      const resealed =
        sealKeyFingerprint(sourceSealKey) === sealKeyFingerprint(db.sealKey)
          ? { cells: sealed.cells, staged: sealed.staged }
          : resealSealedCells(db, sourceSealKey, db.sealKey);
      if (
        resealed.cells !== sealed.cells ||
        resealed.staged !== sealed.staged
      ) {
        throw new Error(
          `import refused: re-sealed ${resealed.cells}+${resealed.staged} of the artifact's ${sealed.cells}+${sealed.staged} sealed values — some cell would have been left unreadable`
        );
      }
      stampSealKeyFingerprint(db.vault, db.sealKey);
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
