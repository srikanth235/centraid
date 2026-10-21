package dev.centraid.shared

import centraid.core.v1.CommandStatus
import centraid.screen.v1.NoteDraft
import centraid.screen.v1.NotesEditorEvent
import centraid.screen.v1.NotesEditorState
import centraid.screen.v1.SeatState
import dev.centraid.shared.apps.notes.NotesEditorMachine
import dev.centraid.shared.apps.notes.NotesReads
import dev.centraid.shared.screen.ScreenEffect
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
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
        NotesReads.settled(CommandStatus.COMMAND_STATUS_EXECUTED, "", "k:1")
            .write_settled.shouldNotBeNull().let {
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
            NotesReads.settled(status, "", "k:1").write_settled.shouldNotBeNull().committed shouldBe false
        }
    }

    "a refusal carries the core's sentence, and silence carries none" {
        // `CommandOutcome.reason` is the author's words for a denial or a failed
        // precondition — never the raw predicate, which reaches the audit trail
        // only. A shell that composed one would be the hole in that rule.
        NotesReads.settled(CommandStatus.COMMAND_STATUS_DENIED, "That note was removed.", "k:1")
            .write_settled?.failure.shouldNotBeNull()
            .sentence shouldBe "That note was removed."
        NotesReads.settled(CommandStatus.COMMAND_STATUS_DENIED, "", "k:1")
            .write_settled?.failure shouldBe null
    }

    "a draft saves through the note's own edit, keyed by its sequence" {
        // A NOTE'S BODY IS ITS OWN COLUMN (#1135): it is always here, so there is
        // no "body not on this device" to guard and a save is a save.
        val loaded = NotesEditorMachine.reduce(
            NotesEditorMachine.reduce(
                NotesEditorMachine.initial(),
                NotesEditorEvent(opened = NotesEditorEvent.Opened(note_id = "note-1")),
            ).state,
            NotesEditorEvent(
                data_ = NotesEditorEvent.DataArrived(
                    draft = NoteDraft(
                        title = "Groceries",
                        body = "milk",
                        base_revision_id = "rev-7",
                    ),
                ),
            ),
        ).state
        val edited = NotesEditorMachine.reduce(
            loaded,
            NotesEditorEvent(title = NotesEditorEvent.TitleEdited(title = "Groceries and wine")),
        ).state
        val saved = NotesEditorMachine.reduce(
            edited,
            NotesEditorEvent(save = NotesEditorEvent.SaveRequested()),
        )
        val write = saved.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe NotesEditorMachine.SAVE_COMMAND
        write.invokeKey shouldBe "note.edit:note-1:seq=1"
        saved.state.save shouldBe NotesEditorState.SaveState.SAVE_STATE_SAVING
    }

    "every screen turns a seat into its own event, so one fact reaches all of them" {
        // The seat is ONE fact about the device. Two screens disagreeing about
        // whether it can reach its gateway is not a state the product has, so
        // the machines translate rather than decide.
        val reachable = seat(
            SeatState.Connectivity.CONNECTIVITY_ONLINE_UNMETERED,
            SeatState.Durability.DURABILITY_AUTHORITATIVE,
        )
        NotesEditorMachine.seatChanged(reachable).seat_changed?.seat shouldBe reachable
        dev.centraid.shared.apps.tasks.TasksTrashMachine.machine.seatChanged(reachable)
            .seat_changed?.seat shouldBe reachable
        dev.centraid.shared.apps.photos.PhotosGridMachine.seatChanged(reachable)
            .seat_changed?.seat shouldBe reachable
        dev.centraid.shared.shell.HomeMachine.seatChanged(reachable)
            .seat_changed?.seat shouldBe reachable
    }
})
