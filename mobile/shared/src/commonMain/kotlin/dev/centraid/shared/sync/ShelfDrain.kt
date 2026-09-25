package dev.centraid.shared.sync

import dev.centraid.shared.shell.Shelf

/**
 * THE ONE THING BOTH SHELLS CALL (#1029 W18-6).
 *
 * A pass nobody invokes is the state W5B left with better copy, so this is the
 * join: the platforms have a window and a deadline, [Shelf] has the vaults, and
 * [DrainPass] knows how to empty one. Every trigger on both platforms comes
 * through here and there are exactly three of them:
 *
 * | Trigger | Who calls it | Deadline |
 * |---|---|---|
 * | the app became active | `ShellModel` (iOS) / the lifecycle owner (Android) | [FOREGROUND_DEADLINE_MS] |
 * | a commit happened | the change stream, debounced | [FOREGROUND_DEADLINE_MS] |
 * | a background window opened | `BackgroundPasses` (iOS) / `SyncPass` (Android) | the window's |
 *
 * ## EVERY HELD VAULT, NOT THE FOREGROUND ONE
 *
 * A background window backs up the device, not the screen the member happened
 * to leave open. [Shelf.all] is the roster and this walks it — which is also
 * why the deadline is **divided**: a window that spent all of its budget on the
 * first vault would leave a second vault permanently unbacked-up on a phone
 * that never gets a long window.
 *
 * ## TWO HOLDINGS ARE SKIPPED, AND NEITHER IS A FAILURE
 *
 * A **resting** holding has no core (the OS asked for memory back) and waking
 * one is a suspending act that opens SQLite — a background window is the worst
 * moment to do it, and the vault is drained on the next window after the member
 * touches it. A **frozen** holding has moved to another phone (F1): it is
 * read-only, the gateway would refuse its next put with `VAULT_MOVED`, and
 * draining it would be this phone arguing with a decision already made.
 *
 * ## THE DEBOUNCE IS ON COMMITS AND IT IS NOT A POLL
 *
 * A member typing into a note commits every few keystrokes, and a pass per
 * commit would drain on a keystroke. [afterCommit] coalesces: the first call
 * runs, and calls inside [COMMIT_DEBOUNCE_MS] of the last run are dropped
 * rather than queued — dropped, because the *next* commit will ask again and a
 * queued pass would run against a spool that has already been emptied.
 */
public class ShelfDrain(
    /**
     * Every vault this device holds, foreground first — `Shelf::all`.
     *
     * A SUPPLIER OF HOLDINGS AND NOT THE SHELF, which is the narrower
     * dependency and the honest one: nothing here opens, closes, wakes or
     * reorders a vault, and a class that held the shelf could. It is also what
     * makes this testable without a filesystem, on the one toolchain this
     * container has.
     */
    private val holdings: () -> List<Shelf.Holding>,
    /** Builds the door for one vault's core. `CoreDrainDoor` in production. */
    private val doorFor: (() -> dev.centraid.core.CentraidCore?) -> DrainDoor,
    /** This device's clock, for the debounce only. Never for a backup claim. */
    private val nowMs: () -> Long,
    private val reschedule: DrainPass.Rescheduler = DrainPass.Rescheduler { },
) {
    private val passes = mutableMapOf<String, DrainPass>()
    /**
     * When the last pass ran, or null before the first.
     *
     * **Null and not `Long.MIN_VALUE`.** A sentinel that far away overflows the
     * subtraction in [afterCommit] — `0 - Long.MIN_VALUE` is negative — so every
     * commit after launch read as "inside the debounce" and the trigger was
     * dead until something else ran a pass. The test caught it; nothing about
     * the shape of the code would have.
     */
    private var lastRunAtMs: Long? = null

    /**
     * Run one pass over every held vault inside [deadlineMs].
     *
     * `0` is "no deadline" — `phone.proto`'s own spelling for the foreground
     * case, where the member is watching and the pass runs until the spool is
     * empty. It is passed straight through rather than divided, because a
     * budget of nothing divided is still nothing.
     */
    public suspend fun run(deadlineMs: Long): List<Outcome> {
        lastRunAtMs = nowMs()
        val drainable = holdings().filter { it.core != null && it.moved == null }
        if (drainable.isEmpty()) return emptyList()
        val each = if (deadlineMs <= 0L) 0L else deadlineMs / drainable.size
        return drainable.map { holding ->
            val pass = passes.getOrPut(holding.vaultId) {
                // ONE PASS PER VAULT, KEPT. The try-lock that refuses a
                // concurrent drain lives on the pass, so a pass rebuilt per
                // call would refuse nothing.
                // THE DOOR TAKES A SUPPLIER, so a holding that rests and wakes
                // is followed rather than pinned to a handle that was closed
                // when the OS asked for memory back.
                DrainPass(
                    doorFor { holdings().firstOrNull { it.vaultId == holding.vaultId }?.core },
                    reschedule,
                )
            }
            Outcome(holding.vaultId, pass.run(each))
        }
    }

    /**
     * The app became active. Runs unconditionally: a member who has just opened
     * Centraid is the one moment worth spending a drain on without asking
     * whether one ran recently.
     */
    public suspend fun onBecameActive(): List<Outcome> = run(FOREGROUND_DEADLINE_MS)

    /**
     * A commit landed. **Debounced**, and a dropped call is not queued.
     *
     * @return the outcomes, or an empty list when this call was coalesced into
     *   a run that has just happened.
     */
    public suspend fun afterCommit(): List<Outcome> {
        val last = lastRunAtMs
        if (last != null && nowMs() - last < COMMIT_DEBOUNCE_MS) return emptyList()
        return run(FOREGROUND_DEADLINE_MS)
    }

    /** What one vault's pass did. */
    public data class Outcome(
        public val vaultId: String,
        public val outcome: DrainPass.Outcome,
    )

    public companion object {
        /**
         * No deadline in the foreground: the member is watching a progress
         * line and the pass runs until the spool is empty (`phone.proto`).
         */
        public const val FOREGROUND_DEADLINE_MS: Long = 0

        /**
         * Five seconds.
         *
         * Long enough that a burst of typing is one pass, short enough that a
         * member who writes something and locks their phone has it on the
         * laptop before they put it down.
         */
        public const val COMMIT_DEBOUNCE_MS: Long = 5_000
    }
}
