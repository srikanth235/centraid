// The published ontology page and the live schema, held equal.
//
// `scripts/docs-site/src/content/ontology-body.html` (served at
// centraid.dev/docs/ontology/) is the ontology's written source of truth: its
// §03 renders every table of the ontology packs and the two planes from a
// hand-authored `SCHEMAS` array. That array drifted for eleven rungs — it still
// described `consent.share`, `social.contact_card` and the dropped home and
// business domains — because nothing compared it with the DDL. This module is
// the comparison: `liveOntologyDoc` derives the doc's shape from the registry
// plus `PRAGMA table_info`, and `parseOntologyDocSchemas` reads the page's
// array back. `ontology-doc.test.ts` asserts the two agree, table by table and
// column by column, so the page cannot claim a column the vault does not have
// or omit one it does. Prose (purpose, standards) stays hand-written; only the
// structural half is generated and checked.

import type { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";

import { MACHINERY_BANDS, ONTOLOGY_PACKS } from "./atlas.js";
import { AUDIT_BAND_TABLES } from "./audit.js";
import { LEDGER_BAND_TABLES } from "./ledger.js";
import { VAULT_TABLES } from "./tables.js";

/** One column as §03 draws it: `[name, type, flags, references]`. */
export interface DocColumn {
  name: string;
  /** Declared SQLite type (`TEXT`, `INTEGER`, `REAL`, `BLOB`). */
  type: string;
  /** Space-separated subset of `PK FK UQ NN CK`, in that order. */
  flags: string;
  /** Logical FK target (`core.party`), or `''`. */
  fk: string;
}

export interface DocTable {
  schema: string;
  table: string;
  cols: DocColumn[];
}

/**
 * The schemas §03 describes column by column: the ontology packs (life data)
 * and the two planes every caller walks. Machinery bands are named on the
 * page, never described (#883 O-label), so they are checked by name only.
 */
export const ONTOLOGY_DOC_SCHEMAS: readonly string[] = [
  ...ONTOLOGY_PACKS,
  // The access plane and the agent plane, described column by column. The
  // `audit` and `ledger` bands are NAMED under MACHINERY, not described — they
  // are evidence and transcript, not the model (#916).
  "access",
  "agent",
];

function logicalOf(physical: string): string {
  for (const [schema, tables] of Object.entries(VAULT_TABLES)) {
    for (const table of tables) {
      if (`${schema}_${table}` === physical) return `${schema}.${table}`;
    }
  }
  return physical;
}

/**
 * Column-level CHECKs, read from the CREATE TABLE text: the body is split on
 * top-level commas (after `--` comments are stripped) and a segment that opens
 * with the column's name carries its constraint. Table-level CHECKs are not
 * attributed to a column, which is also how the page has always drawn them.
 */
function columnsWithCheck(sql: string): Set<string> {
  const stripped = sql.replace(/--[^\n]*/gu, "");
  const open = stripped.indexOf("(");
  if (open < 0) return new Set();
  let depth = 0;
  let segment = "";
  const segments: string[] = [];
  for (const ch of stripped.slice(open + 1)) {
    if (ch === "(") depth += 1;
    if (ch === ")") {
      if (depth === 0) break;
      depth -= 1;
    }
    if (ch === "," && depth === 0) {
      segments.push(segment);
      segment = "";
      continue;
    }
    segment += ch;
  }
  segments.push(segment);
  const checked = new Set<string>();
  for (const raw of segments) {
    const text = raw.trim();
    const name = /^(?<name>[A-Za-z_][A-Za-z0-9_]*)\s/u.exec(text)?.groups?.name;
    if (
      name &&
      !/^(?:CHECK|UNIQUE|PRIMARY|FOREIGN)$/iu.test(name) &&
      /\bCHECK\b/u.test(text)
    ) {
      checked.add(name);
    }
  }
  return checked;
}

function describeTable(
  db: DatabaseSync,
  physical: string
): DocColumn[] | undefined {
  const master = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(physical) as { sql: string } | undefined;
  if (!master) return undefined;
  // Identifiers reach PRAGMA as SQL string literals (`JSON.stringify`), the
  // one form the rest of the vault's PRAGMA sites use — see `filters.ts`,
  // `revision-capture.ts`, `entity.ts`, `merge-fold.ts`, `duties.ts`.
  const info = db
    .prepare(`PRAGMA table_info(${JSON.stringify(physical)})`)
    .all() as {
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }[];
  const foreignKeys = db
    .prepare(`PRAGMA foreign_key_list(${JSON.stringify(physical)})`)
    .all() as { from: string; table: string }[];
  const uniqueSingles = new Set<string>();
  const indexes = db
    .prepare(`PRAGMA index_list(${JSON.stringify(physical)})`)
    .all() as {
    name: string;
    unique: number;
    origin: string;
  }[];
  for (const index of indexes) {
    if (!index.unique || index.origin === "pk") continue;
    const cols = db
      .prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`)
      .all() as {
      name: string;
    }[];
    if (cols.length === 1) uniqueSingles.add(cols[0]!.name);
  }
  const checked = columnsWithCheck(master.sql);
  return info.map((column) => {
    const fk = foreignKeys.find((f) => f.from === column.name);
    const flags = [
      column.pk ? "PK" : "",
      fk ? "FK" : "",
      uniqueSingles.has(column.name) ? "UQ" : "",
      column.notnull || column.pk ? "NN" : "",
      checked.has(column.name) ? "CK" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return {
      name: column.name,
      type: column.type.toUpperCase(),
      flags,
      fk: fk ? logicalOf(fk.table) : "",
    };
  });
}

/**
 * What §03 must say, derived from the registry and the live DDL: every table
 * of every in-scope schema, in registry order.
 */
export function liveOntologyDoc(vault: DatabaseSync): DocTable[] {
  const out: DocTable[] = [];
  for (const schema of ONTOLOGY_DOC_SCHEMAS) {
    for (const table of VAULT_TABLES[schema] ?? []) {
      const physical = `${schema}_${table}`;
      const cols = describeTable(vault, physical);
      if (!cols) {
        throw new Error(
          `${schema}.${table} is registered but ${physical} does not exist`
        );
      }
      out.push({ schema, table, cols });
    }
  }
  return out;
}

/**
 * Every machinery-band table the page must at least name.
 *
 * `audit` and `ledger` are BAND-DECLARED rather than registry-declared — their
 * physical names do not follow `<band>_<table>` (the audit band writes
 * `access_provenance`, the ledger band writes `conversations`) — so the page
 * names them from the band modules, which is the same list `local-tables.ts`
 * excludes from the export and the replica by.
 */
export function liveMachineryTables(): Record<string, readonly string[]> {
  const bands: [string, readonly string[]][] = MACHINERY_BANDS.map((band) => {
    if (band === "audit") return [band, AUDIT_BAND_TABLES];
    if (band === "ledger") return [band, LEDGER_BAND_TABLES];
    return [
      band,
      [...(VAULT_TABLES[band] ?? [])].filter(
        // access/agent are described in §03 already; their machinery-band
        // tables are not named twice.
        () => !ONTOLOGY_DOC_SCHEMAS.includes(band)
      ),
    ];
  });
  return Object.fromEntries(bands.filter(([, tables]) => tables.length > 0));
}

export interface DocSchemaEntry {
  id: string;
  tables: { n: string; cols: string[][] }[];
}

export interface DocMachineryEntry {
  id: string;
  tables: string[];
}

function extractArray(html: string, name: string): string {
  const start = html.indexOf(`const ${name} = [`);
  if (start < 0) throw new Error(`ontology page: no \`const ${name} = [\``);
  const end = html.indexOf("\n];", start);
  if (end < 0) throw new Error(`ontology page: \`${name}\` never closes`);
  return html.slice(start + `const ${name} =`.length, end + 3);
}

/** The page's `SCHEMAS` array, evaluated in an empty sandbox. */
export function parseOntologyDocSchemas(html: string): DocSchemaEntry[] {
  return realmLocal(runInNewContext(extractArray(html, "SCHEMAS")));
}

/** The page's `MACHINERY` array — bands named, never described. */
export function parseOntologyDocMachinery(html: string): DocMachineryEntry[] {
  return realmLocal(runInNewContext(extractArray(html, "MACHINERY")));
}

/**
 * A sandbox evaluates into its own realm, so its arrays fail a strict
 * equality against ours on prototype alone; a structured clone lands the
 * data in this realm as plain values.
 */
function realmLocal<T>(value: unknown): T {
  return structuredClone(value) as T;
}

/** The §03 tuple for one live column, ready to paste into the page. */
export function docColumnTuple(column: DocColumn): string {
  const q = (s: string) => `'${s.replace(/'/gu, "\\'")}'`;
  return `[${q(column.name)},${q(column.type)},${q(column.flags)},${q(column.fk)}, '']`;
}
