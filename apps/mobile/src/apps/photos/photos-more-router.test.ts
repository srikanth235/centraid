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
// WHAT THIS SUITE IS ABOUT NOW (issue #712). The sheet used to carry six rows;
// it carries one. Collections is the landing surface and holds every shelf —
// Sharing, Favorites, Places, Duplicates, Trash — as a named section with a
// live count, on screen. A row here for any of them would be a second, hidden
// door to a shelf the member can already see, and a second place to keep its
// label and its count honest. So most of the assertions this file used to make
// are now made by `photos-collections.test.ts` against the sections instead,
// and what is pinned HERE is what stayed and, more importantly, what must not
// come back.
//
// Kept in its own file and importing only from `photos-band.ts`, which stays
// free of react-native/replica imports — so this suite needs no RN mocking to
// exercise the exact rule that was broken.
import { describe, expect, it } from "vitest";

import { PHOTOS_MORE_ROWS, resolveMoreRowRoute } from "./photos-band";
import type { PhotosMoreRowKey } from "./photos-band";

/** Every shelf that is a SECTION of Collections now. None of them may be a
 *  row here as well — that is the duplication this pass removed. */
const SHELVES_ON_COLLECTIONS = [
  "sharing",
  "favorites",
  "places",
  "duplicates",
  "trash",
] as const;

describe("resolveMoreRowRoute (the More sheet's router)", () => {
  it("routes every row PHOTOS_MORE_ROWS carries today to a distinct destination", () => {
    const destinations = PHOTOS_MORE_ROWS.map(
      (row) => resolveMoreRowRoute(row.key).screen
    );
    // Distinct: two different rows landing on the same screen is a subtler
    // version of the same "labelled destination lies" defect.
    expect(new Set(destinations).size).toBe(destinations.length);
  });

  it("carries no row for a shelf Collections already shows", () => {
    // The sabotage target for this whole change: put `favorites` back into
    // `PHOTOS_MORE_ROWS` and this fails. Two doors to one shelf, one of them
    // behind a sheet, is exactly what the landing page removed.
    const keys = PHOTOS_MORE_ROWS.map((row) => row.key) as readonly string[];
    for (const shelf of SHELVES_ON_COLLECTIONS)
      expect(keys).not.toContain(shelf);
  });

  it("backup deep-links ACROSS stacks to frame Settings, not to a Photos route", () => {
    // issue #712 B1/B2: the row is labelled "Backup" (the screen it opens is
    // titled "Backup health"), and the screen itself moved to frame Settings
    // beside Phone storage. A Photos-stack route name here would not resolve
    // at all — which is the point of routing through this one function.
    //
    // It survives the cull because it is NOT a shelf: it is a policy screen
    // about whether this device's bytes have left it, and that policy governs
    // Docs' scans and Notes' attachments too. Collections shows photographs;
    // this is not one.
    expect(resolveMoreRowRoute("backup")).toStrictEqual({
      screen: "Settings",
      params: { screen: "BackupHealth" },
    });
  });

  it("carries no `access` row: permission is a takeover of the timeline now", () => {
    // issue #712 P13. The permission content is rendered in the GRID's slot by
    // `PhotosHome`, so a More row pointing at a pushed screen would be a
    // second, worse route to the same words — and there is no screen left.
    expect(PHOTOS_MORE_ROWS.map((row) => row.key)).not.toContain("access");
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
    // There is no upload / drag / capture flow for the phone (proto:3978), and
    // a row that opens nowhere is the defect this table exists to prevent.
    expect(PHOTOS_MORE_ROWS.map((row) => row.key)).not.toContain("import");
  });
});
