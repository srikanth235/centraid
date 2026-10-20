package dev.centraid.shared.sync.phone

/** WHAT A CALLER OF [FollowGate] DOES NEXT. */
public sealed interface FollowStep {
    /** Nothing: the request joined a pass already waiting or queued, or a timer fired for nothing. */
    public data object Nothing : FollowStep

    /** Wait [delayMs], then ask [FollowGate.fire]. */
    public data class Arm(public val delayMs: Long) : FollowStep

    /** Run a pass now, and call [FollowGate.finish] when it ends. */
    public data object Start : FollowStep
}

/**
 * WHEN A FOLLOWING PASS RUNS (#1127). Pure: no clock, no timer and no thread, only the times a
 * caller hands it. A phone store announces itself in bursts (iOS posts `CNContactStoreDidChange`
 * once per saved contact, and the app coming to the front lands beside it), so:
 *
 * - **Triggers within [settleMs] are one pass.** The first trigger arms a timer; the ones that
 *   arrive before it fires join it. The wait is measured from the FIRST trigger, so a store that
 *   never stops announcing still gets a pass every [settleMs].
 * - **One pass runs per source at a time.** Sources are independent: a contacts pass never holds
 *   up a calendar one.
 * - **A trigger during a pass queues exactly one more**, however many arrive: the pass already
 *   running read the phone before them, and one more reads it after all of them.
 *
 * A gate is confined to one thread (the caller's scope), so it holds no lock.
 */
public class FollowGate(private val settleMs: Long = SETTLE_MS) {
    private sealed interface State {
        data class Waiting(val fireAt: Long) : State

        data class Running(val queued: Boolean) : State
    }

    private val states = mutableMapOf<PhoneSource, State>()

    /** A trigger arrived at [now]. */
    public fun request(source: PhoneSource, now: Long): FollowStep = when (val state = states[source]) {
        null -> {
            states[source] = State.Waiting(now + settleMs)
            FollowStep.Arm(settleMs)
        }
        is State.Waiting -> FollowStep.Nothing
        is State.Running -> {
            states[source] = State.Running(queued = true)
            FollowStep.Nothing
        }
    }

    /** The timer an [FollowStep.Arm] asked for fired at [now]: [FollowStep.Start] when the wait is over. */
    public fun fire(source: PhoneSource, now: Long): FollowStep {
        val state = states[source] as? State.Waiting ?: return FollowStep.Nothing
        if (now < state.fireAt) return FollowStep.Nothing
        states[source] = State.Running(queued = false)
        return FollowStep.Start
    }

    /**
     * The pass ended, however it ended. [FollowStep.Start] when triggers arrived during
     * it: the queued pass runs at once, since they have already waited.
     */
    public fun finish(source: PhoneSource): FollowStep {
        val state = states[source] as? State.Running ?: return FollowStep.Nothing
        if (!state.queued) {
            states.remove(source)
            return FollowStep.Nothing
        }
        states[source] = State.Running(queued = false)
        return FollowStep.Start
    }

    public companion object {
        /** Two seconds: long enough to fold one burst of store notifications, short enough to feel live. */
        public const val SETTLE_MS: Long = 2_000
    }
}
