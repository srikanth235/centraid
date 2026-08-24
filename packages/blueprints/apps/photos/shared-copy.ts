/**
 * PHOTOS COPY BOTH CLIENTS PRINT — the strings web and native each render
 * verbatim, held in one place so the two surfaces cannot drift on what a
 * shelf says about itself.
 *
 * Deliberately IMPORT-FREE, the same shape as `enrichment-consent.ts`. Native
 * bundles this file straight out of the blueprints package, and the mobile
 * TypeScript project does not enable `allowImportingTsExtensions` or declare
 * CSS modules — so a module native reads must not reach for the web app's
 * explicit-`.ts` graph (`view-copy.ts` → `shelves.ts` → `components/
 * SelectionBar.tsx`), which is browser-native ESM on purpose and stays that
 * way. A leaf with no imports is the only shape that both worlds can read.
 *
 * `view-copy.ts` re-exports everything here, so web callers keep importing
 * from the module they already know and nothing about the web side changes.
 *
 * ONLY the strings native actually renders live here. This is not a second
 * home for Photos copy: the rest of the view copy — the shelf titles, the
 * empty-state table, Storage, Search — stays in `view-copy.ts` beside the
 * shelf ids it is keyed by.
 */

/**
 * The section head a Places group takes when the place it names has no name
 * (§5). It is NOT "Unknown": the vault knows exactly where these were taken,
 * it just has no label to print, and the copy says which of the two is true.
 */
export const PLACE_UNNAMED = "A place with no name yet";

/**
 * The trailing Places section/card holding the photographs that carry no place
 * at all (issue #816).
 *
 * A DIFFERENT sentence from `PLACE_UNNAMED`, and the difference is the whole
 * point: `PLACE_UNNAMED` is a place the vault located and cannot name, this is
 * a photograph nobody ever told where it was taken. "yet" because an EXIF-less
 * import can still be placed by hand later. It is a name in its own right, so
 * it never falls through `readableName`'s coordinate fallback.
 */
export const PLACE_NO_LOCATION = "No location yet";

/**
 * The words a member types when they are looking for that bucket.
 *
 * Held here rather than in either client because both surfaces answer the same
 * question — "where are the ones with no place?" — and a query that worked on
 * the phone and not on the desktop would read as one of them being broken.
 * Matched case-insensitively, substring either way, exactly like a place name.
 */
export const PLACE_NO_LOCATION_TERMS: readonly string[] = [
  "no location",
  "no place",
  "unlocated",
];

/**
 * The relative/home vocabulary a place can be FOUND by (issue #816), beside
 * whatever it is called: a member who cannot remember the name of the park
 * still knows it was near home. Only the "at home" and "around town" bands
 * answer to these — a photograph 200 km away is not near home in any register.
 */
export const PLACE_HOME_TERMS: readonly string[] = [
  "home",
  "at home",
  "near home",
];

/**
 * The Duplicates shelf's own lede line (§5, proto 4437), with the live
 * cluster count substituted for the prototype's fixed "Six" and the correct
 * grammar for exactly one cluster. Never names the issue that shipped this
 * shelf — an issue id is an implementation detail, not something a member
 * reads (a member-facing string must never print one).
 */
export function duplicatesLede(clusterCount: number): string {
  const noun = clusterCount === 1 ? "cluster" : "clusters";
  return `${clusterCount} ${noun} of near-identical photographs — selecting a copy marks it for trash.`;
}

// ── Copy both surfaces render, promoted here by issue #805 ──────────────────
//
// Each of these was written out twice: once in this package's web views and
// once in `apps/mobile/src/apps/photos/*`, byte for byte. `photo-edit-model.ts`
// said so in a comment — "lifting them into a leaf module both packages can
// import is the real fix, and is reported upstream" — and this is that lift.

/** The Favorites shelf, empty. One sentence, one gesture. */
export const PHOTOS_EMPTY_FAVORITES =
  "No favorites yet — tap the heart on any photograph.";

/** The Duplicates shelf, empty. */
export const PHOTOS_EMPTY_DUPLICATES =
  "No near-identical clusters in your library.";

/** Search's placeholder: a noun phrase naming what search reaches, not an
 *  instruction. */
export const PHOTOS_SEARCH_PLACEHOLDER =
  "Search photographs, people, places, albums";

/** A playing video names what it is playing FROM: the display copy, which is
 *  the byte actually on screen. */
export const PHOTOS_VIDEO_STATUS =
  "Video · playing from the display copy on this device";

/** Custody for an asset whose original has not been fetched yet. The gateway's
 *  own name rides along, because "the gateway" is not a place a member knows. */
export function photosOriginalNotFetched(gatewayName: string): string {
  return `Original on ${gatewayName} · a full-quality copy has not been fetched`;
}

/** The editor's commit, worded as what it DOES. */
export const PHOTOS_SAVE_AS_NEW = "Save as a new photograph";

/**
 * The explanation beside it, at the point of decision.
 *
 * A non-destructive edit is a risk decision, so it keeps its reassurance — but
 * ONE clause of it: closing with "The original is not touched, and nothing
 * is overwritten" is the same promise twice.
 */
export const PHOTOS_SAVE_AS_NEW_EXPLANATION =
  "Saving writes a new photograph dated today; the original is not touched.";

/** After the write lands. A toast is a fragment — the explanation above
 *  already made the promise, at the moment it was still a decision. */
export const PHOTOS_SAVED_AS_NEW = "Saved as a new photograph";

/** Face review's lead: how much evidence stands behind a proposal. */
export function photosFaceMatchedOn(matchCount: number): string {
  return `Matched on ${matchCount} other photograph${matchCount === 1 ? "" : "s"}. `;
}

/** What a map pin announces: where it is, how many places merged into it, and
 *  how many photographs stand behind it. */
export function photosPinLabel(
  where: string,
  places: number,
  photographs: string
): string {
  return places > 1
    ? `${where} and ${places - 1} more nearby, ${photographs}`
    : `${where}, ${photographs}`;
}

/** Trash's purge countdown, in the tile's state slot. */
export function photosPurgeNote(days: number): string {
  return days === 0
    ? "purges today"
    : `purges in ${days} ${days === 1 ? "day" : "days"}`;
}
