/*
 * THE PAGED DOOR (#996 wave 4, ruling W4-D2).
 *
 * A seat that holds the vault file runs an app handler's statement on the
 * seat. A seat that chose to hold no file — the browser that turned "Keep an
 * offline copy" off, R9 — has nowhere to run it, and the answer is NOT to give
 * that seat a second, unpaged read path: it is to serve the SAME
 * statement-as-data here, under the caller's own principal.
 *
 * W4-D2, in one sentence: an app handler's statement never runs on the gateway
 * as raw SQL. `evaluateAccess`, the R17 field mask and the manifest row filters
 * apply to it exactly as they apply to `gateway.read`, and there is no argument
 * that turns them off.
 *
 * WHY THIS IS A GRAMMAR AND NOT A SANITISER. A statement the door cannot take
 * apart is a statement the door cannot check: to apply a field mask it must
 * know which columns are projected, and to apply a row filter it must know
 * which tables are read. Escaping strings would answer neither question. So the
 * statement's three text parts are parsed against a deliberately small grammar
 * — a FROM that is tables and equijoins, a SELECT and a WHERE that are column
 * references, placeholders, literals and a fixed operator set — and anything
 * outside it is REFUSED rather than repaired. A subquery, a second statement, a
 * comment, a function the list does not name: all refused. That costs handlers
 * some expressiveness, and the alternative costs the vault its field mask.
 *
 * WHAT THE DOOR DOES NOT DO. It does not widen: the row filters it splices in
 * are ANDed, never ORed, and a table whose access decision is `deny` refuses
 * the whole page rather than being dropped from the join — a join silently
 * missing a table returns rows that look like an answer.
 */

import type { DatabaseSync } from "node:sqlite";

import type { PageOrder } from "@centraid/core/page";

import { sealedColumnsOf } from "../schema/sealed.js";
import { listVaultEntities, resolveEntity } from "../schema/tables.js";
import { evaluateAccess } from "./access.js";
import { columnIsNullable, compileFilters, tableColumns } from "./filters.js";
import type { FilterClause, Identity } from "./types.js";
import { GatewayError } from "./types.js";

/** One table a statement reads, resolved and access-checked. */
export interface PagedDoorTable {
  /** The alias the statement refers to it by; the physical name when none. */
  alias: string;
  physical: string;
  /** The logical `schema.table` the access decision was taken on. */
  entity: string;
  fieldMask: string[] | null;
  rowFilter: FilterClause[];
  authorityId: string | null;
  columns: ReadonlySet<string>;
  /** Never projectable: a page is a read, and plaintext takes `reveal` (#293). */
  sealed: readonly string[];
}

/** The door's verdict on one statement, before it is assembled. */
export interface PagedDoorPlan {
  tables: PagedDoorTable[];
  /** The row filters of every table, compiled and ANDed. */
  where: string;
  bind: (string | number | null)[];
}

/**
 * Words a statement may use that are not column references. Deliberately
 * short: every addition is a new thing the grammar has to be sure of, and the
 * handlers that exist need none of the rest of SQL.
 */
const ALLOWED_WORDS = new Set([
  "and",
  "or",
  "not",
  "is",
  "null",
  "in",
  "between",
  "like",
  "case",
  "when",
  "then",
  "else",
  "end",
  "as",
  "coalesce",
  "cast",
  "text",
  "integer",
  "real",
  "distinct",
  "count",
  "min",
  "max",
  "sum",
  "abs",
  "length",
  "substr",
  "lower",
  "upper",
  "ifnull",
  "nullif",
  "json_extract",
  "true",
  "false",
]);

/** Punctuation and operators the grammar accepts, longest first. */
const OPERATORS = [
  "<=",
  ">=",
  "<>",
  "!=",
  "||",
  "=",
  "<",
  ">",
  "+",
  "-",
  "*",
  "/",
  "(",
  ")",
  ",",
  "?",
];

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function refuse(name: string, why: string): never {
  throw new GatewayError(
    "access",
    `paged door refuses handler "${name}": ${why}`
  );
}

/**
 * Split one text part into tokens, refusing anything the grammar has no token
 * for. A comment, a semicolon or a string containing either is a refusal here,
 * before any table has been resolved — the cheapest place to say no.
 */
function tokenize(name: string, part: string, label: string): string[] {
  if (part.includes(";") || part.includes("--") || part.includes("/*"))
    refuse(name, `${label} contains a comment or a statement separator`);
  const tokens: string[] = [];
  let index = 0;
  while (index < part.length) {
    const char = part[index]!;
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === "'") {
      const close = part.indexOf("'", index + 1);
      if (close === -1) refuse(name, `${label} has an unterminated string`);
      tokens.push(part.slice(index, close + 1));
      index = close + 1;
      continue;
    }
    if (/[0-9]/u.test(char)) {
      const match = /^[0-9]+(?<fraction>\.[0-9]+)?/u.exec(part.slice(index))!;
      tokens.push(match[0]);
      index += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/u.test(char)) {
      const match =
        /^[A-Za-z_][A-Za-z0-9_]*(?<qualified>\.[A-Za-z_][A-Za-z0-9_]*)?/u.exec(
          part.slice(index)
        )!;
      tokens.push(match[0]);
      index += match[0].length;
      continue;
    }
    const operator = OPERATORS.find((op) => part.startsWith(op, index));
    if (!operator)
      refuse(
        name,
        `${label} contains ${JSON.stringify(char)}, which the door's grammar has no token for`
      );
    tokens.push(operator);
    index += operator.length;
  }
  return tokens;
}

/**
 * The FROM clause, as tables and equijoins.
 *
 * `table [AS alias] [ [LEFT|INNER] JOIN table [AS alias] ON <condition> ]*`,
 * and the condition goes through the same checks as the WHERE — it is a
 * predicate over the same columns, so it gets the same grammar and the same
 * field mask.
 */
interface FromPart {
  physical: string;
  alias: string;
}

function parseFrom(
  name: string,
  from: string
): { parts: FromPart[]; conditions: string[] } {
  if (from.includes(";") || from.includes("--") || from.includes("/*"))
    refuse(name, "FROM contains a comment or a statement separator");
  if (from.includes("("))
    refuse(
      name,
      "FROM contains a subquery; the door runs statements over tables it can name"
    );
  const parts: FromPart[] = [];
  const conditions: string[] = [];
  // Split on the JOIN keyword, keeping the join kind out of the way: the door
  // treats every join the same, because the access decision does not depend on
  // whether a missing row becomes NULL or removes the pair.
  const segments = from.split(/\s+(?:left\s+|inner\s+|cross\s+)?join\s+/iu);
  segments.forEach((segment, position) => {
    const [source, condition] = position === 0 ? [segment] : splitOn(segment);
    if (position > 0) {
      if (!condition) refuse(name, "a JOIN in FROM has no ON condition");
      conditions.push(condition);
    }
    const words = source.trim().split(/\s+/u).filter(Boolean);
    const [table, ...rest] = words;
    if (!table || !IDENT.test(table))
      refuse(
        name,
        `FROM names ${JSON.stringify(source.trim())}, which is not a table`
      );
    const alias =
      rest.length === 0
        ? table
        : rest.length === 1 && IDENT.test(rest[0]!)
          ? rest[0]!
          : rest.length === 2 &&
              rest[0]!.toLowerCase() === "as" &&
              IDENT.test(rest[1]!)
            ? rest[1]!
            : refuse(
                name,
                `FROM has an alias the door cannot read: ${source.trim()}`
              );
    parts.push({ physical: table, alias });
  });
  return { parts, conditions };
}

function splitOn(segment: string): [string, string | undefined] {
  const match = /\s+on\s+/iu.exec(segment);
  if (!match) return [segment, undefined];
  return [
    segment.slice(0, match.index),
    segment.slice(match.index + match[0].length),
  ];
}

/** Physical table name → logical entity, built from the registry once. */
function entityByPhysical(vault: DatabaseSync): Map<string, string> {
  const map = new Map<string, string>();
  for (const logical of listVaultEntities(vault)) {
    const ref = resolveEntity(logical, vault);
    if (ref) map.set(ref.physical, logical);
  }
  return map;
}

/**
 * Every column reference a text part makes, as written.
 *
 * A word that is not in `ALLOWED_WORDS`, is not a literal and is not followed
 * by `(` is a column. A word the list does not name that IS followed by `(` is
 * an unknown function, which is a refusal rather than a column: SQLite has
 * functions that read files.
 */
function columnRefs(name: string, tokens: string[], label: string): string[] {
  const refs: string[] = [];
  tokens.forEach((token, index) => {
    if (OPERATORS.includes(token)) return;
    if (token.startsWith("'") || /^[0-9]/u.test(token)) return;
    const lower = token.toLowerCase();
    const isCall = tokens[index + 1] === "(";
    if (isCall) {
      if (!ALLOWED_WORDS.has(lower))
        refuse(
          name,
          `${label} calls ${token}, which is not on the door's list`
        );
      return;
    }
    if (ALLOWED_WORDS.has(lower) && !token.includes(".")) return;
    refs.push(token);
  });
  return refs;
}

/**
 * Resolve one column reference to its table, and check the field mask.
 *
 * An unqualified column on a multi-table statement is REFUSED rather than
 * guessed: two tables with a `title` each would make the guess wrong exactly
 * where it matters, and a handler that says which one it means costs one word.
 */
function checkColumn(
  name: string,
  ref: string,
  tables: PagedDoorTable[],
  label: string
): void {
  const dot = ref.indexOf(".");
  if (dot > 0) {
    const alias = ref.slice(0, dot);
    const column = ref.slice(dot + 1);
    const table = tables.find((candidate) => candidate.alias === alias);
    if (!table)
      refuse(name, `${label} reads ${ref}, but the statement has no ${alias}`);
    if (!table.columns.has(column))
      refuse(
        name,
        `${label} reads ${ref}, which ${table.physical} has not got`
      );
    if (table.fieldMask !== null && !table.fieldMask.includes(column))
      refuse(
        name,
        `${label} reads ${ref}, which this caller's field mask does not carry`
      );
    if (table.sealed.includes(column))
      refuse(
        name,
        `${label} reads ${ref}, which is sealed; plaintext takes reveal`
      );
    return;
  }
  const owners = tables.filter((table) => table.columns.has(ref));
  if (owners.length === 0)
    refuse(name, `${label} reads ${ref}, which no table in the statement has`);
  if (owners.length > 1)
    refuse(
      name,
      `${label} reads ${ref} unqualified and more than one table has it`
    );
  const owner = owners[0]!;
  if (owner.fieldMask !== null && !owner.fieldMask.includes(ref))
    refuse(
      name,
      `${label} reads ${ref}, which this caller's field mask does not carry`
    );
  if (owner.sealed.includes(ref))
    refuse(
      name,
      `${label} reads ${ref}, which is sealed; plaintext takes reveal`
    );
}

/**
 * A CONTINUATION OVER A NULLABLE SORT COLUMN IS REFUSED (#1020, R-1020-35).
 *
 * The keyset is a row value: `(sort, pk) < (?, ?)`. SQLite compares a row
 * value containing a NULL operand to NULL, which is not true, so a row whose
 * sort key is NULL is excluded from EVERY page after the first — the walk
 * returns a short page, the cursor says the rows ended, and nothing anywhere
 * says rows were dropped. That is a wrong answer with no error message, and it
 * is the one failure mode of the paged door that neither the grammar nor the
 * access decision could see.
 *
 * WHY THE FIRST PAGE IS LEFT ALONE. Without a cursor there is no row-value
 * comparison and the ordering is total — SQLite sorts NULL as the smallest
 * value, consistently, in both directions — so page one is correct today and
 * refusing it would remove rows a member can currently see (an undated photo
 * in a small library sorts last under `captured_at DESC` and shows up fine).
 * The bug is the CONTINUATION, so the continuation is what refuses.
 *
 * WHY NOT COALESCE IT. Coalescing in the ORDER BY makes the sort key an
 * expression, and a SELECT alias cannot be named in a WHERE, so the keyset
 * could not be written against it at all: the walk would have to fall back to
 * OFFSET, which is the thing `packages/core/src/page/window.ts` exists to
 * prevent. A named refusal is the honest answer.
 *
 * A handler whose sort column is declared nullable but whose own predicate
 * proves it is not — `deleted_at IS NOT NULL` on a trash shelf — is accepted:
 * the proof is syntactic and checked here, in the same place as the schema.
 */
function checkSortColumn(
  vault: DatabaseSync,
  name: string,
  order: PageOrder,
  where: string,
  tables: PagedDoorTable[]
): void {
  const dot = order.sortColumn.indexOf(".");
  const column = dot > 0 ? order.sortColumn.slice(dot + 1) : order.sortColumn;
  const owner =
    dot > 0
      ? tables.find((table) => table.alias === order.sortColumn.slice(0, dot))
      : tables.find((table) => table.columns.has(column));
  if (!owner) return; // `checkColumn` has already refused an unresolvable ref.
  if (!columnIsNullable(vault, owner.physical, column)) return;
  const proven = new RegExp(
    `\\b${column.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s+IS\\s+NOT\\s+NULL\\b`,
    "iu"
  ).test(where);
  if (proven) return;
  refuse(
    name,
    `continues from a cursor on ${owner.physical}.${column}, which is nullable; a row value with a NULL operand compares to NULL, so every later page would silently drop those rows`
  );
}

/**
 * Plan one statement: resolve its tables, take an access decision on each, and
 * compile every table's row filters into the predicate the assembler splices
 * in beside the handler's own.
 */
export function planPagedDoor(
  vault: DatabaseSync,
  identity: Identity,
  query: {
    name: string;
    select: string;
    from: string;
    where?: string;
    order: PageOrder;
  },
  now: string,
  /** True when the request carries a cursor — see `checkSortColumn`. */
  continues = false
): PagedDoorPlan {
  const { name } = query;
  const { parts, conditions } = parseFrom(name, query.from);
  if (parts.length === 0) refuse(name, "FROM names no table");
  const byPhysical = entityByPhysical(vault);
  const tables: PagedDoorTable[] = parts.map((part) => {
    const entity = byPhysical.get(part.physical);
    if (!entity)
      refuse(
        name,
        `FROM names ${part.physical}, which is not an entity of this vault`
      );
    const ref = resolveEntity(entity, vault)!;
    const access = evaluateAccess(
      vault,
      identity,
      ref.schema,
      ref.table,
      "read"
    );
    if (access.decision === "deny")
      refuse(name, `${entity}: ${access.failing}`);
    return {
      alias: part.alias,
      physical: part.physical,
      entity,
      fieldMask: access.fieldMask,
      rowFilter: access.rowFilter,
      authorityId: access.authorityId,
      columns: tableColumns(vault, part.physical),
      sealed: sealedColumnsOf(entity, vault),
    };
  });
  const aliases = new Set(tables.map((table) => table.alias));
  if (aliases.size !== tables.length)
    refuse(name, "two tables in FROM answer to the same name");

  for (const [label, part] of [
    ["SELECT", query.select],
    ["WHERE", query.where ?? ""],
    ...conditions.map((condition) => ["ON", condition] as const),
  ] as [string, string][]) {
    if (part.trim() === "") continue;
    const tokens = tokenize(name, part, label);
    if (tokens.some((token) => token.toLowerCase() === "select"))
      refuse(name, `${label} contains a nested SELECT`);
    for (const ref of columnRefs(name, tokens, label))
      checkColumn(name, ref, tables, label);
  }

  // The keyset's own soundness, checked against the schema rather than hoped
  // for (#1020, R-1020-35). Only a continuation can drop rows, so only a
  // continuation refuses.
  if (continues)
    checkSortColumn(vault, name, query.order, query.where ?? "", tables);

  // The row filters of EVERY table, ANDed. A table whose grant carries a
  // filter carries it wherever it is read from, including the far side of a
  // join — that is what makes a join no wider than the reads it is made of.
  const fragments: string[] = [];
  const bind: (string | number | null)[] = [];
  for (const table of tables) {
    if (table.rowFilter.length === 0) continue;
    const compiled = compileFilters(
      vault,
      table.physical,
      table.rowFilter,
      now,
      table.alias
    );
    fragments.push(`(${compiled.where})`);
    bind.push(...(compiled.params as (string | number | null)[]));
  }
  return { tables, where: fragments.join(" AND "), bind };
}
