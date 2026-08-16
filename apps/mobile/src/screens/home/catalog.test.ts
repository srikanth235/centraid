/**
 * Home / Vaults launcher owner (issue #545 C5/C7 surface) — the pure catalog.
 */
import { describe, expect, it } from "vitest";

import type { AppMetaResolved } from "@centraid/design";

import {
  buildLauncherItems,
  filterLauncherItems,
  orderByPins,
  orderForSpringboard,
} from "./catalog";
import type { LauncherItem } from "./catalog";
import { SPRINGBOARD_ORDER } from "./springboard-policy";

describe(buildLauncherItems, () => {
  it("gives all eight first-party apps a native cover", () => {
    const items = buildLauncherItems();
    expect(items).toHaveLength(8);
    expect(items.map((itLocal) => itLocal.route.kind).sort()).toStrictEqual([
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

  it("keeps every bundled blueprint available without a gateway", () => {
    const notes = buildLauncherItems().find(
      (itLocal) => itLocal.meta.id === "notes"
    );
    expect(notes).toMatchObject({ route: { kind: "notes" } });
  });
});

describe(orderForSpringboard, () => {
  const ids = (items: readonly { meta: AppMetaResolved }[]): string[] =>
    items.map((item) => item.meta.id);

  it("gives the mosaic the corner", () => {
    // The regression this guards: the grid took the CATALOG's order, which
    // opens with Notes, so Home led with a paragraph and the photographs sat
    // in the third row.
    expect(ids(orderForSpringboard(buildLauncherItems()))[0]).toBe("photos");
  });

  it("puts every first-party tile in springboard order", () => {
    expect(ids(orderForSpringboard(buildLauncherItems()))).toStrictEqual([
      ...SPRINGBOARD_ORDER,
    ]);
  });

  it("keeps an app it does not name behind the ones it does", () => {
    const extra: LauncherItem = {
      meta: { id: "mine" } as unknown as AppMetaResolved,
      route: { kind: "notes" },
    };
    const ordered = ids(orderForSpringboard([...buildLauncherItems(), extra]));
    expect(ordered.at(-1)).toBe("mine");
  });

  it("is stable — the same vault produces the same page twice", () => {
    const built = buildLauncherItems();
    expect(ids(orderForSpringboard(built))).toStrictEqual(
      ids(orderForSpringboard(built))
    );
  });

  it("loses to a pin — the member's order wins over the default", () => {
    const ordered = orderByPins(orderForSpringboard(buildLauncherItems()), [
      "tally",
    ]);
    expect(ids(ordered)[0]).toBe("tally");
  });
});

describe(orderByPins, () => {
  const items = buildLauncherItems();
  const ids = (list: readonly { meta: { id: string } }[]): string[] =>
    list.map((item) => item.meta.id);

  it("lifts pinned apps to the front, in the order they were pinned", () => {
    const ordered = orderByPins(items, ["tally", "notes"]);
    expect(ids(ordered).slice(0, 2)).toStrictEqual(["tally", "notes"]);
  });

  it("never hides an unpinned app — a launcher you can lose an app in is not one", () => {
    const ordered = orderByPins(items, ["tally"]);
    expect(ordered).toHaveLength(items.length);
    expect(new Set(ids(ordered))).toStrictEqual(new Set(ids(items)));
  });

  it("keeps catalog order behind the pins", () => {
    const ordered = orderByPins(items, ["tally"]);
    const rest = ids(ordered).slice(1);
    expect(rest).toStrictEqual(ids(items).filter((id) => id !== "tally"));
  });

  it("skips a pinned id that no longer resolves to a listed app", () => {
    expect(ids(orderByPins(items, ["ghost", "notes"]))[0]).toBe("notes");
  });

  it("is a no-op with nothing pinned", () => {
    expect(ids(orderByPins(items, []))).toStrictEqual(ids(items));
  });
});

describe(filterLauncherItems, () => {
  it("filters by name case-insensitively and returns a copy for empty query", () => {
    const items = buildLauncherItems();
    const copy = filterLauncherItems(items, "  ");
    expect(copy).toStrictEqual(items);
    expect(copy).not.toBe(items);
    const photos = filterLauncherItems(items, "PHOTO");
    expect(
      photos.every((itLocal) =>
        itLocal.meta.name.toLowerCase().includes("photo")
      )
    ).toBe(true);
    expect(photos.length).toBeGreaterThan(0);
  });
});
