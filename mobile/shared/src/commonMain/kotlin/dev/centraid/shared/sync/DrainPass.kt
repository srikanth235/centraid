package dev.centraid.shared.sync

import kotlinx.coroutines.sync.Mutex

/**
 * ONE VAULT'S PASS, AS THE SHELL SEES IT (#1080, "The phone core").
 *
 * A pass is one `Drain` through the core door this shell already holds: the
 * core takes a snapshot if one is due, seals what waits into the spool under
 * the member's rule, moves sealed parts to the reachable gateway until the
 * deadline, and settles what the gateway acknowledged. The shell decides only
 * WHEN to ask and WHAT it tells the core about the link — [DrainInput] — and it
 * keeps the answer, which is what the backup line is drawn from.
 *
 * Platforms schedule passes and hand them a deadline; the pass itself is
 * `commonMain` on both. On iOS the OS also moves bytes while the app is
 * suspended, through [BackgroundUploads], fed from the same spool.
 *
 * ## Two rules it keeps that are not obvious
 *
 * * **A second pass while one runs is REFUSED, not queued** ([Outcome.Busy]).
 *   The triggers fire together all the time — the app becomes active while a
 *   background window is still running — and a pass already running moves what
 *   the second would have. It is also the core's own rule (`phone.proto`).
 * * **The next window is asked for on every path**, refusals included: a
 *   `BGTaskRequest` is one-shot, and a pass that only resubmitted on success
 *   would stop for good the first time the gateway was off.
 */
public class DrainPass(
    private val door: DrainDoor,
    /** Asked for the next window when a pass finishes. See [Rescheduler]. */
    private val reschedule: Rescheduler = Rescheduler { },
) {
    // A TRY-LOCK AND NOT A LOCK. `withLock` would QUEUE the second caller, and
    // queueing is exactly the behaviour the request contract refuses.
    private val running = Mutex()

    /** Whether a pass is running now. */
    public val busy: Boolean get() = running.isLocked

    /**
     * Suspend until no pass is running. For a caller that is OWED a pass —
     * a forced snapshot — and must not take [Outcome.Busy] as its answer.
     * Another caller may still take the next turn; that caller then gets Busy.
     */
    public suspend fun awaitIdle() {
        running.lock()
        running.unlock()
    }

    /**
     * Run one pass. [DrainInput.deadlineMs] is the window's, not a
     * preference: iOS hands it down from the task's expiration and Android from
     * WorkManager's stop signal, and a pass that overran it would be killed
     * mid-part rather than stopping at a part boundary.
     */
    public suspend fun run(input: DrainInput): Outcome {
        if (!running.tryLock()) return Outcome.Busy
        return try {
            when (val answer = door.drain(input)) {
                null -> Outcome.Unavailable
                else -> Outcome.Ran(answer)
            }
        } finally {
            running.unlock()
            reschedule.next()
        }
    }

    /** What one pass did. */
    public sealed interface Outcome {

        /** The core answered. [answer] is the whole of what happened. */
        public data class Ran(public val answer: DrainAnswer) : Outcome

        /** A pass was already running. Nothing was sent and nothing is queued. */
        public data object Busy : Outcome

        /**
         * There was no core to ask, or it refused the pass outright. **Not a
         * sentence a member reads**: the status line is drawn from
         * `backup_status`, which is the core's own account and needs no pass.
         */
        public data object Unavailable : Outcome
    }

    /** Ask the platform for the next window. */
    public fun interface Rescheduler {
        public fun next()
    }
}

/**
 * THE CORE DOOR A PASS CALLS, AS A SEAM: `CoreDrainDoor` in production, a
 * scripted answer in the specs. **Never throws for a refusal** — "the gateway
 * did not answer" is [DrainAnswer.Stopped.UNREACHABLE], an answer and not an
 * exception a pass has to guess the meaning of.
 */
public fun interface DrainDoor {

    /** One `Drain`, or null when there is no core to ask. */
    public suspend fun drain(input: DrainInput): DrainAnswer?
}

/**
 * EVERYTHING A PASS TELLS THE CORE (`DrainRequest`, seam contract §1, A2, A3).
 *
 * Built only by [PassConditions.input], which is the one place an unknown
 * platform reading becomes the expensive answer. The fields are plain
 * booleans here because by the time a pass is built that decision is made.
 */
public data class DrainInput(
    /** `0` is "no deadline": the foreground, where the member is watching. */
    public val deadlineMs: Long,
    public val rule: TransferRule,
    /** The member's "Include videos". The wire carries its negation (A3). */
    public val includeVideos: Boolean,
    /** The link is metered. True when the platform would not say. */
    public val metered: Boolean,
    /** On external power. False when the platform would not say. */
    public val charging: Boolean,
    /** "Back up now", entering the background or a finished restore: a snapshot now. */
    public val wantsSnapshot: Boolean,
)

/**
 * What a `Drain` answered (`DrainResponse`, seam contract §1, A4).
 *
 * **Every time here is the GATEWAY's clock** ([ackedAtMs]), which is what lets
 * a line say "backed up" at all: a phone that stamped its own clock would be
 * claiming an acknowledgement nobody gave.
 */
public data class DrainAnswer(
    /** Sealed bytes still in the spool after this pass. Zero means empty. */
    public val pendingBytes: Long,
    public val stopped: Stopped,
    /** The last head acknowledgement, gateway clock; null when there has been none. */
    public val ackedAtMs: Long? = null,
    /** Parts the gateway acknowledged in this pass. */
    public val confirmedParts: Int = 0,
    /** Items whose bytes the shell must stream from the OS library. */
    public val waitingBytesParts: Int = 0,
    /** The items the core wants streamed next, at most 64 (A4). */
    public val needBytes: List<NeededBytes> = emptyList(),
    /**
     * When the gateway says the vault moved, gateway clock; set only with
     * [Stopped.MOVED]. Never this phone's clock: the freeze line dates the move.
     */
    public val movedAtMs: Long? = null,
) {
    /** Whether this pass left the spool empty. */
    public val drained: Boolean get() = stopped == Stopped.EMPTY

    /** Why a pass stopped. */
    public enum class Stopped {
        /** The spool is empty. */
        EMPTY,

        /** The window ran out. The next one resumes where this stopped. */
        DEADLINE,

        /** No gateway answered. Nothing was lost; nothing was sent. */
        UNREACHABLE,

        /**
         * A gateway refused this phone's writes: the vault was restored onto
         * another phone, which claimed the next writer epoch (#1029 F1, #1080).
         * The shell freezes the vault read-only; nothing is deleted.
         */
        MOVED,
    }
}

/**
 * One item whose plaintext the core needs streamed again (`NeedBytes`, A4).
 *
 * The fallback second stream (A8): the import seals in the same stream
 * whenever a destination is paired and the spool has room, so this list is
 * non-empty only for what was imported with no room or no destination.
 */
public data class NeededBytes(
    /** BLAKE3 of the plaintext, lowercase hex: what the stage must hash to. */
    public val contentHash: String,
    /** Where the platform keeps it — a `PHAsset` or `MediaStore` reference. */
    public val osRef: String,
    public val mediaType: String,
    /** Zero when the core does not know it. */
    public val size: Long,
)
