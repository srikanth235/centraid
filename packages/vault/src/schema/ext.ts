import { UPDATED_AT_DEFAULT, touchUpdatedAt } from "./updated-at.js";

export interface ExtColumnSpec {
  name: string;
  type: "text" | "integer" | "real" | "blob";
  primaryKey?: boolean;
  notNull?: boolean;
  default?: string | number;
  references?: string;
}

export interface ExtIndexSpec {
  columns: string[];
  unique?: boolean;
}

export interface ExtTableSpec {
  name: string;
  columns: ExtColumnSpec[];
  indexes?: ExtIndexSpec[];
  searchable?: string[];
  sealed?: string[];
}

export type ExtBand = "live" | "draft";

const NAME_RE = /^[a-z][a-z0-9_]{0,47}$/u;
const APP_ID_RE = /^[a-z][a-z0-9-]{0,63}$/u;

export function normalizeAppId(appId: string): string {
  return appId.replaceAll("-", "_");
}

export function extPhysical(
  appId: string,
  table: string,
  band: ExtBand
): string {
  return `${band === "live" ? "ext" : "extdraft"}_${normalizeAppId(appId)}_${table}`;
}

export function extLogical(
  appId: string,
  table: string,
  band: ExtBand
): string {
  return `${band === "live" ? "ext" : "extdraft"}.${appId}.${table}`;
}

export function parseExtLogical(
  logical: string
): { appId: string; table: string; band: ExtBand } | undefined {
  const parts = logical.split(".");
  if (parts.length !== 3) return undefined;
  const [prefix, appId, table] = parts;
  if (prefix !== "ext" && prefix !== "extdraft") return undefined;
  if (!appId || !table) return undefined;
  return { appId, table, band: prefix === "ext" ? "live" : "draft" };
}

export class ExtSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtSpecError";
  }
}

export function extPk(spec: ExtTableSpec): string {
  const pk = spec.columns.find((c) => c.primaryKey);
  if (!pk) throw new ExtSpecError(`table ${spec.name} has no primary key`);
  return pk.name;
}

export function validateExtSpecs(
  appId: string,
  specs: ExtTableSpec[],
  canReference: (logical: string) => boolean
): void {
  if (!APP_ID_RE.test(appId))
    throw new ExtSpecError(`invalid app id "${appId}"`);
  const names = new Set<string>();
  for (const spec of specs) {
    if (!NAME_RE.test(spec.name))
      throw new ExtSpecError(`invalid table name "${spec.name}"`);
    if (names.has(spec.name))
      throw new ExtSpecError(`duplicate table "${spec.name}"`);
    names.add(spec.name);
    if (spec.columns.length === 0)
      throw new ExtSpecError(`table ${spec.name} has no columns`);
    const colNames = new Set<string>();
    const pks = spec.columns.filter((c) => c.primaryKey);
    if (pks.length !== 1) {
      throw new ExtSpecError(
        `table ${spec.name} must declare exactly one primaryKey column`
      );
    }
    if (pks[0]?.type !== "text") {
      throw new ExtSpecError(
        `table ${spec.name}: the primary key must be a text (UUIDv7) column`
      );
    }
    for (const col of spec.columns) {
      if (!NAME_RE.test(col.name)) {
        throw new ExtSpecError(
          `table ${spec.name}: invalid column name "${col.name}"`
        );
      }
      if (colNames.has(col.name)) {
        throw new ExtSpecError(
          `table ${spec.name}: duplicate column "${col.name}"`
        );
      }
      colNames.add(col.name);
      if (!["text", "integer", "real", "blob"].includes(col.type)) {
        throw new ExtSpecError(
          `table ${spec.name}.${col.name}: unknown type "${col.type}"`
        );
      }
      if (
        col.default !== undefined &&
        !["string", "number"].includes(typeof col.default)
      ) {
        throw new ExtSpecError(
          `table ${spec.name}.${col.name}: default must be string or number`
        );
      }
      if (col.references !== undefined) {
        const target = parseExtLogical(col.references);
        if (target && (target.appId !== appId || target.band !== "live")) {
          throw new ExtSpecError(
            `table ${spec.name}.${col.name}: ext references must stay within app "${appId}"`
          );
        }
        const ok = target
          ? names.has(target.table) || canReference(col.references)
          : canReference(col.references);
        if (!ok) {
          throw new ExtSpecError(
            `table ${spec.name}.${col.name}: references unknown entity "${col.references}"`
          );
        }
      }
    }
    for (const idx of spec.indexes ?? []) {
      for (const c of idx.columns) {
        if (!colNames.has(c)) {
          throw new ExtSpecError(
            `table ${spec.name}: index names unknown column "${c}"`
          );
        }
      }
    }
    for (const c of spec.searchable ?? []) {
      const col = spec.columns.find((x) => x.name === c);
      if (!col)
        throw new ExtSpecError(
          `table ${spec.name}: searchable names unknown column "${c}"`
        );
      if (col.type !== "text") {
        throw new ExtSpecError(
          `table ${spec.name}: searchable column "${c}" must be text`
        );
      }
    }
    const searchable = new Set(spec.searchable);
    const indexed = new Set((spec.indexes ?? []).flatMap((i) => i.columns));
    for (const c of spec.sealed ?? []) {
      const col = spec.columns.find((x) => x.name === c);
      if (!col)
        throw new ExtSpecError(
          `table ${spec.name}: sealed names unknown column "${c}"`
        );
      if (col.type !== "text") {
        throw new ExtSpecError(
          `table ${spec.name}: sealed column "${c}" must be text`
        );
      }
      if (col.primaryKey) {
        throw new ExtSpecError(
          `table ${spec.name}: the primary key cannot be sealed`
        );
      }
      if (col.references !== undefined) {
        throw new ExtSpecError(
          `table ${spec.name}: an FK column ("${c}") cannot be sealed`
        );
      }
      if (searchable.has(c)) {
        throw new ExtSpecError(
          `table ${spec.name}: "${c}" cannot be both sealed and searchable — sealed columns are never indexed (issue #293)`
        );
      }
      if (indexed.has(c)) {
        throw new ExtSpecError(
          `table ${spec.name}: sealed column "${c}" cannot be indexed — an index over ciphertext leaks and serves nothing`
        );
      }
    }
  }
}

export function canonicalSpecJson(spec: ExtTableSpec): string {
  const col = (c: ExtColumnSpec) => ({
    name: c.name,
    type: c.type,
    ...(c.primaryKey ? { primaryKey: true } : {}),
    ...(c.notNull ? { notNull: true } : {}),
    ...(c.default === undefined ? {} : { default: c.default }),
    ...(c.references === undefined ? {} : { references: c.references }),
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
  return typeof value === "number"
    ? String(value)
    : `'${value.replaceAll("'", "''")}'`;
}

export const JS_SAFE_INTEGER_BOUND = 9007199254740991;

export function columnDdl(
  col: ExtColumnSpec,
  fkPhysical: (logical: string) => { physical: string; pk: string }
): string {
  const parts = [`"${col.name}" ${col.type.toUpperCase()}`];
  if (col.primaryKey) parts.push("PRIMARY KEY");
  if (col.notNull) parts.push("NOT NULL");
  if (col.default !== undefined)
    parts.push(`DEFAULT ${sqlLiteral(col.default)}`);
  if (col.references !== undefined) {
    const target = fkPhysical(col.references);
    parts.push(`REFERENCES "${target.physical}"("${target.pk}")`);
  }
  if (col.type === "integer") {
    parts.push(
      `CHECK ("${col.name}" IS NULL OR "${col.name}" BETWEEN -${JS_SAFE_INTEGER_BOUND} AND ${JS_SAFE_INTEGER_BOUND})`
    );
  }
  return parts.join(" ");
}

export function extIndexName(physical: string, idx: ExtIndexSpec): string {
  return `idx_${physical}_${idx.columns.join("_")}${idx.unique ? "_uq" : ""}`;
}

export function extTableDdl(
  physical: string,
  spec: ExtTableSpec,
  fkPhysical: (logical: string) => { physical: string; pk: string }
): string {
  const cols = spec.columns.map((c) => columnDdl(c, fkPhysical)).join(",\n  ");
  const indexes = (spec.indexes ?? []).map(
    (i) =>
      `CREATE ${i.unique ? "UNIQUE " : ""}INDEX "${extIndexName(physical, i)}" ON "${physical}" (${i.columns.map((c) => `"${c}"`).join(", ")});`
  );
  return [
    `CREATE TABLE "${physical}" (\n  ${cols}\n) STRICT;`,
    ...indexes,
  ].join("\n");
}

export function extFtsDdl(
  physical: string,
  pk: string,
  columns: string[]
): string {
  const fts = `fts_${physical}`;
  const ftsColumns = [`${pk} UNINDEXED`, ...columns];
  const insertColumns = ["rowid", pk, ...columns].join(", ");
  const values = (prefix: string) =>
    [
      `${prefix}.rowid`,
      `${prefix}."${pk}"`,
      ...columns.map((c) => `${prefix}."${c}"`),
    ].join(", ");
  const insertRow = `INSERT INTO ${fts}(${insertColumns}) SELECT ${values("new")};`;
  return `
CREATE VIRTUAL TABLE ${fts} USING fts5(
  ${ftsColumns.join(", ")},
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
INSERT INTO ${fts}(${insertColumns}) SELECT ${values("b")} FROM "${physical}" b;
`;
}

export function dropExtFtsDdl(physical: string): string {
  const fts = `fts_${physical}`;
  return [
    `DROP TRIGGER IF EXISTS ${fts}_ai;`,
    `DROP TRIGGER IF EXISTS ${fts}_au;`,
    `DROP TRIGGER IF EXISTS ${fts}_ad;`,
    `DROP TABLE IF EXISTS ${fts};`,
  ].join("\n");
}

export const APP_EXT_DDL = `
CREATE TABLE access_app_ext (
  app_id      TEXT NOT NULL,
  band        TEXT NOT NULL DEFAULT 'live' CHECK (band IN ('live', 'draft')),
  table_name  TEXT NOT NULL,
  physical    TEXT NOT NULL UNIQUE,
  spec_json   TEXT NOT NULL CHECK (json_valid(spec_json)),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retained')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  PRIMARY KEY (app_id, band, table_name)
) STRICT;
${touchUpdatedAt("access_app_ext", ["app_id", "band", "table_name"])}
`;
