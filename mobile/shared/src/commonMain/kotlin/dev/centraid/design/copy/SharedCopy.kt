// Hand-maintained (the emitter, `export-copy.ts`, left with v0's copy leaves
// in #1020 wave 6). `copy/shared.json` is its twin: edit both, and
// `CopySyncSpec` fails when they disagree. One file per app, so an app's
// port edits only its own.

package dev.centraid.design.copy

/** Shared's strings. STRINGS ONLY: a function composes a sentence and is the app's to write. */
public object SharedCopy {
    public const val ALL_DAY: String = "All day"
    public const val LEAVING_SHARED_VAULT: String = "Leaving ends your access to this vault; copies already shared into your own vault stay."
    public const val MONTH_01: String = "January"
    public const val MONTH_02: String = "February"
    public const val MONTH_03: String = "March"
    public const val MONTH_04: String = "April"
    public const val MONTH_05: String = "May"
    public const val MONTH_06: String = "June"
    public const val MONTH_07: String = "July"
    public const val MONTH_08: String = "August"
    public const val MONTH_09: String = "September"
    public const val MONTH_10: String = "October"
    public const val MONTH_11: String = "November"
    public const val MONTH_12: String = "December"
    public const val SAVED_TO_MY_VAULT: String = "Saved to my vault"
    public const val SHARE_ENRICHMENT_IS_THEIRS: String = "Their vault makes its own thumbnails, text and search for the copy, under their settings."
    public const val STRANDED_WRITE: String = "Your last change in {app} was not saved."
    public const val STRANDED_WRITE_WHY: String = "{app}: {sentence}"
    public const val TODAY: String = "Today"
    public const val TOMORROW: String = "Tomorrow"
    public const val TRASH_DELETED: String = "Deleted"
    public const val TRASH_EMPTY_ACTION: String = "Empty trash"
    public const val TRASH_EMPTY_BODY: String = "Everything in trash leaves this vault for good. This cannot be undone."
    public const val TRASH_EMPTY_HEADLINE: String = "Trash is empty."
    public const val TRASH_EMPTY_STATE_BODY: String = "Deleted things wait here before they go for good."
    public const val TRASH_EMPTY_TITLE: String = "Empty trash?"
    public const val TRASH_PURGE: String = "Delete forever"
    public const val TRASH_PURGE_BODY: String = "It leaves this vault for good. This cannot be undone."
    public const val TRASH_PURGE_TITLE: String = "Delete this forever?"
    public const val TRASH_RESTORE: String = "Restore"
    public const val TRASH_TITLE: String = "Trash"
    public const val TRASH_UNTITLED: String = "Untitled"
    public const val VAULT_DENIED_TITLE: String = "No vault access yet."
    public const val WEEKDAY_FRI: String = "Fri"
    public const val WEEKDAY_MON: String = "Mon"
    public const val WEEKDAY_SAT: String = "Sat"
    public const val WEEKDAY_SUN: String = "Sun"
    public const val WEEKDAY_THU: String = "Thu"
    public const val WEEKDAY_TUE: String = "Tue"
    public const val WEEKDAY_WED: String = "Wed"
    public const val YESTERDAY: String = "Yesterday"
}
