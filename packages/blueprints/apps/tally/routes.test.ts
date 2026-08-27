// The room's fifteen routes, as a round trip (Tally spec §1).
//
// A ROUTE IS A VALUE, so the whole navigation model is testable without a
// renderer: `tally` and `tally/<sub>` are one destination, and a member's URL,
// the rail's current row, the band's lit tab and the back row's label all read
// the SAME record. What this file guards is that they cannot disagree.
import { describe, expect, it } from "vitest";

import {
  ACTIVITY,
  ADD,
  BAND_DESTINATIONS,
  EXPENSE,
  EXPORT,
  FRIEND,
  GROUP,
  GROUPS,
  MORE_SHELVES,
  RECEIPT,
  RECURRING,
  SEARCH,
  SETTLE,
  SPENDING,
  TALLY_SHELVES,
  TRASH,
  WAITING,
  backShelf,
  bandActiveId,
  bandShelf,
  shelfFromRoute,
  shelfLabel,
  shelfRoute,
  showsLedgerList,
} from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";

const ROUTES = [
  "tally",
  "tally/activity",
  "tally/groups",
  "tally/group",
  "tally/friend",
  "tally/expense",
  "tally/add",
  "tally/receipt",
  "tally/settle",
  "tally/recurring",
  "tally/contrib",
  "tally/insight",
  "tally/trash",
  "tally/search",
  "tally/export",
];

describe("the fifteen routes", () => {
  it("names exactly the fifteen the spec draws", () => {
    expect(TALLY_SHELVES).toHaveLength(15);
    expect(TALLY_SHELVES.map((shelf) => shelfRoute(shelf.id))).toStrictEqual(
      ROUTES
    );
  });

  it.each(ROUTES)("%s round-trips through the shelf model", (route) => {
    const shelf = shelfFromRoute(route);
    expect(shelfRoute(shelf)).toBe(route);
  });

  it("treats a foreign route as no shelf of this app's", () => {
    expect(shelfFromRoute("tasks/upcoming")).toBeNull();
  });

  it("keeps a group and a friend singular routes, not shelf families", () => {
    // Which group is open is app state BESIDE the route; the spec's table
    // names fifteen routes and this is what keeps it fifteen.
    expect(shelfRoute(GROUP)).toBe("tally/group");
    expect(shelfRoute(FRIEND)).toBe("tally/friend");
  });
});

describe("the phone's band", () => {
  it("claims four places plus the frame's More, and carries no count", () => {
    expect(BAND_DESTINATIONS.map((dest) => dest.label)).toStrictEqual([
      "Balances",
      "Activity",
      "Groups",
      "Waiting",
    ]);
    for (const dest of BAND_DESTINATIONS)
      expect(Object.keys(dest)).toStrictEqual(["id", "label", "icon"]);
  });

  it.each([
    [null as ShelfId, "balances"],
    [ACTIVITY, "activity"],
    [GROUPS, "groups"],
    [WAITING, "contrib"],
    // A descent lights the place it was reached from.
    [GROUP, "groups"],
    [FRIEND, "balances"],
    [EXPENSE, "activity"],
    [ADD, "activity"],
    [RECEIPT, "activity"],
    [SETTLE, "balances"],
  ])("lights %s as %s", (shelf, expected) => {
    expect(bandActiveId(shelf)).toBe(expected);
  });

  it.each([RECURRING, SPENDING, SEARCH, TRASH, EXPORT])(
    "puts the lens %s behind More rather than in the band",
    (shelf) => {
      expect(bandActiveId(shelf)).toBeUndefined();
      expect(MORE_SHELVES).toContain(shelf);
    }
  );

  it("lights the group ledger's rail row on Groups, where it was reached", () => {
    expect(bandShelf(GROUP)).toBe(GROUPS);
    expect(bandShelf(ACTIVITY)).toBe(ACTIVITY);
  });
});

describe("what a route offers", () => {
  it.each([
    null as ShelfId,
    ACTIVITY,
    GROUPS,
    GROUP,
    FRIEND,
    RECURRING,
    WAITING,
    SPENDING,
    TRASH,
    SEARCH,
  ])("%s paints a list the rail stands beside", (shelf) => {
    expect(showsLedgerList(shelf)).toBe(true);
  });

  it.each([EXPENSE, ADD, RECEIPT, SETTLE, EXPORT])(
    "%s fills the pane with one thing, so the rail is withdrawn",
    (shelf) => {
      expect(showsLedgerList(shelf)).toBe(false);
    }
  );
});

describe("the back row names its destination", () => {
  it.each([
    [GROUP, "Groups"],
    [FRIEND, "Balances"],
    [EXPENSE, "Activity"],
    [ADD, "Activity"],
    [RECEIPT, "Activity"],
    [SETTLE, "Balances"],
    [RECURRING, "Tally"],
    [WAITING, "Tally"],
    [SPENDING, "Tally"],
    [TRASH, "Tally"],
    [SEARCH, "Tally"],
    [EXPORT, "Groups"],
  ])("%s backs out to %s", (shelf, label) => {
    expect(backShelf(shelf)?.label).toBe(label);
  });

  it.each([null as ShelfId, ACTIVITY, GROUPS])(
    "%s is arrived at, not descended into, so it draws no back row",
    (shelf) => {
      expect(backShelf(shelf)).toBeUndefined();
    }
  );

  it("sends a lens back to the ledger's own root", () => {
    expect(backShelf(TRASH)?.shelf).toBeNull();
    expect(backShelf(GROUP)?.shelf).toBe(GROUPS);
  });

  it("spells each shelf's own name once", () => {
    expect(shelfLabel(null)).toBe("Balances");
    expect(shelfLabel(GROUP)).toBe("Group ledger");
    expect(shelfLabel(WAITING)).toBe("Waiting");
  });
});
