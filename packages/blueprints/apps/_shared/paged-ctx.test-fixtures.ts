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

export interface PagedFixture {
  page: (request: {
    query: PagedStatement;
    limit: number;
  }) => Promise<{ rows: Record<string, unknown>[] }>;
  /** Every statement the handler asked for, in order. */
  statements: PagedStatement[];
}

/** The table a statement reads, ignoring any JOIN or alias after it. */
export function tableOf(from: string): string {
  return from.trim().split(/\s+/u)[0] ?? from;
}

/**
 * A `ctx.vault.page` that answers from entity-keyed fixtures.
 *
 * `deny` makes every page throw the way a refused grant does, so a handler's
 * denial branch is exercised through the door it now actually uses.
 */
export function pagedFixture(
  rowsByEntity: Record<string, unknown[]>,
  deny?: () => never
): PagedFixture {
  const statements: PagedStatement[] = [];
  return {
    statements,
    page: async (request) => {
      statements.push(request.query);
      if (deny) deny();
      const table = tableOf(request.query.from);
      const rows = rowsByEntity[table] ?? rowsByEntity[table.replace("_", ".")];
      return { rows: (rows ?? []) as Record<string, unknown>[] };
    },
  };
}
