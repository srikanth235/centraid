import type { DatabaseSync } from "node:sqlite";

import { nowIso, uuidv7 } from "../ids.js";

export const ENRICH_EGRESS_CLASSES = [
  "on-device",
  "gateway",
  "provider",
] as const;
export type EnrichEgressClass = (typeof ENRICH_EGRESS_CLASSES)[number];

export type EnrichConsentDecision = "granted" | "declined";

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
  scopeRef?: string;
}

export interface EnrichConsentInput extends EnrichConsentKey {
  decision: EnrichConsentDecision;
  receiptId?: string;
  now?: string;
}

const ENRICH_SUBJECT_TYPE = "enrich.scope";

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

const CONSENT_SELECT = `SELECT verb AS capability, principal_id AS egress,
    subject_id AS scope_ref, decision AS decision,
    granted_at AS decided_at, receipt_id AS receipt_id
  FROM share_authority
  WHERE principal_kind = 'harness' AND subject_type = '${ENRICH_SUBJECT_TYPE}'
    AND revoked_at IS NULL
    -- An answer past its own end date is no longer an answer (#916, review
    -- 6.1): \`expires_at\` used to be written and never read.
    AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export function recordEnrichConsent(
  vault: DatabaseSync,
  input: EnrichConsentInput
): void {
  const scopeRef = input.scopeRef ?? "";
  const now = input.now ?? nowIso();
  const receiptId = input.receiptId ?? null;
  const standing = readEnrichConsent(vault, input);
  if (standing?.decision === input.decision) {
    vault
      .prepare(
        `UPDATE share_authority SET receipt_id = ?
          WHERE principal_kind = 'harness' AND principal_id = ?
            AND subject_type = ? AND subject_id = ? AND verb = ?
            AND revoked_at IS NULL`
      )
      .run(
        receiptId,
        input.egress,
        ENRICH_SUBJECT_TYPE,
        scopeRef,
        input.capability
      );
    return;
  }
  vault
    .prepare(
      `UPDATE share_authority SET revoked_at = ?
        WHERE principal_kind = 'harness' AND principal_id = ?
          AND subject_type = ? AND subject_id = ? AND verb = ?
          AND revoked_at IS NULL`
    )
    .run(now, input.egress, ENRICH_SUBJECT_TYPE, scopeRef, input.capability);
  vault
    .prepare(
      `INSERT INTO share_authority
         (authority_id, principal_kind, principal_id, subject_type, subject_id,
          verb, duration, expires_at, decision, granted_at, granted_by,
          revoked_at, receipt_id)
       VALUES (?, 'harness', ?, ?, ?, ?, 'standing', NULL, ?, ?, NULL, NULL, ?)`
    )
    .run(
      uuidv7(),
      input.egress,
      ENRICH_SUBJECT_TYPE,
      scopeRef,
      input.capability,
      input.decision,
      now,
      receiptId
    );
}

export function readEnrichConsent(
  vault: DatabaseSync,
  key: EnrichConsentKey
): EnrichConsentRecord | null {
  const row = vault
    .prepare(
      `${CONSENT_SELECT} AND verb = ? AND principal_id = ? AND subject_id = ?`
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
        `${CONSENT_SELECT}
          ORDER BY granted_at DESC, verb, principal_id, subject_id`
      )
      .all() as unknown as ConsentRow[]
  ).map(toRecord);
}

export function readEnrichConsentId(
  vault: DatabaseSync,
  key: EnrichConsentKey
): string | undefined {
  const row = vault
    .prepare(
      `SELECT authority_id FROM share_authority
        WHERE principal_kind = 'harness' AND principal_id = ?
          AND subject_type = ? AND subject_id = ? AND verb = ?
          AND revoked_at IS NULL`
    )
    .get(
      key.egress,
      ENRICH_SUBJECT_TYPE,
      key.scopeRef ?? "",
      key.capability
    ) as { authority_id: string } | undefined;
  return row?.authority_id;
}
