package dev.centraid.shared.sync

import kotlinx.coroutines.sync.Mutex

/**
 * THE PASS THAT EMPTIES THE SPOOL, IN ONE PLACE (#1029 W18-2).
 *
 * The owner's [scope amendment of
 * 2026-09-21](https://github.com/srikanth235/centraid/issues/1029#issuecomment-5755559795),
 * "Superseded — Background upload":
 *
 * > the phone drains its spool over iroh in the foreground and inside the
 * > `BGProcessingTask` window iOS grants, and under WorkManager on Android.
 * > There is no transfer while the app is suspended. Force-quit stops it until
 * > next launch. This is the iCloud Backup posture and the copy says so.
 *
 * That sentence is why this class exists and why it is `commonMain`. What
 * preceded it was a `URLSession` background session and a `WorkManager` upload
 * worker — the OS carrying bytes to an HTTPS endpoint while the app was
 * suspended — and the destination no longer exists: the gateway is reached over
 * iroh by a client inside this process, so a transfer needs the process to be
 * running. **One flow, and platforms only schedule it and hand it a deadline.**
 *
 * ## What a pass IS
 *
 * One call of W15's `Drain` request through the core door this shell already
 * holds: seal what the spool holds, upload until the spool is empty or the
 * deadline is near, answer with an acked txid, the bytes still pending and why
 * it stopped. The pass does no uploading and no deciding — it is the thing that
 * knows *when* to ask, what to do with the answer, and what a member is told.
 *
 * ## Two rules it keeps that are not obvious
 *
 * * **A second pass while one runs is REFUSED, not queued** ([Outcome.Busy]).
 *   Both triggers fire together all the time — the app becomes active while a
 *   background window is still draining — and a queued second pass would double
 *   a member's data bill for no new bytes. It is also the request contract's own
 *   rule, so a queue here would be a second answer to it.
 * * **The claim is folded from the ANSWER and never from the attempt.** The
 *   umbrella's UI invariant is that the phone never claims backup the gateway
 *   has not acknowledged, and [BackupClaim] is where that is spelled. A pass
 *   that ran and was refused by the laptop moves nothing a member reads.
 */
public class DrainPass(
    private val door: DrainDoor,
    /** Asked for the next window when a pass finishes. See [Rescheduler]. */
    private val reschedule: Rescheduler = Rescheduler { },
) {
    // A TRY-LOCK AND NOT A LOCK. `withLock` would QUEUE the second caller, and
    // queueing is exactly the behaviour the request contract refuses.
    private val running = Mutex()

    /**
     * Run one pass against [deadlineMs] milliseconds of budget.
     *
     * The deadline is the window's, not a preference: iOS hands it down from the
     * task's expiration and Android from WorkManager's stop signal, and a pass
     * that overran it would be killed mid-object rather than stopping cleanly.
     */
    public suspend fun run(deadlineMs: Long): Outcome {
        if (!running.tryLock()) return Outcome.Busy
        return try {
            when (val answer = door.drain(deadlineMs)) {
                null -> Outcome.Unavailable
                else -> Outcome.Ran(answer)
            }
        } finally {
            running.unlock()
            // ASKED FOR ON EVERY PATH, INCLUDING A REFUSAL. A window that is not
            // re-requested is the last window: `BGTaskRequest` is one-shot, and
            // a pass that only resubmits when it succeeded stops for good the
            // first time a member's laptop is off.
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
         * There was no core to ask — the app has not finished launching, or this
         * device holds no vault. **Not a failure**, and not a sentence a member
         * reads: there is nothing to tell them about.
         */
        public data object Unavailable : Outcome
    }

    /** Ask the platform for the next window. */
    public fun interface Rescheduler {
        public fun next()
    }
}

/**
 * THE CORE DOOR THIS PASS CALLS, AS A SEAM (#1029 W18-2).
 *
 * The request kinds are W15's — `Drain { deadline_ms }` answering
 * `{ acked_txid, pending_bytes, stopped }`, and `BackupStatus` — and they reach
 * this shell as `centraid.core.v1.Request` variants over the five-symbol ABI
 * `CentraidCore` already holds. This interface is the seam so that the pass, its
 * claim folding and its copy are testable on the JVM without an FFI, which is
 * the only toolchain this container has.
 *
 * **The core-backed implementation lands with W15's request contract.** Until
 * `envelope.proto` carries `drain` and `backup_status` there is nothing to
 * encode; what is here is everything that does not depend on the wire, and the
 * adapter is one `Envelope` build and one `when` over the answer.
 */
public interface DrainDoor {

    /**
     * One `Drain`, or null when there is no core to ask.
     *
     * Never throws for a refusal: "your laptop is not reachable" is an answer
     * ([DrainAnswer.Stopped.UNREACHABLE]) and a sentence a member reads, not an
     * exception a pass has to guess the meaning of.
     */
    public suspend fun drain(deadlineMs: Long): DrainAnswer?
}

/**
 * What a `Drain` answered (#1029 W18-2; W15's request contract).
 *
 * Three facts and nothing derived from this phone's clock. [ackedTxid] and
 * [lastAckedAtMs] are the LAPTOP's, which is what makes [BackupClaim] able to
 * say "backed up" at all.
 */
public data class DrainAnswer(
    /** The highest txid the laptop acknowledged, or 0 when it has never. */
    public val ackedTxid: Long,
    /** What is still in the spool after this pass. Zero means empty. */
    public val pendingBytes: Long,
    /** Why the pass stopped. */
    public val stopped: Stopped,
    /**
     * The laptop's own `committed_at_ms` for [ackedTxid], or null when it has
     * never acknowledged a commit. **Never this phone's clock** — see
     * [BackupClaim.line]'s parameter documentation for why that is the whole
     * point of the field.
     */
    public val lastAckedAtMs: Long? = null,
) {
    /** Whether this pass left the spool empty. */
    public val drained: Boolean get() = stopped == Stopped.EMPTY

    /** Why a pass stopped. One sentence each in [DrainCopy]. */
    public enum class Stopped {
        /** The spool is empty. Everything this phone holds is on the laptop. */
        EMPTY,

        /** The window ran out. The next one resumes where this stopped. */
        DEADLINE,

        /** The laptop did not answer. Nothing was lost; nothing was sent. */
        UNREACHABLE,
    }
}

/**
 * THE FOLD FROM A PASS'S ANSWER INTO THE BACKUP CLAIM (#1029 W18-2).
 *
 * The umbrella's UI invariant — **the phone never claims backup the gateway has
 * not acknowledged** — is [BackupClaim]'s, and this is the only place a pass
 * reaches it. It is a fold and not a second rule: every value handed over came
 * out of the laptop's own acknowledgement, and there is deliberately no
 * constructor here that takes "true".
 *
 * `CustodyAndBackupClaimSpec` held this invariant over the retired
 * `BackgroundTransfers` seam. It holds it here now, over the source that
 * replaced it.
 */
public object DrainClaim {

    /** The backup row's line, from what the pass was told. */
    public fun line(answer: DrainAnswer, unacked: Int, relative: String): String =
        BackupClaim.line(answer.lastAckedAtMs, unacked, relative)

    /**
     * Whether a shell may use the word "backed up" without a qualifier.
     *
     * **Pending bytes are unacked changes** — the pass reports the spool's
     * remaining bytes rather than a row count, and any remainder at all is
     * enough to disqualify the claim, which is the safe direction. A pass that
     * stopped on a deadline or on an unreachable laptop is behind by
     * construction.
     */
    public fun isBackedUp(answer: DrainAnswer): Boolean = BackupClaim.isBackedUp(
        lastAckedAtMs = answer.lastAckedAtMs,
        unacked = if (answer.pendingBytes > 0L) 1 else 0,
    )
}

/**
 * WHAT A MEMBER IS TOLD, AND IT IS ONE PLACE (#1029 W18-2, W18-3).
 *
 * Copy rather than a shell's, for the reason the `BackgroundTransfers` header
 * gave before it was retired with its destination: *a sentence spelled in each
 * shell is a sentence one shell gets wrong.* The two platform truths moved here
 * verbatim with the pass, and the amendment's own posture sentence joined them.
 *
 * Nothing here says "backed up". That word belongs to [BackupClaim], which only
 * ever says it over an acknowledgement.
 */
public object DrainCopy {

    /**
     * **THE POSTURE, AND IT IS THE AMENDMENT'S OWN** (2026-09-21, "Superseded —
     * Background upload").
     *
     * Centraid does not hand bytes to a system daemon that keeps moving them
     * while the app is gone; it drains over iroh from inside this process, in
     * the foreground and in the background window the OS grants. That is the
     * same posture iCloud Backup has, which is a thing members already
     * understand, so the copy says so rather than inventing a promise.
     */
    public const val POSTURE_SENTENCE: String =
        "Centraid backs up while it is open and in the background windows your phone gives it, " +
            "the same way iCloud Backup works. It does not upload while the app is closed."

    /**
     * **iOS: force-quitting stops the drain until the next launch.**
     *
     * Moved verbatim from `BackgroundTransfers.FORCE_QUIT_SENTENCE` and then
     * corrected for the pass it now describes. The old sentence promised
     * "uploads keep going if iOS closes the app itself", which was true of a
     * `URLSession` background session and is **not** true of a drain that runs
     * inside this process: a terminated app uploads nothing either way, and the
     * difference is only whether the OS will wake it again.
     */
    public const val FORCE_QUIT_SENTENCE: String =
        "If you swipe Centraid away from the app switcher, backing up stops until you open it " +
            "again. Your phone stops giving Centraid background time until then."

    /**
     * Android's floor, before the member's own rule is applied.
     *
     * Moved verbatim from `BackgroundTransfers.ANDROID_UNMETERED_SENTENCE`.
     */
    public const val ANDROID_UNMETERED_SENTENCE: String =
        "Centraid uploads in the background when this phone has a network. " +
            "Your Downloads setting still decides what crosses cellular."

    /** What a member reads while a pass is running. */
    public const val IN_FLIGHT_TITLE: String = "Backing up"

    /**
     * One sentence per `stopped` reason.
     *
     * **`DEADLINE` is not an error and does not say so.** A window that ran out
     * with bytes left is the ordinary case for a first backup of a camera roll,
     * and a phone that reported it as a failure would train members to distrust
     * a product that is working.
     */
    public fun stoppedSentence(answer: DrainAnswer): String = when (answer.stopped) {
        DrainAnswer.Stopped.EMPTY -> "Everything on this phone is on your laptop."
        DrainAnswer.Stopped.DEADLINE ->
            "Still backing up. Centraid carries on in the background and when you open it."
        DrainAnswer.Stopped.UNREACHABLE ->
            "Your laptop did not answer. Centraid will try again when it can reach it."
    }
}
