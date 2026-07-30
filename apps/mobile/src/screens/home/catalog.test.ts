import type { AppMetaResolved } from "@centraid/design-tokens";
/* oxlint-disable import/first -- vi.mock is hoisted; subject imports intentionally follow */
/**
 * Home / Spaces launcher owner (issue #545 C5/C7 surface) — pure catalog merge.
 * resolveAppMeta is mocked so vitest never loads react-native via gateway.
 */
import { describe, expect, it, vi } from "vitest";

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
} from "./catalog";

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
