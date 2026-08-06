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

  it("access opens the permission screen (§13), the only route to the OS grant", () => {
    expect(resolveMoreRowRoute("access")).toStrictEqual({
      screen: "PhotoPermission",
    });
  });

  it("places opens PlacesView, the place-cards shelf, not the map directly", () => {
    // proto:4197 — the phone drops the map to a list first, map on demand
    // (`PlacesView`'s own Map control opens `PlacesMap` as a second screen).
    expect(resolveMoreRowRoute("places")).toStrictEqual({
      screen: "PlacesView",
    });
  });

  it("storage opens BackupHealth", () => {
    expect(resolveMoreRowRoute("storage")).toStrictEqual({
      screen: "BackupHealth",
    });
  });

  it("throws on an unhandled key instead of silently resolving anywhere", () => {
    // The exhaustiveness guard, exercised directly: a key the union doesn't
    // know about (cast past the type system, the way a stale build or a
    // future unwired row would arrive at runtime) must fail loudly rather
    // than falling through to some default screen.
    expect(() => resolveMoreRowRoute("sharing" as PhotosMoreRowKey)).toThrow(
      /Unhandled More-sheet row/u
    );
  });

  it("PHOTOS_MORE_ROWS never carries sharing or import — no destination exists for either yet", () => {
    const keys = PHOTOS_MORE_ROWS.map((row) => row.key);
    expect(keys).not.toContain("sharing");
    expect(keys).not.toContain("import");
  });
});
