// Photos copy web and native both print. Deliberately IMPORT-FREE: native
// bundles this leaf and cannot read the web app's `.ts` graph. `view-copy.ts`
// re-exports it and holds the rest.

export const PLACE_UNNAMED = "A place with no name yet";

/** Distinct from `PLACE_UNNAMED`: nobody placed this one at all. */
export const PLACE_NO_LOCATION = "No location yet";

export const PLACE_NO_LOCATION_TERMS: readonly string[] = [
  "no location",
  "no place",
  "unlocated",
];

export const PLACE_HOME_TERMS: readonly string[] = [
  "home",
  "at home",
  "near home",
];

export function duplicatesLede(clusterCount: number): string {
  const noun = clusterCount === 1 ? "cluster" : "clusters";
  return `${clusterCount} ${noun} of near-identical photographs — selecting a copy marks it for trash.`;
}

export const PHOTOS_EMPTY_FAVORITES =
  "No favorites yet — tap the heart on any photograph.";

export const PHOTOS_EMPTY_DUPLICATES =
  "No near-identical clusters in your library.";

export const PHOTOS_SEARCH_PLACEHOLDER =
  "Search photographs, people, places, albums";

// WHAT PHOTOS SAYS WHEN A WRITE DOES NOT LAND (#1015, S14).
//
// One noun per failure and the shared retry word — never the engine's own
// sentence. A member who is told `AbortError: The operation was aborted.`
// has been handed a fact about the runtime, not about their photograph, and
// cannot act on it. The reason still reaches the log; only the SCREEN is
// spared. Signage names the noun (DESIGN.md §Copy).
export const PHOTOS_ERROR_EDIT_NOT_SAVED = "Photograph not saved.";
export const PHOTOS_ERROR_EXPORT_FAILED = "Photograph not exported.";
// A CAUSE the member can act on, so it is named rather than folded into the
// generic noun: the original lives in iCloud and has to come down first.
export const PHOTOS_ERROR_IN_CLOUD = "Original is still in iCloud.";
export const PHOTOS_ERROR_FREE_UP_PAUSED = "Free up vault paused.";
export const PHOTOS_ERROR_WRITE_NOT_SAVED = "Photo change not saved.";

export const PHOTOS_VIDEO_STATUS =
  "Video · playing from the display copy on this device";

export function photosOriginalNotFetched(gatewayName: string): string {
  return `Original on ${gatewayName} · a full-quality copy has not been fetched`;
}

export const PHOTOS_SAVE_AS_NEW = "Save as a new photograph";

export const PHOTOS_SAVE_AS_NEW_EXPLANATION =
  "Saving writes a new photograph dated today; the original is not touched.";

export const PHOTOS_SAVED_AS_NEW = "Saved as a new photograph";

export function photosFaceMatchedOn(matchCount: number): string {
  return `Matched on ${matchCount} other photograph${matchCount === 1 ? "" : "s"}. `;
}

export function photosPinLabel(
  where: string,
  places: number,
  photographs: string
): string {
  return places > 1
    ? `${where} and ${places - 1} more nearby, ${photographs}`
    : `${where}, ${photographs}`;
}

export function photosPurgeNote(days: number): string {
  return days === 0
    ? "purges today"
    : `purges in ${days} ${days === 1 ? "day" : "days"}`;
}

/** The archived-shelf verb. Same word as the shelf, on every seat. */
export const PHOTOS_ARCHIVE = "Archive";
export const PHOTOS_UNARCHIVE = "Unarchive";
export const PHOTOS_ARCHIVE_EMPTY = "Archive is empty.";

export function photosArchiveVerb(archived: boolean): string {
  return archived ? PHOTOS_UNARCHIVE : PHOTOS_ARCHIVE;
}

export function photosArchiveMoved(archiving: boolean): string {
  return archiving
    ? "Moved to Archive — the device original is untouched."
    : "Back in your library.";
}
