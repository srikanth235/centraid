// governance: allow-repo-hygiene file-size-limit the ext band is one lifecycle (apply/diff, draft seed/drop, retain/purge, the write trio) sharing the registry-row and fk-resolver internals — splitting would export private seams
// The ext band's imperative half (issue #286 phase 2): DDL apply + diff,
// the draft band lifecycle (seed / drop / publish), uninstall semantics
// (retain by default, purge on demand), and the per-app typed write commands
// (`ext.<appId>.insert|update|delete`) that keep "typed commands are the
// only write path" (R04) true for extension tables too.
//
// DDL is a gateway duty: specs come from the app's manifest, the gateway
// generates and applies the SQL. Diffing is deliberately narrow for v0
// (pre-release, no compat): add/drop whole tables, add/drop columns, change
// indexes and searchable columns. Anything else — type changes, primary-key
// moves, notNull tightening — is refused with an actionable message; declare
// a new table instead.

import type { DatabaseSync } from 'node:sqlite';
import type { VaultDb } from '../db.js';
import { nowIso } from '../ids.js';
import { refreshReplicaTriggers } from '../replica/change-log.js';
import {
  canonicalSpecJson,
  dropExtFtsDdl,
  ExtSpecError,
  extFtsDdl,
  extIndexName,
  extLogical,
  extPhysical,
  extPk,
  extTableDdl,
  JS_SAFE_INTEGER_BOUND,
  parseExtLogical,
  validateExtSpecs,
  type ExtBand,
  type ExtTableSpec,
} from '../schema/ext.js';
import { resolveEntity } from '../schema/tables.js';
import { isSealedValue, sealAad, sealValue, stampSealKeyFingerprint } from '../schema/sealed.js';
import { clearColumnCache } from './filters.js';
import type { SearchableEntity } from '../schema/fts.js';
import type { CommandDefinition, HandlerCtx } from './types.js';

export interface ExtApplyOutcome {
  created: string[];
  dropped: string[];
  altered: string[];
}

interface RegistryRow {
  app_id: string;
  band: ExtBand;
  table_name: string;
  physical: string;
  spec_json: string;
  status: 'active' | 'retained';
}

function registryRows(vault: DatabaseSync, appId: string, band: ExtBand): RegistryRow[] {
  return vault
    .prepare(
      `SELECT app_id, band, table_name, physical, spec_json, status
         FROM consent_app_ext WHERE app_id = ? AND band = ? ORDER BY table_name`,
    )
    .all(appId, band) as unknown as RegistryRow[];
}

function actualColumns(vault: DatabaseSync, physical: string): Set<string> {
  const rows = vault.prepare(`PRAGMA table_info(${JSON.stringify(physical)})`).all() as {
    name: string;
  }[];
  return new Set(rows.map((r) => r.name));
}

function pkColumn(vault: DatabaseSync, physical: string): string {
  const rows = vault.prepare(`PRAGMA table_info(${JSON.stringify(physical)})`).all() as {
    name: string;
    pk: number;
  }[];
  return rows.find((r) => r.pk === 1)?.name ?? 'rowid';
}

/**
 * Whether a `references` target is acceptable: canonical tables outside the
 * consent/agent planes (an app never holds an FK into the privacy plumbing),
 * or the same app's own ext tables (validated by the caller against the
 * declared batch).
 */
function referencable(logical: string): boolean {
  const ref = resolveEntity(logical);
  return (
    ref !== undefined && ref.file === 'vault' && ref.schema !== 'consent' && ref.schema !== 'agent'
  );
}

/** Band-aware FK target resolver for DDL generation. */
function fkResolver(
  db: VaultDb,
  appId: string,
  band: ExtBand,
  batch: Map<string, ExtTableSpec>,
): (logical: string) => { physical: string; pk: string } {
  return (logical) => {
    const ext = parseExtLogical(logical);
    if (ext) {
      const inBatch = batch.get(ext.table);
      if (inBatch) return { physical: extPhysical(appId, ext.table, band), pk: extPk(inBatch) };
      const existing = resolveEntity(extLogical(appId, ext.table, band), db.vault);
      if (existing)
        return { physical: existing.physical, pk: pkColumn(db.vault, existing.physical) };
      throw new ExtSpecError(`references unknown ext table "${logical}"`);
    }
    const ref = resolveEntity(logical);
    if (!ref || !referencable(logical)) {
      throw new ExtSpecError(`references unknown entity "${logical}"`);
    }
    return { physical: ref.physical, pk: pkColumn(db.vault, ref.physical) };
  };
}

/**
 * Rows of a dropped table are gone, so classification and curation on them
 * go too, and live links end-date — the same hygiene duties.ts applies to
 * purged content (issue #272/#274 rules, ext-shaped).
 */
function sweepDroppedType(db: VaultDb, logical: string, now: string): void {
  db.vault
    .prepare(
      `UPDATE core_link SET valid_to = ? WHERE valid_to IS NULL AND (from_type = ? OR to_type = ?)`,
    )
    .run(now, logical, logical);
  db.vault.prepare('DELETE FROM core_tag WHERE target_type = ?').run(logical);
  db.vault.prepare('DELETE FROM core_collection_entry WHERE target_type = ?').run(logical);
  db.vault.prepare('DELETE FROM knowledge_annotation WHERE target_type = ?').run(logical);
}

function dropExtTable(db: VaultDb, row: RegistryRow, now: string): void {
  if (row.band === 'live') db.vault.exec(dropExtFtsDdl(row.physical));
  db.vault.exec(`DROP TABLE IF EXISTS "${row.physical}"`);
  db.vault
    .prepare('DELETE FROM consent_app_ext WHERE app_id = ? AND band = ? AND table_name = ?')
    .run(row.app_id, row.band, row.table_name);
  sweepDroppedType(db, extLogical(row.app_id, row.table_name, row.band), now);
  clearColumnCache(row.physical);
}

function validateBatch(db: VaultDb, appId: string, specs: ExtTableSpec[]): void {
  validateExtSpecs(appId, specs, (logical) => {
    const ext = parseExtLogical(logical);
    if (ext) return resolveEntity(extLogical(appId, ext.table, 'live'), db.vault) !== undefined;
    return referencable(logical);
  });
}

/**
 * Diff-apply one band to the declared specs, inside one transaction:
 * new tables created (with indexes and, on the live band, FTS artifacts),
 * absent tables dropped (with reference hygiene), changed tables altered
 * additively (ADD/DROP COLUMN, index and searchable rebuild) — anything
 * beyond that refuses. Registry rows always end `active`: re-applying a
 * retained band is exactly how a reinstall revives its data.
 */
export function applyExtBand(
  db: VaultDb,
  appId: string,
  specs: ExtTableSpec[],
  band: ExtBand,
): ExtApplyOutcome {
  validateBatch(db, appId, specs);
  const batch = new Map(specs.map((s) => [s.name, s]));
  const fk = fkResolver(db, appId, band, batch);
  const now = nowIso();
  const outcome: ExtApplyOutcome = { created: [], dropped: [], altered: [] };
  db.vault.exec('BEGIN');
  try {
    const existing = new Map(registryRows(db.vault, appId, band).map((r) => [r.table_name, r]));
    for (const row of existing.values()) {
      if (!batch.has(row.table_name)) {
        dropExtTable(db, row, now);
        outcome.dropped.push(row.table_name);
      }
    }
    for (const spec of specs) {
      const physical = extPhysical(appId, spec.name, band);
      const prior = existing.get(spec.name);
      if (!prior) {
        db.vault.exec(extTableDdl(physical, spec, fk));
        if (band === 'live' && (spec.searchable?.length ?? 0) > 0) {
          db.vault.exec(extFtsDdl(physical, extPk(spec), spec.searchable ?? []));
        }
        db.vault
          .prepare(
            `INSERT INTO consent_app_ext (app_id, band, table_name, physical, spec_json, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
          )
          .run(appId, band, spec.name, physical, canonicalSpecJson(spec), now, now);
        outcome.created.push(spec.name);
        clearColumnCache(physical);
        continue;
      }
      const specJson = canonicalSpecJson(spec);
      if (prior.spec_json === specJson && prior.status === 'active') continue;
      if (prior.spec_json !== specJson) {
        alterExtTable(db, appId, band, prior, spec, fk);
        outcome.altered.push(spec.name);
      }
      db.vault
        .prepare(
          `UPDATE consent_app_ext SET spec_json = ?, status = 'active', updated_at = ?
            WHERE app_id = ? AND band = ? AND table_name = ?`,
        )
        .run(specJson, now, appId, band, spec.name);
      clearColumnCache(prior.physical);
    }
    // Live ext tables join the durable vault change log before their DDL
    // transaction becomes visible. Draft tables are intentionally absent
    // from listVaultEntities and therefore never replicated.
    refreshReplicaTriggers(db.vault);
    db.vault.exec('COMMIT');
  } catch (err) {
    db.vault.exec('ROLLBACK');
    throw err;
  }
  return outcome;
}

/** The narrow ALTER path: column adds/drops, index set, searchable set. */
function alterExtTable(
  db: VaultDb,
  appId: string,
  band: ExtBand,
  prior: RegistryRow,
  spec: ExtTableSpec,
  fk: (logical: string) => { physical: string; pk: string },
): void {
  const oldSpec = JSON.parse(prior.spec_json) as ExtTableSpec;
  const oldCols = new Map(oldSpec.columns.map((c) => [c.name, c]));
  const newCols = new Map(spec.columns.map((c) => [c.name, c]));
  const newlySealed = (spec.sealed ?? []).filter(
    (column) => !(oldSpec.sealed ?? []).includes(column),
  );
  const canonColumn = (c: ExtTableSpec['columns'][number]) =>
    canonicalSpecJson({ name: 'x', columns: [{ ...c, primaryKey: c.primaryKey }] });
  for (const [name, col] of newCols) {
    const old = oldCols.get(name);
    if (old && canonColumn(old) !== canonColumn(col)) {
      throw new ExtSpecError(
        `table ${spec.name}: column "${name}" changed shape — declare a new column or table instead`,
      );
    }
    if (!old && col.primaryKey) {
      throw new ExtSpecError(`table ${spec.name}: cannot add a primary key column ("${name}")`);
    }
    if (!old && col.notNull && col.default === undefined) {
      throw new ExtSpecError(
        `table ${spec.name}: new column "${name}" is NOT NULL — give it a default`,
      );
    }
  }
  const physical = prior.physical;
  // Indexes rebuild wholesale (names are derived, so this is cheap and exact).
  for (const idx of oldSpec.indexes ?? []) {
    db.vault.exec(`DROP INDEX IF EXISTS "${extIndexName(physical, idx)}"`);
  }
  const hadFts = (oldSpec.searchable?.length ?? 0) > 0 && band === 'live';
  if (hadFts) db.vault.exec(dropExtFtsDdl(physical));
  for (const [name] of oldCols) {
    if (!newCols.has(name)) db.vault.exec(`ALTER TABLE "${physical}" DROP COLUMN "${name}"`);
  }
  for (const col of spec.columns) {
    if (!oldCols.has(col.name)) {
      db.vault.exec(`ALTER TABLE "${physical}" ADD COLUMN ${columnAddDdl(col, fk)}`);
    }
  }
  for (const idx of spec.indexes ?? []) {
    db.vault.exec(
      `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX "${extIndexName(physical, idx)}" ON "${physical}" (${idx.columns.map((c) => `"${c}"`).join(', ')})`,
    );
  }
  if (band === 'live' && (spec.searchable?.length ?? 0) > 0) {
    db.vault.exec(extFtsDdl(physical, extPk(spec), spec.searchable ?? []));
  }
  // A column newly declared sealed must seal the rows already sitting in it
  // (issue #298 item 9) — otherwise the declaration would protect future
  // writes while leaving today's plaintext readable. Fresh writes are sealed
  // by the command seal sweep; this closes the at-declaration gap.
  const oldSealed = new Set(oldSpec.sealed);
  const nowSealed = (spec.sealed ?? []).filter((c) => !oldSealed.has(c) && newCols.has(c));
  if (nowSealed.length > 0) sealExistingExtColumns(db, physical, extPk(spec), nowSealed);
  // The retro-seal UPDATE itself was observed by the old trigger contract,
  // so scrub after sealing as well as covering earlier retained history.
  for (const column of newlySealed) {
    db.vault
      .prepare(
        `UPDATE replica_change
            SET old_values_json = json_remove(old_values_json, '$.' || ?)
          WHERE entity = ? AND old_values_json IS NOT NULL`,
      )
      .run(column, extLogical(appId, prior.table_name, band));
  }
}

/** Seal the plaintext already present in ext columns just declared sealed. */
function sealExistingExtColumns(
  db: VaultDb,
  physical: string,
  pk: string,
  columns: string[],
): void {
  const select = columns.map((c) => `"${c}"`).join(', ');
  const rows = db.vault
    .prepare(`SELECT "${pk}" AS __pk, ${select} FROM "${physical}"`)
    .all() as Record<string, unknown>[];
  let sealedAny = false;
  for (const row of rows) {
    const id = String(row['__pk']);
    for (const col of columns) {
      const value = row[col];
      if (typeof value !== 'string' || value.length === 0 || isSealedValue(value)) continue;
      db.vault
        .prepare(`UPDATE "${physical}" SET "${col}" = ? WHERE "${pk}" = ?`)
        .run(sealValue(db.sealKey, sealAad(physical, col, id), value), id);
      sealedAny = true;
    }
  }
  if (sealedAny) stampSealKeyFingerprint(db.vault, db.sealKey);
}

/**
 * ADD COLUMN fragment (PRIMARY KEY is structurally impossible here). Carries
 * the same JS-safe-integer CHECK bound as `columnDdl` in schema/ext.ts — a
 * column added mid-lifecycle must be exactly as poison-proof as one declared
 * at table creation.
 */
function columnAddDdl(
  col: ExtTableSpec['columns'][number],
  fk: (logical: string) => { physical: string; pk: string },
): string {
  const parts = [`"${col.name}" ${col.type.toUpperCase()}`];
  if (col.notNull) parts.push('NOT NULL');
  if (col.default !== undefined) {
    parts.push(
      `DEFAULT ${typeof col.default === 'number' ? col.default : `'${col.default.replaceAll("'", "''")}'`}`,
    );
  }
  if (col.references !== undefined) {
    const target = fk(col.references);
    parts.push(`REFERENCES "${target.physical}"("${target.pk}")`);
  }
  if (col.type === 'integer') {
    parts.push(
      `CHECK ("${col.name}" IS NULL OR "${col.name}" BETWEEN -${JS_SAFE_INTEGER_BOUND} AND ${JS_SAFE_INTEGER_BOUND})`,
    );
  }
  return parts.join(' ');
}

/**
 * Ensure the draft band matches the declared specs — the builder session's
 * scratch copy. FIRST access creates the band and seeds it with the live
 * band's rows (common columns); later accesses diff-apply DDL changes and
 * PRESERVE the draft's rows (a mid-session schema edit must not eat the
 * session's test data — reset is an explicit `dropExtBand` first). FK
 * order inside the copy is satisfied by deferring enforcement to COMMIT.
 */
export function seedExtDraft(db: VaultDb, appId: string, specs: ExtTableSpec[]): ExtApplyOutcome {
  const hasDraft = registryRows(db.vault, appId, 'draft').length > 0;
  if (hasDraft) return applyExtBand(db, appId, specs, 'draft');
  const outcome = applyExtBand(db, appId, specs, 'draft');
  const live = new Map(registryRows(db.vault, appId, 'live').map((r) => [r.table_name, r]));
  db.vault.exec('BEGIN');
  db.vault.exec('PRAGMA defer_foreign_keys = ON');
  try {
    for (const spec of specs) {
      const liveRow = live.get(spec.name);
      if (!liveRow) continue;
      const draftPhysical = extPhysical(appId, spec.name, 'draft');
      const liveCols = actualColumns(db.vault, liveRow.physical);
      const common = spec.columns.map((c) => c.name).filter((c) => liveCols.has(c));
      if (common.length === 0) continue;
      const cols = common.map((c) => `"${c}"`).join(', ');
      db.vault.exec(
        `INSERT INTO "${draftPhysical}" (${cols}) SELECT ${cols} FROM "${liveRow.physical}"`,
      );
    }
    db.vault.exec('COMMIT');
  } catch (err) {
    db.vault.exec('ROLLBACK');
    throw err;
  }
  return outcome;
}

/** Drop one whole band (draft discard, or the purge path). */
export function dropExtBand(db: VaultDb, appId: string, band: ExtBand): string[] {
  const now = nowIso();
  const rows = registryRows(db.vault, appId, band);
  db.vault.exec('BEGIN');
  try {
    for (const row of rows) dropExtTable(db, row, now);
    db.vault.exec('COMMIT');
  } catch (err) {
    db.vault.exec('ROLLBACK');
    throw err;
  }
  return rows.map((r) => r.table_name);
}

/**
 * Uninstall default: the data stays (status `retained`), the scratch copy
 * goes, app access is already gone with the grants. Returns the retained
 * table names.
 */
export function retainExtBand(db: VaultDb, appId: string): string[] {
  dropExtBand(db, appId, 'draft');
  const rows = registryRows(db.vault, appId, 'live');
  if (rows.length > 0) {
    db.vault
      .prepare(
        `UPDATE consent_app_ext SET status = 'retained', updated_at = ? WHERE app_id = ? AND band = 'live'`,
      )
      .run(nowIso(), appId);
  }
  return rows.map((r) => r.table_name);
}

/** Owner purge: both bands, tables and registry rows, reference hygiene. */
export function purgeExtBand(db: VaultDb, appId: string): string[] {
  const draft = dropExtBand(db, appId, 'draft');
  const live = dropExtBand(db, appId, 'live');
  return [...new Set([...live, ...draft])];
}

/** SEARCHABLE, ext-shaped: the dynamic half of the search surface. */
export function extSearchable(vault: DatabaseSync, entity: string): SearchableEntity | undefined {
  const ext = parseExtLogical(entity);
  if (!ext || ext.band !== 'live') return undefined;
  try {
    const row = vault
      .prepare(
        `SELECT physical, spec_json FROM consent_app_ext WHERE app_id = ? AND band = 'live' AND table_name = ?`,
      )
      .get(ext.appId, ext.table) as { physical: string; spec_json: string } | undefined;
    if (!row) return undefined;
    const spec = JSON.parse(row.spec_json) as ExtTableSpec;
    if ((spec.searchable?.length ?? 0) === 0) return undefined;
    return {
      fts: `fts_${row.physical}`,
      idColumn: extPk(spec),
      maskColumns: spec.searchable ?? [],
      alsoConsent: [],
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The per-app typed write trio. Registered under owner schema `ext.<appId>`
// so one manifest scope ({ schema: "ext.<appId>", verbs: "read+act" }) covers
// the whole band; the `band` input routes a builder session's writes at the
// scratch copy without a second grant.
// ---------------------------------------------------------------------------

const BAND_PROP = { enum: ['live', 'draft'] };

type Bindable = string | number | bigint | Uint8Array | null;

function bindable(table: string, column: string, value: unknown): Bindable {
  if (value === null || typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw new Error(`${table}.${column}: values must be string, number, boolean or null`);
}

function requireBandRow(
  ctx: HandlerCtx,
  appId: string,
  band: ExtBand,
  table: string,
): { physical: string; spec: ExtTableSpec } {
  const row = ctx.db
    .prepare(
      `SELECT physical, spec_json, status FROM consent_app_ext
        WHERE app_id = ? AND band = ? AND table_name = ?`,
    )
    .get(appId, band, table) as { physical: string; spec_json: string; status: string } | undefined;
  if (!row) throw new Error(`no ${band} ext table "${table}" for app ${appId}`);
  if (row.status !== 'active')
    throw new Error(`ext table "${table}" is retained (app uninstalled)`);
  return { physical: row.physical, spec: JSON.parse(row.spec_json) as ExtTableSpec };
}

/** Names of the trio, for registration and deregistration alike. */
export function extCommandNames(appId: string): string[] {
  return [`ext.${appId}.insert`, `ext.${appId}.update`, `ext.${appId}.delete`];
}

/** Build the three CommandDefinitions for one app's band. */
export function extCommandDefinitions(appId: string): CommandDefinition[] {
  const ownerSchema = `ext.${appId}`;
  const shared = {
    ownerSchema,
    outputSchema: { type: 'object' } as Record<string, unknown>,
    preconditions: [],
    postconditions: [],
    idempotency: 'retry-safe' as const,
    risk: 'low' as const,
  };
  const insert: CommandDefinition = {
    ...shared,
    name: `ext.${appId}.insert`,
    inputSchema: {
      type: 'object',
      required: ['table', 'values'],
      properties: {
        table: { type: 'string' },
        values: { type: 'object' },
        band: BAND_PROP,
      },
      additionalProperties: false,
    },
    handler: (ctx) => {
      const input = ctx.input as { table: string; values: Record<string, unknown>; band?: ExtBand };
      const band = input.band ?? 'live';
      const { physical, spec } = requireBandRow(ctx, appId, band, input.table);
      const pk = extPk(spec);
      const known = new Set(spec.columns.map((c) => c.name));
      const values: Record<string, unknown> = { ...input.values };
      for (const key of Object.keys(values)) {
        if (!known.has(key)) throw new Error(`${input.table}: unknown column "${key}"`);
      }
      if (values[pk] === undefined || values[pk] === null) values[pk] = ctx.newId();
      const names = Object.keys(values);
      ctx.db
        .prepare(
          `INSERT INTO "${physical}" (${names.map((n) => `"${n}"`).join(', ')})
           VALUES (${names.map(() => '?').join(', ')})`,
        )
        .run(...names.map((n) => bindable(input.table, n, values[n])));
      const id = String(values[pk]);
      ctx.wrote(extLogical(appId, input.table, band), id);
      return { id };
    },
  };
  const update: CommandDefinition = {
    ...shared,
    name: `ext.${appId}.update`,
    inputSchema: {
      type: 'object',
      required: ['table', 'id', 'set'],
      properties: {
        table: { type: 'string' },
        id: { type: 'string' },
        set: { type: 'object' },
        band: BAND_PROP,
      },
      additionalProperties: false,
    },
    handler: (ctx) => {
      const input = ctx.input as {
        table: string;
        id: string;
        set: Record<string, unknown>;
        band?: ExtBand;
      };
      const band = input.band ?? 'live';
      const { physical, spec } = requireBandRow(ctx, appId, band, input.table);
      const pk = extPk(spec);
      const known = new Set(spec.columns.map((c) => c.name));
      const names = Object.keys(input.set);
      if (names.length === 0) throw new Error(`${input.table}: nothing to set`);
      for (const key of names) {
        if (!known.has(key)) throw new Error(`${input.table}: unknown column "${key}"`);
        if (key === pk) throw new Error(`${input.table}: the primary key is immutable`);
      }
      const result = ctx.db
        .prepare(
          `UPDATE "${physical}" SET ${names.map((n) => `"${n}" = ?`).join(', ')} WHERE "${pk}" = ?`,
        )
        .run(...names.map((n) => bindable(input.table, n, input.set[n])), input.id);
      if (Number(result.changes) === 0) throw new Error(`${input.table}: no row ${input.id}`);
      ctx.wrote(extLogical(appId, input.table, band), input.id);
      return { id: input.id };
    },
  };
  const del: CommandDefinition = {
    ...shared,
    name: `ext.${appId}.delete`,
    inputSchema: {
      type: 'object',
      required: ['table', 'id'],
      properties: {
        table: { type: 'string' },
        id: { type: 'string' },
        band: BAND_PROP,
      },
      additionalProperties: false,
    },
    handler: (ctx) => {
      const input = ctx.input as { table: string; id: string; band?: ExtBand };
      const band = input.band ?? 'live';
      const { physical } = requireBandRow(ctx, appId, band, input.table);
      const pk = pkColumnOf(ctx.db, physical);
      const result = ctx.db.prepare(`DELETE FROM "${physical}" WHERE "${pk}" = ?`).run(input.id);
      if (Number(result.changes) === 0) throw new Error(`${input.table}: no row ${input.id}`);
      // The deleted row's links end-date via the gateway's dangling-link
      // sweep — record the write so S4/S5 see it.
      ctx.wrote(extLogical(appId, input.table, band), input.id);
      return { id: input.id };
    },
  };
  return [insert, update, del];
}

function pkColumnOf(vault: DatabaseSync, physical: string): string {
  const rows = vault.prepare(`PRAGMA table_info(${JSON.stringify(physical)})`).all() as {
    name: string;
    pk: number;
  }[];
  return rows.find((r) => r.pk === 1)?.name ?? 'rowid';
}

/** App ids with an active live band — whose command trios must exist. */
export function extAppIds(vault: DatabaseSync): string[] {
  try {
    const rows = vault
      .prepare(
        `SELECT DISTINCT app_id FROM consent_app_ext WHERE band = 'live' AND status = 'active' ORDER BY app_id`,
      )
      .all() as { app_id: string }[];
    return rows.map((r) => r.app_id);
  } catch {
    return [];
  }
}

/** Guard for spec sources: an ext schema an app may declare is its own. */
export function assertExtSchemaOwnership(appId: string, schema: string): void {
  if (schema.startsWith('ext.') && schema !== `ext.${appId}`) {
    throw new ExtSpecError(`app ${appId} may not request scope on ${schema}`);
  }
  if (schema === 'ext' || schema.startsWith('extdraft')) {
    throw new ExtSpecError(`"${schema}" is not a grantable schema`);
  }
}

/** The live DDL of the (any-status) live band — for the assistant's map. */
export function extBandDdl(db: VaultDb): string {
  try {
    const rows = db.vault
      .prepare(
        `SELECT e.app_id, e.physical, m.sql FROM consent_app_ext e
           JOIN sqlite_master m ON m.name = e.physical AND m.type = 'table'
          WHERE e.band = 'live' ORDER BY e.physical`,
      )
      .all() as { app_id: string; physical: string; sql: string }[];
    return rows.map((r) => `${r.sql};`).join('\n');
  } catch {
    return '';
  }
}

/**
 * Recreate missing ext physical tables from registry rows — the import path:
 * a fresh vault receives `consent_app_ext` rows from the artifact first,
 * then this plants the tables (both bands; draft arrives empty), then the
 * ext rows load like any other entity. SQLite resolves FK targets at DML
 * time, so creation order within a band doesn't matter.
 */
export function recreateExtTables(db: VaultDb): string[] {
  const rows = db.vault
    .prepare(
      `SELECT app_id, band, table_name, physical, spec_json, status FROM consent_app_ext
        ORDER BY app_id, band, table_name`,
    )
    .all() as unknown as RegistryRow[];
  const byAppBand = new Map<string, RegistryRow[]>();
  for (const row of rows) {
    const key = `${row.app_id} ${row.band}`;
    byAppBand.set(key, [...(byAppBand.get(key) ?? []), row]);
  }
  const created: string[] = [];
  for (const group of byAppBand.values()) {
    const first = group[0];
    if (!first) continue;
    const batch = new Map(
      group.map((r) => [r.table_name, JSON.parse(r.spec_json) as ExtTableSpec]),
    );
    const fk = fkResolver(db, first.app_id, first.band, batch);
    for (const row of group) {
      const exists = db.vault
        .prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(row.physical);
      if (exists) continue;
      const spec = batch.get(row.table_name);
      if (!spec) continue;
      db.vault.exec(extTableDdl(row.physical, spec, fk));
      if (row.band === 'live' && (spec.searchable?.length ?? 0) > 0) {
        db.vault.exec(extFtsDdl(row.physical, extPk(spec), spec.searchable ?? []));
      }
      created.push(row.physical);
    }
  }
  refreshReplicaTriggers(db.vault);
  return created;
}

/** Physical names of live ext tables (assistant DDL filter, sql surfaces). */
export function extPhysicalNames(vault: DatabaseSync): string[] {
  try {
    const rows = vault
      .prepare(`SELECT physical FROM consent_app_ext WHERE band = 'live' ORDER BY physical`)
      .all() as { physical: string }[];
    return rows.map((r) => r.physical);
  } catch {
    return [];
  }
}
