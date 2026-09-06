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
