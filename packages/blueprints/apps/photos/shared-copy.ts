export const PLACE_UNNAMED = "A place with no name yet";

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
