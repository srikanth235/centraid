package dev.centraid.android.screens.agenda

/**
 * AN EVENT'S LINK ON THE PHONE'S CALENDAR. `CalendarContract` has no address column (EventKit has
 * `url`), so the writer keeps the link as the LAST paragraph of the description, after a blank
 * line, and the reader takes it out again. Notes and link therefore round-trip as the two fields
 * Rust holds: what [join] writes, [split] reads back unchanged, and the two-way sync sees no
 * edit on a pass that only read what it wrote.
 *
 * Only a web address in its own last paragraph is a link; anything else a description ends with
 * stays in the notes.
 */
internal object CalendarLink {
    private const val BREAK = "\n\n"

    /** The description for [notes] and [url]; either may be empty. */
    fun join(notes: String, url: String): String {
        val text = notes.trim()
        val link = url.trim()
        return when {
            link.isEmpty() -> notes
            text.isEmpty() -> link
            else -> text + BREAK + link
        }
    }

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
