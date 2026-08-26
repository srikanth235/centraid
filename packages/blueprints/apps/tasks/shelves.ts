// Tasks shelves (spec §1, §2): a place or a lens, never a mode. Structure is
// `_shared/shelves.ts`. `tasks/task` is a routed screen, not an overlay.
import { createShelfRoutes, tokenFromShelf } from "../_shared/shelves.ts";
import type { BandDestination, Shelf, ShelfId } from "../_shared/shelves.ts";

export type { Shelf, ShelfId } from "../_shared/shelves.ts";

// `built-in:` cannot collide with a project id (opaque, no colon).
export const UPCOMING = "built-in:upcoming";
export const ANYTIME = "built-in:anytime";
export const ALL = "built-in:all";
export const INBOX = "built-in:inbox";
export const PROJECTS = "built-in:projects";
export const PROJECT = "built-in:project";
export const TASK = "built-in:task";
export const REENTRY = "built-in:reentry";
export const LOGBOOK = "built-in:logbook";
export const SEARCH = "built-in:search";
export const NOTIFY = "built-in:notify";

const PROJECT_PREFIX = "project:";

export function projectShelf(projectId: string): string {
  return `${PROJECT_PREFIX}${projectId}`;
}

export function projectIdFrom(id: ShelfId): string | null {
  return tokenFromShelf(PROJECT_PREFIX, id);
}

/** `null` is Today: empty segment, not `today`. */
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

const TODAY_ID = "today";

/** Four places plus More. Lenses sit behind More. */
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

export const MORE_SHELVES: readonly ShelfId[] = [
  ANYTIME,
  ALL,
  SEARCH,
  LOGBOOK,
  REENTRY,
  NOTIFY,
];

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

export function allowsQuickAdd(id: ShelfId): boolean {
  return showsBoard(id) || id === PROJECTS;
}

/** One project lights Projects; the editor lights nothing. */
export function railShelf(id: ShelfId): ShelfId {
  if (projectIdFrom(id)) return PROJECTS;
  return id === PROJECT ? PROJECTS : id;
}
