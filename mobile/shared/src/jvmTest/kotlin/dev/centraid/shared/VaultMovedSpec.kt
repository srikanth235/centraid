package dev.centraid.shared

import centraid.core.v1.CommandStatus
import centraid.screen.v1.BackupState
import centraid.screen.v1.MediaPermission
import centraid.screen.v1.NoteDraft
import centraid.screen.v1.NotesEditorEvent
import centraid.screen.v1.NotesEditorState
import dev.centraid.core.CentraidCore
import dev.centraid.shared.apps.notes.NotesEditorMachine
import dev.centraid.shared.apps.notes.NotesReads
import dev.centraid.shared.platform.FakePlatformServices
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.shell.CameraRoll
import dev.centraid.shared.shell.Shelf
import dev.centraid.shared.sync.ScreenRuntime
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.runTest

/**
 * `VAULT_MOVED` IS COOPERATION, NOT ENFORCEMENT (#1029 F1).
 *
 * Both phones hold the same seed, so no lease and no lock can DECIDE who owns a
 * vault — either phone could ignore any answer it is given and go on writing.
 * What supersession buys is an ORDER (F3): the restored phone claims the next
 * epoch, and the phone that learns it has been superseded stops writing because
 * that is the cooperative thing to do.
 *
 * So the freeze is exactly three properties, and each one is a way the obvious
 * alternative would hurt a member:
 *
 * 1. **Writes refuse, reads do not.** Freezing the whole vault would take away
 *    everything the member still has on a phone they are still holding.
 * 2. **The spool is SHOWN and KEPT** — "N changes since <date>". Wiping would
 *    destroy the only copy of whatever this phone wrote last, and saying
 *    nothing would let the member discover it after they wiped the phone
 *    themselves.
 * 3. **Nothing takes the vault back on its own.** Two phones claiming one
 *    authority automatically is a loop with the member watching it flip.
 *
 * The state has no producer in this shell yet and says so where it is defined:
 * `error.proto` has no `ERROR_CODE_VAULT_MOVED`, `crates/api-proto` is another
 * lane's, and the lease that hears the supersession is #1029 W5's. These pin
 * the behaviour that call will get.
 */
class VaultMovedSpec : StringSpec({

    val movedAt = "2026-03-14T09:31:00Z"

    fun held(moved: Shelf.Moved? = null) = Shelf.Holding(
        vaultId = "v1",
        path = "/vaults/centraid-vault-0a1b.sqlite3",
        name = "Tahoe Demo",
        core = CentraidCore.answering(Dispatchers.Unconfined) { it },
        moved = moved,
    )

    "an ordinary vault is not read-only and draws no line" {
        // The inverse first, so the freeze is a state and not a wall.
        held().readOnly.shouldBeFalse()
        held().frozenLine.shouldBeNull()
    }

    "a moved vault refuses writes and keeps its reads" {
        val frozen = held(Shelf.Moved(atIso = movedAt, unacked = 12))
        frozen.readOnly.shouldBeTrue()
        // AND THE CORE IS STILL OPEN. Freezing is not forgetting: the member
        // keeps every row they had and can read all of it.
        frozen.core.shouldNotBeNull()
        frozen.resting.shouldBeFalse()
    }

    "the line counts what is KEPT, and names the day" {
        held(Shelf.Moved(atIso = movedAt, unacked = 12))
            .frozenLine shouldBe "12 changes since 2026-03-14"
        // ONE IS NOT "1 changes". A count a member reads is a sentence.
        held(Shelf.Moved(atIso = movedAt, unacked = 1))
            .frozenLine shouldBe "1 change since 2026-03-14"
        // AND ZERO IS STILL A LINE, not silence: the vault moved, and a member
        // told nothing cannot tell this phone from one that is current.
        held(Shelf.Moved(atIso = movedAt, unacked = 0))
            .frozenLine shouldBe "0 changes since 2026-03-14"
    }

    "there is no way to unfreeze, and freezing an absent vault is not an error" {
        runTest {
            val shelf = Shelf(
                vaultDir = "/vaults",
                services = FakePlatformServices(),
                dispatcher = Dispatchers.Unconfined,
                uiThreadName = "test",
            )
            // A VAULT THIS PHONE DOES NOT HOLD IS A NO-OP, not a throw: the
            // caller is a restore client reporting what a server said, and a
            // vault this phone already forgot is not an error it can act on.
            shelf.freeze("nobody", movedAt, 3)
            shelf.roster.value.shouldBeEmpty()
            // AND THERE IS NO `thaw`. Taking the vault back is a deliberate act
            // and #1029 W5's; a method here that undid the freeze would be the
            // automatic take-back F1 forbids. "The surface does not offer one"
            // is the whole guarantee, so it is asserted as one.
            Shelf::class.members.none { it.name == "thaw" }.shouldBeTrue()
        }
    }

    "a save on a frozen vault is DENIED with the sentence, and never reaches the core" {
        runTest {
            val host = ScreenHost(NotesEditorMachine)
            val seen = mutableListOf<Pair<CommandStatus, String>>()
            // A HEALTHY HANDLE, OPEN, and that is what makes the assertion
            // worth making: the refusal has to happen in front of a door that
            // WOULD have opened. Reads still go through it — a frozen vault is
            // fully readable — so what is asserted below is that no COMMAND
            // reached it, not that nothing did.
            val asked = mutableListOf<centraid.core.v1.Envelope>()
            val core = CentraidCore.answering(Dispatchers.Unconfined) { request ->
                asked += request
                centraid.core.v1.Envelope(response = centraid.core.v1.Response())
            }
            // AN UNCONFINED SCOPE OF ITS OWN, cancelled at the end. The
            // runtime's collector never completes — that is its job — so
            // leaving it on `runTest`'s scope hangs the test rather than
            // failing it, and `Unconfined` is what makes the effects run inline
            // (the same shape `ChangeStreamSpec` uses).
            val runtimeScope = CoroutineScope(Dispatchers.Unconfined)
            ScreenRuntime(
                core = { core },
                host = host,
                reads = NotesReads,
                scope = runtimeScope,
                writes = object : dev.centraid.shared.sync.ScreenWrites<
                    NotesEditorState,
                    NotesEditorEvent,
                    > {
                    override val appId: String = NotesReads.appId

                    override fun settled(
                        status: CommandStatus,
                        sentence: String,
                        invokeKey: String,
                    ): NotesEditorEvent {
                        seen += status to sentence
                        return NotesReads.settled(status, sentence, invokeKey)
                    }
                },
                readOnly = { Shelf.MOVED_SENTENCE },
            ).start()

            // DRIVEN THROUGH THE REAL EDITOR, so what is refused is the write
            // the product actually emits rather than one this test invented.
            host.send(NotesEditorEvent(opened = NotesEditorEvent.Opened(note_id = "n-1")))
            host.send(
                NotesEditorEvent(
                    data_ = NotesEditorEvent.DataArrived(
                        draft = NoteDraft(title = "Groceries", body = "milk", base_revision_id = "rev-7"),
                    ),
                ),
            )
            host.send(NotesEditorEvent(title = NotesEditorEvent.TitleEdited(title = "Groceries and wine")))
            host.send(NotesEditorEvent(save = NotesEditorEvent.SaveRequested()))
            runtimeScope.cancel()

            seen shouldBe listOf(CommandStatus.COMMAND_STATUS_DENIED to Shelf.MOVED_SENTENCE)
            // NOTHING WAS SUBMITTED. The editor's `Opened` also asks for a
            // read, and that one is allowed through — so the assertion is that
            // no request carried a COMMAND, which is what a write is.
            asked.none { it.request?.command != null }.shouldBeTrue()
            // AND THE EDITOR RENDERS IT AS A REFUSAL, not as a queue badge
            // promising a save that will never happen. The sentence's own
            // journey onto the draft is `WriteRunnerSpec`'s — this harness's
            // stub core refuses the editor's opening READ a beat later, which
            // clears the draft, and chasing that ordering would be testing the
            // stub. What belongs here is that a frozen vault denies.
            host.state.value.save shouldBe NotesEditorState.SaveState.SAVE_STATE_REFUSED
        }
    }

    "a camera-roll pass over a frozen vault takes no photographs" {
        runTest {
            val services = FakePlatformServices()
            services.mediaLibrary.grant = MediaPermission.MEDIA_PERMISSION_GRANTED
            val report = CameraRoll(
                services = services,
                // NULL, ON PURPOSE: a frozen holding may also be RESTING, and
                // the member is owed "it moved" rather than "no vault is open".
                // The order of the two checks in `pass` is the sentence.
                core = { null },
                readOnly = { Shelf.MOVED_SENTENCE },
            ).pass("v1")
            // IDLE AND NOT PARKED. Parked is a device out of disk, which
            // resumes when space is freed; this does not resume — the vault
            // moved, and the member takes it back deliberately or not at all.
            report.state.phase shouldBe BackupState.Phase.PHASE_IDLE
            report.state.paused_reason shouldBe Shelf.MOVED_SENTENCE
            report.queued shouldBe 0
            // AND THE ROLL WAS NEVER WALKED: nothing was opened, so no original
            // was read off the device for a vault that cannot take it.
            services.mediaLibrary.opened.shouldBeEmpty()
        }
    }
})
