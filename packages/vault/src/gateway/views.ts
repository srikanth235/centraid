// View service (§10 standing duty): the paved road for generated apps. A
// consent.app_view is a declarative, registered derivative view — the gateway
// compiles it, proves every join follows a declared FK, clamps results to the
// owning app's grant scopes (per joined entity — the view cannot over-read
// even if the generated code is wrong), and receipts every execution. Live
// views only in v0: materialization refresh (rows marked wasDerivedFrom)
// remains a seam; registration therefore always stores materialized=0.

import type { DatabaseSync } from 'node:sqlite';
import type { VaultDb } from '../db.js';
import { nowIso, uuidv7 } from '../ids.js';
import { resolveEntity, type EntityRef } from '../schema/tables.js';
import { evaluateConsent } from './consent.js';
import { writeReceipt } from './evidence.js';
import { compileFilters, tableColumns } from './filters.js';
import type { FilterClause, Identity } from './types.js';
import { GatewayError } from './types.js';

export interface ViewJoin {
  /** Joined logical entity, e.g. `core.place`. */
  entity: string;
  /** FK column on the base table that must be declared to reference it. */
  fk_column: string;
  /** Columns surfaced from the joined table (aliased `<table>_<col>`). */
  columns: string[];
}

export interface ViewDefinition {
  columns: string[];
  where?: FilterClause[];
  joins?: ViewJoin[];
}

interface FkEdge {
  table: string;
  from: string;
  to: string;
}

function declaredFks(vault: DatabaseSync, physical: string): FkEdge[] {
  return vault
    .prepare(`PRAGMA foreign_key_list(${JSON.stringify(physical)})`)
    .all() as unknown as FkEdge[];
}

function requireColumns(
  vault: DatabaseSync,
  ref: EntityRef,
  columns: string[],
  where: string,
): void {
  const cols = tableColumns(vault, ref.physical);
  for (const column of columns) {
    if (!cols.has(column)) {
      throw new GatewayError(
        'contract',
        `${where}: column "${column}" does not exist on ${ref.schema}.${ref.table}`,
      );
    }
  }
}

/**
 * Compile-time validation + registration of a consent.app_view. Throws on
 * anything the definition gets wrong — a view that cannot be proven safe is
 * never stored.
 */
export function registerAppView(
  db: VaultDb,
  options: { appId: string; name: string; baseEntity: string; definition: ViewDefinition },
): string {
  const base = resolveEntity(options.baseEntity);
  if (!base || base.file !== 'vault') {
    throw new GatewayError('contract', `unknown base entity ${options.baseEntity}`);
  }
  requireColumns(db.vault, base, options.definition.columns, 'view columns');
  for (const clause of options.definition.where ?? []) {
    requireColumns(db.vault, base, [clause.column], 'view filter');
  }
  const fks = declaredFks(db.vault, base.physical);
  for (const join of options.definition.joins ?? []) {
    const joined = resolveEntity(join.entity);
    if (!joined || joined.file !== 'vault') {
      throw new GatewayError('contract', `unknown joined entity ${join.entity}`);
    }
    // §10: prove every join follows a declared FK — no free-form joins.
    const edge = fks.find((f) => f.from === join.fk_column && f.table === joined.physical);
    if (!edge) {
      throw new GatewayError(
        'contract',
        `join to ${join.entity} via "${join.fk_column}" is not a declared FK of ${options.baseEntity}`,
      );
    }
    requireColumns(db.vault, joined, join.columns, `join ${join.entity} columns`);
  }
  const viewId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO consent_app_view (view_id, app_id, name, base_entity, definition_json, materialized, refreshed_at, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, 0, NULL, ?, NULL)`,
    )
    .run(
      viewId,
      options.appId,
      options.name,
      options.baseEntity,
      JSON.stringify(options.definition),
      nowIso(),
    );
  return viewId;
}

export interface ViewResult {
  rows: Record<string, unknown>[];
  receiptId: string;
}

/**
 * Execute a registered view under the app's grant. Every entity the view
 * touches — base and each join — needs read consent; field masks intersect
 * with the view's declared columns; scope row filters AND with the view's own.
 */
export function queryAppView(
  db: VaultDb,
  identity: Identity,
  appId: string,
  viewName: string,
  purpose: string,
): ViewResult {
  const view = db.vault
    .prepare(
      `SELECT view_id, base_entity, definition_json FROM consent_app_view
        WHERE app_id = ? AND name = ? AND revoked_at IS NULL`,
    )
    .get(appId, viewName) as
    | { view_id: string; base_entity: string; definition_json: string }
    | undefined;
  const deny = (failing: string, grantId: string | null = null): never => {
    const receiptId = writeReceipt(db.journal, {
      grantId,
      invocationId: null,
      action: `read view:${viewName}`,
      objectType: 'consent.app_view',
      objectId: view?.view_id ?? null,
      purpose,
      decision: 'deny',
      detail: { failing },
    });
    throw new GatewayError('consent', `deny (receipt ${receiptId}): ${failing}`);
  };
  if (!view) return deny(`no registered view "${viewName}" for this app`);
  const base = resolveEntity(view.base_entity);
  if (!base) return deny(`view base entity ${view.base_entity} no longer resolves`);
  const definition = JSON.parse(view.definition_json) as ViewDefinition;

  const baseConsent = evaluateConsent(db.vault, identity, base.schema, base.table, 'read', purpose);
  if (baseConsent.decision === 'deny') return deny(baseConsent.failing, baseConsent.grantId);

  // Clamp base columns: view columns ∩ grant field mask.
  const mask = baseConsent.fieldMask;
  const baseColumns = definition.columns.filter((c) => mask === null || mask.includes(c));
  if (baseColumns.length === 0)
    return deny('field mask excludes every view column', baseConsent.grantId);
  const selects = baseColumns.map((c) => `b."${c}" AS "${c}"`);
  const joins: string[] = [];
  for (const [i, join] of (definition.joins ?? []).entries()) {
    const joined = resolveEntity(join.entity);
    if (!joined)
      return deny(`joined entity ${join.entity} no longer resolves`, baseConsent.grantId);
    const joinConsent = evaluateConsent(
      db.vault,
      identity,
      joined.schema,
      joined.table,
      'read',
      purpose,
    );
    if (joinConsent.decision === 'deny') {
      return deny(`join ${join.entity}: ${joinConsent.failing}`, baseConsent.grantId);
    }
    const joinMask = joinConsent.fieldMask;
    const joinColumns = join.columns.filter((c) => joinMask === null || joinMask.includes(c));
    const edge = declaredFks(db.vault, base.physical).find(
      (f) => f.from === join.fk_column && f.table === joined.physical,
    );
    if (!edge)
      return deny(`join ${join.entity} no longer follows a declared FK`, baseConsent.grantId);
    const alias = `j${i}`;
    joins.push(
      `LEFT JOIN "${joined.physical}" ${alias} ON ${alias}."${edge.to}" = b."${join.fk_column}"`,
    );
    for (const c of joinColumns) selects.push(`${alias}."${c}" AS "${joined.table}_${c}"`);
  }
  const now = nowIso();
  const scopeFilter = compileFilters(db.vault, base.physical, baseConsent.rowFilter, now, 'b');
  const viewFilter = compileFilters(db.vault, base.physical, definition.where ?? [], now, 'b');
  const rows = db.vault
    .prepare(
      `SELECT ${selects.join(', ')} FROM "${base.physical}" b ${joins.join(' ')}
        WHERE ${scopeFilter.where} AND ${viewFilter.where} LIMIT 1000`,
    )
    .all(...scopeFilter.params, ...viewFilter.params) as Record<string, unknown>[];
  const receiptId = writeReceipt(db.journal, {
    grantId: baseConsent.grantId,
    invocationId: null,
    action: `read view:${viewName}`,
    objectType: 'consent.app_view',
    objectId: view.view_id,
    purpose,
    decision: 'allow',
    detail: { rowCount: rows.length, baseEntity: view.base_entity },
  });
  return { rows, receiptId };
}
