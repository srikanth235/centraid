// Egress consent for enrichment (#807) — reads and writes of
// `enrich_consent`, keyed capability × egress class × scope.
//
// ORTHOGONAL TO POLICY, BY CONSTRUCTION. The cascade (enrich/policy-rules.ts)
// says which engine a scope prefers; this says whether the member ever agreed
// to that engine's EGRESS CLASS. Keeping them in two stores with two keys is
// what makes "use provider X for this one document" incapable of widening
// egress on its own: selecting an engine cannot write a consent row, and the
// gate must find one independently.
//
// A DECLINE IS A RECORD, not an absence. `readEnrichConsent` returns the row
// either way and `null` only when nothing was ever asked — the caller can then
// tell "told no" from "not asked", which is the whole difference between
// respecting an answer and re-asking a question the member already answered.
// Neither is permission: an absent row is not a grant, and callers treat
// anything other than a `granted` decision as a refusal.
//
// LIKE THE TIER READ (enrich/policy.ts) this is storage, not the gate.

import type { DatabaseSync } from "node:sqlite";

import { nowIso, uuidv7 } from "../ids.js";

/**
 * How far an engine's work travels — a fact about the ENGINE, never about who
 * asked. `on-device` never leaves the member's own devices; `gateway` runs on
 * their own infrastructure and reaches no third party; `provider` talks to
 * one. Same axis as `packages/server/src/automation/fire/enrich-gate.ts`.
 */
export const ENRICH_EGRESS_CLASSES = [
  "on-device",
  "gateway",
  "provider",
] as const;
export type EnrichEgressClass = (typeof ENRICH_EGRESS_CLASSES)[number];

export type EnrichConsentDecision = "granted" | "declined";

/** One answered question. `scopeRef` is `''` when the answer covers the vault. */
export interface EnrichConsentRecord {
  capability: string;
  egress: EnrichEgressClass;
  scopeRef: string;
  decision: EnrichConsentDecision;
  decidedAt: string;
  /** The `consent_receipt` row (journal.db) this answer was receipted by. */
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

/**
 * Record the member's answer, replacing any previous answer for the same
 * (capability, egress class, scope) — a mind changed is a new decision, and
 * the durable history of both lives in the journal's receipt chain, never in a
 * second row here.
 *
 * The caller owns the transaction.
 */
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
 * The answer on record for one key, or `null` when the question was never
 * asked at that scope. Deliberately NOT a cascade: a vault-wide answer does
 * not silently cover a narrower scope here, because widening consent by
 * inheritance is exactly the move this key shape exists to prevent. A caller
 * that wants the vault-wide answer asks for it.
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

/** Every answer on record, newest decision first — the Privacy audit read. */
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
