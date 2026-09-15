package dev.centraid.shared

import centraid.core.v1.IntentStatus
import centraid.screen.v1.NoteDraft
import centraid.screen.v1.NotesEditorEvent
import centraid.screen.v1.NotesEditorState
import centraid.screen.v1.SeatState
import dev.centraid.shared.apps.notes.NotesEditorMachine
import dev.centraid.shared.apps.notes.NotesReads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.sync.WriteGate
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe

/**
 * A WRITE HAS SOMEWHERE TO GO (#1025 S5).
 *
 * `WriteGate` had three verdicts, a test file and **no caller in the product**,
 * because `Request::Intent` refused on a seat role and there was nothing for it
 * to gate: a shell could not queue a write at all. Everything downstream of the
 * outbox — `IntentRecord`, `seat_outbox`, S2's live `IntentSink`,
 * `Outbox::overlaid()`'s paint, `settle_at_commit_seq` — operated on a row
 * nothing in the product ever wrote.
 *
 * The simulator is what said so: with the gateway stopped, pressing Save left
 * the screen on "Saving" for ever and `seat_outbox` held zero rows. These
 * assert the shell's half of the join — the gate is consulted, and every answer
 * the core can give becomes a state the editor renders.
 */
class WriteRunnerSpec : StringSpec({

    fun seat(connectivity: SeatState.Connectivity, durability: SeatState.Durability) =
        SeatState(connectivity = connectivity, durability = durability)

    val offline = seat(
        SeatState.Connectivity.CONNECTIVITY_OFFLINE,
        SeatState.Durability.DURABILITY_LOCAL_ONLY,
    )

    "an ordinary write with no gateway in reach is ENQUEUED, never refused" {
        // The outbox is the point. A note save is not online-only.
        val save = ScreenEffect.SubmitWrite(
            command = "knowledge.save_note",
            inputJson = "{}",
            invokeKey = "notes.save:note-1:rev-1",
            onlineOnly = false,
        )
        WriteGate.verdict(save, offline) shouldBe WriteGate.Verdict.Enqueue
    }

    "an online-only write NEVER falls back to the outbox" {
        // `docs/mobile-offline.md:259`, census §E seam 7. The flag's whole
        // meaning is that a gateway it cannot reach is a FAILURE, not a delay —
        // the answer cannot be reconstructed later.
        val verdict = WriteGate.verdict(
            ScreenEffect.SubmitWrite("locker.reveal", "{}", "k", onlineOnly = true),
            offline,
        )
        (verdict is WriteGate.Verdict.Refuse).shouldBeTrue()
    }

    "queued is its own state, and it is not clean" {
        // `SAVE_STATE_QUEUED` — "written to this device's outbox; the gateway
        // has not confirmed". Collapsing it into CLEAN would be the shell
        // claiming a confirmation the gateway has not given, which is exactly
        // the badge a member reads to know a write is still owed. The iOS
        // shell renders it "Waiting for your gateway".
        NotesReads.settled(IntentStatus.INTENT_STATUS_QUEUED, "")
            .save_settled?.outcome shouldBe NotesEditorState.SaveState.SAVE_STATE_QUEUED
        NotesReads.settled(IntentStatus.INTENT_STATUS_SENDING, "")
            .save_settled?.outcome shouldBe NotesEditorState.SaveState.SAVE_STATE_QUEUED
        NotesReads.settled(IntentStatus.INTENT_STATUS_PARKED, "")
            .save_settled?.outcome shouldBe NotesEditorState.SaveState.SAVE_STATE_QUEUED
    }

    "only an executed intent is clean, and every refusal is refused" {
        NotesReads.settled(IntentStatus.INTENT_STATUS_EXECUTED, "")
            .save_settled?.outcome shouldBe NotesEditorState.SaveState.SAVE_STATE_CLEAN
        listOf(
            IntentStatus.INTENT_STATUS_DENIED,
            IntentStatus.INTENT_STATUS_FAILED,
            IntentStatus.INTENT_STATUS_CONFLICT,
            IntentStatus.INTENT_STATUS_UNSPECIFIED,
        ).forEach { status ->
            NotesReads.settled(status, "")
                .save_settled?.outcome shouldBe NotesEditorState.SaveState.SAVE_STATE_REFUSED
        }
    }

    "a refusal carries the core's sentence, and silence carries none" {
        // `Outcome.reason` is the author's words for a denial or a failed
        // precondition — never the raw predicate, which reaches the audit trail
        // only. A shell that composed one would be the hole in that rule.
        NotesReads.settled(IntentStatus.INTENT_STATUS_DENIED, "That note was removed.")
            .save_settled?.failure.shouldNotBeNull()
            .sentence shouldBe "That note was removed."
        NotesReads.settled(IntentStatus.INTENT_STATUS_DENIED, "")
            .save_settled?.failure shouldBe null
    }

    "a parked seat refuses rather than pretending to queue" {
        // Parked means out of disk: a queued write needs a durable row and
        // there is nowhere to put it. Pretending would lose the write on the
        // next launch, which is worse than saying so.
        val verdict = WriteGate.verdict(
            ScreenEffect.SubmitWrite("knowledge.save_note", "{}", "k", onlineOnly = false),
            seat(
                SeatState.Connectivity.CONNECTIVITY_OFFLINE,
                SeatState.Durability.DURABILITY_PARKED_LOW_DISK,
            ),
        )
        (verdict is WriteGate.Verdict.Refuse).shouldBeTrue()
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
        // a note save is never onlineOnly; queue is the product.
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
        write.onlineOnly shouldBe false
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
        write.onlineOnly shouldBe false
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

    "a reachable seat SENDS NOW, so the gate is a gate and not a rubber stamp" {
        // #1025 S5, D-1025-S5-6. Nothing in the product ever sent a
        // `SeatChanged`, so every screen held a null `SeatState` for its whole
        // life and `WriteGate` never saw a reachable seat. The consequences
        // both ways: an `onlineOnly` write was refused on EVERY device always,
        // and an ordinary write queued with a healthy gateway in the same room.
        // A gate handed a constant is not a gate.
        val reachable = seat(
            SeatState.Connectivity.CONNECTIVITY_ONLINE_UNMETERED,
            SeatState.Durability.DURABILITY_AUTHORITATIVE,
        )
        WriteGate.verdict(
            ScreenEffect.SubmitWrite("knowledge.save_note", "{}", "k", onlineOnly = false),
            reachable,
        ) shouldBe WriteGate.Verdict.SendNow
        // And the case that was impossible before: an online-only write that is
        // ALLOWED, because the gateway is actually there.
        WriteGate.verdict(
            ScreenEffect.SubmitWrite("locker.reveal", "{}", "k", onlineOnly = true),
            reachable,
        ) shouldBe WriteGate.Verdict.SendNow
        // A METERED link is still reachable: metering governs uploads, not
        // writes.
        WriteGate.verdict(
            ScreenEffect.SubmitWrite("locker.reveal", "{}", "k", onlineOnly = true),
            seat(
                SeatState.Connectivity.CONNECTIVITY_ONLINE_METERED,
                SeatState.Durability.DURABILITY_AUTHORITATIVE,
            ),
        ) shouldBe WriteGate.Verdict.SendNow
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

    "a seat that reaches its gateway stops withholding Tally's recurring verb" {
        // The other thing a null seat got wrong. `Reads.isLocalOnly(null)` is
        // true, so Tally's `materialize-recurring-expense` was WITHHELD on every
        // device for ever — a verb a member could never reach, with a sentence
        // explaining an outage that was not happening.
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
