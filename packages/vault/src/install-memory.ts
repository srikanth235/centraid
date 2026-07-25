// Consent memory for the install-grant top-up (issue #308 A3/A4).
//
// Two facts the #306 top-up forgot, made durable:
//   - the owner's "no": `consent_scope_tombstone` rows survive revocation,
//     so a mount/sync/publish can never silently re-mint a scope the owner
//     took away (A4). Only an explicit owner approval clears one.
//   - the last consent's extent: an app whose manifest widens beyond what
//     was ever consented gets a `consent_scope_request` blocking item, not
//     an auto-grant (A3) — agents author their own manifests, so the
//     top-up must not be steerable by the actor it contains.

import type { VaultDb } from './db.js';
import type { FilterClause } from './gateway/types.js';
import { nowIso, uuidv7 } from './ids.js';
import { scopeCovers } from './scope-extent.js';

/** One scope extent as the consent-memory tables store it. */
export interface ScopeTriple {
  schema: string;
  table?: string | undefined;
  verbs: 'read' | 'read+act' | 'act' | 'reveal';
  rowFilter?: FilterClause[];
  fieldMask?: string[];
}

/** The grantee key mirrors consent_access_grant's two planes. */
export interface GranteeKey {
  /** consent_app.app_id (row uuid) — the app plane. */
  appId?: string;
  /** core_party.party_id — the agent plane. */
  granteePartyId?: string;
}

export interface ScopeRequestSummary {
  requestId: string;
  plane: 'app' | 'agent';
  /** The Centraid app id (enrollment name), not the row uuid. */
  appId: string;
  purpose: string;
  scopes: ScopeTriple[];
  requestedAt: string;
}

const tripleKey = (s: {
  schema: string;
  table?: string | null;
  verbs: string;
  rowFilter?: readonly FilterClause[] | null;
  fieldMask?: readonly string[] | null;
}): string =>
  `${s.schema}|${s.table ?? ''}|${s.verbs}|${JSON.stringify(s.rowFilter ?? null)}|${JSON.stringify(
    s.fieldMask ?? null,
  )}`;

function granteeClause(grantee: GranteeKey): { where: string; param: string } {
  if (grantee.appId) return { where: 'app_id = ?', param: grantee.appId };
  if (grantee.granteePartyId) {
    return { where: 'grantee_party_id = ?', param: grantee.granteePartyId };
  }
  throw new Error('a scope tombstone needs an app or a grantee party');
}

/** Record the owner's revocation per scope triple, deduped. */
export function writeScopeTombstones(
  db: VaultDb,
  grantee: GranteeKey,
  scopes: readonly ScopeTriple[],
): number {
  const existing = new Set(listScopeTombstones(db, grantee).map(tripleKey));
  const insert = db.vault.prepare(
    `INSERT INTO consent_scope_tombstone
       (tombstone_id, app_id, grantee_party_id, schema_name, table_name, verbs,
        row_filter_json, field_mask_json, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = nowIso();
  let written = 0;
  for (const scope of scopes) {
    if (existing.has(tripleKey(scope))) continue;
    existing.add(tripleKey(scope));
    insert.run(
      uuidv7(),
      grantee.appId ?? null,
      grantee.granteePartyId ?? null,
      scope.schema,
      scope.table ?? null,
      scope.verbs,
      scope.rowFilter ? JSON.stringify(scope.rowFilter) : null,
      scope.fieldMask ? JSON.stringify(scope.fieldMask) : null,
      now,
    );
    written += 1;
  }
  return written;
}

interface TombstoneRow {
  tombstone_id: string;
  schema_name: string;
  table_name: string | null;
  verbs: string;
  row_filter_json: string | null;
  field_mask_json: string | null;
}

const tombstoneExtent = (row: TombstoneRow): ScopeTriple => ({
  schema: row.schema_name,
  ...(row.table_name !== null ? { table: row.table_name } : {}),
  verbs: row.verbs as ScopeTriple['verbs'],
  ...(row.row_filter_json ? { rowFilter: JSON.parse(row.row_filter_json) as FilterClause[] } : {}),
  ...(row.field_mask_json ? { fieldMask: JSON.parse(row.field_mask_json) as string[] } : {}),
});

function tombstoneRows(db: VaultDb, grantee: GranteeKey): TombstoneRow[] {
  const { where, param } = granteeClause(grantee);
  return db.vault
    .prepare(
      `SELECT tombstone_id, schema_name, table_name, verbs, row_filter_json, field_mask_json
         FROM consent_scope_tombstone WHERE ${where}`,
    )
    .all(param) as unknown as TombstoneRow[];
}

export function listScopeTombstones(db: VaultDb, grantee: GranteeKey): ScopeTriple[] {
  return tombstoneRows(db, grantee).map(tombstoneExtent);
}

/**
 * An explicit owner approval clears the tombstones that approval COVERS —
 * and only those. The direction matters: approving schema-wide `core` read
 * withdraws every narrower `core.*` read "no", but approving one anchored
 * `core.core_task` read must NOT erase a schema-wide `core` read refusal
 * (issue #541 review). Erasing it would put the owner back in front of an ask
 * they already refused on the next mount — exactly the nagging A4 exists to
 * end.
 *
 * The surviving broad tombstone costs the approved scope nothing: the grant
 * this approval mints covers it, so `missingScopes` never asks for it again.
 * That is why a covered sub-extent is not carved out of the tombstone — the
 * row shape has no "everything except" and it would buy nothing.
 */
export function clearScopeTombstones(
  db: VaultDb,
  grantee: GranteeKey,
  scopes: readonly ScopeTriple[],
): void {
  const del = db.vault.prepare('DELETE FROM consent_scope_tombstone WHERE tombstone_id = ?');
  for (const row of tombstoneRows(db, grantee)) {
    const tombstone = tombstoneExtent(row);
    if (scopes.some((approved) => scopeCovers(approved, tombstone))) del.run(row.tombstone_id);
  }
}

/** Uninstall wipes the memory: a reinstall is a fresh consent. */
export function clearAllScopeTombstones(db: VaultDb, grantee: GranteeKey): void {
  const { where, param } = granteeClause(grantee);
  db.vault.prepare(`DELETE FROM consent_scope_tombstone WHERE ${where}`).run(param);
}

/** Has the owner EVER consented to this grantee (any grant, any status)? */
export function hasGrantHistory(db: VaultDb, grantee: GranteeKey): boolean {
  const column = grantee.appId ? 'app_id' : 'grantee_party_id';
  const param = grantee.appId ?? grantee.granteePartyId;
  if (!param) throw new Error('grant history needs an app or a grantee party');
  const row = db.vault
    .prepare(`SELECT 1 AS x FROM consent_access_grant WHERE ${column} = ? LIMIT 1`)
    .get(param);
  return row !== undefined;
}

/**
 * Park a widened manifest as the app's ONE open request. A re-publish
 * replaces the open request's scope set (the manifest is the source of
 * truth for what is being asked); deciding closes it.
 */
export function openScopeRequest(
  db: VaultDb,
  input: { plane: 'app' | 'agent'; appId: string; purpose: string; scopes: ScopeTriple[] },
): string {
  const open = db.vault
    .prepare(
      `SELECT request_id, scopes_json FROM consent_scope_request
        WHERE plane = ? AND app_id = ? AND decided_at IS NULL`,
    )
    .get(input.plane, input.appId) as { request_id: string; scopes_json: string } | undefined;
  const scopesJson = JSON.stringify(input.scopes);
  if (open) {
    if (open.scopes_json !== scopesJson) {
      db.vault
        .prepare(
          `UPDATE consent_scope_request SET scopes_json = ?, purpose = ?, requested_at = ?
            WHERE request_id = ?`,
        )
        .run(scopesJson, input.purpose, nowIso(), open.request_id);
    }
    return open.request_id;
  }
  const requestId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO consent_scope_request
         (request_id, plane, app_id, purpose, scopes_json, requested_at, decided_at, decision)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .run(requestId, input.plane, input.appId, input.purpose, scopesJson, nowIso());
  return requestId;
}

/** Drop the open request when the manifest no longer widens anything. */
export function closeObsoleteScopeRequest(
  db: VaultDb,
  plane: 'app' | 'agent',
  appId: string,
): void {
  db.vault
    .prepare(
      `DELETE FROM consent_scope_request WHERE plane = ? AND app_id = ? AND decided_at IS NULL`,
    )
    .run(plane, appId);
}

export function listOpenScopeRequests(db: VaultDb): ScopeRequestSummary[] {
  const rows = db.vault
    .prepare(
      `SELECT request_id, plane, app_id, purpose, scopes_json, requested_at
         FROM consent_scope_request WHERE decided_at IS NULL ORDER BY requested_at`,
    )
    .all() as {
    request_id: string;
    plane: 'app' | 'agent';
    app_id: string;
    purpose: string;
    scopes_json: string;
    requested_at: string;
  }[];
  return rows.map((r) => ({
    requestId: r.request_id,
    plane: r.plane,
    appId: r.app_id,
    purpose: r.purpose,
    scopes: JSON.parse(r.scopes_json) as ScopeTriple[],
    requestedAt: r.requested_at,
  }));
}

export function getOpenScopeRequest(
  db: VaultDb,
  requestId: string,
): ScopeRequestSummary | undefined {
  return listOpenScopeRequests(db).find((r) => r.requestId === requestId);
}

export function markScopeRequestDecided(
  db: VaultDb,
  requestId: string,
  decision: 'approved' | 'denied',
): void {
  db.vault
    .prepare(
      `UPDATE consent_scope_request SET decided_at = ?, decision = ? WHERE request_id = ? AND decided_at IS NULL`,
    )
    .run(nowIso(), decision, requestId);
}
