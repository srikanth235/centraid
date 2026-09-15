package dev.centraid.shared.shell

/**
 * What a shell learns when it pairs or syncs (#1020, D-1020-B7).
 *
 * Two small result types and two field readers, kept out of [HomeSession] so
 * that file stays about a screen.
 */

/** The command name that runs one sync pass. Mirrors `centraid_core`'s. */
public const val SEAT_SYNC_COMMAND: String = "seat.sync"

/**
 * THE COMMAND THAT CLOSES AN OPEN TAIL (#1025 S2, D-1025-S7-40).
 *
 * A tail is closed by the SHELL, from the thread that learns the foreground was
 * lost — never from the coroutine blocked inside the pass. Mirrors
 * `centraid_core`'s `SEAT_TAIL_STOP_COMMAND`.
 */
public const val SEAT_TAIL_STOP_COMMAND: String = "seat.tail.stop"

/**
 * FETCH THIS ONE NOW (#1025 S5, D-1025-S7-63).
 *
 * WhatsApp's download arrow, as a command. Mirrors `centraid_core`'s
 * `SEAT_BYTES_FETCH_COMMAND`, and like `seat.sync` it is the seat's own rather
 * than a registered vault command: it commits no row and has no handler.
 *
 * **It is `seat.sync` with a one-item window**, so the bytes it lands write
 * `seat_blob_held` like any landed blob and the grid refreshes through the same
 * `RowsChanged` over `media_asset` (D-1025-S7-21). No shell needs a second
 * decoder and no screen needs a second event kind for the success path.
 */
public const val SEAT_BYTES_FETCH_COMMAND: String = "seat.bytes.fetch"

/** What came of redeeming a ticket. */
public sealed interface PairOutcome {
    /**
     * Paired, AND the copy landed inside the pair call, so the replica could be
     * asked its own name.
     *
     * **[vaultName] comes out of the vault, never off the ticket** (#1025
     * S7-9). A ticket carries the gateway's `--vault-name` flag: on a seeded
     * demo it said "Centraid" over a vault whose `core_vault.display_name` is
     * "Tahoe Demo", so the sheet named the wrong thing at the one moment a
     * member is checking they paired with what they meant to. A ticket is also
     * minted once and read off a screen later, so a vault renamed in between
     * would be shown under its old name forever.
     */
    public data class Paired(val vaultName: String) : PairOutcome

    /**
     * PAIRED, AND THE COPY IS STILL COMING (#1025 S7-9).
     *
     * A real state and a common one: a gateway is reachable long enough to
     * redeem a ticket and not long enough to move a 300 MB artifact. There is
     * no replica to ask for a name yet, and the ticket's name is a placeholder
     * — so the sheet says the vault is being copied rather than printing a
     * label it cannot vouch for. The roster names it properly the moment the
     * first pass brings the file.
     */
    public data object Copying : PairOutcome

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

/**
 * ONE STAGE OF A PASS, AS THE CORE REPORTED IT (#1025 S7).
 *
 * The core's `PassReport` says, for every stage, exactly one of three things:
 * what it moved, what it kept when the deadline ended it, or which of a CLOSED
 * set of reasons stopped it. **This shell renders that and computes nothing.**
 *
 * [reason] is a CODE and never a sentence — `not-paired`, `unreachable`,
 * `nothing-queued`, and so on — so a shell switches on a value. [sentence] is
 * beside it when there is something a member is owed, and it comes from the
 * core's own table: no database text, no path and no peer's words reach a
 * member through it. An ORDINARY reason (a seat that already holds its copy, an
 * empty queue, a device that wants no files) carries no sentence, because a
 * status line that narrated health is noise a member learns to ignore.
 */
public data class StageReport(
    /** `moved`, `cut` or `skipped`. The field a shell switches on. */
    public val state: String = "skipped",
    /** One of the core's closed set of codes. Present only when skipped. */
    public val reason: String? = null,
    /** What a member is owed, when anything. */
    public val sentence: String? = null,
) {
    /** Whether this stage ran at all. */
    public val ran: Boolean get() = state != "skipped"

    /** Whether the deadline ended this stage. A NORMAL END, never a failure. */
    public val cut: Boolean get() = state == "cut"
}

/** What one sync pass moved, and what every stage of it said. */
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
    /** Log positions this seat is behind the gateway's watermark. */
    val behind: Long = 0,
    /**
     * The deadline ended this window before it ran out of work. **NOT a
     * failure**: what landed is durable and the next pass continues from it.
     */
    val cutByTheDeadline: Boolean = false,
    /** The repair ran three times in a row and ended under the floor each time. */
    val parked: Boolean = false,
    /**
     * Originals a metered window declined to fetch.
     *
     * Not a failure and not a loss: they are still owed and the next unmetered
     * window takes them. It is here because a grid of placeholders on a
     * cellular link is a DECISION this device made, and a shell that could not
     * say so would make a working byte plane look broken.
     */
    val originalsWithheld: Long = 0,
    /**
     * A TAIL WAS OPEN ON THIS WINDOW (#1025 S2, D-1025-S7-40).
     *
     * **A tail that is open IS a gateway that is reached**, whatever the row
     * count says: a caught-up device on a quiet vault moves nothing for hours
     * and is not offline for a second of it. The header reads this rather than
     * inferring liveness from counts, which is the guess that put "not
     * connected to a gateway" over a synced device for two waves.
     */
    val tailOpen: Boolean = false,
    /** The budget selector the core actually ran under, as it received it. */
    val budget: String = "",
    /** Whether the core ran this window as metered. */
    val metered: Boolean = false,
    /** Taking the first copy, or a fresh one after falling under the floor. */
    val bootstrap: StageReport = StageReport(),
    /** Bytes of the copy this window has fetched. */
    val copyFetched: Long = 0,
    /** Bytes the whole copy is, so a progress line has a denominator. */
    val copyTotal: Long = 0,
    /** The inbound log. */
    val rows: StageReport = StageReport(),
    /** The outbox. */
    val intents: StageReport = StageReport(),
    /** The files the rows name. */
    val bytes: StageReport = StageReport(),
) {
    /**
     * WHY THE ROW PLANE MOVED NOTHING, when something stopped it.
     *
     * A RENAME OF [rows].sentence and nothing more — the decision is the
     * core's. Kept under the old name because it is what a status line draws,
     * and because for three slices there was no field for it at all:
     * `Handle::sync_now` ran the pass inside `Vault::read`, so every apply
     * failed under `PRAGMA query_only`, and the answer was "reached the
     * gateway, zero rows, no error" on every window since S1.
     */
    public val stale: String? get() = rows.sentence

    /**
     * WHY THE OUTBOX DID NOT DRAIN. [intents].sentence, renamed.
     *
     * Null is the good case. A sentence means the member's queued writes are
     * still queued with their attempt counts raised, which is a state that
     * resolves itself — but a shell that could not tell it from "caught up"
     * drew "Synced: 0 changes" over a write that was going nowhere.
     */
    public val blocked: String? get() = intents.sentence

    /** Why the BYTE plane moved nothing. [bytes].sentence, renamed. */
    public val bytesStalled: String? get() = bytes.sentence

    /**
     * WHAT A MEMBER READS WHILE THEIR VAULT IS BEING COPIED (#1025 S7, item 3).
     *
     * "Paired, no file yet" is a real state and a common one: a gateway is
     * reachable long enough to redeem a ticket and not long enough to move a
     * 300 MB artifact. Before this the shell drew "Synced: 0 changes, 0 files"
     * over it, which is the sentence that makes a working device look broken.
     *
     * `null` on every pass where the bootstrap stage did not run, which is
     * every pass but the first — the core answers `already-held` and that is
     * the ordinary case, not something to narrate.
     */
    public val copying: String? get() = when {
        !bootstrap.ran -> null
        copyTotal <= 0 -> "Copying your vault."
        else -> {
            val percent = (copyFetched * 100 / copyTotal).coerceIn(0, 100)
            "Copying your vault — $percent%."
        }
    }
}

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

/**
 * As [intField], for a nullable string.
 *
 * `null` for an absent field AND for a JSON `null`, which are the same answer
 * here: `stale` and `blocked` are absent on an older core and null on a good
 * pass, and both mean "nothing to say". The value is read to the closing quote
 * without unescaping, which is safe for exactly the reason the header gives —
 * these are sentences the core wrote, from a fixed table, with no quotes in
 * them. A sentence that ever could contain one needs a real parser, and that is
 * the day this file grows a dependency.
 */
internal fun String.stringField(name: String): String? {
    val at = indexOf("\"$name\":")
    if (at < 0) return null
    val rest = substring(at + name.length + 3)
    if (!rest.startsWith("\"")) return null
    val end = rest.indexOf('"', startIndex = 1)
    return if (end < 0) null else rest.substring(1, end)
}

/**
 * The text of one nested object, so a field can be read inside its own scope.
 *
 * NEEDED THE MOMENT THE PAYLOAD STOPPED BEING FLAT (#1025 S7). The pass report
 * carries four stages and every one of them has a `state`, a `reason` and a
 * `sentence`; a scanner that took the FIRST match would answer the bootstrap
 * stage's reason to a question about the bytes. This finds the object's own
 * braces and the readers above then work within it.
 *
 * Still not a JSON parser, and for the same reason as its neighbours: the
 * payload is written by `Handle::seat_sync` with `serde_json` from a fixed
 * shape, and the only strings in it are codes and sentences from the core's own
 * table, which contain no braces. A payload that could carry one needs a real
 * parser, and that is the day this file grows a dependency.
 */
internal fun String.objectField(name: String): String? {
    val at = indexOf("\"$name\":")
    if (at < 0) return null
    val open = indexOf('{', startIndex = at)
    if (open < 0) return null
    var depth = 0
    for (index in open until length) {
        when (this[index]) {
            '{' -> depth += 1
            '}' -> {
                depth -= 1
                if (depth == 0) return substring(open, index + 1)
            }
        }
    }
    return null
}

/** One stage of the report, read out of its own object. */
internal fun String.stageField(name: String): StageReport {
    val scope = objectField("stages")?.objectField(name) ?: return StageReport()
    return StageReport(
        state = scope.stringField("state") ?: "skipped",
        reason = scope.stringField("reason"),
        sentence = scope.stringField("sentence"),
    )
}
