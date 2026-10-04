package dev.centraid.shared.sync

import dev.centraid.core.CentraidCore
import dev.centraid.shared.platform.NetworkStatus
import dev.centraid.shared.shell.Shelf
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * THE ONE THING EVERY TRIGGER CALLS (#1080, the shells; #1029 W18-6).
 *
 * The platforms have a window and a deadline, [Shelf] has the vaults, and
 * [DrainPass] knows how to run one vault's pass. Every trigger on both shells
 * comes through here with a [WakeReason]:
 *
 * | Trigger | Reason | Deadline | Snapshot | Asked |
 * |---|---|---|---|---|
 * | the session opened | [WakeReason.SESSION_OPENED] | none | when due | no |
 * | the app became active | [WakeReason.BECAME_ACTIVE] | none | when due | no |
 * | a commit landed (debounced) | [WakeReason.AFTER_COMMIT] | none | when due | no |
 * | a camera-roll pass imported | [WakeReason.AFTER_IMPORT] | none | when due | no |
 * | the link came back (debounced) | [WakeReason.CONNECTIVITY] | none | when due | no |
 * | a background window | [WakeReason.SCHEDULED] | the window's | when due | no |
 * | "Back up now" | [WakeReason.BACK_UP_NOW] | none | now | yes |
 * | the app left the screen | [WakeReason.ENTERED_BACKGROUND] | the grace | now | no |
 * | a restore finished | [WakeReason.RESTORED] | none | now | no |
 *
 * "Asked" is `DrainRequest.asked` (#1080 A24): the member's own tap, which
 * alone lets originals through under MANUAL and a video off the charger.
 *
 * ## EVERY HELD VAULT, AND THE DEADLINE IS DIVIDED
 *
 * A window backs up the device, not the screen the member left open, and a
 * window that spent its whole budget on the first vault would leave a second
 * one never backed up on a phone that never gets a long window. A RESTING
 * holding (no core) and a FROZEN one (moved to another phone) are skipped:
 * waking one opens SQLite inside a background window, and the gateway refuses
 * the other's writes.
 *
 * ## A PASS MAY TAKE MORE THAN ONE ROUND
 *
 * When the core's spool is empty but it names items whose bytes only the OS
 * library holds ([DrainAnswer.needBytes]), the shell streams them in through
 * [feed] and runs the pass again — inside the same budget, and only while the
 * ask changes, so a library that will not produce a photograph cannot spin.
 *
 * ## RESULTS ARE KEPT
 *
 * Each vault's outcome goes to [onOutcome] the moment its pass ends, which is
 * where the status line is re-read and a `MOVED` vault is frozen.
 */
public class ShelfDrain(
    /** Every vault this device holds, foreground first — `Shelf::all`. */
    private val holdings: () -> List<Shelf.Holding>,
    /** Builds the door for one vault's core. `CoreDrainDoor` in production. */
    private val doorFor: (() -> CentraidCore?) -> DrainDoor,
    /** A monotonic clock, for the debounces and round budgets only. Never a backup claim. */
    private val nowMs: () -> Long,
    /** The rule and the platform's reading, read at the start of every run. */
    private val conditions: suspend () -> PassConditions = { PassConditions.UNKNOWN },
    private val reschedule: DrainPass.Rescheduler = DrainPass.Rescheduler { },
    /** Stream what a pass asked for into that vault's core; answers how many landed. */
    private val feed: suspend (vaultId: String, needs: List<NeededBytes>) -> Int = { _, _ -> 0 },
    /** One vault's pass ended. */
    private val onOutcome: suspend (Outcome) -> Unit = {},
) {
    private val passes = mutableMapOf<String, DrainPass>()
    private val passesGate = Mutex()

    /**
     * When the last debounced trigger ran, or null before the first.
     *
     * **Null and not `Long.MIN_VALUE`**: `now - Long.MIN_VALUE` overflows
     * negative, which read every commit as "inside the debounce".
     */
    private var lastCommitRunMs: Long? = null
    private var lastLinkRunMs: Long? = null

    private val backlogGate = Mutex()
    private var backlog: CompletableDeferred<List<Outcome>>? = null
    private val backingUpNow = MutableStateFlow(false)

    /** True while a "Back up now" run is in progress. The Backup screen draws it. */
    public val backingUp: StateFlow<Boolean> get() = backingUpNow.asStateFlow()

    /**
     * Run one pass over every held vault inside [deadlineMs]; `0` is "no
     * deadline" and is passed through rather than divided. A bare deadline is
     * a background window ([WakeReason.SCHEDULED]).
     */
    public suspend fun run(deadlineMs: Long, reason: WakeReason = WakeReason.SCHEDULED): List<Outcome> {
        val drainable = holdings().filter { it.core != null && it.moved == null }
        if (drainable.isEmpty()) return emptyList()
        val read = conditions()
        val each = if (deadlineMs <= 0L) 0L else deadlineMs / drainable.size
        return drainable.map { holding ->
            passOver(holding.vaultId, each, reason, read).also { onOutcome(it) }
        }
    }

    /** The session opened. */
    public suspend fun onSessionOpened(): List<Outcome> = run(FOREGROUND_DEADLINE_MS, WakeReason.SESSION_OPENED)

    /** The app became active. Not debounced: opening the app is worth a pass. */
    public suspend fun onBecameActive(): List<Outcome> = run(FOREGROUND_DEADLINE_MS, WakeReason.BECAME_ACTIVE)

    /**
     * A commit landed. **Debounced, and a dropped call is not queued**: the
     * next commit asks again, and a pass already running moves what this one
     * would have.
     *
     * @return the outcomes, or an empty list when this call was coalesced.
     */
    public suspend fun afterCommit(): List<Outcome> {
        val now = nowMs()
        val last = lastCommitRunMs
        if (last != null && now - last < COMMIT_DEBOUNCE_MS) return emptyList()
        lastCommitRunMs = now
        return run(FOREGROUND_DEADLINE_MS, WakeReason.AFTER_COMMIT)
    }

    /** A camera-roll pass imported something. */
    public suspend fun afterImport(): List<Outcome> = run(FOREGROUND_DEADLINE_MS, WakeReason.AFTER_IMPORT)

    /**
     * The radio moved. Only a link that is UP is worth a pass, and a link that
     * flaps runs at most one per [COMMIT_DEBOUNCE_MS] — on its own clock, so a
     * commit a moment ago does not swallow the move from cellular to Wi-Fi.
     */
    public suspend fun onConnectivity(reading: NetworkStatus.Reading): List<Outcome> {
        if (!reading.online) return emptyList()
        val now = nowMs()
        val last = lastLinkRunMs
        if (last != null && now - last < COMMIT_DEBOUNCE_MS) return emptyList()
        lastLinkRunMs = now
        return run(FOREGROUND_DEADLINE_MS, WakeReason.CONNECTIVITY)
    }

    /** A background window the OS granted, with its own budget. */
    public suspend fun scheduled(windowMs: Long): List<Outcome> = run(windowMs, WakeReason.SCHEDULED)

    /**
     * The app is leaving the screen, with [graceMs] the platform grants.
     * Forces a snapshot (#1080 §5); a pass already running is waited for
     * inside the grace rather than refused, so the snapshot is not lost.
     */
    public suspend fun enteredBackground(graceMs: Long): List<Outcome> = run(graceMs, WakeReason.ENTERED_BACKGROUND)

    /** A restore laid a vault down: its first snapshot, now. */
    public suspend fun afterRestore(): List<Outcome> = run(FOREGROUND_DEADLINE_MS, WakeReason.RESTORED)

    /**
     * "BACK UP NOW." Runs one unbounded run over the shelf with a snapshot
     * forced; a second press while it runs JOINS it rather than starting
     * another, so the member's two taps are one backup and both answer when
     * it ends.
     */
    public suspend fun backUpNow(): List<Outcome> {
        val (mine, run) = backlogGate.withLock {
            val running = backlog
            if (running != null) {
                false to running
            } else {
                true to CompletableDeferred<List<Outcome>>().also { backlog = it }
            }
        }
        if (!mine) return run.await()
        backingUpNow.value = true
        try {
            val outcomes = run(FOREGROUND_DEADLINE_MS, WakeReason.BACK_UP_NOW)
            run.complete(outcomes)
            return outcomes
        } catch (failure: Throwable) {
            run.completeExceptionally(failure)
            throw failure
        } finally {
            withContext(NonCancellable) {
                backlogGate.withLock { backlog = null }
                backingUpNow.value = false
            }
        }
    }

    private suspend fun passFor(vaultId: String): DrainPass = passesGate.withLock {
        passes.getOrPut(vaultId) {
            // ONE PASS PER VAULT, KEPT: the try-lock that refuses a concurrent
            // pass lives on it. The door takes a SUPPLIER, so a holding that
            // rests and wakes is followed rather than pinned to a closed handle.
            DrainPass(doorFor { holdings().firstOrNull { it.vaultId == vaultId }?.core }, reschedule)
        }
    }

    private suspend fun passOver(
        vaultId: String,
        budgetMs: Long,
        reason: WakeReason,
        read: PassConditions,
    ): Outcome {
        val pass = passFor(vaultId)
        val started = nowMs()
        fun remaining(): Long = if (budgetMs <= 0L) 0L else budgetMs - (nowMs() - started)

        var outcome = pass.run(read.input(budgetMs, reason))
        if (outcome is DrainPass.Outcome.Busy && reason.wantsSnapshot) {
            // A SNAPSHOT IS OWED, so a running pass is waited for rather than
            // taken as the answer — inside the budget when there is one.
            val waited = if (budgetMs <= 0L) {
                pass.awaitIdle()
                true
            } else {
                withTimeoutOrNull(budgetMs) { pass.awaitIdle() } != null
            }
            if (waited && (budgetMs <= 0L || remaining() > MIN_ROUND_MS)) {
                outcome = pass.run(read.input(remaining(), reason))
            }
        }
        var asked: Set<String> = emptySet()
        for (round in 1 until MAX_ROUNDS) {
            val answer = (outcome as? DrainPass.Outcome.Ran)?.answer ?: break
            if (answer.stopped != DrainAnswer.Stopped.EMPTY || answer.needBytes.isEmpty()) break
            val ask = answer.needBytes.map { it.contentHash }.toSet()
            // THE SAME ASK TWICE IS NO PROGRESS: the library would not produce
            // those bytes, and asking again would spin the window away —
            // unless the round moved parts. An original larger than the spool
            // is asked for again, for its next window, once the last one
            // moved (#1080, R-1080-C39).
            if (ask == asked && answer.confirmedParts == 0) break
            asked = ask
            if (budgetMs > 0L && remaining() <= MIN_ROUND_MS) break
            if (feed(vaultId, answer.needBytes) == 0) break
            // THE SNAPSHOT WAS TAKEN IN THE FIRST ROUND; the member's ask
            // covers the whole pass, so `asked` rides every round.
            outcome = pass.run(read.input(remaining(), reason).copy(wantsSnapshot = false))
        }
        return Outcome(vaultId, outcome, reason)
    }

    /** What one vault's pass did, and why it ran. */
    public data class Outcome(
        public val vaultId: String,
        public val outcome: DrainPass.Outcome,
        public val reason: WakeReason = WakeReason.SCHEDULED,
    )

    public companion object {
        /** No deadline: the member is watching and the pass runs until the spool is empty. */
        public const val FOREGROUND_DEADLINE_MS: Long = 0

        /**
         * Five seconds: a burst of typing is one pass, and a member who writes
         * something and locks the phone has it moving before they put it down.
         */
        public const val COMMIT_DEBOUNCE_MS: Long = 5_000

        /** Rounds of "stream what was asked, pass again" one pass may take. */
        public const val MAX_ROUNDS: Int = 8

        /** Below this much budget a further round would be killed mid-part. */
        public const val MIN_ROUND_MS: Long = 2_000
    }
}

/** Whether every vault's pass ran and left its spool empty — what a BGTask reports. */
public fun List<ShelfDrain.Outcome>.allDrained(): Boolean = all {
    val outcome = it.outcome
    outcome is DrainPass.Outcome.Ran && outcome.answer.drained
}
