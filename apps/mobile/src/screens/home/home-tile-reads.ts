// Every Home springboard read, as data (#708 A, #880).
//
// Held apart from `useSpringboardTiles` because the claim these requests make
// is a property of the REQUEST, not of React: the mounted reader can be
// pointed straight at them and asked what SQL it emits
// (`home-tile-reads.test.ts`). No runtime imports, so that test costs nothing
// but SQLite.
//
// Two separate bounds are at work, and only one of them used to hold:
//
//  - Every read carries an explicit `limit`, because an unbounded read
//    silently defaults to 1000 rows (packages/client/src/replica/query.ts).
//  - A limit bounds the ANSWER. It bounds the WORK only where the mounted
//    reader can page inside SQLite (lib/replica/replica-read-pushdown.ts):
//    every `where` clause must push, and an ordered read additionally needs a
//    disclosed, type-uniform order column, an exposed scalar primary key, and
//    an entity that carries no content hash — equal bytes in two scopes
//    collapse into one badged row, so a per-scope page could drop the
//    duplicate that supplies a badge.
//
// `media.asset`, `core.document` and `knowledge.note` each clear that bar:
// single-column TEXT keys, TEXT order columns, no `sha256`. `core.content_item`
// does NOT — it is the content-hashed entity — which is why the document and
// note BODIES are fetched by id (`idFilter`) rather than ordered: an id filter
// pushes as a predicate and costs the ids asked for, with or without a page.
import type { NativeReadRequest } from "../../lib/replica/native-session";

export const HOME_TILE_LIMITS = {
  documents: 300,
  events: 500,
  exceptions: 500,
  expenses: 500,
  notes: 300,
  photos: 200,
  profiles: 300,
  tasks: 500,
  vaults: 4,
} as const;

/**
 * The three tiles that mean "the newest". Each one pages per scope inside
 * SQLite, so it costs its page rather than the library; the evaluator still
 * re-sorts the union and remains the authority on the final order.
 */
export const HOME_ORDERED_TILE_READS = {
  photos: {
    entity: "media.asset",
    where: [{ column: "deleted_at", op: "is-null" }],
    orderBy: { column: "captured_at", dir: "desc" },
    limit: HOME_TILE_LIMITS.photos,
  },
  documents: {
    entity: "core.document",
    where: [{ column: "deleted_at", op: "is-null" }],
    orderBy: { column: "updated_at", dir: "desc" },
    limit: HOME_TILE_LIMITS.documents,
  },
  notes: {
    entity: "knowledge.note",
    where: [{ column: "deleted_at", op: "is-null" }],
    orderBy: { column: "updated_at", dir: "desc" },
    limit: HOME_TILE_LIMITS.notes,
  },
} satisfies Record<string, NativeReadRequest>;

/**
 * Tiles that fold their whole bounded set in JavaScript — recurrence
 * expansion, an open-task count, a month's sum — so they ask for no order and
 * take an arbitrary bounded page.
 */
export const HOME_TILE_READS = {
  events: { entity: "core.event", limit: HOME_TILE_LIMITS.events },
  exceptions: {
    entity: "schedule.recurrence_exception",
    limit: HOME_TILE_LIMITS.exceptions,
  },
  profiles: { entity: "people.profile", limit: HOME_TILE_LIMITS.profiles },
  tasks: { entity: "schedule.task", limit: HOME_TILE_LIMITS.tasks },
  vault: { entity: "core.vault", limit: HOME_TILE_LIMITS.vaults },
} satisfies Record<string, NativeReadRequest>;

/** `spent_on` is a day string, so the month bound compares as text. */
export function expenseTileRead(monthStart: string): NativeReadRequest {
  return {
    entity: "tally.expense",
    where: [
      { column: "deleted_at", op: "is-null" },
      { column: "spent_on", op: "gte", value: monthStart },
    ],
    limit: HOME_TILE_LIMITS.expenses,
  };
}

/** Bounded: an unbounded second read blows past the 1000-row default. */
export function idFilter(
  entity: string,
  column: string,
  ids: readonly string[]
): NativeReadRequest {
  return ids.length === 0
    ? { entity, where: [{ column, op: "eq", value: "__none__" }], limit: 1 }
    : {
        entity,
        where: [{ column, op: "in", value: [...ids] }],
        limit: Math.max(ids.length, 1),
      };
}
