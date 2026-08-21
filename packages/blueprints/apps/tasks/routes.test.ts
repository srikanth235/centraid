// The room's twelve routes, as a round trip (spec §1, §2).
//
// A ROUTE IS A VALUE, so the whole navigation model is testable without a
// renderer: `tasks` and `tasks/<sub>` are one destination, and a member's URL,
// the rail's current row and the band's lit tab all read the SAME record. What
// this file guards is that they cannot disagree.
import { describe, expect, it } from "vitest";

import {
  ALL,
  ANYTIME,
  BAND_DESTINATIONS,
  INBOX,
  LOGBOOK,
  MORE_SHELVES,
  NOTIFY,
  PROJECT,
  PROJECTS,
  REENTRY,
  SEARCH,
  TASK,
  TASK_SHELVES,
  UPCOMING,
  allowsQuickAdd,
  bandActiveId,
  projectIdFrom,
  projectShelf,
  railShelf,
  shelfFromRoute,
  shelfFromSegment,
  shelfRoute,
  showsBoard,
} from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";

const ROUTES = [
  "tasks",
  "tasks/upcoming",
  "tasks/anytime",
  "tasks/all",
  "tasks/inbox",
  "tasks/projects",
  "tasks/project",
  "tasks/task",
  "tasks/reentry",
  "tasks/logbook",
  "tasks/search",
  "tasks/notify",
];

describe("the twelve routes", () => {
  it("names exactly the twelve the spec draws", () => {
    expect(TASK_SHELVES).toHaveLength(12);
    expect(TASK_SHELVES.map((shelf) => shelfRoute(shelf.id))).toStrictEqual(
      ROUTES
    );
  });

  it.each(ROUTES)("%s round-trips through the shelf model", (route) => {
    const shelf = shelfFromRoute(route);
    expect(shelfRoute(shelf)).toBe(route);
  });

  it("treats a foreign route as no shelf of this app's", () => {
    expect(shelfFromRoute("docs/folders")).toBeNull();
  });

  it("carries one project as a sub-state of Projects, not a thirteenth route", () => {
    const shelf = projectShelf("p7");
    expect(shelfRoute(shelf)).toBe("tasks/project/p7");
    expect(shelfFromRoute("tasks/project/p7")).toBe(shelf);
    expect(projectIdFrom(shelf)).toBe("p7");
    expect(railShelf(shelf)).toBe(PROJECTS);
    // A segment with no token lands on the index rather than a project that
    // does not exist.
    expect(shelfFromSegment("project/")).toBe(PROJECTS);
  });
});

describe("the phone's band", () => {
  it("claims four places plus the frame's More, and no lens", () => {
    expect(BAND_DESTINATIONS.map((dest) => dest.label)).toStrictEqual([
      "Today",
      "Upcoming",
      "Inbox",
      "Projects",
    ]);
  });

  it.each([
    [null as ShelfId, "today"],
    [UPCOMING, "upcoming"],
    [INBOX, "inbox"],
    [PROJECTS, "projects"],
    [projectShelf("p1"), "projects"],
  ])("lights %s as %s", (shelf, expected) => {
    expect(bandActiveId(shelf)).toBe(expected);
  });

  it.each([ANYTIME, ALL, SEARCH, LOGBOOK, REENTRY, NOTIFY])(
    "puts the lens %s behind More rather than in the band",
    (shelf) => {
      expect(bandActiveId(shelf)).toBeUndefined();
      expect(MORE_SHELVES).toContain(shelf);
    }
  );
});

describe("what a route offers", () => {
  it.each([null as ShelfId, UPCOMING, ANYTIME, ALL, INBOX, projectShelf("p1")])(
    "%s paints the task row set",
    (shelf) => {
      expect(showsBoard(shelf)).toBe(true);
      expect(allowsQuickAdd(shelf)).toBe(true);
    }
  );

  it.each([PROJECTS, TASK, REENTRY, NOTIFY, LOGBOOK, SEARCH])(
    "%s paints its own screen rather than the board",
    (shelf) => {
      expect(showsBoard(shelf)).toBe(false);
    }
  );

  it("offers capture on the Projects index — a project is a place a task lands", () => {
    expect(allowsQuickAdd(PROJECTS)).toBe(true);
  });

  it("lights Projects from the bare project route", () => {
    expect(railShelf(PROJECT)).toBe(PROJECTS);
  });
});
