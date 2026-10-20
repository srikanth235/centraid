package dev.centraid.shared.sync.phone

import okio.ByteString.Companion.encodeUtf8

/**
 * WHICH PHONE STORE A SYNC PASS FOLLOWS (#1127, `phone_link.source`). The engine is the same for
 * every one; a source brings only its snapshot reader and its [PhoneStore].
 */
public enum class PhoneSource(public val wire: String) {
    CONTACTS("contacts"),
    CALENDAR("calendar"),
    FILES("files"),
}

/**
 * THE PHONE'S OWN ID FOR A RECORD, WITH ITS KIND AS A PREFIX (R-1127-10), so a portable id is never
 * mistaken for a local fallback: `uid:` an iCal UID (the same on every device Google syncs to),
 * `lookup:` an Android `LOOKUP_KEY`, `local:` an id that means something on this device only (an
 * iOS contact identifier, an Android `CONTACT_ID`, an EventKit item id). A `file:` kind for the
 * Docs lane is just another prefix: the engine reads only that one is there.
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

/**
 * THE FIELDS A PHONE OWNS, IN ONE CANONICAL FORM, and the digest over them (R-1127-2).
 *
 * The digest is computed the same way from a phone record and from a vault row: the same
 * normalization (whitespace folded, phone numbers reduced to digits, emails lowercased), sets
 * sorted and de-duplicated so a list's order never changes it, and an absent field and an empty
 * one the same. A field a phone does not own (a note the member added, a tag) is not in it.
 */
public class PhoneFields private constructor(private val entries: Map<String, List<String>>) {
    /** The canonical form, for the tests: one `key=value|value` line per field, sorted by key. */
    public fun canonical(): String = entries.entries.sortedBy { it.key }
        .joinToString("\n") { (key, values) -> key + "=" + values.joinToString("|") }

    /** A stable digest of [canonical]: 64 hex characters. */
    public fun digest(): String = canonical().encodeUtf8().sha256().hex()

    public fun isEmpty(): Boolean = entries.isEmpty()

    override fun equals(other: Any?): Boolean = other is PhoneFields && other.entries == entries

    override fun hashCode(): Int = entries.hashCode()

    override fun toString(): String = "PhoneFields(${canonical().replace('\n', ';')})"

    /** Collects one record's fields. */
    public class Builder internal constructor() {
        internal val entries: MutableMap<String, List<String>> = linkedMapOf()

        /** One value, whitespace folded. A blank value is no field. */
        public fun text(key: String, value: String) {
            put(key, listOf(squash(value)))
        }

        /** One value kept as it is spelled apart from the ends, for a field whose case or runs mean something. */
        public fun exact(key: String, value: String) {
            put(key, listOf(value.trim()))
        }

        /** A set of values, each folded by [normalize], sorted and de-duplicated. */
        public fun set(key: String, values: List<String>, normalize: (String) -> String = ::squash) {
            put(key, values.map(normalize).filter { it.isNotEmpty() }.distinct().sorted())
        }

        /** Phone numbers: digits, and a leading `+` that means a country code. */
        public fun phones(key: String, values: List<String>) {
            set(key, values, ::phoneNumber)
        }

        /** Email addresses: folded and lowercased. */
        public fun emails(key: String, values: List<String>) {
            set(key, values) { squash(it).lowercase() }
        }

        private fun put(key: String, values: List<String>) {
            val kept = values.filter { it.isNotEmpty() }
            if (kept.isEmpty()) entries.remove(key) else entries[key] = kept
        }
    }

    public companion object {
        /** No fields at all: what a record with no satellite carries. */
        public val EMPTY: PhoneFields = PhoneFields(emptyMap())

        public fun of(build: Builder.() -> Unit): PhoneFields = PhoneFields(Builder().apply(build).entries.toMap())

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

        /** `(555) 010-0142` and `555.010.0142` are one number; `+1 555…` keeps its `+`. */
        public fun phoneNumber(value: String): String {
            val trimmed = value.trim()
            val digits = trimmed.filter { it in '0'..'9' }
            if (digits.isEmpty()) return squash(trimmed)
            return if (trimmed.startsWith("+")) "+$digits" else digits
        }

        private const val NO_BREAK_SPACE: Char = ' '
    }
}

/**
 * A LINK'S FINGERPRINT: THREE DIGESTS IN ONE OPAQUE STRING (the vault stores it and reads nothing
 * in it). `phone` is the digest of the phone record's fields the engine last WROTE; `satellite`
 * the digest of its satellite (what a source follows beside the row's own fields, a series'
 * skipped and moved occurrences); `vault` the digest of the vault row as it READ BACK right after
 * writing it.
 *
 * Three, because the phone's fields and the row the vault keeps are not always spelled alike (a
 * zoned event's wall clock is stored as an instant), so "was the row edited" is the row held
 * against itself and "did the phone change" is the phone held against itself; neither has to
 * convert the one into the other. The satellite is held apart from `phone` because its change is
 * a reason to write the satellite alone, not to rewrite the row.
 */
public object PhoneFingerprint {
    public data class Parts(public val phone: String, public val satellite: String, public val vault: String)

    public fun pack(phone: String, satellite: String, vault: String): String = "v2.$phone.$satellite.$vault"

    public fun parts(fingerprint: String): Parts? {
        val pieces = fingerprint.split('.')
        if (pieces.size != PIECES || pieces[0] != "v2" || pieces.drop(1).any { it.isEmpty() }) return null
        return Parts(phone = pieces[1], satellite = pieces[2], vault = pieces[3])
    }

    private const val PIECES: Int = 4
}

/** A phone account, calendar or picked folder, as the phone names it now. */
public data class PhoneOriginRef(
    public val id: String,
    public val label: String,
)

/**
 * ONE RECORD OF THE PHONE.
 *
 * @property phoneId its durable, kind-prefixed id ([PhoneIds]).
 * @property origin the [PhoneOriginRef.id] it was read in.
 * @property fields the fields the phone owns, canonical.
 * @property matchKey what an unlinked vault row must equal to be adopted (a person's folded name,
 *   an event's folded title); blank adopts nothing.
 * @property tiebreak what ranks several rows with the same [matchKey] (a person's channels).
 * @property satellite what the source follows beside the row's own fields (a series' skipped and
 *   moved occurrences). A change in it alone writes [PhoneStore.follow] and nothing to the row.
 * @property attributes what the source's writer needs and the engine never reads (a contact's
 *   birthday, an event's wall-clock times).
 */
public data class PhoneRecord(
    public val phoneId: String,
    public val origin: String,
    public val fields: PhoneFields,
    public val matchKey: String = "",
    public val tiebreak: Set<String> = emptySet(),
    public val satellite: PhoneFields = PhoneFields.EMPTY,
    public val attributes: Any? = null,
)

/**
 * WHAT THE PHONE HOLDS RIGHT NOW FOR ONE SOURCE.
 *
 * @property complete false for a read that may have missed records: iOS limited contacts access,
 *   a permission refused, a store that failed part-way. **An incomplete snapshot never trashes,
 *   forgets or holds anything** (R-1127-3, R-1127-9).
 * @property readAt when the read was made, RFC 3339 UTC with milliseconds; a link sighted at or
 *   after it is not touched again, which is what makes a second pass over the same snapshot write
 *   nothing.
 * @property origins every account, calendar or folder present, whether or not it has a record.
 */
public data class PhoneSnapshot(
    public val source: PhoneSource,
    public val complete: Boolean,
    public val readAt: String,
    public val origins: List<PhoneOriginRef>,
    public val records: List<PhoneRecord>,
)

/** An origin as the vault holds it: its row id, the phone's id for it, and the label last written. */
public data class StoredOrigin(
    public val originId: String,
    public val phoneOrigin: String,
    public val label: String,
)

/**
 * A `phone_link` row. [entityId] is null for the tombstone a purge leaves (the member deleted the
 * row forever): the phone record must not be added again, and the link goes once the phone record
 * does.
 */
public data class StoredLink(
    public val linkId: String,
    public val phoneId: String,
    public val originId: String,
    public val entityId: String?,
    public val fingerprint: String,
    public val detached: Boolean,
    public val lastSeenAt: String,
) {
    public val purged: Boolean get() = entityId == null
}

/**
 * A VAULT ROW OF THE SOURCE'S KIND, read for a fingerprint or an adoption: a person, an event, a
 * document. [fields] is what the source's reader makes of the row, canonical; [trashed] is in the
 * trash.
 */
public data class VaultRow(
    public val entityId: String,
    public val fields: PhoneFields,
    public val trashed: Boolean = false,
    public val matchKey: String = "",
    public val tiebreak: Set<String> = emptySet(),
    public val attributes: Any? = null,
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
 * stored while it was present. Its rows are held, not trashed, until [PhoneSync.resolveGone].
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

/** What a member answers to [OriginGone]. Keeping detaches the rows (R-1127-2) and is the default. */
public enum class GoneChoice { KEEP, TRASH }
