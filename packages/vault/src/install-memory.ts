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
import { nowIso, uuidv7 } from './ids.js';

/** One scope triple as the memory tables store it. */
export interface ScopeTriple {
  schema: string;
  table?: string | undefined;
  verbs: 'read' | 'read+act' | 'act' | 'reveal';
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

const tripleKey = (s: { schema: string; table?: string | null; verbs: string }): string =>
  `${s.schema}|${s.table ?? ''}|${s.verbs}`;

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
  scopes: readonly { schema: string; table?: string | null; verbs: string }[],
): number {
  const existing = new Set(listScopeTombstones(db, grantee).map(tripleKey));
  const insert = db.vault.prepare(
    `INSERT INTO consent_scope_tombstone
       (tombstone_id, app_id, grantee_party_id, schema_name, table_name, verbs, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
      now,
    );
    written += 1;
  }
  return written;
}

export function listScopeTombstones(db: VaultDb, grantee: GranteeKey): ScopeTriple[] {
  const { where, param } = granteeClause(grantee);
  const rows = db.vault
    .prepare(
      `SELECT schema_name, table_name, verbs FROM consent_scope_tombstone WHERE ${where}`,
    )
    .all(param) as { schema_name: string; table_name: string | null; verbs: string }[];
  return rows.map((r) => ({
    schema: r.schema_name,
    ...(r.table_name !== null ? { table: r.table_name } : {}),
    verbs: r.verbs as ScopeTriple['verbs'],
  }));
}

/** An explicit owner approval of these triples clears their tombstones. */
export function clearScopeTombstones(
  db: VaultDb,
  grantee: GranteeKey,
  scopes: readonly { schema: string; table?: string | null; verbs: string }[],
): void {
  const { where, param } = granteeClause(grantee);
  const del = db.vault.prepare(
    `DELETE FROM consent_scope_tombstone
      WHERE ${where} AND schema_name = ? AND coalesce(table_name, '') = ? AND verbs = ?`,
  );
  for (const scope of scopes) del.run(param, scope.schema, scope.table ?? '', scope.verbs);
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
    .prepare(`DELETE FROM consent_scope_request WHERE plane = ? AND app_id = ? AND decided_at IS NULL`)
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
