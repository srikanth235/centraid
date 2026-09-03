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
