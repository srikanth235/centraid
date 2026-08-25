// Egress consent for enrichment (#807). Orthogonal to policy: selecting an
// engine cannot write a consent row. A decline is a record, not an absence.
// Storage, not the gate.

import type { DatabaseSync } from "node:sqlite";

import { nowIso, uuidv7 } from "../ids.js";

/** Fact about the ENGINE. Same axis as enrich-gate.ts. */
export const ENRICH_EGRESS_CLASSES = [
  "on-device",
  "gateway",
  "provider",
] as const;
export type EnrichEgressClass = (typeof ENRICH_EGRESS_CLASSES)[number];

export type EnrichConsentDecision = "granted" | "declined";

/** `scopeRef` is `''` when the answer covers the vault. */
export interface EnrichConsentRecord {
  capability: string;
  egress: EnrichEgressClass;
  scopeRef: string;
  decision: EnrichConsentDecision;
  decidedAt: string;
  receiptId: string | null;
}

export interface EnrichConsentKey {
  capability: string;
  egress: EnrichEgressClass;
  /** Omit (or `''`) for the vault-wide answer. */
  scopeRef?: string;
}

export interface EnrichConsentInput extends EnrichConsentKey {
  decision: EnrichConsentDecision;
  receiptId?: string;
  now?: string;
}

interface ConsentRow {
  capability: string;
  egress: string;
  scope_ref: string;
  decision: string;
  decided_at: string;
  receipt_id: string | null;
}

function toRecord(row: ConsentRow): EnrichConsentRecord {
  return {
    capability: row.capability,
    egress: row.egress as EnrichEgressClass,
    scopeRef: row.scope_ref,
    decision: row.decision as EnrichConsentDecision,
    decidedAt: row.decided_at,
    receiptId: row.receipt_id,
  };
}

/** Replace any previous answer for the same key. Caller owns the transaction. */
export function recordEnrichConsent(
  vault: DatabaseSync,
  input: EnrichConsentInput
): void {
  vault
    .prepare(
      `INSERT INTO enrich_consent
         (consent_id, capability, egress, scope_ref, decision, decided_at,
          receipt_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (capability, egress, scope_ref) DO UPDATE SET
         decision = excluded.decision,
         decided_at = excluded.decided_at,
         receipt_id = excluded.receipt_id`
    )
    .run(
      uuidv7(),
      input.capability,
      input.egress,
      input.scopeRef ?? "",
      input.decision,
      input.now ?? nowIso(),
      input.receiptId ?? null
    );
}

/**
 * Answer on record, or `null` when never asked at that scope. Not a cascade:
 * a vault-wide answer does not silently cover a narrower scope.
 */
export function readEnrichConsent(
  vault: DatabaseSync,
  key: EnrichConsentKey
): EnrichConsentRecord | null {
  const row = vault
    .prepare(
      `SELECT capability, egress, scope_ref, decision, decided_at, receipt_id
         FROM enrich_consent
        WHERE capability = ? AND egress = ? AND scope_ref = ?`
    )
    .get(key.capability, key.egress, key.scopeRef ?? "") as
    | ConsentRow
    | undefined;
  return row ? toRecord(row) : null;
}

export function listEnrichConsent(vault: DatabaseSync): EnrichConsentRecord[] {
  return (
    vault
      .prepare(
        `SELECT capability, egress, scope_ref, decision, decided_at, receipt_id
           FROM enrich_consent
          ORDER BY decided_at DESC, capability, egress, scope_ref`
      )
      .all() as unknown as ConsentRow[]
  ).map(toRecord);
}
