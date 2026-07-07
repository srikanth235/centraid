// The ext band (issue #286 phase 2): app-declared extension tables that live
// INSIDE vault.db — physical `ext_<app>_<table>` — for shapes the canonical
// ontology genuinely doesn't cover (Lane 2 of the two-lane rule; Lane 1 is
// mapping onto the ontology). The gateway applies the DDL from the app's
// manifest declaration; apps never run DDL themselves. Because the tables sit
// in the one file behind the one door, consent scopes, core_link refs,
// receipts, export and the owner's vault_sql all work over them unchanged.
//
// R09 still holds, band-shaped: an ext table may hold FKs INTO the vault
// (and into the same app's other ext tables); no canonical table ever
// references an ext table.
//
// This module is the declarative half: the spec shape, its validation, and
// deterministic DDL generation (specs are diffed by canonical JSON, so
// generation must be a pure function of the spec). The applying/diffing
// half lives in gateway/ext.ts — DDL is a gateway duty.

/** One declared column. `references` names a logical vault entity. */
export interface ExtColumnSpec {
  name: string;
  type: 'text' | 'integer' | 'real' | 'blob';
  /** Exactly one column per table, and it must be `text` (UUIDv7 ids). */
  primaryKey?: boolean;
  notNull?: boolean;
  default?: string | number;
  /** FK into the vault: a logical entity (`core.party`) or a same-app ext
   * table (`ext.<appId>.<table>`). The vault never references back. */
  references?: string;
}

export interface ExtIndexSpec {
  columns: string[];
  unique?: boolean;
}

/** One declared extension table, as the app manifest carries it. */
export interface ExtTableSpec {
  name: string;
  columns: ExtColumnSpec[];
  indexes?: ExtIndexSpec[];
  /** Text columns to FTS5-index (opt-in search). */
  searchable?: string[];
  /**
   * Text columns holding secret material (issue #298 item 9): declared here,
   * enforced by the SAME chokepoints as canonical sealed columns — ciphertext
   * at rest via the seal sweep, placeholder in every default read, plaintext
   * only under the `reveal` verb, hash tokens in the journal, and never FTS
   * (sealed ∩ searchable is a validation error). One declaration, the whole
   * pipeline — a third-party app's API-key column gets the Locker treatment.
   */
  sealed?: string[];
}

/** Which copy of the band: `live` is the app's data; `draft` is the builder
 * session's scratch copy (seeded from live, dropped or promoted on publish). */
export type ExtBand = 'live' | 'draft';

const NAME_RE = /^[a-z][a-z0-9_]{0,47}$/;
const APP_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

/** appIds allow hyphens; SQLite identifiers shouldn't. `my-app` → `my_app`. */
export function normalizeAppId(appId: string): string {
  return appId.replaceAll('-', '_');
}

/** Physical table name for one band: `ext_gym_workout` / `extdraft_gym_workout`. */
export function extPhysical(appId: string, table: string, band: ExtBand): string {
  return `${band === 'live' ? 'ext' : 'extdraft'}_${normalizeAppId(appId)}_${table}`;
}

/** Logical entity name for one band: `ext.gym.workout` / `extdraft.gym.workout`.
 * Both bands share the consent schema `ext.<appId>` — the draft copy is the
 * same data class under the same grant, just a different physical home. */
export function extLogical(appId: string, table: string, band: ExtBand): string {
  return `${band === 'live' ? 'ext' : 'extdraft'}.${appId}.${table}`;
}

/** Parse a (possibly ext) logical name. Returns undefined for non-ext names. */
export function parseExtLogical(
  logical: string,
): { appId: string; table: string; band: ExtBand } | undefined {
  const parts = logical.split('.');
  if (parts.length !== 3) return undefined;
  const [prefix, appId, table] = parts;
  if (prefix !== 'ext' && prefix !== 'extdraft') return undefined;
  if (!appId || !table) return undefined;
  return { appId, table, band: prefix === 'ext' ? 'live' : 'draft' };
}

export class ExtSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtSpecError';
  }
}

/** The primary-key column of a validated spec. */
export function extPk(spec: ExtTableSpec): string {
  const pk = spec.columns.find((c) => c.primaryKey);
  if (!pk) throw new ExtSpecError(`table ${spec.name} has no primary key`);
  return pk.name;
}

/**
 * Validate a whole declared band. Throws ExtSpecError with a message the
 * builder can act on. `canReference` decides whether a `references` target
 * is acceptable (the caller checks the entity registry + same-app tables).
 */
export function validateExtSpecs(
  appId: string,
  specs: ExtTableSpec[],
  canReference: (logical: string) => boolean,
): void {
  if (!APP_ID_RE.test(appId)) throw new ExtSpecError(`invalid app id "${appId}"`);
  const names = new Set<string>();
  for (const spec of specs) {
    if (!NAME_RE.test(spec.name)) throw new ExtSpecError(`invalid table name "${spec.name}"`);
    if (names.has(spec.name)) throw new ExtSpecError(`duplicate table "${spec.name}"`);
    names.add(spec.name);
    if (spec.columns.length === 0) throw new ExtSpecError(`table ${spec.name} has no columns`);
    const colNames = new Set<string>();
    const pks = spec.columns.filter((c) => c.primaryKey);
    if (pks.length !== 1) {
      throw new ExtSpecError(`table ${spec.name} must declare exactly one primaryKey column`);
    }
    if (pks[0]?.type !== 'text') {
      throw new ExtSpecError(`table ${spec.name}: the primary key must be a text (UUIDv7) column`);
    }
    for (const col of spec.columns) {
      if (!NAME_RE.test(col.name)) {
        throw new ExtSpecError(`table ${spec.name}: invalid column name "${col.name}"`);
      }
      if (colNames.has(col.name)) {
        throw new ExtSpecError(`table ${spec.name}: duplicate column "${col.name}"`);
      }
      colNames.add(col.name);
      if (!['text', 'integer', 'real', 'blob'].includes(col.type)) {
        throw new ExtSpecError(`table ${spec.name}.${col.name}: unknown type "${col.type}"`);
      }
      if (col.default !== undefined && !['string', 'number'].includes(typeof col.default)) {
        throw new ExtSpecError(`table ${spec.name}.${col.name}: default must be string or number`);
      }
      if (col.references !== undefined) {
        const target = parseExtLogical(col.references);
        if (target && (target.appId !== appId || target.band !== 'live')) {
          throw new ExtSpecError(
            `table ${spec.name}.${col.name}: ext references must stay within app "${appId}"`,
          );
        }
        const ok = target
          ? names.has(target.table) || canReference(col.references)
          : canReference(col.references);
        if (!ok) {
          throw new ExtSpecError(
            `table ${spec.name}.${col.name}: references unknown entity "${col.references}"`,
          );
        }
      }
    }
    for (const idx of spec.indexes ?? []) {
      for (const c of idx.columns) {
        if (!colNames.has(c)) {
          throw new ExtSpecError(`table ${spec.name}: index names unknown column "${c}"`);
        }
      }
    }
    for (const c of spec.searchable ?? []) {
      const col = spec.columns.find((x) => x.name === c);
      if (!col)
        throw new ExtSpecError(`table ${spec.name}: searchable names unknown column "${c}"`);
      if (col.type !== 'text') {
        throw new ExtSpecError(`table ${spec.name}: searchable column "${c}" must be text`);
      }
    }
    const searchable = new Set(spec.searchable);
    const indexed = new Set((spec.indexes ?? []).flatMap((i) => i.columns));
    for (const c of spec.sealed ?? []) {
      const col = spec.columns.find((x) => x.name === c);
      if (!col) throw new ExtSpecError(`table ${spec.name}: sealed names unknown column "${c}"`);
      if (col.type !== 'text') {
        throw new ExtSpecError(`table ${spec.name}: sealed column "${c}" must be text`);
      }
      if (col.primaryKey) {
        throw new ExtSpecError(`table ${spec.name}: the primary key cannot be sealed`);
      }
      if (col.references !== undefined) {
        throw new ExtSpecError(`table ${spec.name}: an FK column ("${c}") cannot be sealed`);
      }
      if (searchable.has(c)) {
        throw new ExtSpecError(
          `table ${spec.name}: "${c}" cannot be both sealed and searchable — sealed columns are never indexed (issue #293)`,
        );
      }
      if (indexed.has(c)) {
        throw new ExtSpecError(
          `table ${spec.name}: sealed column "${c}" cannot be indexed — an index over ciphertext leaks and serves nothing`,
        );
      }
    }
  }
}

/** Canonical form for diffing: stable key order, defaults dropped. */
export function canonicalSpecJson(spec: ExtTableSpec): string {
  const col = (c: ExtColumnSpec) => ({
    name: c.name,
    type: c.type,
    ...(c.primaryKey ? { primaryKey: true } : {}),
    ...(c.notNull ? { notNull: true } : {}),
    ...(c.default !== undefined ? { default: c.default } : {}),
    ...(c.references !== undefined ? { references: c.references } : {}),
  });
  return JSON.stringify({
    name: spec.name,
    columns: spec.columns.map(col),
    indexes: (spec.indexes ?? []).map((i) => ({
      columns: i.columns,
      ...(i.unique ? { unique: true } : {}),
    })),
    searchable: [...(spec.searchable ?? [])].sort(),
    sealed: [...(spec.sealed ?? [])].sort(),
  });
}

function sqlLiteral(value: string | number): string {
  return typeof value === 'number' ? String(value) : `'${value.replaceAll("'", "''")}'`;
}

/**
 * One column's DDL fragment. `fkPhysical` resolves a `references` target to
 * (physical table, pk column) — band-aware, supplied by the applier.
 */
export function columnDdl(
  col: ExtColumnSpec,
  fkPhysical: (logical: string) => { physical: string; pk: string },
): string {
  const parts = [`"${col.name}" ${col.type.toUpperCase()}`];
  if (col.primaryKey) parts.push('PRIMARY KEY');
  if (col.notNull) parts.push('NOT NULL');
  if (col.default !== undefined) parts.push(`DEFAULT ${sqlLiteral(col.default)}`);
  if (col.references !== undefined) {
    const target = fkPhysical(col.references);
    parts.push(`REFERENCES "${target.physical}"("${target.pk}")`);
  }
  return parts.join(' ');
}

/** Deterministic index name: diffable by name set. */
export function extIndexName(physical: string, idx: ExtIndexSpec): string {
  return `idx_${physical}_${idx.columns.join('_')}${idx.unique ? '_uq' : ''}`;
}

/** CREATE TABLE + indexes for one spec in one band. */
export function extTableDdl(
  physical: string,
  spec: ExtTableSpec,
  fkPhysical: (logical: string) => { physical: string; pk: string },
): string {
  const cols = spec.columns.map((c) => columnDdl(c, fkPhysical)).join(',\n  ');
  const indexes = (spec.indexes ?? []).map(
    (i) =>
      `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX "${extIndexName(physical, i)}" ON "${physical}" (${i.columns.map((c) => `"${c}"`).join(', ')});`,
  );
  return [`CREATE TABLE "${physical}" (\n  ${cols}\n);`, ...indexes].join('\n');
}

/**
 * FTS5 artifacts for a searchable ext table (live band only): shadow table,
 * sync triggers, backfill — the same shape schema/fts.ts gives canonical
 * entities, minus content-uri indirection (ext columns are plain text).
 */
export function extFtsDdl(physical: string, pk: string, columns: string[]): string {
  const fts = `fts_${physical}`;
  const ftsColumns = [`${pk} UNINDEXED`, ...columns];
  const insertColumns = ['rowid', pk, ...columns].join(', ');
  const values = (prefix: string) =>
    [`${prefix}.rowid`, `${prefix}."${pk}"`, ...columns.map((c) => `${prefix}."${c}"`)].join(', ');
  const insertRow = `INSERT INTO ${fts}(${insertColumns}) SELECT ${values('new')};`;
  return `
CREATE VIRTUAL TABLE ${fts} USING fts5(
  ${ftsColumns.join(', ')},
  tokenize = "unicode61 remove_diacritics 2"
);
CREATE TRIGGER ${fts}_ai AFTER INSERT ON "${physical}" BEGIN
  ${insertRow}
END;
CREATE TRIGGER ${fts}_au AFTER UPDATE ON "${physical}" BEGIN
  DELETE FROM ${fts} WHERE rowid = old.rowid;
  ${insertRow}
END;
CREATE TRIGGER ${fts}_ad AFTER DELETE ON "${physical}" BEGIN
  DELETE FROM ${fts} WHERE rowid = old.rowid;
END;
INSERT INTO ${fts}(${insertColumns}) SELECT ${values('b')} FROM "${physical}" b;
`;
}

export function dropExtFtsDdl(physical: string): string {
  const fts = `fts_${physical}`;
  return [
    `DROP TRIGGER IF EXISTS ${fts}_ai;`,
    `DROP TRIGGER IF EXISTS ${fts}_au;`,
    `DROP TRIGGER IF EXISTS ${fts}_ad;`,
    `DROP TABLE IF EXISTS ${fts};`,
  ].join('\n');
}

/**
 * Migration rung (v5): the band registry. One row per (app, band, table) —
 * `spec_json` is the canonical declared spec (the diff base for the next
 * apply), `status` survives uninstall (`retained`: data kept, app access
 * gone) until the owner purges.
 */
export const APP_EXT_DDL = `
CREATE TABLE IF NOT EXISTS consent_app_ext (
  app_id      TEXT NOT NULL,
  band        TEXT NOT NULL DEFAULT 'live' CHECK (band IN ('live', 'draft')),
  table_name  TEXT NOT NULL,
  physical    TEXT NOT NULL UNIQUE,
  spec_json   TEXT NOT NULL CHECK (json_valid(spec_json)),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retained')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (app_id, band, table_name)
);
`;
