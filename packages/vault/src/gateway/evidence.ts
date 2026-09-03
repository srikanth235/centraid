import type { DatabaseSync } from "node:sqlite";

import { nowIso, sha256Hex, uuidv7 } from "../ids.js";
import type { Citation, Identity } from "./types.js";

export interface ReceiptInput {
  grantId: string | null;
  invocationId: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  purpose: string | null | undefined;
  decision: "allow" | "deny";
  detail?: Record<string, unknown>;
}

export function actingOwnerDetail(
  identity: Pick<Identity, "onBehalfOfOwner">,
  request: { actingOwnerId?: string }
): Record<string, string> {
  const ownerId = request.actingOwnerId ?? identity.onBehalfOfOwner?.ownerId;
  return ownerId === undefined ? {} : { actingOwner: ownerId };
}

export function writeReceipt(audit: DatabaseSync, input: ReceiptInput): string {
  const receiptId = uuidv7();
  const occurredAt = nowIso();
  const head = audit
    .prepare(
      "SELECT hash, seq FROM access_receipt ORDER BY seq DESC, receipt_id DESC LIMIT 1"
    )
    .get() as { hash: string; seq: number | null } | undefined;
  const seq = (head?.seq ?? 0) + 1;
  const detailJson = input.detail ? JSON.stringify(input.detail) : null;
  const hash = sha256Hex(
    JSON.stringify([
      head?.hash ?? "",
      receiptId,
      seq,
      input.grantId,
      input.invocationId,
      input.action,
      input.objectType,
      input.objectId,
      input.purpose ?? null,
      input.decision,
      occurredAt,
      detailJson,
    ])
  );
  audit
    .prepare(
      `INSERT INTO access_receipt
         (receipt_id, grant_id, invocation_id, action, object_type, object_id, purpose_concept_id, decision, occurred_at, hash, detail_json, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      receiptId,
      input.grantId,
      input.invocationId,
      input.action,
      input.objectType,
      input.objectId,
      input.purpose ?? null,
      input.decision,
      occurredAt,
      hash,
      detailJson,
      seq
    );
  return receiptId;
}

export function receiptHash(row: {
  prevHash: string | null;
  receiptId: string;
  seq: number | null;
  grantId: string | null;
  invocationId: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  purpose: string | null;
  decision: string;
  occurredAt: string;
  detailJson: string | null;
}): string {
  return sha256Hex(
    JSON.stringify([
      row.prevHash ?? "",
      row.receiptId,
      row.seq,
      row.grantId,
      row.invocationId,
      row.action,
      row.objectType,
      row.objectId,
      row.purpose,
      row.decision,
      row.occurredAt,
      row.detailJson,
    ])
  );
}

export function writeProvenance(
  audit: DatabaseSync,
  identity: Identity,
  entityType: string,
  entityId: string,
  activity: string,
  used?: Record<string, unknown>,
  agentKind?: "owner" | "app" | "ai_agent" | "import"
): string {
  const provId = uuidv7();
  const prev = audit
    .prepare(
      "SELECT prov_id FROM access_provenance WHERE entity_type = ? AND entity_id = ? ORDER BY prov_id DESC LIMIT 1"
    )
    .get(entityType, entityId) as { prov_id: string } | undefined;
  audit
    .prepare(
      `INSERT INTO access_provenance
         (prov_id, entity_type, entity_id, prov_activity, agent_kind, agent_id, used_json, occurred_at, prev_prov_id, signature)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    )
    .run(
      provId,
      entityType,
      entityId,
      activity,
      agentKind ?? identity.provAgentKind,
      identity.callerId,
      used ? JSON.stringify(used) : null,
      nowIso(),
      prev?.prov_id ?? null
    );
  return provId;
}

export function writeCheck(
  audit: DatabaseSync,
  invocationId: string,
  phase: "pre" | "post",
  predicate: string,
  passed: boolean,
  observed?: Record<string, unknown>
): void {
  audit
    .prepare(
      `INSERT INTO agent_invocation_check (check_id, invocation_id, phase, predicate, passed, observed_json, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      uuidv7(),
      invocationId,
      phase,
      predicate,
      passed ? 1 : 0,
      observed ? JSON.stringify(observed) : null,
      nowIso()
    );
}

export function writeEvidence(
  audit: DatabaseSync,
  invocationId: string,
  citations: Citation[]
): void {
  const stmt = audit.prepare(
    `INSERT INTO agent_evidence (evidence_id, invocation_id, claim, entity_type, entity_id, prov_id, weight)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`
  );
  for (const c of citations) {
    stmt.run(
      uuidv7(),
      invocationId,
      c.claim,
      c.entityType,
      c.entityId,
      c.weight ?? null
    );
  }
}

export function writeExplanation(
  audit: DatabaseSync,
  invocationId: string,
  summary: string
): void {
  audit
    .prepare(
      `INSERT INTO agent_explanation (explanation_id, invocation_id, audience, summary, generated_at)
       VALUES (?, ?, 'owner', ?, ?)`
    )
    .run(uuidv7(), invocationId, summary, nowIso());
}
