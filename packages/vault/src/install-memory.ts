// Consent memory for the install-grant top-up (#308 A3/A4): tombstone rows
// survive revocation (only an explicit owner approval clears one), and a
// manifest widened beyond what was ever consented gets a blocking
// `access_scope_request`, not an auto-grant — the top-up cannot be steered
// by the actor it contains.

import type { VaultDb } from "./db.js";
import type { FilterClause } from "./gateway/types.js";
import { nowIso, uuidv7 } from "./ids.js";
import { scopeCovers } from "./scope-extent.js";

/** One scope extent as the consent-memory tables store it. */
export interface ScopeTriple {
  schema: string;
  table?: string | undefined;
  verbs: "read" | "read+act" | "act" | "reveal";
  rowFilter?: FilterClause[];
  fieldMask?: string[];
}

export interface GranteeKey {
  /** access_app.app_id (row uuid). */
  appId?: string;
  /** core_party.party_id. */
  granteePartyId?: string;
}

export interface ScopeRequestSummary {
  requestId: string;
  plane: "app" | "agent";
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
  `${s.schema}|${s.table ?? ""}|${s.verbs}|${JSON.stringify(s.rowFilter ?? null)}|${JSON.stringify(
    s.fieldMask ?? null
  )}`;

function granteeClause(grantee: GranteeKey): { where: string; param: string } {
  if (grantee.appId) return { where: "app_id = ?", param: grantee.appId };
  if (grantee.granteePartyId) {
    return { where: "grantee_party_id = ?", param: grantee.granteePartyId };
  }
  throw new Error("a scope tombstone needs an app or a grantee party");
}

/** Record the owner's revocation per scope triple. */
export function writeScopeTombstones(
  db: VaultDb,
  grantee: GranteeKey,
  scopes: readonly ScopeTriple[]
): number {
  const existing = new Set(listScopeTombstones(db, grantee).map(tripleKey));
  const insert = db.vault.prepare(
    `INSERT INTO access_scope_tombstone
       (tombstone_id, app_id, grantee_party_id, entity, verbs,
        row_filter_json, field_mask_json, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
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
      dottedEntity(scope),
      scope.verbs,
      scope.rowFilter ? JSON.stringify(scope.rowFilter) : null,
      scope.fieldMask ? JSON.stringify(scope.fieldMask) : null,
      now
    );
    written += 1;
  }
  return written;
}

interface TombstoneRow {
  tombstone_id: string;
  /** The dotted encoding `access_grant_scope.entity` carries (#916, R10). */
  entity: string;
  verbs: string;
  row_filter_json: string | null;
  field_mask_json: string | null;
}

/** `{schema, table}` → the one dotted name the access plane stores. */
function dottedEntity(scope: Pick<ScopeTriple, "schema" | "table">): string {
  return scope.table === undefined || scope.table === null
    ? scope.schema
    : `${scope.schema}.${scope.table}`;
}

const tombstoneExtent = (row: TombstoneRow): ScopeTriple => ({
  schema: row.entity.includes(".")
    ? row.entity.slice(0, row.entity.indexOf("."))
    : row.entity,
  ...(row.entity.includes(".")
    ? { table: row.entity.slice(row.entity.indexOf(".") + 1) }
    : {}),
  verbs: row.verbs as ScopeTriple["verbs"],
  ...(row.row_filter_json
    ? { rowFilter: JSON.parse(row.row_filter_json) as FilterClause[] }
    : {}),
  ...(row.field_mask_json
    ? { fieldMask: JSON.parse(row.field_mask_json) as string[] }
    : {}),
});

function tombstoneRows(db: VaultDb, grantee: GranteeKey): TombstoneRow[] {
  const { where, param } = granteeClause(grantee);
  return db.vault
    .prepare(
      `SELECT tombstone_id, entity, verbs, row_filter_json, field_mask_json
         FROM access_scope_tombstone WHERE ${where}`
    )
    .all(param) as unknown as TombstoneRow[];
}

export function listScopeTombstones(
  db: VaultDb,
  grantee: GranteeKey
): ScopeTriple[] {
  return tombstoneRows(db, grantee).map(tombstoneExtent);
}

/**
 * Approval clears only the tombstones it COVERS (#541 review): an anchored
 * approval must not erase a schema-wide refusal — the owner would be asked
 * again on the next mount. The surviving broad tombstone costs nothing; the
 * minted grant covers it.
 */
export function clearScopeTombstones(
  db: VaultDb,
  grantee: GranteeKey,
  scopes: readonly ScopeTriple[]
): void {
  const del = db.vault.prepare(
    "DELETE FROM access_scope_tombstone WHERE tombstone_id = ?"
  );
  for (const row of tombstoneRows(db, grantee)) {
    const tombstone = tombstoneExtent(row);
    if (scopes.some((approved) => scopeCovers(approved, tombstone)))
      del.run(row.tombstone_id);
  }
}

/** Uninstall wipes the memory: a reinstall is a fresh consent. */
export function clearAllScopeTombstones(
  db: VaultDb,
  grantee: GranteeKey
): void {
  const { where, param } = granteeClause(grantee);
  db.vault
    .prepare(`DELETE FROM access_scope_tombstone WHERE ${where}`)
    .run(param);
}

/** Has the owner EVER consented to this grantee (any grant)? */
export function hasGrantHistory(db: VaultDb, grantee: GranteeKey): boolean {
  const column = grantee.appId ? "app_id" : "grantee_party_id";
  const param = grantee.appId ?? grantee.granteePartyId;
  if (!param) throw new Error("grant history needs an app or a grantee party");
  const row = db.vault
    .prepare(`SELECT 1 AS x FROM access_grant WHERE ${column} = ? LIMIT 1`)
    .get(param);
  return row !== undefined;
}

/** Park a widened manifest as the app's ONE open request; a re-publish
 *  replaces it; deciding closes it. */
export function openScopeRequest(
  db: VaultDb,
  input: {
    plane: "app" | "agent";
    appId: string;
    purpose: string;
    scopes: ScopeTriple[];
  }
): string {
  const open = db.vault
    .prepare(
      `SELECT request_id, scopes_json FROM access_scope_request
        WHERE plane = ? AND app_id = ? AND decided_at IS NULL`
    )
    .get(input.plane, input.appId) as
    | { request_id: string; scopes_json: string }
    | undefined;
  const scopesJson = JSON.stringify(input.scopes);
  if (open) {
    if (open.scopes_json !== scopesJson) {
      db.vault
        .prepare(
          `UPDATE access_scope_request SET scopes_json = ?, purpose = ?, requested_at = ?
            WHERE request_id = ?`
        )
        .run(scopesJson, input.purpose, nowIso(), open.request_id);
    }
    return open.request_id;
  }
  const requestId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO access_scope_request
         (request_id, plane, app_id, purpose, scopes_json, requested_at, decided_at, decision)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`
    )
    .run(
      requestId,
      input.plane,
      input.appId,
      input.purpose,
      scopesJson,
      nowIso()
    );
  return requestId;
}

/** Drop the open request when the manifest no longer widens anything. */
export function closeObsoleteScopeRequest(
  db: VaultDb,
  plane: "app" | "agent",
  appId: string
): void {
  db.vault
    .prepare(
      `DELETE FROM access_scope_request WHERE plane = ? AND app_id = ? AND decided_at IS NULL`
    )
    .run(plane, appId);
}

export function listOpenScopeRequests(db: VaultDb): ScopeRequestSummary[] {
  const rows = db.vault
    .prepare(
      `SELECT request_id, plane, app_id, purpose, scopes_json, requested_at
         FROM access_scope_request WHERE decided_at IS NULL ORDER BY requested_at`
    )
    .all() as {
    request_id: string;
    plane: "app" | "agent";
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
      `UPDATE access_scope_request SET decided_at = ?, decision = ? WHERE request_id = ? AND decided_at IS NULL`
    )
    .run(nowIso(), decision, requestId);
}
