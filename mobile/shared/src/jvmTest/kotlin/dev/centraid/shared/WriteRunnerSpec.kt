package dev.centraid.shared

import centraid.core.v1.CommandStatus
import centraid.screen.v1.SeatState
import dev.centraid.shared.kit.WriteLaw
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe

/**
 * A WRITE HAS SOMEWHERE TO GO (#1025 S5, narrowed by #1029 §1).
 *
 * ## What left, and what that leaves
 *
 * **Every `WriteGate` case is deleted here because the gate is deleted.** It
 * chose between sending now, the durable outbox and a refusal, and all three
 * were answers to "can this device reach its gateway right now": an
 * `onlineOnly` write was one whose answer could not be reconstructed later, and
 * `Enqueue` put the write in `seat_outbox` for a pass to submit. The phone is
 * the vault (#1029 §1). A write commits here or it does not commit, there is no
 * outbox and no gateway, and `grep -rn 'WriteGate|onlineOnly|seat_outbox'
 * mobile/ crates/` finds nothing. Those are tests whose SUBJECT is gone.
 *
 * What is left is the half that always mattered on its own and still does:
 * **every answer the core can give becomes a state the editor renders**, the
 * sentence a member reads is the CORE's and never one this shell composed, and
 * one `SeatState` reaches every screen rather than each screen guessing. The
 * statuses are `CommandStatus` now — the `Intent` plane's enum went with
 * `intent.proto` — and they still map to the same three save states, because
 * "somewhere durable, not yet committed" is still a thing a commit can be.
 */
class WriteRunnerSpec : StringSpec({

    fun seat(connectivity: SeatState.Connectivity, durability: SeatState.Durability) =
        SeatState(connectivity = connectivity, durability = durability)

    "only an executed command commits; every other status is refused, keyed to its save" {
        // THE PHONE IS THE VAULT (#1029 §1): a save commits here or it does
        // not. QUEUED left with the outbox, so there is no third state — and
        // the settle carries the key it answers, so the editor can tell its
        // own save's answer from a stale one.
        WriteLaw.settledOf(CommandStatus.COMMAND_STATUS_EXECUTED, "", "k:1")
            .let {
                it.committed shouldBe true
                it.invoke_key shouldBe "k:1"
            }
        listOf(
            CommandStatus.COMMAND_STATUS_QUEUED,
            CommandStatus.COMMAND_STATUS_IN_FLIGHT,
            CommandStatus.COMMAND_STATUS_PARKED,
            CommandStatus.COMMAND_STATUS_DENIED,
            CommandStatus.COMMAND_STATUS_FAILED,
            CommandStatus.COMMAND_STATUS_UNSPECIFIED,
        ).forEach { status ->
            WriteLaw.settledOf(status, "", "k:1").committed shouldBe false
        }
    }

    "a refusal carries the core's sentence, and silence carries none" {
        // `CommandOutcome.reason` is the author's words for a denial or a failed
        // precondition — never the raw predicate, which reaches the audit trail
        // only. A shell that composed one would be the hole in that rule.
        WriteLaw.settledOf(CommandStatus.COMMAND_STATUS_DENIED, "That note was removed.", "k:1")
            .failure.shouldNotBeNull()
            .sentence shouldBe "That note was removed."
        WriteLaw.settledOf(CommandStatus.COMMAND_STATUS_DENIED, "", "k:1")
            .failure shouldBe null
    }

    "every screen turns a seat into its own event, so one fact reaches all of them" {
        // The seat is ONE fact about the device. Two screens disagreeing about
        // whether it can reach its gateway is not a state the product has, so
        // the machines translate rather than decide.
        val reachable = seat(
            SeatState.Connectivity.CONNECTIVITY_ONLINE_UNMETERED,
            SeatState.Durability.DURABILITY_AUTHORITATIVE,
        )
        dev.centraid.shared.shell.HomeMachine.seatChanged(reachable)
            .seat_changed?.seat shouldBe reachable
    }
})
