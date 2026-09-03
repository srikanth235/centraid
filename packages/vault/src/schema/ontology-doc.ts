import type { DatabaseSync } from "node:sqlite";

import { MACHINERY_BANDS, ONTOLOGY_PACKS } from "./atlas.js";
import { AUDIT_BAND_TABLES } from "./audit.js";
import { LEDGER_BAND_TABLES } from "./ledger.js";
import { VAULT_TABLES } from "./tables.js";

export interface DocColumn {
  name: string;
  type: string;
  flags: string;
  fk: string;
}

export interface DocTable {
  schema: string;
  table: string;
  cols: DocColumn[];
}

export const ONTOLOGY_DOC_SCHEMAS: readonly string[] = [
  ...ONTOLOGY_PACKS,
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

export function liveMachineryTables(): Record<string, readonly string[]> {
  const bands: [string, readonly string[]][] = MACHINERY_BANDS.map((band) => {
    if (band === "audit") return [band, AUDIT_BAND_TABLES];
    if (band === "ledger") return [band, LEDGER_BAND_TABLES];
    return [
      band,
      [...(VAULT_TABLES[band] ?? [])].filter(
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
  return html.slice(start + `const ${name} =`.length, end + 2);
}

export function parseOntologyDocSchemas(html: string): DocSchemaEntry[] {
  return parseDataLiteral(extractArray(html, "SCHEMAS")) as DocSchemaEntry[];
}

export function parseOntologyDocMachinery(html: string): DocMachineryEntry[] {
  return parseDataLiteral(
    extractArray(html, "MACHINERY")
  ) as DocMachineryEntry[];
}

function positionOf(source: string, index: number): string {
  const before = source.slice(0, index);
  const line = before.split("\n").length;
  return `line ${line}, column ${index - before.lastIndexOf("\n")}`;
}

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

export function docColumnTuple(column: DocColumn): string {
  const q = (s: string) => `'${s.replace(/'/gu, "\\'")}'`;
  return `[${q(column.name)},${q(column.type)},${q(column.flags)},${q(column.fk)}, '']`;
}
