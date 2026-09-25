// Hand-maintained (the emitter, `export-copy.ts`, left with v0's copy leaves
// in #1020 wave 6). `copy/photos.json` is its twin: edit both, and
// `CopySyncSpec` fails when they disagree. One file per app, so an app's
// port edits only its own.

package dev.centraid.design.copy

/** Photos's strings. STRINGS ONLY: a function composes a sentence and is the app's to write. */
public object PhotosCopy {
    public const val PHOTOS_ARCHIVE: String = "Archive"
    public const val PHOTOS_ARCHIVE_EMPTY: String = "Archive is empty."
    public const val PHOTOS_EMPTY_DUPLICATES: String = "No near-identical clusters in your library."
    public const val PHOTOS_EMPTY_FAVORITES: String = "No favorites yet — tap the heart on any photograph."
    public const val PHOTOS_ERROR_EDIT_NOT_SAVED: String = "Photograph not saved."
    public const val PHOTOS_ERROR_EXPORT_FAILED: String = "Photograph not exported."
    public const val PHOTOS_ERROR_FREE_UP_PAUSED: String = "Free up vault paused."
    public const val PHOTOS_ERROR_IN_CLOUD: String = "Original is still in iCloud."
    public const val PHOTOS_ERROR_WRITE_NOT_SAVED: String = "Photo change not saved."
    public const val PHOTOS_SAVE_AS_NEW: String = "Save as a new photograph"
    public const val PHOTOS_SAVE_AS_NEW_EXPLANATION: String = "Saving writes a new photograph with the original's date and place; the original is not touched."
    public const val PHOTOS_SAVED_AS_NEW: String = "Saved as a new photograph"
    public const val PHOTOS_SEARCH_PLACEHOLDER: String = "Search photographs, people, places, albums"
    public const val PHOTOS_UNARCHIVE: String = "Unarchive"
    public const val PHOTOS_VIDEO_STATUS: String = "Video · playing from the display copy on this device"
    public const val PLACE_NO_LOCATION: String = "No location yet"
    public const val PLACE_UNNAMED: String = "A place with no name yet"
}
