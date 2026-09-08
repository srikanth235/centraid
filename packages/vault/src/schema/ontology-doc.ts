// The published ontology page and the live schema, held equal.
//
// `scripts/docs-site/src/content/ontology-body.html` (served at
// centraid.dev/docs/ontology/) is the ontology's written source of truth: its
// §03 renders every table of the ontology packs and the two planes from a
// hand-authored `SCHEMAS` array. That array drifted for eleven rungs — it still
// described `consent.share`, `social.contact_card` and the dropped home and
// business domains — because nothing compared it with the DDL. This module is
// the comparison: `liveOntologyDoc` derives the doc's shape from the registry
// plus `PRAGMA table_info`, and `parseOntologyDocSchemas` PARSES the page's
// array back — the page is data and is never executed, see `parseDataLiteral`.
// `ontology-doc.test.ts` asserts the two agree, table by table and
// column by column, so the page cannot claim a column the vault does not have
// or omit one it does. Prose (purpose, standards) stays hand-written; only the
// structural half is generated and checked.

import type { DatabaseSync } from "node:sqlite";

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
  // Up to and including the `]`, never the `;`: what comes back is one value,
  // not a statement, because `parseDataLiteral` refuses trailing text.
  return html.slice(start + `const ${name} =`.length, end + 2);
}

/**
 * THE PAGE IS DATA, SO IT IS READ AND NEVER RUN (#916).
 *
 * Both arrays used to reach `node:vm`'s `runInNewContext`: whatever the slice
 * held was EXECUTED, and an empty sandbox is not a security boundary — it
 * shares the process, so a `while(true)` or a `process.mainModule` walk
 * authored into the page ran with the test runner's privileges. Nothing about
 * the data needs evaluation. `parseDataLiteral` reads the one grammar §03 is
 * written in — arrays, objects, strings, numbers, the three keywords — and
 * refuses every other token, so a call, an identifier or a template literal is
 * a parse error where it used to be code.
 *
 * The parser also builds its values HERE, which retires the structured clone
 * the sandbox needed: vm returns another realm's arrays, and those fail
 * `toStrictEqual` on prototype alone.
 */
export function parseOntologyDocSchemas(html: string): DocSchemaEntry[] {
  return parseDataLiteral(extractArray(html, "SCHEMAS")) as DocSchemaEntry[];
}

/** The page's `MACHINERY` array — bands named, never described. */
export function parseOntologyDocMachinery(html: string): DocMachineryEntry[] {
  return parseDataLiteral(
    extractArray(html, "MACHINERY")
  ) as DocMachineryEntry[];
}

/** Where the scanner stopped, so a page typo names a line rather than an offset. */
function positionOf(source: string, index: number): string {
  const before = source.slice(0, index);
  const line = before.split("\n").length;
  return `line ${line}, column ${index - before.lastIndexOf("\n")}`;
}

/**
 * A JS data literal, parsed rather than evaluated. The subset is exactly what
 * §03 is hand-authored in — JSON plus single-quoted strings, bare keys and
 * trailing commas — because the page stays readable prose-first; JSON quoting
 * would make its 91 KB of column tuples unwritable.
 */
export function parseDataLiteral(source: string): unknown {
  let at = 0;

  const fail = (what: string): never => {
    throw new Error(`ontology page: ${what} at ${positionOf(source, at)}`);
  };

  const skipTrivia = (): void => {
    while (at < source.length && /\s/u.test(source[at]!)) at++;
  };

  const readString = (): string => {
    const quote = source[at];
    at++;
    let out = "";
    while (at < source.length && source[at] !== quote) {
      if (source[at] === "\\") {
        at += 2; // past the backslash and the character it escapes
        const escaped = source[at - 1];
        if (escaped === undefined) fail("a string escape runs off the end");
        if (escaped === "u") {
          const hex = source.slice(at, at + 4);
          if (!/^[0-9a-f]{4}$/iu.test(hex)) fail("a bad \\u escape");
          out += String.fromCodePoint(Number.parseInt(hex, 16));
          at += 4;
        } else {
          // Everything else is the character itself, as JS reads it: `\'` and
          // `\"` close nothing, `\n` is a newline, an unknown escape is literal.
          out +=
            { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" }[escaped!] ??
            escaped;
        }
      } else {
        out += source[at];
        at++;
      }
    }
    if (at >= source.length) fail("a string never closes");
    at++;
    return out;
  };

  const readKey = (): string => {
    if (source[at] === "'" || source[at] === '"') return readString();
    const match = /^[A-Za-z_$][\w$]*/u.exec(source.slice(at));
    if (!match) fail("a property name that is not an identifier or a string");
    at += match![0].length;
    return match![0];
  };

  const readValue = (): unknown => {
    skipTrivia();
    const c = source[at];
    if (c === undefined) return fail("the literal ends early");
    if (c === "[") return readArray();
    if (c === "{") return readObject();
    if (c === "'" || c === '"') return readString();
    for (const [word, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (source.startsWith(word, at)) {
        at += word.length;
        return value;
      }
    }
    // Scanned character by character rather than by regular expression: the
    // input is a 91 KB page and a scanner has no backtracking to reason about.
    const start = at;
    if (source[at] === "-") at++;
    const digits = (): number => {
      const from = at;
      while (at < source.length && source[at]! >= "0" && source[at]! <= "9")
        at++;
      return at - from;
    };
    if (digits() === 0)
      return fail(`\`${c}\` starts no value the page may contain`);
    if (source[at] === ".") {
      at++;
      if (digits() === 0) fail("a number with no digits after its point");
    }
    return Number(source.slice(start, at));
  };

  /** One `,` between entries, one optional before the close, and no more. */
  const readSeparator = (close: string): boolean => {
    skipTrivia();
    if (source[at] === ",") {
      at++;
      skipTrivia();
      return source[at] !== close;
    }
    if (source[at] !== close) fail(`a missing \`,\` before \`${close}\``);
    return false;
  };

  const readArray = (): unknown[] => {
    at++;
    const out: unknown[] = [];
    skipTrivia();
    while (source[at] !== "]") {
      if (at >= source.length) fail("an array never closes");
      out.push(readValue());
      if (!readSeparator("]")) break;
    }
    skipTrivia();
    if (source[at] !== "]") fail("an array never closes");
    at++;
    return out;
  };

  const readObject = (): Record<string, unknown> => {
    at++;
    const out: Record<string, unknown> = {};
    skipTrivia();
    while (source[at] !== "}") {
      if (at >= source.length) fail("an object never closes");
      const key = readKey();
      skipTrivia();
      if (source[at] !== ":") fail(`no \`:\` after \`${key}\``);
      at++;
      // `__proto__` as a plain key: a page entry cannot reach a prototype.
      Object.defineProperty(out, key, {
        value: readValue(),
        writable: true,
        enumerable: true,
        configurable: true,
      });
      if (!readSeparator("}")) break;
    }
    skipTrivia();
    if (source[at] !== "}") fail("an object never closes");
    at++;
    return out;
  };

  const parsed = readValue();
  skipTrivia();
  if (at < source.length) fail("trailing text after the literal");
  return parsed;
}

/** The §03 tuple for one live column, ready to paste into the page. */
export function docColumnTuple(column: DocColumn): string {
  const q = (s: string) => `'${s.replace(/'/gu, "\\'")}'`;
  return `[${q(column.name)},${q(column.type)},${q(column.flags)},${q(column.fk)}, '']`;
}
