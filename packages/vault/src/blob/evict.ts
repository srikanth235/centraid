import type { DatabaseSync } from "node:sqlite";

import { BINARY_DERIVATIVE_SQL } from "./derivatives.js";

export function pinnedThumbShas(vault: DatabaseSync): Set<string> {
  const rows = vault
    .prepare(
      `SELECT sha256 FROM core_content_derivative
        WHERE variant IN (${BINARY_DERIVATIVE_SQL}) AND variant != 'preview' AND sha256 IS NOT NULL`
    )
    .all() as { sha256: string }[];
  return new Set(rows.map((r) => r.sha256));
}

export function previewShas(vault: DatabaseSync): Set<string> {
  const rows = vault
    .prepare(
      `SELECT sha256 FROM core_content_derivative WHERE variant = 'preview' AND sha256 IS NOT NULL`
    )
    .all() as { sha256: string }[];
  return new Set(rows.map((r) => r.sha256));
}

export function stagingShas(vault: DatabaseSync): Set<string> {
  const rows = vault
    .prepare(
      `SELECT sha256 FROM blob_staging
        WHERE variant IS NULL OR variant IN (${BINARY_DERIVATIVE_SQL})`
    )
    .all() as { sha256: string }[];
  return new Set(rows.map((r) => r.sha256));
}

export function pendingOutboxShas(vault: DatabaseSync): Set<string> {
  const rows = vault.prepare("SELECT sha256 FROM blob_outbox").all() as {
    sha256: string;
  }[];
  return new Set(rows.map((row) => row.sha256));
}
