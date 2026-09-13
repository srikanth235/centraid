package dev.centraid.shared.screen

/**
 * What a shell learns when it pairs or syncs (#1020, D-1020-B7).
 *
 * Two small result types and two field readers, kept out of [HomeSession] so
 * that file stays about a screen.
 */

/** The command name that runs one sync pass. Mirrors `centraid_core`'s. */
public const val SEAT_SYNC_COMMAND: String = "seat.sync"

/** What came of redeeming a ticket. */
public sealed interface PairOutcome {
    /** Paired. The name is the GATEWAY's for the vault, not the ticket's — a
     *  ticket is minted once and read off a screen later, so a vault renamed in
     *  between would otherwise be shown under its old name forever. */
    public data class Paired(val vaultName: String) : PairOutcome

    /**
     * Not paired, with a sentence a member can act on.
     *
     * **The sentence is made from a code, never from a peer's words.** The
     * gateway's refusal vocabulary carries no text at all, on purpose.
     */
    public data class Refused(val sentence: String) : PairOutcome

    /** There is no vault open to pair on behalf of. */
    public data object NoCore : PairOutcome
}

/** What one sync pass moved. */
public data class SyncOutcome(
    val rowsApplied: Long = 0,
    val blobsCompleted: Long = 0,
    val bytesMoved: Long = 0,
    /**
     * The gateway was not reached. **A state, not a failure**: the seat is
     * stale, it still reads, and the next window continues from here. A shell
     * that drew a red banner every time a phone was in a lift would be wrong
     * about what happened.
     */
    val unreachable: Boolean = false,
    val sentence: String = "",
)

/**
 * Read one integer field out of a flat JSON object.
 *
 * NOT A JSON PARSER, and deliberately not. The payload is five fields written
 * by `Handle::seat_sync` with `serde_json` — flat, no nesting, no strings that
 * could contain a brace — and pulling a multiplatform JSON dependency into
 * `commonMain` to read five integers would be a dependency for nothing. An
 * unreadable field answers `null` and the caller's default stands, which is the
 * same answer it would give for a field a newer core stopped sending.
 */
internal fun String.intField(name: String): Long? {
    val at = indexOf("\"$name\":")
    if (at < 0) return null
    val from = at + name.length + 3
    val digits = substring(from).takeWhile { it.isDigit() || it == '-' }
    return digits.toLongOrNull()
}

/** As [intField], for `true`/`false`. */
internal fun String.boolField(name: String): Boolean? {
    val at = indexOf("\"$name\":")
    if (at < 0) return null
    return substring(at + name.length + 3).startsWith("true")
}
