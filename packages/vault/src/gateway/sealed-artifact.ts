/*
 * Sealed values as seen from OUTSIDE a vault (#630): an export artifact is
 * rows, not a database, so the seal audit that decides whether an import can
 * proceed has to read the artifact itself — before a single row is written.
 *
 * The registry is rebuilt from the artifact, never from the target: an
 * incoming bundle's ext-band apps declare their own sealed columns in the
 * `access.app_ext` rows it carries, and a fresh target knows nothing about
 * them yet.
 */

import {
  SEALED_COLUMNS,
  isSealedValue,
  sealedPayloadFieldsOf,
} from "../schema/sealed.js";
import type { VaultExport } from "./portability.js";

export interface SealedArtifactAudit {
  /** Sealed values sitting in a DECLARED sealed column. */
  cells: number;
  /** Sealed values inside a staged import row's declared payload field. */
  staged: number;
  /** `entity.column` of sealed values nothing in the registry accounts for. */
  unexpected: string[];
}

export function sealedArtifactTotal(audit: SealedArtifactAudit): number {
  return audit.cells + audit.staged;
}

/** Sealed columns per logical entity, canonical plus the artifact's ext band. */
function sealedColumnsFromArtifact(
  artifact: VaultExport
): Map<string, readonly string[]> {
  const map = new Map<string, readonly string[]>(
    Object.entries(SEALED_COLUMNS)
  );
  for (const row of artifact.tables["access.app_ext"] ?? []) {
    // Only the live band is exported and re-sealed; a draft ext row carrying a
    // sealed value would land in `unexpected`, which is the honest answer.
    if (row["band"] !== "live") continue;
    const appId = row["app_id"];
    const table = row["table_name"];
    const spec = row["spec_json"];
    if (typeof appId !== "string" || typeof table !== "string") continue;
    if (typeof spec !== "string") continue;
    try {
      const sealed = (JSON.parse(spec) as { sealed?: unknown }).sealed;
      if (!Array.isArray(sealed)) continue;
      const columns = sealed.filter((c): c is string => typeof c === "string");
      if (columns.length > 0) map.set(`ext.${appId}.${table}`, columns);
    } catch {
      // A malformed spec declares nothing; its cells surface as `unexpected`.
    }
  }
  return map;
}

/**
 * Every sealed value the artifact carries, classified. `unexpected` is the
 * load-bearing half: a sealed value the re-seal sweep would not reach must
 * refuse the import rather than ride in as permanent GCM garbage.
 */
export function auditArtifactSealedValues(
  artifact: VaultExport
): SealedArtifactAudit {
  const registry = sealedColumnsFromArtifact(artifact);
  const audit: SealedArtifactAudit = { cells: 0, staged: 0, unexpected: [] };
  for (const [entity, rows] of Object.entries(artifact.tables)) {
    const sealedColumns = registry.get(entity) ?? [];
    for (const row of rows) {
      for (const [column, value] of Object.entries(row)) {
        if (entity === "sync.import_row" && column === "payload_json") {
          auditStagedPayload(audit, row, value);
          continue;
        }
        if (!isSealedValue(value)) continue;
        if (sealedColumns.includes(column)) audit.cells += 1;
        else audit.unexpected.push(`${entity}.${column}`);
      }
    }
  }
  audit.unexpected = [...new Set(audit.unexpected)].sort();
  return audit;
}

function auditStagedPayload(
  audit: SealedArtifactAudit,
  row: Record<string, unknown>,
  value: unknown
): void {
  if (typeof value !== "string") return;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(value) as Record<string, unknown>;
  } catch {
    return;
  }
  if (typeof payload !== "object" || payload === null) return;
  const fields = sealedPayloadFieldsOf(String(row["entity_type"] ?? ""));
  for (const [field, item] of Object.entries(payload)) {
    if (!isSealedValue(item)) continue;
    if (fields.includes(field)) audit.staged += 1;
    else audit.unexpected.push(`sync.import_row.payload_json:${field}`);
  }
}
