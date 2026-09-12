package dev.centraid.shared.sync

import centraid.screen.v1.SeatState
import dev.centraid.shared.screen.ScreenEffect

/**
 * Where a write goes, and the one case where it goes nowhere
 * (#1020, D-1020-E4; `docs/mobile-offline.md:259`, census §E seam 7).
 *
 * **An online-only write never enqueues.** "Falling back to the outbox is
 * exactly what the flag forbids" — the flag's whole meaning is that a gateway
 * it cannot reach is a FAILURE, not a delay. v0's list is
 * `packages/blueprints/apps/locker/writes.ts`'s `ONLINE_ONLY_ACTIONS`; the
 * reason a verb is on it is that its answer cannot be reconstructed later
 * (a secret revealed, a session opened, an id the canonical engine mints).
 *
 * This is a gate and not a branch inside each screen for the reason the
 * `ScreenEffect.SubmitWrite` comment gives: a rule that lives in every reducer
 * is a rule one reducer will get wrong.
 */
public object WriteGate {
    public sealed interface Verdict {
        /** Send it now, and wait for the gateway's answer. */
        public data object SendNow : Verdict

        /** Put it in the durable outbox; the next pass submits it. */
        public data object Enqueue : Verdict

        /**
         * REFUSE. Not "queue and hope": the member is told the write did not
         * happen, with the sentence that says why.
         */
        public data class Refuse(public val sentence: String) : Verdict
    }

    public fun verdict(write: ScreenEffect.SubmitWrite, seat: SeatState?): Verdict {
        val reachable = seat?.connectivity in REACHABLE
        return when {
            reachable -> Verdict.SendNow
            write.onlineOnly -> Verdict.Refuse(
                "Centraid needs to reach your gateway for this one, and cannot right now.",
            )
            // Parked means out of disk: a queued write needs a durable row, and
            // there is nowhere to put it. Refusing is the honest answer;
            // pretending to queue would lose the write on the next launch.
            seat?.durability == SeatState.Durability.DURABILITY_PARKED_LOW_DISK ->
                Verdict.Refuse("This device is out of space, so Centraid cannot save this yet.")

            else -> Verdict.Enqueue
        }
    }

    /**
     * The connectivity answers that mean "the gateway may be reachable".
     *
     * `CONNECTIVITY_UNKNOWN_PLATFORM_REFUSED` is deliberately NOT here: a pass
     * asks the platform for the real answer rather than assuming a radio
     * (`docs/mobile-offline.md:212`), and an unknown answer is not a yes. A
     * metered connection IS here — metering governs uploads, not writes.
     */
    private val REACHABLE = setOf(
        SeatState.Connectivity.CONNECTIVITY_ONLINE_UNMETERED,
        SeatState.Connectivity.CONNECTIVITY_ONLINE_METERED,
    )
}
