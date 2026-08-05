/* oxlint-disable import/first -- vi.mock is hoisted; subject imports intentionally follow */
/**
 * Home / Vaults launcher owner (issue #545 C5/C7 surface) — pure catalog merge.
 * resolveAppMeta is mocked so vitest never loads react-native via gateway.
 */
import { describe, expect, it, vi } from "vitest";

import type { AppMetaResolved } from "@centraid/design";

vi.mock(import("../../lib/gateway"), () => ({
  resolveAppMeta: (row: {
    id: string;
    name?: string;
    description?: string;
    iconKey?: string;
    colorKey?: string;
  }): AppMetaResolved =>
    ({
      id: row.id,
      name: row.name ?? row.id,
      desc: row.description ?? "",
      iconKey: row.iconKey ?? "Sparkle",
      color: "#888",
      colorKey: row.colorKey ?? "slate",
    }) as unknown as AppMetaResolved,
}));

import {
  buildLauncherItems,
  filterLauncherItems,
  NATIVE_APP_IDS,
  orderByPins,
  orderForSpringboard,
} from "./catalog";
import { SPRINGBOARD_ORDER } from "./tile-model";

function meta(id: string, name: string, description = ""): AppMetaResolved {
  return {
    id,
    name,
    desc: description,
    iconKey: "Sparkle",
    color: "#888",
    colorKey: "slate",
  } as unknown as AppMetaResolved;
}

describe(buildLauncherItems, () => {
  it("always includes native covers as installed", () => {
    const items = buildLauncherItems([]);
    const natives = items.filter((itLocal) =>
      NATIVE_APP_IDS.has(itLocal.meta.id)
    );
    expect(natives).toHaveLength(8);
    expect(natives.every((itLocal) => itLocal.installed)).toBe(true);
    expect(natives.map((itLocal) => itLocal.route.kind).sort()).toStrictEqual([
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

  it("keeps every bundled blueprint available without a gateway catalog", () => {
    const items = buildLauncherItems([]);
    const notes = items.find((itLocal) => itLocal.meta.id === "notes");
    expect(notes).toMatchObject({
      installed: true,
      route: { kind: "notes" },
    });
  });

  it("keeps native routing authoritative and appends custom remote apps", () => {
    const remote = [
      meta("notes", "My Notes", "live"),
      meta("custom-app", "Custom", "user built"),
    ];
    const items = buildLauncherItems(remote);
    const notes = items.find((itLocal) => itLocal.meta.id === "notes");
    expect(notes).toMatchObject({
      installed: true,
      meta: expect.objectContaining({ name: "Notes" }),
      route: { kind: "notes" },
    });
    const custom = items.find((itLocal) => itLocal.meta.id === "custom-app");
    expect(custom).toMatchObject({
      installed: true,
      route: { kind: "app", appId: "custom-app" },
    });
  });
});

describe(orderForSpringboard, () => {
  const ids = (items: readonly { meta: AppMetaResolved }[]): string[] =>
    items.map((item) => item.meta.id);

  it("gives the mosaic the corner", () => {
    // The regression this guards: the grid took the CATALOG's order, which
    // opens with Notes, so Home led with a paragraph and the photographs sat
    // in the third row.
    expect(ids(orderForSpringboard(buildLauncherItems([])))[0]).toBe("photos");
  });

  it("puts every first-party tile in springboard order", () => {
    expect(ids(orderForSpringboard(buildLauncherItems([])))).toStrictEqual([
      ...SPRINGBOARD_ORDER,
    ]);
  });

  it("keeps an app it does not name behind the ones it does", () => {
    const built = buildLauncherItems([meta("mine", "Mine")]);
    const ordered = ids(orderForSpringboard(built));
    expect(ordered.at(-1)).toBe("mine");
  });

  it("is stable — the same vault produces the same page twice", () => {
    const built = buildLauncherItems([meta("a", "A"), meta("b", "B")]);
    expect(ids(orderForSpringboard(built))).toStrictEqual(
      ids(orderForSpringboard(built))
    );
    // Two apps it does not name keep their catalog order rather than swapping.
    expect(ids(orderForSpringboard(built)).slice(-2)).toStrictEqual(["a", "b"]);
  });

  it("loses to a pin — the member's order wins over the default", () => {
    const ordered = orderByPins(orderForSpringboard(buildLauncherItems([])), [
      "tally",
    ]);
    expect(ids(ordered)[0]).toBe("tally");
  });
});

describe(orderByPins, () => {
  const items = buildLauncherItems([]);
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
    const items = buildLauncherItems([]);
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
