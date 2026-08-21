// The twelve routes of the Tasks room, the compact band's four destinations,
// and the route round trip (Tasks spec §1, §2).
//
// The structure — id model, route round trip, band tab — is
// `_shared/shelves.ts`, because Tasks is a route inside the same frame Docs and
// Photos are routes inside, and a member should not have to learn a third
// navigation model. This file is Tasks' TABLES.
//
// A SHELF HERE IS A PLACE OR A LENS, never a mode. `tasks/task` is the editor,
// which is a screen the member lands on and backs out of — so it is a routed
// shelf like the rest rather than an overlay pretending not to be a route.
import { createShelfRoutes, tokenFromShelf } from "../_shared/shelves.ts";
import type { BandDestination, Shelf, ShelfId } from "../_shared/shelves.ts";

export type { Shelf, ShelfId } from "../_shared/shelves.ts";

// The `built-in:` prefix can never collide with a project id, which is an
// opaque token carrying no colon — the one-slot trick `docs/shelves.ts` uses.
export const UPCOMING = "built-in:upcoming";
export const ANYTIME = "built-in:anytime";
export const ALL = "built-in:all";
export const INBOX = "built-in:inbox";
export const PROJECTS = "built-in:projects";
/** One project with no id yet — the route the rail lands on before a project
 *  is named. A project WITH an id is the dynamic family below. */
export const PROJECT = "built-in:project";
/** The editor. A screen, not a drawer (§1). */
export const TASK = "built-in:task";
/** The pressure valve (§"The five rulings", ruling 2) — reachable any day. */
export const REENTRY = "built-in:reentry";
export const LOGBOOK = "built-in:logbook";
export const SEARCH = "built-in:search";
/** The reminder surface. Drawn on every seat; only the phone can fire one. */
export const NOTIFY = "built-in:notify";

const PROJECT_PREFIX = "project:";

/** The shelf id for one project, from its project id. */
export function projectShelf(projectId: string): string {
  return `${PROJECT_PREFIX}${projectId}`;
}

/** The project id behind a project shelf, or null for any other shelf. */
export function projectIdFrom(id: ShelfId): string | null {
  return tokenFromShelf(PROJECT_PREFIX, id);
}

/**
 * Every routed shelf, in the spec's own order. `null` is Today: `tasks` IS
 * Today, which is why it carries the empty segment rather than a `today` one.
 */
export const TASK_SHELVES: readonly Shelf[] = [
  { id: null, label: "Today", segment: "" },
  { id: UPCOMING, label: "Upcoming", segment: "upcoming" },
  { id: ANYTIME, label: "Anytime", segment: "anytime" },
  { id: ALL, label: "All", segment: "all" },
  { id: INBOX, label: "Inbox", segment: "inbox" },
  { id: PROJECTS, label: "Projects", segment: "projects" },
  { id: PROJECT, label: "Project", segment: "project" },
  { id: TASK, label: "Task", segment: "task" },
  { id: REENTRY, label: "Catch up", segment: "reentry" },
  { id: LOGBOOK, label: "Logbook", segment: "logbook" },
  { id: SEARCH, label: "Search", segment: "search" },
  { id: NOTIFY, label: "Reminder", segment: "notify" },
];

/** The band's id for the root shelf, whose segment is empty. Accepted as a
 *  segment synonym too, so a band id round-trips. */
const TODAY_ID = "today";

/**
 * The band Tasks claims (§2): four PLACES plus More. Anytime, All, Search, the
 * Logbook, Catch up and Reminders are lenses or acts, so they sit behind More —
 * a band tab is a claim about where a member goes, and a lens is not a where.
 */
export const BAND_DESTINATIONS: readonly BandDestination[] = [
  { id: TODAY_ID, label: "Today", icon: "Check" },
  { id: "upcoming", label: "Upcoming", icon: "Clock" },
  { id: "inbox", label: "Inbox", icon: "Inbox" },
  { id: "projects", label: "Projects", icon: "Folder" },
];

export const {
  shelfFromSegment,
  shelfSegment,
  shelfRoute,
  shelfFromRoute,
  bandActiveId,
} = createShelfRoutes({
  route: "tasks",
  routed: TASK_SHELVES,
  band: BAND_DESTINATIONS,
  rootBandId: TODAY_ID,
  dynamic: {
    idPrefix: PROJECT_PREFIX,
    segmentPrefix: "project/",
    fallback: PROJECTS,
    bandKey: "projects",
  },
});

/** The shelves reached from the band's More sheet, in the sheet's order. */
export const MORE_SHELVES: readonly ShelfId[] = [
  ANYTIME,
  ALL,
  SEARCH,
  LOGBOOK,
  REENTRY,
  NOTIFY,
];

/**
 * Does this shelf paint the TASK ROW SET — the same rows under a filter?
 * Projects paints project rows, the editor paints one task's fields, and
 * Catch up, Reminder and the Logbook each paint their own screen, so none of
 * them takes the board's grouping, its window end or its quick add.
 */
const NON_BOARD: ReadonlySet<string> = new Set([
  PROJECTS,
  TASK,
  REENTRY,
  NOTIFY,
  LOGBOOK,
  SEARCH,
]);

export function showsBoard(id: ShelfId): boolean {
  if (projectIdFrom(id)) return true;
  return id === null || !NON_BOARD.has(id);
}

/** May a new task be captured from here? Everywhere a board is painted, plus
 *  the Projects index — a project is a place a task can land. */
export function allowsQuickAdd(id: ShelfId): boolean {
  return showsBoard(id) || id === PROJECTS;
}

/** Which rail row / band tab is lit for a shelf. One project lights Projects,
 *  the place it is a sub-state of; the editor lights nothing, because it is
 *  reached from wherever the member already was. */
export function railShelf(id: ShelfId): ShelfId {
  if (projectIdFrom(id)) return PROJECTS;
  return id === PROJECT ? PROJECTS : id;
}
