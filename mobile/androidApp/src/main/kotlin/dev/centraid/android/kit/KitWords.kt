package dev.centraid.android.kit

/**
 * THE KIT'S OWN FIXED WORDS (K5, #1029).
 *
 * The room and state views need a handful of words no machine names yet —
 * the retry verb, the skeleton's spoken label, the close key. Every kit
 * composable takes each as a parameter defaulting to the value here, so a
 * screen whose machine carries the word passes it and nothing reads this.
 *
 * These belong in `dev.centraid.design.copy.SharedCopy` (and
 * `copy/shared.json`), which the KMP lane owns; until they move, this is the
 * one Compose file that spells them, and the iOS kit spells the same words.
 */
public object KitWords {
    public const val RETRY: String = "Try again"
    public const val OPENING: String = "Opening"
    public const val SHOW_MORE: String = "Show more"
    public const val LOADING_MORE: String = "Loading more"
    public const val SAVED: String = "Saved"
    public const val SAVING: String = "Saving…"
    public const val NOT_SAVED: String = "Could not save"
    public const val CHANGED_ELSEWHERE: String = "Changed on another device"
    public const val PENDING: String = "Saving"
    public const val CANCEL: String = "Cancel"
    public const val DONE: String = "Done"
    public const val BACK: String = "Back"
    public const val SEARCH: String = "Search"
    public const val CLOSE_SEARCH: String = "Close search"
    public const val REFRESH: String = "Refresh"
}
