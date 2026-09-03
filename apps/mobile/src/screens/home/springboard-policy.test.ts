import { describe, expect, it } from "vitest";

import {
  countThings,
  everyTileUnreadable,
  gridMembership,
  isWideTile,
  springboardState,
  tileEarnsGrid,
  tileSize,
  TILE_EMPTY_COPY,
} from "./springboard-policy";
import type { TileData, TileStatus } from "./tile-model";

describe(tileEarnsGrid, () => {
  const tile = (status: TileStatus, kind: "notes" | "locker" = "notes") => ({
    body: { kind },
    status,
  });

  it("admits a tile that has something to show", () => {
    expect(tileEarnsGrid(tile("content"))).toBe(true);
  });

  it("holds the slot while a read is in flight, so nothing relayouts", () => {
    expect(tileEarnsGrid(tile("loading"))).toBe(true);
  });

  it("demotes a settled-empty app to a first move", () => {
    expect(tileEarnsGrid(tile("empty"))).toBe(false);
  });

  it("demotes an unreadable app rather than showing a body it cannot stand behind", () => {
    expect(tileEarnsGrid(tile("unknown"))).toBe(false);
  });

  it("always keeps Locker, whose body is a state and not a query result", () => {
    expect(tileEarnsGrid(tile("unknown", "locker"))).toBe(true);
    expect(tileEarnsGrid(tile("empty", "locker"))).toBe(true);
  });
});

describe(everyTileUnreadable, () => {
  const status = (value: TileStatus): Pick<TileData, "status"> => ({
    status: value,
  });

  it("is the state a springboard with no replica session reaches", () => {
    expect(everyTileUnreadable([status("unknown"), status("unknown")])).toBe(
      true
    );
  });

  it("is not reached while one app can still be read", () => {
    expect(everyTileUnreadable([status("unknown"), status("empty")])).toBe(
      false
    );
    expect(everyTileUnreadable([status("unknown"), status("content")])).toBe(
      false
    );
    expect(everyTileUnreadable([status("unknown"), status("loading")])).toBe(
      false
    );
  });

  it("claims nothing about an empty tile set", () => {
    expect(everyTileUnreadable([])).toBe(false);
  });
});

describe(gridMembership, () => {
  const items = ["notes", "photos", "docs"].map((id) => ({ meta: { id } }));
  const graded = (entries: Record<string, TileStatus>) =>
    new Map(
      Object.entries(entries).map(([id, value]) => [
        id,
        { body: { kind: "notes" as const }, status: value },
      ])
    );

  it("keeps every app when nothing is readable", () => {
    const { earned, idleIds } = gridMembership(
      items,
      graded({ docs: "unknown", notes: "unknown", photos: "unknown" })
    );
    expect(earned.map((item) => item.meta.id)).toStrictEqual([
      "notes",
      "photos",
      "docs",
    ]);
    expect(idleIds).toStrictEqual([]);
  });

  it("still demotes a lone unreadable app beside one that reads", () => {
    const { earned, idleIds } = gridMembership(
      items,
      graded({ docs: "empty", notes: "content", photos: "unknown" })
    );
    expect(earned.map((item) => item.meta.id)).toStrictEqual(["notes"]);
    expect(idleIds).toStrictEqual(["photos", "docs"]);
  });

  it("keeps an app that has no tile at all — Home cannot call it empty", () => {
    const { earned, idleIds } = gridMembership(
      items,
      graded({ notes: "empty" })
    );
    expect(earned.map((item) => item.meta.id)).toStrictEqual([
      "photos",
      "docs",
    ]);
    expect(idleIds).toStrictEqual(["notes"]);
  });

  it("populates the grid in exactly the state springboardState routes there", () => {
    const tiles = graded({
      docs: "unknown",
      notes: "unknown",
      photos: "unknown",
    });
    expect(springboardState([...tiles.values()])).toBe("content");
    expect(gridMembership(items, tiles).earned).toHaveLength(items.length);
  });
});

describe(countThings, () => {
  const tile = (over: Partial<TileData>): TileData =>
    ({
      appId: "notes",
      body: { kind: "notes", title: "", excerpt: "" },
      countLabel: "notes",
      status: "content",
      ...over,
    }) as TileData;

  it("sums only the counts a read actually returned", () => {
    expect(
      countThings([
        tile({ count: 8000 }),
        tile({ count: 432 }),
        tile({ count: undefined, status: "unknown" }),
      ])
    ).toStrictEqual({ capped: false, settled: true, total: 8432 });
  });

  it("reports the total as a floor when a contributing read hit its ceiling", () => {
    expect(countThings([tile({ count: 200, countCapped: true })]).capped).toBe(
      true
    );
  });

  it("is unsettled while any tile is still reading", () => {
    expect(
      countThings([tile({ count: 3 }), tile({ status: "loading" })]).settled
    ).toBe(false);
  });
});

describe(springboardState, () => {
  const tiles = (...statuses: TileStatus[]): { status: TileStatus }[] =>
    statuses.map((status) => ({ status }));

  it("shows the grid as soon as one app has content", () => {
    expect(springboardState(tiles("loading", "empty", "content"))).toBe(
      "content"
    );
  });

  it("will not call first run while a read is still in flight", () => {
    expect(springboardState(tiles("empty", "loading", "unknown"))).toBe(
      "loading"
    );
  });

  it("calls first run only when every readable tile settled empty", () => {
    expect(springboardState(tiles("empty", "empty", "unknown"))).toBe(
      "first-run"
    );
  });

  it("renders the grid, not day one, when nothing is readable at all", () => {
    expect(springboardState(tiles("unknown", "unknown"))).toBe("content");
  });

  it("treats no tiles as not-yet-known", () => {
    expect(springboardState([])).toBe("loading");
  });
});

describe(tileSize, () => {
  it("gives Photos the 2×2, prose the 2×1, and everything else the 1×1", () => {
    expect(tileSize("photos")).toBe("large");
    expect(tileSize("docs")).toBe("medium");
    expect(tileSize("notes")).toBe("medium");
    for (const id of ["agenda", "tasks", "people", "tally", "locker"])
      expect(tileSize(id)).toBe("small");
  });

  it("gives an app with no first-party tile the 1×1", () => {
    expect(tileSize("some-gateway-app")).toBe("small");
  });

  it("puts medium AND the flattened large in a full-width mobile slot", () => {
    expect(isWideTile("photos")).toBe(true);
    expect(isWideTile("docs")).toBe(true);
    expect(isWideTile("tasks")).toBe(false);
  });
});

describe("what-to-do copy", () => {
  it("covers every first-party app", () => {
    expect(Object.keys(TILE_EMPTY_COPY).sort()).toStrictEqual([
      "agenda",
      "docs",
      "locker",
      "notes",
      "people",
      "photos",
      "tally",
      "tasks",
    ]);
  });
});
