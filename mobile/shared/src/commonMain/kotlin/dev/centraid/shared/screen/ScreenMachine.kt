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
