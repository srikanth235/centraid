// Export & portability (§10, GDPR art.20): whole model out verifiable, back
// lossless — §11 gates every new domain on this.

import type { VaultDb } from "../db.js";
import { nowIso, sha256Hex, uuidv7 } from "../ids.js";
import { beginReplicaCommit, endReplicaCommit } from "../replica/change-log.js";
import { ONTOLOGY_VERSION } from "../schema/migrate.js";
import {
  sealKeyFingerprint,
  stampSealKeyFingerprint,
} from "../schema/sealed.js";
import { listVaultEntities, resolveEntity } from "../schema/tables.js";
import { writeAuthorityReceipt } from "./evidence.js";
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
 * Assemble the artifact and receipt it. `_owner` is the authenticated caller;
 * it stopped being read when the export-job table left the ontology (#916,
 * ruling ONT-06) and the receipt below became the only record of the export.
 * The parameter stays because the export is an OWNER act and the callers pass
 * the identity they authenticated — dropping it from the signature would make
 * that seam invisible.
 */
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
    // Per-table isolation (#374 4.3): a poisoned row skips its table; others continue.
    try {
      const pk = primaryKeyColumn(db, ref.physical);
      tables[logical] = (
        db.vault
          .prepare(`SELECT * FROM "${ref.physical}" ORDER BY "${pk}"`)
          .all() as Record<string, unknown>[]
      ).map((row) => {
        // A pointer into the AUDIT band never crosses (#916): the band itself
        // does not travel, so the id would name an invocation the target has
        // never heard of. See `AUDIT_POINTER_COLUMNS`.
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
  // An export keeps its RECEIPT (#916, ruling ONT-06). The export-job table
  // was a second copy of what the receipt below already records — who asked,
  // when, over what, and the hash that proves it — so it left the ontology and
  // the id it was keyed by is minted here for the receipt alone.
  const exportId = uuidv7();
  const vaultId = (
    db.vault.prepare("SELECT vault_id FROM core_vault LIMIT 1").get() as
      | { vault_id: string }
      | undefined
  )?.vault_id;
  const receiptId = writeAuthorityReceipt(db, {
    authorityId: null,
    invocationId: null,
    action: "act access.export_vault",
    // The object of an export is the VAULT itself (#916, ruling ONT-06); the
    // export's own id is minted here and lives in the receipt detail.
    objectType: "core.vault",
    objectId: vaultId ?? exportId,
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

/**
 * `core_vault.settings_json`'s seal-key bag, mirroring schema/sealed.ts's
 * private `SETTINGS_KEY`. Named here because the import must be able to REMOVE
 * a stamp it is deliberately not honouring.
 */
const SEAL_KEY_SETTING = "seal_key";

/**
 * Columns a portable artifact carries but a portable IMPORT must not (#916).
 *
 * `core_entity_revision.invocation_id` is a real foreign key into the AUDIT
 * band — the band a portable export deliberately leaves behind, because it is
 * this vault's evidence and not the member's data. Loading the id anyway names
 * an invocation the target has never heard of. The snapshot is the fact worth
 * carrying; which command caused it is a local audit detail.
 */
const AUDIT_POINTER_COLUMNS: ReadonlySet<string> = new Set([
  "core.entity_revision.invocation_id",
]);

/**
 * Drop the SOURCE vault's seal-key stamp from a freshly loaded `core_vault`.
 *
 * The bug this closes (#630): the stamp is the fingerprint of a key that lives
 * on the exporting machine, so copying it made the target report a successful
 * import and then refuse to reopen with `SealKeyError('missing')`. The stamp
 * is re-applied below from the key this vault ACTUALLY seals with, or left
 * absent when nothing sealed came in.
 */
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
  /**
   * The SOURCE vault's data-encryption key, unwrapped from the export's
   * password-wrapped custody kit. REQUIRED whenever the artifact carries
   * sealed values — without it the ciphertext is unreadable forever, so the
   * import refuses up front instead of writing rows nobody can open.
   */
  sourceSealKey?: Buffer;
}

/**
 * Rebuild a fresh vault from an export, identities intact; FKs checked
 * wholesale after load (per-row ordering impossible in general).
 *
 * SEALED VALUES (#630, review-A 10.1 / review-B BUG-12). Three rules:
 *  1. Sealed cells arrive as ciphertext and are RE-SEALED under the target
 *     vault's own key — the source key is never installed, so the target's key
 *     file, its custody and its rotation history stay its own.
 *  2. Without the source key, an artifact carrying sealed values is REFUSED
 *     before the first row is written.
 *  3. The source's seal-key stamp is never copied; the stamp this vault ends
 *     up with names the key it actually sealed with.
 */
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
  // Everything about secrets is decided BEFORE the first write.
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
    // Canonical entities first: loads access_app_ext, planting ext-band tables.

    for (const logical of listVaultEntities()) imported += load(logical);
    recreateExtTables(db);
    for (const logical of listVaultEntities(db.vault)) {
      if (logical.startsWith("ext.")) imported += load(logical);
    }
    clearImportedSealKeyStamp(db.vault);
    if (sealedTotal > 0 && sourceSealKey) {
      // Re-seal, never install: the target keeps its own key.
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
      // This vault now HAS secrets, sealed with THIS key. Stamp says so.
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
