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
