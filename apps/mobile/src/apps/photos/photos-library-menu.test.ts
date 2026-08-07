import { describe, expect, it, vi } from "vitest";

import type { MenuSubmenuRow } from "../../kit/components/AnchoredMenu";
import { libraryMenuGroups } from "./photos-library-menu";
import type { LibraryFilter } from "./photos-library-menu";

/** Every row this module builds sits one level deep, inside a disclosure —
 *  never a flat action row at the top, so tests reach in through this rather
 *  than repeating the type guard and the "not found" failure everywhere. */
function submenu(
  groups: ReturnType<typeof libraryMenuGroups>,
  key: string
): MenuSubmenuRow {
  const row = groups[0]!.rows.find((candidate) => candidate.key === key);
  if (!row || !("rows" in row))
    throw new Error(`expected a submenu row for "${key}"`);
  return row;
}

function baseInput(
  overrides: Partial<Parameters<typeof libraryMenuGroups>[0]> = {}
) {
  return {
    filter: "all" as LibraryFilter,
    onFilter: vi.fn<(filter: LibraryFilter) => void>(),
    onRung: vi.fn<(rung: 0 | 1 | 2 | 3) => void>(),
    rung: 2 as const,
    grain: "all" as const,
    ...overrides,
  };
}

describe("the Library header menu's model at the All grain", () => {
  it("carries both disclosure rows, and no third", () => {
    const groups = libraryMenuGroups(baseInput());
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows.map((row) => row.key)).toStrictEqual([
      "filter",
      "view-options",
    ]);
  });

  it("Filter offers All Photos and Favorites, exactly one checked to the passed filter", () => {
    const groups = libraryMenuGroups(baseInput({ filter: "favorites" }));
    const filter = submenu(groups, "filter");
    expect(filter.rows.map((row) => row.label)).toStrictEqual([
      "All Photos",
      "Favorites",
    ]);
    const checked = filter.rows.filter((row) => row.checked === true);
    expect(checked).toHaveLength(1);
    expect(checked[0]!.key).toBe("favorites");
  });

  it("selecting a Filter row calls onFilter with that row's key", () => {
    const onFilter = vi.fn<(filter: LibraryFilter) => void>();
    const groups = libraryMenuGroups(baseInput({ onFilter }));
    const filter = submenu(groups, "filter");
    const favorites = filter.rows.find((row) => row.key === "favorites")!;
    favorites.onSelect();
    expect(onFilter).toHaveBeenCalledExactlyOnceWith("favorites");
  });

  it("View Options carries one row per rung label, exactly one checked", () => {
    const groups = libraryMenuGroups(baseInput({ rung: 1 }));
    const viewOptions = submenu(groups, "view-options");
    expect(viewOptions.rows.map((row) => row.label)).toStrictEqual([
      "XS",
      "S",
      "M",
      "L",
    ]);
    const checked = viewOptions.rows.filter((row) => row.checked === true);
    expect(checked).toHaveLength(1);
    expect(checked[0]!.label).toBe("S");
  });

  it("every View Options row stays open on selection — a member steps several rungs in a row", () => {
    const groups = libraryMenuGroups(baseInput());
    const viewOptions = submenu(groups, "view-options");
    expect(viewOptions.rows.every((row) => row.staysOpen === true)).toBe(true);
  });

  it("selecting a View Options row calls onRung with that row's index", () => {
    const onRung = vi.fn<(rung: 0 | 1 | 2 | 3) => void>();
    const groups = libraryMenuGroups(baseInput({ onRung }));
    const viewOptions = submenu(groups, "view-options");
    viewOptions.rows[3]!.onSelect();
    expect(onRung).toHaveBeenCalledExactlyOnceWith(3);
  });
});

describe("the Library header menu's model at the Years and Months grains", () => {
  it("drops View Options at Years — a rung control may not sit over a grid it cannot resize", () => {
    const groups = libraryMenuGroups(baseInput({ grain: "years" }));
    expect(groups[0]!.rows.map((row) => row.key)).toStrictEqual(["filter"]);
  });

  it("drops View Options at Months, for the same reason", () => {
    const groups = libraryMenuGroups(baseInput({ grain: "months" }));
    expect(groups[0]!.rows.map((row) => row.key)).toStrictEqual(["filter"]);
  });

  it("keeps Filter at every grain — it narrows what the periods are built from", () => {
    for (const grain of ["years", "months", "all"] as const) {
      const groups = libraryMenuGroups(baseInput({ grain }));
      expect(groups[0]!.rows.some((row) => row.key === "filter")).toBe(true);
    }
  });
});

describe("the Library header menu's model has no Sort section", () => {
  it("at any grain — this vault has no field independent of Date Captured to sort by", () => {
    for (const grain of ["years", "months", "all"] as const) {
      const groups = libraryMenuGroups(baseInput({ grain }));
      expect(groups).toHaveLength(1);
      expect(groups[0]!.rows.some((row) => row.key === "sort")).toBe(false);
    }
  });
});
