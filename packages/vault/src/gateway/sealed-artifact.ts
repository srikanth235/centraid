import {
  SEALED_COLUMNS,
  isSealedValue,
  sealedPayloadFieldsOf,
} from "../schema/sealed.js";
import type { VaultExport } from "./portability.js";

export interface SealedArtifactAudit {
  cells: number;
  staged: number;
  unexpected: string[];
}

export function sealedArtifactTotal(audit: SealedArtifactAudit): number {
  return audit.cells + audit.staged;
}

function sealedColumnsFromArtifact(
  artifact: VaultExport
): Map<string, readonly string[]> {
  const map = new Map<string, readonly string[]>(
    Object.entries(SEALED_COLUMNS)
  );
  for (const row of artifact.tables["access.app_ext"] ?? []) {
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
      // Intentionally empty.
    }
  }
  return map;
}

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
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return;
  const payload = parsed as Record<string, unknown>;
  const fields = sealedPayloadFieldsOf(String(row["entity_type"] ?? ""));
  for (const [field, item] of Object.entries(payload)) {
    if (!isSealedValue(item)) continue;
    if (fields.includes(field)) audit.staged += 1;
    else audit.unexpected.push(`sync.import_row.payload_json:${field}`);
  }
}
