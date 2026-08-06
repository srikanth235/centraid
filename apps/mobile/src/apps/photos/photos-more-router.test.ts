// Pins the More-sheet router (issue #711 — the phone's band and More sheet
// are labelled destinations, and every one of them used to open something
// else). `PhotosHome`'s old `onMoreRow` handled only `duplicates`, `places`
// and `storage`; every other key — including `trash` and `favorites` — fell
// through to an `else navigation.navigate("PhotosLibrary")`.
// `resolveMoreRowRoute` (photos-band.ts) is the pure, exhaustive mapping that
// replaced that fallthrough: a row added to `PHOTOS_MORE_ROWS` without a
// matching case fails to TYPECHECK via the `never` assignment in its default
// branch, rather than silently landing on Library at runtime.
//
// Kept in its own file (not folded into `photos-band.test.ts`, which a
// concurrent pass on this issue is also touching) and importing only from
// `photos-band.ts`, which stays free of react-native/replica imports — so
// this suite needs no RN mocking to exercise the exact rule that was broken.
import { describe, expect, it } from "vitest";

import { PHOTOS_MORE_ROWS, resolveMoreRowRoute } from "./photos-band";
import type { PhotosMoreRowKey } from "./photos-band";

describe("resolveMoreRowRoute (the More sheet's router)", () => {
  it("routes every row PHOTOS_MORE_ROWS carries today to a distinct destination", () => {
    const destinations = PHOTOS_MORE_ROWS.map((row) => {
      const route = resolveMoreRowRoute(row.key);
      return route.screen === "PhotoStateView"
        ? `PhotoStateView:${route.params.mode}`
        : route.screen;
    });
    // Distinct: two different rows landing on the same screen is a subtler
    // version of the same "labelled destination lies" defect.
    expect(new Set(destinations).size).toBe(destinations.length);
  });

  it("trash opens PhotoStateView in trash mode, not the library timeline", () => {
    expect(resolveMoreRowRoute("trash")).toStrictEqual({
      screen: "PhotoStateView",
      params: { mode: "trash" },
    });
  });

  it("favorites opens PhotoStateView in favorites mode, not the library timeline", () => {
    expect(resolveMoreRowRoute("favorites")).toStrictEqual({
      screen: "PhotoStateView",
      params: { mode: "favorites" },
    });
  });

  it("duplicates opens the clusters SHELF, not the cluster-at-a-time review", () => {
    // proto:4436 vs proto:4291 — the row's meta is a cluster count, so the
    // surface it opens has to be the one that shows clusters. The review is
    // one control away, from the shelf's own head.
    expect(resolveMoreRowRoute("duplicates")).toStrictEqual({
      screen: "DuplicatesShelf",
    });
  });

  it("sharing opens the Sharing shelf — the row is back because the surface is", () => {
    // issue #712 A5. `PHOTOS_MORE_ROWS` refused to carry this row until a
    // destination existed for it; it exists now, and it is the sheet's FIRST
    // row (proto:4980-4983).
    expect(resolveMoreRowRoute("sharing")).toStrictEqual({
      screen: "SharingShelf",
    });
  });

  it("carries no `access` row: permission is a takeover of the timeline now", () => {
    // issue #712 P13. The permission content is rendered in the GRID's slot by
    // `PhotosHome`, so a More row pointing at a pushed screen would be a
    // second, worse route to the same words — and there is no screen left.
    expect(PHOTOS_MORE_ROWS.map((row) => row.key)).not.toContain("access");
  });

  it("places opens PlacesView, the place-cards shelf, not the map directly", () => {
    // proto:4197 — the phone drops the map to a list first, map on demand
    // (`PlacesView`'s own Map control opens `PlacesMap` as a second screen).
    expect(resolveMoreRowRoute("places")).toStrictEqual({
      screen: "PlacesView",
    });
  });

  it("backup deep-links ACROSS stacks to frame Settings, not to a Photos route", () => {
    // issue #712 B1/B2: the row is labelled "Backup" (the screen it opens is
    // titled "Backup health"), and the screen itself moved to frame Settings
    // beside Phone storage. A Photos-stack route name here would not resolve
    // at all — which is the point of routing through this one function.
    expect(resolveMoreRowRoute("backup")).toStrictEqual({
      screen: "Settings",
      params: { screen: "BackupHealth" },
    });
  });

  it("throws on an unhandled key instead of silently resolving anywhere", () => {
    // The exhaustiveness guard, exercised directly: a key the union doesn't
    // know about (cast past the type system, the way a stale build or a
    // future unwired row would arrive at runtime) must fail loudly rather
    // than falling through to some default screen.
    expect(() => resolveMoreRowRoute("import" as PhotosMoreRowKey)).toThrow(
      /Unhandled More-sheet row/u
    );
  });

  it("PHOTOS_MORE_ROWS still carries no import — no phone destination exists yet", () => {
    // Sharing came back in issue #712 because its surface shipped. Import did
    // not: there is no upload / drag / capture flow for the phone
    // (proto:3978), and a row that opens nowhere is the defect this table
    // exists to prevent.
    expect(PHOTOS_MORE_ROWS.map((row) => row.key)).not.toContain("import");
  });
});
