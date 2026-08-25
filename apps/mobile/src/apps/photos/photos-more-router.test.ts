// Pins the More-sheet router (#711): mostly what must NOT return as a row,
// since Collections already carries every shelf as a section (#712, #726).
import { describe, expect, it } from "vitest";

import { PHOTOS_MORE_ROWS, resolveMoreRowRoute } from "./photos-band";
import type { PhotosMoreRowKey } from "./photos-band";

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
    expect(new Set(destinations).size).toBe(destinations.length);
  });

  it("carries no row for a shelf Collections already shows", () => {
    const keys = PHOTOS_MORE_ROWS.map((row) => row.key) as readonly string[];
    for (const shelf of SHELVES_ON_COLLECTIONS)
      expect(keys).not.toContain(shelf);
  });

  it("backup deep-links ACROSS stacks to frame Settings, not to a Photos route", () => {
    // Backup stays a row because it is a policy screen, not a shelf (#712).
    expect(resolveMoreRowRoute("backup")).toStrictEqual({
      screen: "Settings",
      params: { screen: "BackupHealth" },
    });
  });

  it("carries no `access` row: permission is a takeover of the timeline now", () => {
    expect(PHOTOS_MORE_ROWS.map((row) => row.key)).not.toContain("access");
  });

  it("throws on an unhandled key instead of silently resolving anywhere", () => {
    expect(() => resolveMoreRowRoute("import" as PhotosMoreRowKey)).toThrow(
      /Unhandled More-sheet row/u
    );
  });

  it("PHOTOS_MORE_ROWS still carries no import — no phone destination exists yet", () => {
    expect(PHOTOS_MORE_ROWS.map((row) => row.key)).not.toContain("import");
  });
});
