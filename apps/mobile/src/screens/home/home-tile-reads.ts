// Every Home springboard read, as a STATEMENT (#708 A, #880; #996 wave 5, R8).
//
// Held apart from `useSpringboardTiles` because the claim these reads make is a
// property of the STATEMENT, not of React: the seat's page reader can be
// pointed straight at them and asked what it runs (`home-tile-reads.test.ts`).
// No runtime imports, so that test costs nothing but SQLite.
//
// TWO SHAPES, AND THE DIFFERENCE IS THE SCREEN'S OWN CLAIM:
//
//  - A TILE IS A WINDOW. "The newest 200 photographs" is what the tile draws
//    and what its count means; walking a real library to the end to render four
//    thumbnails would read the whole library on every focus. These take
//    `useSeatWindow`, one page, and the fact that the rows ran past the window
//    comes back as `truncated` rather than being swallowed — which is exactly
//    what `countCapped` draws.
//  - A BODY LOOKUP IS A SET. The document and note bodies are fetched by the
//    ids the window already named, so the set is bounded by the window and the
//    walk is finite; `idList` builds the `IN (…)` and its binds together.
//
// `from` names the PHYSICAL table because the same statement runs against the
// seat's own file and against the gateway's paged door for a seat that holds
// none (W4-D2), and the door resolves tables and columns before it will run it.

import { inList } from "@centraid/blueprints/apps/_shared/paged-reads";
import type { PageQuery } from "@centraid/core/page";

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
 * The three tiles that mean "the newest": ordered by the column the tile
 * itself sorts on, so the window is the newest rows rather than an arbitrary
 * page the screen re-sorts into a wrong "newest".
 */
export const HOME_ORDERED_TILE_READS = {
  photos: {
    name: "phone.home.photos",
    select: "asset_id, content_id, kind, captured_at",
    from: "media_asset",
    where: "deleted_at IS NULL",
    order: {
      sortColumn: "captured_at",
      pkColumn: "asset_id",
      descending: true,
    },
  },
  documents: {
    name: "phone.home.documents",
    select: "document_id, title, current_content_id, updated_at",
    from: "core_document",
    where: "deleted_at IS NULL",
    order: {
      sortColumn: "updated_at",
      pkColumn: "document_id",
      descending: true,
    },
  },
  notes: {
    name: "phone.home.notes",
    select: "note_id, title, body_content_id, updated_at",
    from: "knowledge_note",
    where: "deleted_at IS NULL",
    order: { sortColumn: "updated_at", pkColumn: "note_id", descending: true },
  },
} satisfies Record<string, PageQuery>;

/**
 * Tiles that fold their whole window in JavaScript — recurrence expansion, an
 * open-task count, a month's sum. They order on the primary key because the
 * fold does the ordering and a sort column nobody reads would only be a second
 * index to keep.
 */
export const HOME_TILE_READS = {
  events: {
    name: "phone.home.events",
    select: "event_id, summary, dtstart, dtend, start_tz, rrule, status",
    from: "core_event",
    order: { sortColumn: "event_id", pkColumn: "event_id", descending: false },
  },
  exceptions: {
    name: "phone.home.exceptions",
    select:
      "exception_id, target_type, target_id, original_start_local, " +
      "recurrence_semantics, scope, action, override_json",
    from: "schedule_recurrence_exception",
    order: {
      sortColumn: "exception_id",
      pkColumn: "exception_id",
      descending: false,
    },
  },
  profiles: {
    name: "phone.home.profiles",
    select: "profile_id, party_id, avatar_color, deleted_at",
    from: "people_profile",
    order: {
      sortColumn: "profile_id",
      pkColumn: "profile_id",
      descending: false,
    },
  },
  tasks: {
    name: "phone.home.tasks",
    select: "task_id, title, status, completed_at, sort_order",
    from: "schedule_task",
    order: { sortColumn: "task_id", pkColumn: "task_id", descending: false },
  },
  vault: {
    name: "phone.home.vault",
    select: "vault_id, base_currency",
    from: "core_vault",
    order: { sortColumn: "vault_id", pkColumn: "vault_id", descending: false },
  },
} satisfies Record<string, PageQuery>;

/** `spent_on` is a day string, so the month bound compares as text. */
export function expenseTileRead(monthStart: string): PageQuery {
  return {
    name: "phone.home.expenses",
    select: "expense_id, amount_minor, spent_on",
    from: "tally_expense",
    where: "deleted_at IS NULL AND spent_on >= ?",
    bind: [monthStart],
    order: {
      sortColumn: "expense_id",
      pkColumn: "expense_id",
      descending: false,
    },
  };
}

/**
 * The rows a window already named, by id.
 *
 * `undefined` for an empty set rather than a statement that matches nothing:
 * an `IN ()` read is a read that should not have been made, and the hooks hold
 * `loading` for a query they have not got their input for yet.
 */
export function idList(
  spec: { name: string; select: string; from: string; column: string },
  ids: readonly string[]
): PageQuery | undefined {
  if (ids.length === 0) return undefined;
  const fragment = inList(spec.column, ids);
  return {
    name: spec.name,
    select: spec.select,
    from: spec.from,
    where: fragment.sql,
    bind: fragment.bind,
    order: {
      sortColumn: spec.column,
      pkColumn: spec.column,
      descending: false,
    },
  };
}

/** Document and note bodies: the prose excerpt and the byte size. */
export const HOME_BODY_LOOKUP = {
  name: "phone.home.bodies",
  select: "content_id, content_uri, byte_size",
  from: "core_content_item",
  column: "content_id",
} as const;

/** The names behind the profile discs the People tile draws. */
export const HOME_PARTY_LOOKUP = {
  name: "phone.home.parties",
  select: "party_id, display_name",
  from: "core_party",
  column: "party_id",
} as const;
