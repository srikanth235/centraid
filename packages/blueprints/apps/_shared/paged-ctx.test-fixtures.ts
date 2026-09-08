/**
 * THE PAGED DOOR, IN A HANDLER TEST (#996 wave 4, R8).
 *
 * Every app's handler tests already hold fixtures keyed by ENTITY —
 * `"core.tag"`, `"knowledge.note"` — because that is what the declarative read
 * took. A paged statement names the PHYSICAL TABLE instead (`core_tag`), since
 * the same statement runs on the seat's own file and on the gateway's paged
 * door. Rather than restate every fixture map in the new spelling, the two are
 * bridged in ONE place: the first underscore becomes the dot.
 *
 * The page served is always the LAST one. A fixture map is small, so a handler
 * that walked a second page would be walking a set it never bounded, and the
 * absent cursor is what stops it rather than a fixture that repeats itself.
 *
 * The statements are recorded because they are the thing worth asserting: a
 * page's window is required by its type, so what a test can still get wrong is
 * the cursor — an order whose columns the projection does not carry.
 */

/** One handler statement, as `ctx.vault.page` receives it. */
export interface PagedStatement {
  name: string;
  select: string;
  from: string;
  where?: string;
  bind?: readonly (string | number | null)[];
  order: { sortColumn: string; pkColumn: string; descending: boolean };
}

export interface PageCursorish {
  sortKey: string;
  pk: string;
}

export interface PagedFixture {
  page: (request: {
    query: PagedStatement;
    limit: number;
    after?: PageCursorish;
  }) => Promise<{ rows: Record<string, unknown>[]; next?: PageCursorish }>;
  /** Every statement the handler asked for, in order. */
  statements: PagedStatement[];
  /** Predicates outside the fixture's grammar, so a test can see them. */
  unapplied: string[];
}

/** The table a statement reads, ignoring any JOIN or alias after it. */
export function tableOf(from: string): string {
  return from.trim().split(/\s+/u)[0] ?? from;
}

/**
 * THE FIXTURE HONOURS THE PREDICATE (#996 wave 4).
 *
 * A handler that trusted its `where` and did not re-narrow in memory used to
 * be caught by a fixture that DIDN'T filter. The mirror mistake is worse and
 * newer: a fixture that ignores the predicate hands a handler rows its
 * statement excluded, and a window built out of ids it never asked for reads
 * as an answer.
 *
 * So the small conjunctive grammar the handlers actually write is evaluated
 * here — `col = ?`, the comparisons, `col IN (?, …)`, `col IS [NOT] NULL`,
 * ANDed — with the binds consumed positionally, exactly as SQLite consumes
 * them. A clause outside that grammar is left UNAPPLIED and recorded, so a
 * test asserting on a predicate this cannot evaluate can see that it did not.
 */
const CLAUSE =
  /^\s*(?<column>[a-z_][a-z0-9_]*)\s*(?<operator>is\s+not\s+null|is\s+null|in|<>|!=|>=|<=|>|<|=)\s*(?<argument>\(\s*\?(?:\s*,\s*\?)*\s*\)|\?)?\s*$/iu;

function applyWhere(
  rows: Record<string, unknown>[],
  where: string | undefined,
  bind: readonly (string | number | null)[],
  unapplied: string[]
): Record<string, unknown>[] {
  if (!where) return rows;
  let at = 0;
  let kept = rows;
  for (const clause of where.split(/\s+and\s+/iu)) {
    const parsed = CLAUSE.exec(clause);
    if (!parsed) {
      unapplied.push(clause.trim());
      // The binds this clause would have eaten are gone with it, so nothing
      // after it can be trusted either.
      return kept;
    }
    const {
      column = "",
      operator: rawOperator = "",
      argument,
    } = parsed.groups ?? {};
    const operator = rawOperator.toLowerCase().replaceAll(/\s+/gu, " ");
    if (operator === "is null" || operator === "is not null") {
      const wantNull = operator === "is null";
      kept = kept.filter(
        (row) =>
          (row[column] === null || row[column] === undefined) === wantNull
      );
      continue;
    }
    if (operator === "in") {
      const count = (argument ?? "").split("?").length - 1;
      const values = bind.slice(at, at + count);
      at += count;
      kept = kept.filter((row) => values.includes(row[column] as never));
      continue;
    }
    const value = bind[at];
    at += 1;
    kept = kept.filter((row) => {
      const cell = row[column];
      if (operator === "=") return cell === value;
      if (operator === "<>" || operator === "!=") return cell !== value;
      if (cell == null || value == null) return false;
      if (operator === ">") return cell > value;
      if (operator === ">=") return cell >= value;
      if (operator === "<") return cell < value;
      return cell <= value;
    });
  }
  return kept;
}

export interface PagedFixtureOptions {
  /**
   * Entities whose page throws the way a refused grant does. A denial is a
   * FIRST-CLASS answer on these handlers — a parked scope must cost a shelf,
   * never the whole screen — so it has to be reachable through the door the
   * handler actually uses.
   */
  deniedEntities?: ReadonlySet<string>;
  /**
   * Rows for one named statement, ahead of the entity map. A statement's own
   * `where` is SQL, and a fixture that pretended to evaluate it would be
   * asserting its own parser; naming the handler is how a test says "these are
   * the rows THIS read returns".
   */
  byHandler?: Record<string, unknown[]>;
}

/**
 * THE FIXTURE PAGES FOR REAL.
 *
 * Ordering, the keyset and the window are the three things a handler now hands
 * the host, and a fixture that ignored them could not tell a handler that asked
 * for 200 rows from one that asked for all of them. So the rows are sorted by
 * the statement's own two columns, the cursor is applied as the row value
 * `(sort, pk)` comparison the assembler emits, and `next` appears exactly when
 * a row was left behind — which is what a handler reads as `truncated`.
 */
function pageOfRows(
  rows: Record<string, unknown>[],
  query: PagedStatement,
  limit: number,
  after?: PageCursorish
): { rows: Record<string, unknown>[]; next?: PageCursorish } {
  const { sortColumn, pkColumn, descending } = query.order;
  const keyOf = (row: Record<string, unknown>): [string, string] => [
    row[sortColumn] == null ? "" : String(row[sortColumn]),
    String(row[pkColumn] ?? ""),
  ];
  const compare = (
    a: Record<string, unknown>,
    b: Record<string, unknown>
  ): number => {
    const [as, ap] = keyOf(a);
    const [bs, bp] = keyOf(b);
    const order = as < bs ? -1 : as > bs ? 1 : ap < bp ? -1 : ap > bp ? 1 : 0;
    return descending ? -order : order;
  };
  const ordered = [...rows].sort(compare);
  const past = after
    ? ordered.filter((row) => {
        const [sortKey, pk] = keyOf(row);
        const beyond =
          sortKey === after.sortKey ? pk > after.pk : sortKey > after.sortKey;
        return descending
          ? !beyond && !(sortKey === after.sortKey && pk === after.pk)
          : beyond;
      })
    : ordered;
  const window = past.slice(0, limit);
  const last = window.at(-1);
  if (past.length <= limit || !last) return { rows: window };
  const [sortKey, pk] = keyOf(last);
  return { rows: window, next: { sortKey, pk } };
}

/** A `ctx.vault.page` that answers from entity-keyed fixtures. */
export function pagedFixture(
  rowsByEntity: Record<string, unknown[]>,
  options: PagedFixtureOptions = {}
): PagedFixture {
  const statements: PagedStatement[] = [];
  const unapplied: string[] = [];
  return {
    statements,
    unapplied,
    page: async (request) => {
      statements.push(request.query);
      const table = tableOf(request.query.from);
      const entity = table.replace("_", ".");
      if (options.deniedEntities?.has(entity))
        throw Object.assign(new Error("scope awaiting owner approval"), {
          code: "VAULT_ACCESS",
        });
      const rows = (options.byHandler?.[request.query.name] ??
        rowsByEntity[table] ??
        rowsByEntity[entity] ??
        []) as Record<string, unknown>[];
      return pageOfRows(
        applyWhere(
          rows,
          request.query.where,
          request.query.bind ?? [],
          unapplied
        ),
        request.query,
        request.limit,
        request.after
      );
    },
  };
}
