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

    "queued is its own state, and it is not clean" {
        // `SAVE_STATE_QUEUED` — durable here, not yet committed. Collapsing it
        // into CLEAN would be the shell claiming a commit that has not
        // happened, which is exactly the badge a member reads to know a write
        // is still owed.
        NotesReads.settled(CommandStatus.COMMAND_STATUS_QUEUED, "")
            .save_settled?.outcome shouldBe NotesEditorState.SaveState.SAVE_STATE_QUEUED
        NotesReads.settled(CommandStatus.COMMAND_STATUS_IN_FLIGHT, "")
            .save_settled?.outcome shouldBe NotesEditorState.SaveState.SAVE_STATE_QUEUED
        NotesReads.settled(CommandStatus.COMMAND_STATUS_PARKED, "")
            .save_settled?.outcome shouldBe NotesEditorState.SaveState.SAVE_STATE_QUEUED
    }

    "only an executed command is clean, and every refusal is refused" {
        NotesReads.settled(CommandStatus.COMMAND_STATUS_EXECUTED, "")
            .save_settled?.outcome shouldBe NotesEditorState.SaveState.SAVE_STATE_CLEAN
        listOf(
            CommandStatus.COMMAND_STATUS_DENIED,
            CommandStatus.COMMAND_STATUS_FAILED,
            CommandStatus.COMMAND_STATUS_UNSPECIFIED,
        ).forEach { status ->
            NotesReads.settled(status, "")
                .save_settled?.outcome shouldBe NotesEditorState.SaveState.SAVE_STATE_REFUSED
        }
    }

    "a refusal carries the core's sentence, and silence carries none" {
        // `CommandOutcome.reason` is the author's words for a denial or a failed
        // precondition — never the raw predicate, which reaches the audit trail
        // only. A shell that composed one would be the hole in that rule.
        NotesReads.settled(CommandStatus.COMMAND_STATUS_DENIED, "That note was removed.")
            .save_settled?.failure.shouldNotBeNull()
            .sentence shouldBe "That note was removed."
        NotesReads.settled(CommandStatus.COMMAND_STATUS_DENIED, "")
            .save_settled?.failure shouldBe null
    }

    "a save that would blank the note is refused, not sent" {
        // THE DATA-LOSS GUARD (#1025 S5, R-NOTES-2). A draft whose body is
        // empty AND marked unavailable has no member-typed replacement: sending
        // it as a whole-draft write would blank the note. `knowledge.edit_note`
        // treats an absent `body_text` as leave-alone, and title/pin-only saves
        // queue on that path — but a pristine empty+unavailable save with no
        // typed body still refuses, so the sentence reaches the member rather
        // than a quiet no-op that looks like success.
        val opened = NotesEditorMachine.reduce(
            NotesEditorMachine.initial(),
            NotesEditorEvent(opened = NotesEditorEvent.Opened(note_id = "note-1")),
        ).state
        val loaded = NotesEditorMachine.reduce(
            opened,
            NotesEditorEvent(
                data_ = NotesEditorEvent.DataArrived(
                    draft = NoteDraft(
                        title = "Groceries",
                        body = "",
                        body_unavailable = true,
                        base_revision_id = "rev-7",
                    ),
                ),
            ),
        ).state
        val saved = NotesEditorMachine.reduce(
            loaded,
            NotesEditorEvent(save = NotesEditorEvent.SaveRequested()),
        )

        // NO WRITE LEAVES. That is the whole assertion.
        saved.effects.shouldBeEmpty()
        saved.state.save shouldBe NotesEditorState.SaveState.SAVE_STATE_REFUSED
        saved.state.draft?.save_failure.shouldNotBeNull()
            .sentence shouldBe "Centraid has not copied this note's text to this device yet."
    }

    "a title-only save while the body is unavailable still queues" {
        // End state (#1025 live-notes): omit `body_text` (already) and still
        // queue — must not blank the note and must not drop the edit. R-NOTES-3:
        // the edit must reach the vault, not be thrown away.
        val opened = NotesEditorMachine.reduce(
            NotesEditorMachine.initial(),
            NotesEditorEvent(opened = NotesEditorEvent.Opened(note_id = "note-1")),
        ).state
        val loaded = NotesEditorMachine.reduce(
            opened,
            NotesEditorEvent(
                data_ = NotesEditorEvent.DataArrived(
                    draft = NoteDraft(
                        title = "Groceries",
                        body = "",
                        body_unavailable = true,
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
        write.inputJson.contains("body_text").shouldBe(false)
        write.inputJson.contains("\"title\":\"Groceries and wine\"").shouldBe(true)
        saved.state.save shouldBe NotesEditorState.SaveState.SAVE_STATE_SAVING
        saved.state.draft?.save_failure shouldBe null
    }

    "a member who typed a body while it was marked unavailable saves their words" {
        // R-NOTES-2: refusing stands ONLY when the draft body is empty AND
        // unavailable. A member who typed a body is saving their words, not
        // blanking the note — and `edited()` must clear the flag so
        // `saveInput` includes `body_text`.
        val opened = NotesEditorMachine.reduce(
            NotesEditorMachine.initial(),
            NotesEditorEvent(opened = NotesEditorEvent.Opened(note_id = "note-1")),
        ).state
        val loaded = NotesEditorMachine.reduce(
            opened,
            NotesEditorEvent(
                data_ = NotesEditorEvent.DataArrived(
                    draft = NoteDraft(
                        title = "Groceries",
                        body = "",
                        body_unavailable = true,
                        base_revision_id = "rev-7",
                    ),
                ),
            ),
        ).state
        val typed = NotesEditorMachine.reduce(
            loaded,
            NotesEditorEvent(body = NotesEditorEvent.BodyEdited(body = "milk")),
        ).state
        typed.draft?.body_unavailable shouldBe false
        val saved = NotesEditorMachine.reduce(
            typed,
            NotesEditorEvent(save = NotesEditorEvent.SaveRequested()),
        )
        val write = saved.effects.single() as ScreenEffect.SubmitWrite
        write.inputJson.contains("\"body_text\":\"milk\"").shouldBe(true)
        saved.state.save shouldBe NotesEditorState.SaveState.SAVE_STATE_SAVING
    }

    "a draft whose body DID arrive saves normally" {
        // The inverse, so the guard is a guard and not a wall: the refusal is
        // about an absent body, not about saving.
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
                        body_unavailable = false,
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
        write.invokeKey shouldBe "notes.save:note-1:rev-7"
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
        dev.centraid.shared.apps.tally.TallyListMachine.seatChanged(reachable)
            .seat_changed?.seat shouldBe reachable
        dev.centraid.shared.apps.photos.PhotosGridMachine.seatChanged(reachable)
            .seat_changed?.seat shouldBe reachable
        dev.centraid.shared.shell.HomeMachine.seatChanged(reachable)
            .seat_changed?.seat shouldBe reachable
    }

    "an authoritative seat stops withholding Tally's recurring verb" {
        // The other thing a null seat got wrong. `Reads.isLocalOnly(null)` is
        // true, so Tally's `materialize-recurring-expense` was WITHHELD on every
        // device for ever — a verb a member could never reach, with a sentence
        // explaining an outage that was not happening. On a phone that IS the
        // vault the seat is ALWAYS authoritative (`HomeSession.publishSeat`), so
        // this is the only case left and it had better be the reachable one.
        val reduced = dev.centraid.shared.apps.tally.TallyListMachine.reduce(
            dev.centraid.shared.apps.tally.TallyListMachine.initial(),
            dev.centraid.shared.apps.tally.TallyListMachine.seatChanged(
                seat(
                    SeatState.Connectivity.CONNECTIVITY_ONLINE_UNMETERED,
                    SeatState.Durability.DURABILITY_AUTHORITATIVE,
                ),
            ),
        )
        reduced.state.recurring_materialisation_withheld shouldBe false
    }
})
