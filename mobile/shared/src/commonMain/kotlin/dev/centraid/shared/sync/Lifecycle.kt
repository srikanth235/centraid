package dev.centraid.shared.sync

/**
 * The lifecycle and the sync pass, as one explicit state machine
 * (#1020, D-1020-E4).
 *
 * v0's sentences are kept, not reinterpreted (`docs/mobile-offline.md:208`–
 * `:262`). What changes in v1 is the mechanism underneath: the lease was TWO
 * mechanisms — a `<seat>.lease.json` sidecar and `useNewConnection: true` — and
 * **both halves were needed and neither was enough** (census §E seam 1). With
 * the core owning the file, the two collapse into **one core per device
 * process** (R-1020-24), which `dev.centraid.core.CentraidCore.open` enforces
 * and which makes app extensions load-bearing: Share, Autofill and Widget
 * processes never open the vault and never start iroh.
 *
 * ## Five states, and what each one is for
 *
 * | State | The member is | The core is |
 * |---|---|---|
 * | [Foreground] | looking at it | open, reader running |
 * | [BackgroundPass] | elsewhere | open, on a 20 s budget |
 * | [Locked] | locked out | closed, decrypted material cleared |
 * | [Suspended] | elsewhere, no pass | open, idle |
 * | [Relaunched] | back after a kill | not open yet |
 *
 * [Relaunched] is a state and not an initial condition because what it implies
 * is different: a relaunch has a durable outbox and a durable cursor to resume
 * from, and a cold start that treated itself as a first run would re-bootstrap.
 */
public sealed interface LifecycleState {
    public data object Foreground : LifecycleState

    /**
     * A background pass, inside its budget.
     *
     * **The budget is checked at STAGE BOUNDARIES** (`:212`): a pass that runs
     * out stops at a boundary and reports what it managed. A coroutine
     * cancelled mid-stage is a different failure — it leaves a stage half done
     * with no report, and the next pass cannot tell whether to redo it.
     */
    public data class BackgroundPass(
        public val startedAtMs: Long,
        public val budgetMs: Long = BUDGET_MS,
        public val wake: WakeReason,
        /** Stages not yet attempted, in order. */
        public val remaining: List<Stage>,
        /** What this pass managed, stage by stage. */
        public val report: PassReport = PassReport(),
        /**
         * The platform said time is nearly up. A SECOND, INDEPENDENT TRIGGER
         * (`:212`) — it must not be dropped in favour of the timer, because
         * the platform knows things the timer does not.
         */
        public val platformWarned: Boolean = false,
    ) : LifecycleState {
        public fun elapsed(nowMs: Long): Long = nowMs - startedAtMs

        public fun outOfTime(nowMs: Long): Boolean =
            platformWarned || elapsed(nowMs) >= budgetMs
    }

    /**
     * Locked. Leaving the foreground clears the decrypted cache, unmounts
     * replica sessions and paints an opaque switcher mask (`:253`).
     */
    public data object Locked : LifecycleState

    public data object Suspended : LifecycleState

    public data object Relaunched : LifecycleState

    public companion object {
        /** 20 seconds (`docs/mobile-offline.md:212`). */
        public const val BUDGET_MS: Long = 20_000
    }
}

/**
 * Why a pass is running.
 *
 * **`PUSH` CARRIES NOTHING.** Push is wake-only and content-free: no vault id,
 * item id, title, content, cursor or owner data (`:220`). The enum is the whole
 * payload, and there is deliberately no `Push(payload)` case for a future
 * broker to fill in — loss or throttling cannot lose data, because correctness
 * comes from the durable outboxes and the next foreground pull.
 */
public enum class WakeReason {
    /** BGTaskScheduler / WorkManager fired. */
    SCHEDULED,

    /** A content-free push woke the app. */
    PUSH,

    /** Reachability changed, or the radio came back. */
    CONNECTIVITY,

    /** Disk space was freed. */
    DISK_FREED,

    /** The member brought the app forward. */
    FOREGROUND,
}

/**
 * A stage of a pass. Ordered, and **isolated**: one failure never cancels the
 * rest (`docs/mobile-offline.md:212`).
 */
public enum class Stage {
    /** Pull the replica log forward. */
    PULL_LOG,

    /** Submit the intent outbox. */
    SUBMIT_INTENTS,

    /** Place thumbnails and other derived files. */
    PLACEMENT,

    /** Drain the camera-roll upload ledger. */
    UPLOAD,
}

/** What a pass managed. Counters are integers and always on (`:218`). */
public data class PassReport(
    public val completed: List<Stage> = emptyList(),
    public val failed: Map<Stage, String> = emptyMap(),
    public val skippedLive: List<Stage> = emptyList(),
    /** True when the pass stopped because it ran out of budget or was warned. */
    public val stoppedAtBoundary: Boolean = false,
)

/** What the shell is told to do. Data, like [dev.centraid.shared.screen.ScreenEffect]. */
public sealed interface SyncEffect {
    public data class RunStage(public val stage: Stage) : SyncEffect

    /**
     * Stop, and report. The report is the deliverable: "a pass that runs out
     * stops at a stage boundary and reports what it managed".
     */
    public data class FinishPass(public val report: PassReport) : SyncEffect

    /** Clear every decrypted credential from memory (`:253`). */
    public data object ClearDecryptedMaterial : SyncEffect

    /** Close the core and unmount the replica. */
    public data object UnmountReplica : SyncEffect

    /**
     * PARK the feed: stop the 1 s retry cadence, keep the cursor and the rows
     * (`:238`). Never an eviction — Centraid does not free canonical rows or
     * queued writes to manufacture space.
     */
    public data object ParkFeed : SyncEffect

    /** Resume from the DURABLE cursor, not from the top. */
    public data object ResumeFromDurableCursor : SyncEffect

    /**
     * Ask the platform to register the background task, and RECORD the answer.
     * Registration is observable rather than assumed (`:214`), so that
     * "Background App Refresh is off" is a sentence a member reads.
     */
    public data object RegisterBackgroundWork : SyncEffect
}

public sealed interface LifecycleEvent {
    public data object Foregrounded : LifecycleEvent

    public data object Backgrounded : LifecycleEvent

    public data class PassRequested(
        public val wake: WakeReason,
        public val nowMs: Long,
        public val stages: List<Stage> = Stage.entries,
    ) : LifecycleEvent

    /** A stage finished, one way or another. Always at a boundary. */
    public data class StageSettled(
        public val stage: Stage,
        public val nowMs: Long,
        public val outcome: Outcome,
    ) : LifecycleEvent {
        public sealed interface Outcome {
            public data object Completed : Outcome

            public data class Failed(public val sentence: String) : Outcome

            /**
             * Another opener holds the file. v0 counted this as `skippedLive`
             * and NOT as a failure, because a foreground member using the app
             * is not a broken background pass.
             */
            public data object SkippedLive : Outcome
        }
    }

    /** The platform's own expiration handler fired. */
    public data class PlatformExpirationWarning(public val nowMs: Long) : LifecycleEvent

    public data object Locked : LifecycleEvent

    public data object Unlocked : LifecycleEvent

    public data object Terminated : LifecycleEvent

    public data object Relaunched : LifecycleEvent

    public data object DiskLow : LifecycleEvent

    public data class DiskFreed(public val nowMs: Long) : LifecycleEvent
}

public data class LifecycleStep(
    public val state: LifecycleState,
    public val effects: List<SyncEffect> = emptyList(),
    /** True while the feed is parked. Survives every transition below. */
    public val parked: Boolean = false,
)

/**
 * The scheduler. Pure, like the screens — the clock arrives in the events.
 *
 * A `nowMs` parameter on the events rather than a clock in the scheduler, for
 * the reason `crates/core`'s `CoreConfig` gives about its own injectable clock:
 * a pass on the real wall clock is not reproducible, and a budget test that
 * slept for twenty seconds would be a test nobody runs.
 */
public class SyncScheduler(
    private val state: LifecycleState = LifecycleState.Relaunched,
    private val parked: Boolean = false,
) {
    public fun reduce(event: LifecycleEvent): LifecycleStep = when (event) {
        LifecycleEvent.Foregrounded -> LifecycleStep(
            LifecycleState.Foreground,
            // A FOREGROUND ALWAYS REGISTERS. Whether the platform accepted is
            // the answer that gets recorded and rendered.
            listOf(SyncEffect.RegisterBackgroundWork),
            parked,
        )

        LifecycleEvent.Backgrounded -> LifecycleStep(
            LifecycleState.Suspended,
            // LEAVING THE FOREGROUND CLEARS DECRYPTED MATERIAL (`:253`), even
            // when the app is not locked: an opaque switcher mask over a
            // process that still holds a vault key is a mask, not a lock.
            listOf(SyncEffect.ClearDecryptedMaterial),
            parked,
        )

        is LifecycleEvent.PassRequested ->
            if (parked) {
                // A PARKED FEED DOES NOT START A PASS. The cursor and the rows
                // stay; a later wake does not restart the loop.
                LifecycleStep(state, listOf(SyncEffect.ParkFeed), parked = true)
            } else {
                val pass = LifecycleState.BackgroundPass(
                    startedAtMs = event.nowMs,
                    wake = event.wake,
                    remaining = event.stages.drop(1),
                )
                LifecycleStep(
                    pass,
                    event.stages.firstOrNull()
                        ?.let { listOf(SyncEffect.RunStage(it)) }
                        ?: listOf(SyncEffect.FinishPass(PassReport())),
                    parked,
                )
            }

        is LifecycleEvent.StageSettled -> settle(event)

        is LifecycleEvent.PlatformExpirationWarning -> {
            val pass = state as? LifecycleState.BackgroundPass
                ?: return LifecycleStep(state, emptyList(), parked)
            // THE WARNING IS RECORDED, AND THE PASS STILL STOPS AT A BOUNDARY.
            // It does not cancel the stage in flight: a cancelled stage leaves
            // no report, which is the failure this whole design avoids.
            LifecycleStep(pass.copy(platformWarned = true), emptyList(), parked)
        }

        LifecycleEvent.Locked -> LifecycleStep(
            LifecycleState.Locked,
            listOf(SyncEffect.ClearDecryptedMaterial, SyncEffect.UnmountReplica),
            parked,
        )

        LifecycleEvent.Unlocked -> LifecycleStep(
            LifecycleState.Foreground,
            listOf(SyncEffect.RegisterBackgroundWork),
            parked,
        )

        LifecycleEvent.Terminated -> LifecycleStep(
            LifecycleState.Suspended,
            listOf(SyncEffect.UnmountReplica),
            parked,
        )

        LifecycleEvent.Relaunched -> LifecycleStep(
            LifecycleState.Relaunched,
            // A RELAUNCH RESUMES; it does not re-bootstrap. The outbox and the
            // cursor are durable, which is the whole reason platform timing can
            // be opportunistic.
            listOf(SyncEffect.ResumeFromDurableCursor),
            parked,
        )

        LifecycleEvent.DiskLow -> LifecycleStep(
            state,
            listOf(SyncEffect.ParkFeed),
            parked = true,
        )

        is LifecycleEvent.DiskFreed -> LifecycleStep(
            state,
            listOf(SyncEffect.ResumeFromDurableCursor),
            parked = false,
        )
    }

    private fun settle(event: LifecycleEvent.StageSettled): LifecycleStep {
        val pass = state as? LifecycleState.BackgroundPass
            ?: return LifecycleStep(state, emptyList(), parked)
        // SCOPES ARE ISOLATED: a failed stage is recorded and the pass
        // continues. One scope's failure never cancels the rest (`:212`).
        val report = when (val outcome = event.outcome) {
            LifecycleEvent.StageSettled.Outcome.Completed ->
                pass.report.copy(completed = pass.report.completed + event.stage)

            is LifecycleEvent.StageSettled.Outcome.Failed ->
                pass.report.copy(failed = pass.report.failed + (event.stage to outcome.sentence))

            LifecycleEvent.StageSettled.Outcome.SkippedLive ->
                pass.report.copy(skippedLive = pass.report.skippedLive + event.stage)
        }
        val next = pass.copy(report = report, remaining = pass.remaining)
        return when {
            // THE BOUNDARY CHECK. Either trigger stops the pass, and it stops
            // HERE — between stages — with a report of what it managed.
            next.outOfTime(event.nowMs) -> LifecycleStep(
                LifecycleState.Suspended,
                listOf(SyncEffect.FinishPass(report.copy(stoppedAtBoundary = true))),
                parked,
            )

            next.remaining.isEmpty() -> LifecycleStep(
                LifecycleState.Suspended,
                listOf(SyncEffect.FinishPass(report)),
                parked,
            )

            else -> LifecycleStep(
                next.copy(remaining = next.remaining.drop(1)),
                listOf(SyncEffect.RunStage(next.remaining.first())),
                parked,
            )
        }
    }
}
