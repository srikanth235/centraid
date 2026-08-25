// Pins the More-sheet router (#711 — the phone's band and More sheet
// are labelled destinations, and each must open the thing it names).
// `resolveMoreRowRoute` (photos-band.ts) is the pure, exhaustive mapping that
// makes that mechanical: a row added to `PHOTOS_MORE_ROWS` without a matching
// case fails to TYPECHECK via the `never` assignment in its default branch,
// rather than falling through to `navigation.navigate("PhotosLibrary")` at
// runtime.
//
// WHAT THIS SUITE IS ABOUT (#712). The sheet carries ONE row.
// Collections is the landing surface and holds every shelf — Favorites,
// Places, Duplicates, Trash — as a named section with a live count, on screen,
// and there is no Photos "Sharing" place at all (#726). A row here for
// any of them would be a second, hidden door to a shelf the member can already
// see, and a second place to keep its label and its count honest. The section
// assertions live in `photos-collections.test.ts`; what is pinned HERE is what
// stayed and, more importantly, what must not come back.
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
    // #712/B2: the row is labelled "Backup" (the screen it opens is
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
    // #712. The permission content is rendered in the GRID's slot by
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
