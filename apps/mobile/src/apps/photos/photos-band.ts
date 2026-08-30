// The phone's bottom band, as a model (§3.1). A first-party route may CLAIM the
// band, capped at five destinations plus More; the frame is then a Home capsule
// at the LEADING edge, which mirrors under RTL (§18).
//
// "Outside the app's tab group" is STRUCTURAL: the capsule and the tab group
// are two separate plates in a transparent row with an 8pt seam and no
// enclosing plate. That boundary is why the capsule is not a sixth tab.

import { BAND_CAPSULE } from "../../kit/band/band-capsule";
import type { BandCapsule } from "../../kit/band/band-capsule";
import type { BandOwner } from "../../kit/band/band-owner";

// The frame's capsule lives in `kit/band/band-capsule.ts` (#883 B5).
export { BAND_CAPSULE } from "../../kit/band/band-capsule";
export type { BandCapsule } from "../../kit/band/band-capsule";

export type BandDestinationKey = "library" | "collections" | "search" | "more";

export interface BandDestination {
  key: BandDestinationKey;
  label: string;
  icon: string;
}

/** The frame's own cap; the fifth is More. */
export const BAND_MAX_DESTINATIONS = 5;

export const TARGET_MIN = 44;

// §G — plate geometry and the opacity rule live in `kit/band-surface.ts`: Home's
// band and a claimed band draw the same plate and must not drift.

/**
 * Exactly these, in this order, on every compact surface: Library first, since
 * the band is judged by how few taps the timeline costs. People is NOT a tab —
 * it is a pushed route reached from Collections and the Library shelf list.
 */
export const PHOTOS_BAND_DESTINATIONS: readonly BandDestination[] = [
  { key: "library", label: "Library", icon: "image" },
  // Collections, not Albums: this holds every shelf Photos has, so "Albums"
  // would name one section and hide the rest.
  { key: "collections", label: "Collections", icon: "Layers" },
  { key: "search", label: "Search", icon: "search" },
  { key: "more", label: "More", icon: "more-vertical" },
];

/** Declared up front so the router switches exhaustively and a stray key fails
 *  to typecheck here. */
export type PhotosMoreRowKey = "backup";

export interface MoreRow {
  key: PhotosMoreRowKey;
  label: string;
  icon: string;
  /** Filled at RENDER time; omitted, never a placeholder, without a source. */
  meta?: string;
}

/**
 * ONE ROW: this sheet keeps only what Collections does not carry, since a row
 * for a shelf Collections shows is two doors, one hidden. Tile size belongs to
 * the Library's header menu; `Photo access` to the grid's own slot.
 */
export const PHOTOS_MORE_ROWS: readonly MoreRow[] = [
  // "Backup", not "Storage" (#712): the screen is about whether this device's
  // photographs have left it.
  { key: "backup", label: "Backup", icon: "archive" },
];

/** One clause only: a second sentence narrates a control already on screen. */
export const PHOTOS_MORE_FOOT = "Everything Photos can show.";

/**
 * A CROSS-STACK destination (#712), and the only one: Backup health is a frame
 * screen, because the policy it edits governs Docs' scans and Notes'
 * attachments too, so Photos keeps a deep link rather than a copy.
 *
 * A union of ONE rather than a bare object type: that shape is what makes
 * `resolveMoreRowRoute`'s `never` check load-bearing, so a row added without a
 * matching case fails to typecheck rather than falling through at runtime.
 */
export type MoreRowRoute = {
  screen: "Settings";
  params: { screen: "BackupHealth" };
};

export function resolveMoreRowRoute(key: PhotosMoreRowKey): MoreRowRoute {
  switch (key) {
    case "backup":
      return { screen: "Settings", params: { screen: "BackupHealth" } };
    default: {
      const exhaustive: never = key;
      throw new Error(`Unhandled More-sheet row: ${String(exhaustive)}`);
    }
  }
}

// Band ownership is THE FRAME'S LATCH (`kit/band/band-owner.ts`, #712), and
// mobile shares web's `shell.bandOwner.*` key rather than keeping a twin.
// NOTHING is re-exported from here: this file only consumes the type, so it
// stays free of storage imports and its rules assert as plain values.

/** Exactly ONE exists at a time. */
export type ResolvedBand =
  | {
      owner: "app";
      destinations: readonly BandDestination[];
      capsule: BandCapsule;
    }
  | { owner: "host" };

export function resolveBand(owner: BandOwner): ResolvedBand {
  if (owner === "host") return { owner: "host" };
  // A claim over the cap is a bug in the table, never something to truncate
  // silently at render.
  if (PHOTOS_BAND_DESTINATIONS.length > BAND_MAX_DESTINATIONS) {
    throw new Error(
      `Photos claimed ${PHOTOS_BAND_DESTINATIONS.length} band destinations; the cap is ${BAND_MAX_DESTINATIONS}`
    );
  }
  return {
    owner: "app",
    destinations: PHOTOS_BAND_DESTINATIONS,
    capsule: BAND_CAPSULE,
  };
}
