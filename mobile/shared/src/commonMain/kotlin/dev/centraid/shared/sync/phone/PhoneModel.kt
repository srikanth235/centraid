package dev.centraid.shared.sync.phone

/**
 * WHICH PHONE STORE A FOLLOWING PASS READS (#1127, `origin.system`). The merge is the vault's
 * (`follow.<system>`, #1135); a source brings only its reader.
 */
public enum class PhoneSource(public val wire: String) {
    CONTACTS("contacts"),
    CALENDAR("calendar"),
    FILES("files"),

    /** The phone's health store, into Health: its workouts follow through `follow.health`; its day totals through `measurement.record` (R-1129-3). */
    HEALTH("health"),
}

/**
 * THE PHONE'S OWN ID FOR A RECORD, WITH ITS KIND AS A PREFIX (R-1127-10), so a portable id is never
 * mistaken for a local fallback: `uid:` an iCal UID (the same on every device Google syncs to),
 * `lookup:` an Android `LOOKUP_KEY`, `local:` an id that means something on this device only (an
 * iOS contact identifier, an Android `CONTACT_ID`, an EventKit item id, a followed file's
 * `<folder>/<path>`, a health store's workout id). The engine reads only that a prefix is there,
 * and that a `local:` id is the device's own: its link names the [PhoneDevice] that made it.
 */
public object PhoneIds {
    public const val UID: String = "uid"
    public const val LOOKUP: String = "lookup"
    public const val LOCAL: String = "local"

    private val portable: Set<String> = setOf(UID, LOOKUP)

    public fun uid(value: String): String = "$UID:$value"

    public fun lookup(value: String): String = "$LOOKUP:$value"

    public fun local(value: String): String = "$LOCAL:$value"

    /** The kind an id carries (`uid`, `lookup`, `local`…), or null when it carries none. */
    public fun kind(id: String): String? {
        val at = id.indexOf(':')
        if (at < 1 || at == id.length - 1) return null
        val prefix = id.substring(0, at)
        return prefix.takeIf { p -> p.all { it in 'a'..'z' } }
    }

    /** An id the engine accepts: it names its kind and something after it. */
    public fun isValid(id: String): Boolean = kind(id) != null && id.substring(id.indexOf(':') + 1).isNotBlank()

    /** An id that survives a new phone, so the same record is re-found there without matching. */
    public fun isPortable(id: String): Boolean = kind(id) in portable
}

/** The phone's words, in one canonical form. */
public object PhoneFields {
    /** Whitespace runs (and no-break spaces) become one space; the ends go. */
    public fun squash(value: String): String {
        val out = StringBuilder(value.length)
        var pendingSpace = false
        for (character in value) {
            if (character.isWhitespace() || character == NO_BREAK_SPACE) {
                pendingSpace = out.isNotEmpty()
            } else {
                if (pendingSpace) out.append(' ')
                pendingSpace = false
                out.append(character)
            }
        }
        return out.toString()
    }

    private const val NO_BREAK_SPACE: Char = '\u00a0'
}

/** A phone account, calendar or picked folder, as the phone names it now. */
public data class PhoneOriginRef(
    public val id: String,
    public val label: String,
)

/** WHY AN ORIGIN'S ROWS ARE HELD FOR A QUESTION (R-1127-9). */
public enum class GoneReason {
    /** The account, calendar or folder is no longer on the phone at all. */
    LEFT,

    /** It is still listed, but a complete read lost most of its followed rows in one pass: a glitch looks like this. */
    VANISHED,
}

/**
 * THE QUESTION A VANISHED ORIGIN LEAVES (R-1127-9): "Your Google calendar is no longer on this
 * phone. Keep its 214 events?". Asked after the origin is gone, so [label] is the one the vault
 * stored while it was present. 
 * [reason] says whether the origin left ([GoneReason.LEFT]) or only lost most of its rows
 * ([GoneReason.VANISHED]); the question and its answer are the same, except that a vanished
 * origin's answer touches only the rows the read lost: those not sighted since [seenBefore], the
 * pass's read time.
 */
public data class OriginGone(
    public val source: PhoneSource,
    public val originId: String,
    public val phoneOrigin: String,
    public val label: String,
    public val count: Int,
    public val reason: GoneReason = GoneReason.LEFT,
    public val seenBefore: String = "",
)
