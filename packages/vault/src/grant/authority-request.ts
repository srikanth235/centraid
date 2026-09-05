/*
 * A widened automation manifest PARKS (#308 A4, re-homed by #928): agents
 * author their own manifests, so "install was the answer" must not be
 * bypassable by the very actor the answer contains. One open request per
 * automation; a re-publish replaces its scope set; deciding it closes the row
 * and writes the owner's answer into `share_authority`.
 *
 * A parked ask is NOT an answer, which is why it is not a `share_authority`
 * row: that table records what the owner said, and this one records what has
 * not been put to them yet.
 */

import type { VaultDb } from "../db.js";
import { nowIso, uuidv7 } from "../ids.js";

/** One scope extent, as the manifest declares it. */
export interface ScopeTriple {
  schema: string;
  table?: string;
  verbs: "read" | "read+act" | "act" | "reveal";
}

export interface ScopeRequestSummary {
  requestId: string;
  /** The automation's own id (its enrolment key), not a row uuid. */
  principalId: string;
  scopes: ScopeTriple[];
  requestedAt: string;
}

export function openScopeRequest(
  db: VaultDb,
  input: { principalId: string; scopes: ScopeTriple[] }
): string {
  const open = db.vault
    .prepare(
      `SELECT request_id, scopes_json FROM share_authority_request
        WHERE principal_id = ? AND decided_at IS NULL`
    )
    .get(input.principalId) as
    | { request_id: string; scopes_json: string }
    | undefined;
  const scopesJson = JSON.stringify(input.scopes);
  if (open) {
    if (open.scopes_json !== scopesJson) {
      db.vault
        .prepare(
          `UPDATE share_authority_request SET scopes_json = ?, requested_at = ?
            WHERE request_id = ?`
        )
        .run(scopesJson, nowIso(), open.request_id);
    }
    return open.request_id;
  }
  const requestId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO share_authority_request
         (request_id, principal_id, scopes_json, requested_at, decided_at, decision)
       VALUES (?, ?, ?, ?, NULL, NULL)`
    )
    .run(requestId, input.principalId, scopesJson, nowIso());
  return requestId;
}

/** Drop the open request when the manifest no longer widens anything. */
export function closeObsoleteScopeRequest(
  db: VaultDb,
  principalId: string
): void {
  db.vault
    .prepare(
      `DELETE FROM share_authority_request WHERE principal_id = ? AND decided_at IS NULL`
    )
    .run(principalId);
}

export function listOpenScopeRequests(db: VaultDb): ScopeRequestSummary[] {
  const rows = db.vault
    .prepare(
      `SELECT request_id, principal_id, scopes_json, requested_at
         FROM share_authority_request WHERE decided_at IS NULL ORDER BY requested_at`
    )
    .all() as {
    request_id: string;
    principal_id: string;
    scopes_json: string;
    requested_at: string;
  }[];
  return rows.map((r) => ({
    requestId: r.request_id,
    principalId: r.principal_id,
    scopes: JSON.parse(r.scopes_json) as ScopeTriple[],
    requestedAt: r.requested_at,
  }));
}

export function getOpenScopeRequest(
  db: VaultDb,
  requestId: string
): ScopeRequestSummary | undefined {
  return listOpenScopeRequests(db).find((r) => r.requestId === requestId);
}

export function markScopeRequestDecided(
  db: VaultDb,
  requestId: string,
  decision: "approved" | "denied"
): void {
  db.vault
    .prepare(
      `UPDATE share_authority_request SET decided_at = ?, decision = ? WHERE request_id = ? AND decided_at IS NULL`
    )
    .run(nowIso(), decision, requestId);
}
