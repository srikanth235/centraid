// The mocked `ctx` a blueprint query handler runs against — the same shape the
// dispatcher hands a real one, with `ctx.time` wired to the shared civil-time
// engine so a handler's recurrence and occurrence reads are the product's, not
// a stub's.
//
// Shared by `query-handlers.test.ts` and `query-handlers-996.test.ts`: one
// builder, so two suites cannot disagree about what a handler is handed.

import {
  applyRecurrenceExceptions,
  collapseMissedOccurrences,
  describeRecurrence,
  expandRecurrence,
  occurrenceExceptionsOf,
  overrideAt,
  recurrenceExceptionsOf,
  shiftTemporal,
} from "@centraid/core/time";

/**
 * A page's rows come from the SAME fixture map the declarative reads used
 * (#996 wave 4): a statement names the physical table, so `core_concept` is
 * looked up as `core.concept` — one fixture per entity, whichever door the
 * handler goes through. A table key may also be given verbatim for a statement
 * whose `from` carries a JOIN.
 */
function pageRowsFor(
  rowsByEntity: Record<string, unknown[]>,
  from: string
): unknown[] {
  const verbatim = rowsByEntity[from];
  if (verbatim) return verbatim;
  const table = from.trim().split(/\s+/u)[0] ?? from;
  return rowsByEntity[table] ?? rowsByEntity[table.replace("_", ".")] ?? [];
}

/** A mock ctx.vault that returns fixture rows keyed by entity name. */
export function queryHandlerCtx(rowsByEntity: Record<string, unknown[]>) {
  return {
    time: {
      applyRecurrenceExceptions,
      collapseMissedOccurrences,
      describeRecurrence,
      expandRecurrence,
      occurrenceExceptionsOf,
      overrideAt,
      recurrenceExceptionsOf,
      shiftTemporal,
    },
    vault: {
      // One page, and it is the last one: the fixtures are small, so a
      // handler that asked for a second page would be walking a set it did
      // not bound, and the missing `next` is what stops it.
      page: async ({ query }: { query: { from: string } }) => ({
        rows: pageRowsFor(rowsByEntity, query.from),
      }),
      read: async ({ entity }: { entity: string }) => ({
        rows: rowsByEntity[entity] ?? [],
      }),
      resolve: async () => ({ cards: [] }),
      invoke: async () => ({ status: "executed", output: { items: [] } }),
      search: async () => ({ rows: rowsByEntity.__search__ ?? [] }),
      // Companion/query tests default to an unlocked Locker; lock gates are
      // covered by vault unit tests of LockerAuthentication.
      authenticate: async () => ({
        ok: true,
        configured: false,
        authenticated: false,
        unlocked: true,
      }),
    },
  };
}
