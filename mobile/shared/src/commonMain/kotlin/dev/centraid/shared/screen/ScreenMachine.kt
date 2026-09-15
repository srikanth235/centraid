package dev.centraid.shared.screen

import centraid.screen.v1.ReadFailure
import centraid.screen.v1.ReadFailureKind
import centraid.screen.v1.SeatState

/**
 * A screen is one pure function (#1020, D-1020-E3).
 *
 * `(state, event) -> (state, effects)`. No coroutines, no clock, no I/O, no
 * platform import — which is what makes every screen testable on the JVM and
 * what keeps `commonMain` inside the Konsist rule.
 *
 * **Effects are DATA, never closures.** A closure survives neither a
 * Kotlin/Native boundary nor a test that wants to assert what a screen decided
 * to do, and the same shape is what `centraid.core.v1.PageQuery` chose for the
 * same reason: "a read as DATA, never as a string or a closure".
 */
public interface ScreenMachine<S, E> {
    public fun reduce(state: S, event: E): Step<S>

    /** The state a screen is in before its first event. */
    public fun initial(): S

    /**
     * A ROW MOVED IN THE VAULT. What does this screen make of it?
     * (#1025 S5, D-1025-S5-3.)
     *
     * The core's change stream (`next_event`) says `(table, keys, commit_seq)`
     * and nothing else — it never carries values, which is what makes
     * coalescing lossless in `crates/core`'s event queue. So each screen turns
     * that into its OWN event, here, and `null` means "not mine": a table this
     * screen does not read, or keys it is not showing.
     *
     * **One declaration and not two.** The first draft of this had a `tables`
     * set beside a translator, and the two are a pair that can disagree — a
     * screen that adds a read and forgets the set stops moving on sync, with
     * nothing red anywhere. There is one member, so there is one thing to get
     * right.
     *
     * The pk_set is `String` keys and not a typed row id because a change event
     * is about a TABLE: the core has no idea which of a screen's ids a primary
     * key is, and a screen that cannot recognise its own ids in a list of
     * strings has a bigger problem than this signature.
     */
    public fun rowsChanged(table: String, keys: List<String>, commitSeq: ULong): E?

    /**
     * WHAT THIS SEAT CAN SAY ABOUT ITSELF, CHANGED (#1025 S5, D-1025-S5-6).
     *
     * Every screen's event already has a `SeatChanged` case and every machine
     * already reduces it — and **nothing in the product ever sent one**, so
     * `SeatState` was null on every screen for ever. That is not cosmetic:
     * [dev.centraid.shared.sync.WriteGate] reads the seat off the screen, a
     * null seat is not reachable, and the consequence is that an `onlineOnly`
     * write was **refused on every device, always**, while an ordinary write
     * queued even with a healthy gateway one hop away. A gate handed a constant
     * is not a gate.
     *
     * `null` from a machine means the screen does not render the seat, which is
     * a real answer — Home draws its own status line and needs no seat.
     */
    public fun seatChanged(seat: SeatState): E?
}

public data class Step<S>(val state: S, val effects: List<ScreenEffect> = emptyList())

/**
 * What a screen asked the shell to do.
 *
 * The shell's effect runner is the only thing that touches `CentraidCore`, so
 * the reducers never see a handle, a dispatcher or a suspend function.
 */
public sealed interface ScreenEffect {
    /**
     * Read one page. `afterCursor` is the keyset cursor, never an offset — and
     * `null` means the first page rather than "start from zero", which for a
     * pruned feed is a different request.
     */
    public data class ReadPage(
        public val screenId: String,
        public val afterCursor: String?,
    ) : ScreenEffect

    /** Ask the OS. The answer arrives as an event, because it is a state. */
    public data object RequestMediaPermission : ScreenEffect

    /**
     * Submit a write.
     *
     * `onlineOnly` is carried here and honoured by the write gate, not by the
     * reducer: **falling back to the outbox is exactly what the flag forbids**
     * (`docs/mobile-offline.md:259`), and a reducer that decided for itself
     * would be a second place the rule lives.
     */
    public data class SubmitWrite(
        public val command: String,
        public val inputJson: String,
        public val invokeKey: String,
        public val onlineOnly: Boolean,
    ) : ScreenEffect

    /**
     * Tell the member a verb is WITHHELD rather than queued.
     *
     * Tally's `materialize-recurring-expense` is the case: its occurrence id is
     * minted by the canonical engine, so a seat withholds it offline rather
     * than queueing a copy (`docs/mobile-offline.md:257`).
     */
    public data class WithheldOffline(
        public val verb: String,
        public val sentence: String,
    ) : ScreenEffect

    /** Start, pause or resume the camera-roll backup. */
    public data class Backup(public val action: Action) : ScreenEffect {
        public enum class Action { START, PAUSE, RESUME }
    }

    /**
     * RE-POINT THE WHOLE APP AT ANOTHER VAULT.
     *
     * An effect and not a reduce, because switching is closing one core and
     * opening another — I/O that can fail, on a file the reducer has never
     * seen. The machine names the vault by id and nothing else; which file that
     * is, and whether it opens, belongs to the session that owns the core.
     *
     * It carries no path for the same reason `VaultLockup` does not: a screen
     * effect with a filesystem in it is a screen effect one shell can serve and
     * the other cannot.
     */
    public data class SwitchVault(public val vaultId: String) : ScreenEffect

    /**
     * FETCH ONE ORIGINAL THE MEMBER TAPPED (#1025 S5, D-1025-S7-63).
     *
     * WhatsApp's download arrow. An effect and not a write: it commits
     * nothing, has no intent and no outbox entry — it is a `seat.bytes.fetch`
     * command, which is `seat.sync` with a one-item window, and the bytes it
     * lands redraw the cell through the ordinary `RowsChanged` every other
     * arriving blob uses (D-1025-S7-21).
     *
     * **Not `SubmitWrite`.** A write gate would queue this offline, and a
     * queued download is a promise nobody can keep: the member wants the file
     * now or they want to be told the gateway is away.
     */
    public data class FetchOriginal(
        public val screenId: String,
        public val assetId: String,
        public val contentHash: String,
    ) : ScreenEffect
}

/**
 * The three-state read law, in one place (census §E seam 3).
 *
 * Every screen's `content` oneof has exactly these three shapes, and the
 * helpers below are how a reducer moves between them without ever producing the
 * fourth one — an empty data case standing in for a failure.
 */
public object Reads {
    /** A refusal from the access plane: its sentence, never its predicate. */
    public fun refused(sentence: String): ReadFailure = ReadFailure(
        kind = ReadFailureKind.READ_FAILURE_KIND_REFUSED,
        sentence = sentence,
    )

    /** This seat has no copy yet. A first sync, not a refusal. */
    public fun noCopyYet(): ReadFailure = ReadFailure(
        kind = ReadFailureKind.READ_FAILURE_KIND_NO_COPY_YET,
        sentence = "This device has not copied these yet.",
        remedy = "Stay on Wi-Fi while Centraid catches up.",
    )

    /**
     * Out of disk: the feed is PARKED. The cursor and the rows stay, the retry
     * cadence stops, and freeing space resumes from the durable cursor
     * (`docs/mobile-offline.md:238`). Centraid never evicts canonical rows or
     * queued writes to manufacture space.
     */
    public fun lowDiskParked(): ReadFailure = ReadFailure(
        kind = ReadFailureKind.READ_FAILURE_KIND_LOW_DISK_PARKED,
        sentence = "This device is out of space, so Centraid has paused.",
        remedy = "Free up space and Centraid picks up where it stopped.",
    )

    public fun unavailable(sentence: String): ReadFailure = ReadFailure(
        kind = ReadFailureKind.READ_FAILURE_KIND_UNAVAILABLE,
        sentence = sentence,
        remedy = "Centraid tries again when it can reach your gateway.",
    )

    public fun coreRestarted(): ReadFailure = ReadFailure(
        kind = ReadFailureKind.READ_FAILURE_KIND_CORE_RESTARTED,
        sentence = "Centraid hit a problem and restarted.",
    )

    /**
     * Is the feed parked? A parked feed emits NO re-read effect: a retry loop
     * that keeps re-applying the failing batch is the regression the device
     * contract test already pins (census §E seam 8).
     */
    public fun isParked(failure: ReadFailure?): Boolean =
        failure?.kind == ReadFailureKind.READ_FAILURE_KIND_LOW_DISK_PARKED

    /** Is this seat writing to its own outbox rather than to the gateway? */
    public fun isLocalOnly(seat: SeatState?): Boolean =
        seat?.durability != SeatState.Durability.DURABILITY_AUTHORITATIVE
}
