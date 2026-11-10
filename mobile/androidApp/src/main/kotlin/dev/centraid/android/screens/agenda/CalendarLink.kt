package dev.centraid.android.screens.agenda

/**
 * AN EVENT'S LINK ON THE PHONE'S CALENDAR. `CalendarContract` has no address column (EventKit has
 * `url`), so a phone calendar app keeps the link as the LAST paragraph of the description, after
 * a blank line, and the reader takes it out again as the two fields Rust holds.
 *
 * Only a web address in its own last paragraph is a link; anything else a description ends with
 * stays in the notes.
 */
internal object CalendarLink {
    private const val BREAK = "\n\n"

    /** The notes and the link a description holds. */
    fun split(description: String): Pair<String, String> {
        val text = description.trimEnd()
        val at = text.lastIndexOf(BREAK)
        val tail = if (at < 0) text else text.substring(at + BREAK.length)
        if (!isWebAddress(tail)) return description to ""
        return (if (at < 0) "" else text.substring(0, at)) to tail
    }

    private fun isWebAddress(text: String): Boolean =
        text.isNotEmpty() &&
            text.none { it.isWhitespace() } &&
            (text.startsWith("http://", ignoreCase = true) || text.startsWith("https://", ignoreCase = true)) &&
            text.length > "https://".length
}
