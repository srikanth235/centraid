// The phone's bottom band, as a model (Photos v4 handoff §3.1, CHANGELOG §F/§G).
//
// Invariant 1 was amended for the compact surface: a first-party route may
// CLAIM the band, capped at five destinations plus More. Photos claims it. The
// frame is then represented by a capsule — a Home button at the LEADING edge,
// OUTSIDE the app's tab group, on the frame's own page colour with its own
// border. The group boundary is the whole explanation for why the capsule is
// not a sixth tab, so "outside the group" is structural here, not cosmetic:
// the capsule and the tab group are TWO SEPARATE PLATES (each with its own
// radius, hairline and ground) inside a transparent row, and the 8pt gap
// between them is the seam. There is no enclosing plate — see the anatomy
// block in `PhotosBand.tsx`.
//
// (CHANGELOG §F's prose says "trailing edge"; README §3.1 and the shipped web
// shell — `packages/client/src/react/shell/AppBand.tsx` — both say leading, and
// leading is what this mirrors. Under RTL "leading" flips with the writing
// direction, which is the point: §18 requires the capsule to mirror.)
//
// This module is deliberately free of `react-native` imports so the rules can
// be asserted directly. `PhotosBand.tsx` renders them and adds nothing.

import type { BandOwner } from "../../kit/band/band-owner";

/** A destination in the claimed band. `more` opens the sheet, not a route. */
export type BandDestinationKey = "library" | "collections" | "search" | "more";

export interface BandDestination {
  key: BandDestinationKey;
  /** Copy is final (handoff §3.1) — these four strings are the band. */
  label: string;
  icon: string;
}

/**
 * The cap the frame's own band lives under, and therefore the cap a claiming
 * app lives under too: five destinations, of which the fifth is More.
 */
export const BAND_MAX_DESTINATIONS = 5;

/** The capsule's target. The brief's number is 52 (`width:52px` at :4961); 44
 *  is the floor no target in the system may go under, and the capsule is
 *  explicitly held to it. On the phone this is the capsule plate's WIDTH — its
 *  height comes from the row's `align-items:stretch`, so it matches the tab
 *  group's plate exactly rather than being independently square. */
export const BAND_CAPSULE_SIZE = 52;
export const TARGET_MIN = 44;

// §G — the band floats, inset from the stage edges on opaque paper: 12 off the
// sides and the bottom, 8 clear of the content above. The plate's geometry and
// the opacity rule live in `kit/band-surface.ts`, because Home's band and a
// claimed band draw the same plate and must not drift apart — the claimed band
// simply draws it twice, once for the capsule and once for the tab group.

/**
 * Photos' four (§3.1, issue #712). Exactly these, in this order, on every
 * compact surface: Library first — the timeline is what a member reaches for
 * most, and the band is judged by how few taps that costs — then Collections,
 * then Search, then More. People is not a tab here: it is reached from
 * Collections' own People section (`PhotosCollectionsView.tsx`'s `open()`)
 * and from the Library shelf list's People row, both of which land on the
 * pushed `PhotosPeople` route rather than a band destination.
 */
export const PHOTOS_BAND_DESTINATIONS: readonly BandDestination[] = [
  { key: "library", label: "Library", icon: "image" },
  // Collections, not Albums. The destination behind it holds every shelf
  // Photos has — albums, people, places, favorites, duplicates, trash — so
  // "Albums" named one section of it and hid the rest behind the More sheet.
  // See `PhotosCollectionsView.tsx`.
  { key: "collections", label: "Collections", icon: "Layers" },
  { key: "search", label: "Search", icon: "search" },
  { key: "more", label: "More", icon: "more-vertical" },
];

/**
 * Every key `PHOTOS_MORE_ROWS` carries — declared up front (not derived from
 * the table) so `MoreRow.key` is a closed union and `PhotosHome`'s router can
 * switch over it exhaustively. A row added to `PHOTOS_MORE_ROWS` with a key
 * outside this union fails to typecheck right here, before it ever reaches
 * the router.
 */
export type PhotosMoreRowKey = "backup";

/** What the More sheet carries (§3.1) — the shelves the four cannot hold. */
export interface MoreRow {
  key: PhotosMoreRowKey;
  label: string;
  icon: string;
  /**
   * The row's mono meta string (proto:4980-4983 — e.g. `"128"`,
   * `"6 clusters"`, `"24 · purged in 30 days"`). This is filled in at RENDER
   * time from a live count (`PhotosMoreSheet.tsx`), never here — this module
   * stays free of react-native/replica imports so the rules can be asserted
   * directly. Omitted (not a placeholder number) where the app has no
   * reliable live source for the count.
   */
  meta?: string;
}

/**
 * ONE ROW. What this sheet is FOR, after Collections.
 *
 * It used to carry six — Sharing, Favorites, Places, Duplicates, Trash and
 * Backup — because the band could hold five destinations and Photos has more
 * shelves than that. Collections (`PhotosCollectionsView.tsx`) is now the
 * landing surface and carries every shelf that still exists as a named
 * section with a live count, on screen, without a sheet in the way (Sharing
 * stopped existing with issue #726). Keeping the rows here as well would mean
 * two doors to each shelf, of which one is hidden — and two places to keep
 * their labels and counts honest.
 *
 * So the sheet keeps exactly what Collections does not carry:
 *
 *   - **Backup**, which is not a shelf at all. It is a cross-stack link to a
 *     FRAME screen (issue #712 B2) about whether this device's bytes have
 *     left it — a policy that governs Docs' scans and Notes' attachments too.
 *
 * Tile size used to be rendered directly by this sheet too; it has since
 * moved on to the Library's own header menu (`photos-library-menu.ts`),
 * reached from the header chip rather than from here — see that module's own
 * header comment.
 *
 * `Import` was never here (no phone surface ships one) and `Photo access` was
 * removed in P13, because the grant's sentence belongs in the grid's own slot
 * where the question is actually asked.
 */
export const PHOTOS_MORE_ROWS: readonly MoreRow[] = [
  // "Backup", not "Storage" (issue #712, B1). The screen it opens has always
  // been titled "Backup health" and has always been about whether this device's
  // photographs have left it — the row's old label named the noun the screen
  // does not discuss.
  { key: "backup", label: "Backup", icon: "archive" },
];

/** The sheet's foot line (proto:4979), cut to its first clause: the second
 *  sentence narrated a control the member is looking at (#805). */
export const PHOTOS_MORE_FOOT = "Everything Photos can show.";

/**
 * Where a More-sheet row goes. Kept as a pure mapping, in this
 * react-native-free module, for two reasons at once:
 *
 *   1. `PhotosHome`'s old router handled only `duplicates`, `places` and
 *      `storage`; every other key — `trash`, `favorites`, and the since-
 *      removed `sharing`/`import` — fell through to an
 *      `else navigate("PhotosLibrary")`. That silent fallthrough is the
 *      defect this whole issue is about. Routing through one function that
 *      switches exhaustively over `PhotosMoreRowKey` means a row added to
 *      `PHOTOS_MORE_ROWS` without a matching case here fails to TYPECHECK
 *      (the `never` assignment in `default`), not just fails at runtime.
 *   2. It is directly testable (`photos-more-router.test.ts`) without
 *      rendering `PhotosHome`, which pulls in the replica provider, the
 *      timeline engine, expo-notifications and expo-haptics — none of which
 *      this routing rule depends on.
 */
/**
 * A CROSS-STACK destination (issue #712, B2), and now the only one. Backup
 * health is a frame screen — it lives in Settings beside Phone storage,
 * because nothing on it is about photographs: the policy it edits governs
 * Docs' scans and Notes' attachments too. Photos keeps a deep link to it
 * rather than a copy, the same way `PhotoLightbox`'s `onParked` reaches
 * Approvals.
 *
 * Still a union of one rather than a bare object type: the shape is what makes
 * `resolveMoreRowRoute`'s `never` check load-bearing, and a second row added
 * to this sheet should have to widen this deliberately.
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

/**
 * Who owns the band right now — THE FRAME'S LATCH, not Photos'
 * (`kit/band/band-owner.ts`, issue #712 E3). This module used to define the
 * type, the default and the storage key itself, under `photos.bandOwner.*`,
 * while the web shell kept the same concept under `shell.bandOwner.*`. Two
 * namespaces for one preference, owned by an app, for a decision the frame
 * makes. Mobile adopted web's key; see that module's header for what that
 * costs and why it is safe here.
 *
 * NOTHING is re-exported from here — every consumer imports the type, the
 * hook and the key straight from `kit/band/band-owner`. This file only
 * CONSUMES the type (in `resolveBand`'s signature) and stays free of
 * react-native and storage imports, so its rules can be asserted as plain
 * values (`photos-band.test.ts`) without dragging AsyncStorage into that
 * test's module graph.
 */

/** The frame's capsule — a frame control, never one of the app's tabs. */
export interface BandCapsule {
  label: "Home";
  icon: "home";
  size: number;
  /** Which end of the band it sits at, in LOGICAL terms so it mirrors. */
  edge: "leading";
  /** The seam. `false` is the whole reason it does not read as a sixth tab. */
  inTabGroup: false;
}

export const BAND_CAPSULE: BandCapsule = {
  label: "Home",
  icon: "home",
  size: BAND_CAPSULE_SIZE,
  edge: "leading",
  inTabGroup: false,
};

/**
 * The band, resolved. Exactly ONE of these exists at any moment: when the app
 * has claimed the band the frame's own band does not render, and when it has
 * not, the app's does not. There is no arrangement that yields two.
 */
export type ResolvedBand =
  | {
      owner: "app";
      destinations: readonly BandDestination[];
      capsule: BandCapsule;
    }
  | { owner: "host" };

export function resolveBand(owner: BandOwner): ResolvedBand {
  if (owner === "host") return { owner: "host" };
  // A claim over the cap is a bug in the destination table, not something to
  // silently truncate at render — an app that quietly loses a tab is worse
  // than one that fails its own test.
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
