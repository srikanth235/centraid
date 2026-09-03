// S5 — Evidence: every read and every command leaves rows, allowed or
// denied. Receipts (Kantara-style, hash-chained), provenance (W3C PROV) per
// write, evidence + explanation per invocation. Unskippable because there is
// no other door. All writers here append to the audit band and never UPDATE.

import type { DatabaseSync } from "node:sqlite";

import { nowIso, sha256Hex, uuidv7 } from "../ids.js";
import type { Citation, Identity } from "./types.js";

export interface ReceiptInput {
  grantId: string | null;
  invocationId: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  /** The purpose that APPLIED — callers record the defaulted notation (#306). */
  purpose: string | null | undefined;
  decision: "allow" | "deny";
  detail?: Record<string, unknown>;
}

/**
 * The L4 attribution fragment for one invocation's receipt detail (#599
 * decisions 7–8; #726): the owner the write is attributable to, spread into
 * `detail` beside the app/agent that carried it — so an agent turn journals
 * as "agent, for <owner>".
 *
 * The owner arrives two ways and they agree: `InvokeRequest.actingOwnerId`
 * is the host-resolved device→owner binding, and `Identity.onBehalfOfOwner`
 * is the agent turn's authenticated on-behalf-of principal. Empty when neither
 * is known (a scheduler-fired automation), never guessed.
 */
export function actingOwnerDetail(
  identity: Pick<Identity, "onBehalfOfOwner">,
  request: { actingOwnerId?: string }
): Record<string, string> {
  const ownerId = request.actingOwnerId ?? identity.onBehalfOfOwner?.ownerId;
  return ownerId === undefined ? {} : { actingOwner: ownerId };
}

/**
 * Append an access.receipt, chaining its hash to the previous receipt.
 *
 * THE HASH COVERS THE WHOLE BODY (#916, review 5.3). It used to cover seven
 * columns — the chain proved the action and its object, and left
 * `detail_json`, `grant_id`, `invocation_id` and the purpose outside, so the
 * WHY of a decision could be rewritten without breaking the chain that exists
 * to prove it was not. Every column the row carries is hashed, in a fixed
 * order, so tampering with any of them is detectable.
 *
 * `seq` is the chain POSITION (#916, R13 / review 5.4). The head used to be
 * found with `ORDER BY receipt_id DESC`, correct only because ids happen to be
 * UUIDv7 and therefore happen to sort by time — an accident of the id scheme
 * holding up the integrity of the chain. It is monotonic per file, assigned
 * here, and the head is read by it.
 */
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

/**
 * Recompute a receipt's hash from the row as stored, for a verifier. The one
 * definition of what the chain covers lives above; this is its inverse, so the
 * two can never drift apart.
 */
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

/**
 * Append access.provenance for one written row, chained per entity. Ingest
 * passes agentKind 'import' (W3C PROV agent class) regardless of which
 * enrolled identity carried the batch in.
 */
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

/** Append an agent.invocation_check row (pre or post, S3/S4). */
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

/** Append agent.evidence rows for a command's citations. */
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

/** Append the one agent.explanation for an invocation. */
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
