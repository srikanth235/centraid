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

/** A destination in the claimed band. `more` opens the sheet, not a route. */
export type BandDestinationKey =
  | "library"
  | "albums"
  | "people"
  | "search"
  | "more";

export interface BandDestination {
  key: BandDestinationKey;
  /** Copy is final (handoff §3.1) — these five strings are the band. */
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
 * Photos' five (§3.1). Exactly these, in this order, on every compact surface.
 */
export const PHOTOS_BAND_DESTINATIONS: readonly BandDestination[] = [
  { key: "library", label: "Library", icon: "image" },
  { key: "albums", label: "Albums", icon: "Layers" },
  { key: "people", label: "People", icon: "users" },
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
export type PhotosMoreRowKey =
  | "sharing"
  | "favorites"
  | "places"
  | "duplicates"
  | "trash"
  | "backup";

/** What the More sheet carries (§3.1) — the shelves the five cannot hold. */
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
 * SHARING IS BACK; IMPORT IS STILL NOT (issue #712, A5).
 *
 * This table used to carry neither, and the comment here said to add each one
 * "the moment their surfaces ship — not before". Sharing's surface ships in
 * this pass (`SharingShelf.tsx`), so its row is here, FIRST, exactly where the
 * handoff puts it (proto:4980-4983). Import still has no phone surface — no
 * upload / drag / capture flow (proto:3978) — so it is still absent. A missing
 * row is honest; a row that lies about its destination is not, and
 * `resolveMoreRowRoute` below fails to TYPECHECK on a key with no case.
 *
 * `Photo access` is gone from this table (P13). It was never one of the
 * handoff's rows: it existed because the phone's grant belongs to an operating
 * system and a refused grant otherwise left an empty grid with no sentence.
 * The sentence now lives IN the grid's own slot (`PhotoAccessPanel.tsx`, via
 * `photoAccessTakesOverTimeline`), which is where the question is asked — so
 * the buried row that answered it somewhere else is not needed and would be a
 * second, worse route to the same content.
 */
export const PHOTOS_MORE_ROWS: readonly MoreRow[] = [
  { key: "sharing", label: "Sharing", icon: "share" },
  { key: "favorites", label: "Favorites", icon: "heart" },
  { key: "places", label: "Places", icon: "Pin" },
  { key: "duplicates", label: "Duplicates", icon: "copy" },
  { key: "trash", label: "Trash", icon: "trash-2" },
  // "Backup", not "Storage" (issue #712, B1). The screen it opens has always
  // been titled "Backup health" and has always been about whether this device's
  // photographs have left it — the row's old label named the noun the screen
  // does not discuss. The KEY moved with the label rather than being left as a
  // stale `storage`: this union is closed and its every reference is in this
  // package, so a half-rename would have been the only cost of keeping it.
  { key: "backup", label: "Backup", icon: "archive" },
];

/** The sheet's foot line (proto:4979), verbatim. */
export const PHOTOS_MORE_FOOT =
  "Everything Photos can show. The vault mark in the head goes back to the rest of Centraid.";

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
export type MoreRowRoute =
  | { screen: "PhotoStateView"; params: { mode: "trash" | "favorites" } }
  /**
   * A CROSS-STACK destination (issue #712, B2). Backup health is a frame
   * screen now — it lives in Settings beside Phone storage, because nothing on
   * it is about photographs: the policy it edits governs Docs' scans and
   * Notes' attachments too. Photos keeps a deep link to it rather than a copy,
   * the same way `PhotoLightbox`'s `onParked` reaches Approvals.
   */
  | { screen: "Settings"; params: { screen: "BackupHealth" } }
  | { screen: "DuplicatesShelf" | "PlacesView" | "SharingShelf" };

export function resolveMoreRowRoute(key: PhotosMoreRowKey): MoreRowRoute {
  switch (key) {
    case "trash":
      return { screen: "PhotoStateView", params: { mode: "trash" } };
    case "favorites":
      return { screen: "PhotoStateView", params: { mode: "favorites" } };
    case "duplicates":
      // The SHELF, not the review (proto:4436 vs proto:4291). The row's meta
      // is a cluster count, so the surface it opens has to be the one that
      // shows clusters; the review is one control away, from the shelf's own
      // head, exactly as the prototype's `Review duplicates` primary is.
      return { screen: "DuplicatesShelf" };
    case "sharing":
      return { screen: "SharingShelf" };
    case "places":
      // Cards first (proto:4197): the More row opens the place-cards shelf,
      // not the map directly. The map is one control away, from the shelf's
      // own head (`PlacesView` → `PlacesMap`).
      return { screen: "PlacesView" };
    case "backup":
      return { screen: "Settings", params: { screen: "BackupHealth" } };
    default: {
      const exhaustive: never = key;
      throw new Error(`Unhandled More-sheet row: ${String(exhaustive)}`);
    }
  }
}

/**
 * Who owns the band right now. The member may hand it back to the frame; the
 * shipped web shell persists this PER DEVICE (`shell.bandOwner.<appId>` in
 * local storage) because this repo has no server-side member-preference plane.
 * Mobile matches that reality rather than inventing a sync path.
 */
export type BandOwner = "app" | "host";

export const DEFAULT_BAND_OWNER: BandOwner = "app";

/** Where a member's band-owner choice lives on this device. */
export const bandOwnerKey = (appId: string): string =>
  `photos.bandOwner.${appId}`;

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
