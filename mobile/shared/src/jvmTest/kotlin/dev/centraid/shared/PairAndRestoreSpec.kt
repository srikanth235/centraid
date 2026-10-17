package dev.centraid.shared

import centraid.screen.v1.PairLaptopEvent
import centraid.screen.v1.PairLaptopState
import dev.centraid.design.copy.WordsCopy
import dev.centraid.shared.custody.PairAnswer
import dev.centraid.shared.custody.PairDoor
import dev.centraid.shared.custody.PairEffect
import dev.centraid.shared.custody.PairInput
import dev.centraid.shared.custody.PairLaptopFlow
import dev.centraid.shared.custody.PairLaptopMachine
import dev.centraid.shared.custody.PairRefusal
import dev.centraid.shared.custody.PairResult
import dev.centraid.shared.custody.Pairing
import dev.centraid.shared.custody.Readiness
import dev.centraid.shared.custody.pairedLine
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import io.kotest.matchers.types.shouldBeInstanceOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest

/**
 * Pairing (#1029 W18-4; the `pair.laptop` screen, #1047 E4). Restoring from the
 * 24 words is `WordsEntrySpec` and `EnrollmentSpec` (#1047 E1).
 */
class PairAndRestoreSpec : StringSpec({

    fun pairDoor(answer: PairResult, seen: MutableList<String> = mutableListOf()) =
        object : PairDoor {
            override suspend fun pair(payload: String): PairResult {
                seen += payload
                return answer
            }
        }

    // `contracts/crypto/identity-vectors.json`'s rendered safety number: the
    // shape the core hands over, 60 digits in 12 groups of 5.
    val number = "38394 36422 07209 27357 06879 57260 38834 97705 12477 24050 94056 44949"

    fun paired(label: String = "Home laptop", safety: String = number): PairInput = PairInput.Answered(
        PairResult.Paired(
            PairAnswer(safetyNumber = safety, destinationLabel = label, destinationAddress = "192.168.1.20:7443"),
        ),
    )

    fun refused(why: PairRefusal): PairInput = PairInput.Answered(PairResult.Refused(why))

    fun reduce(model: Pairing, input: PairInput) = PairLaptopMachine.reduce(model, input)

    fun event(event: PairLaptopEvent) = PairInput.View(event)

    val opened = event(PairLaptopEvent(opened = PairLaptopEvent.Opened(camera = true)))
    val primary = event(PairLaptopEvent(primary = PairLaptopEvent.Primary()))

    fun typed(text: String) = event(PairLaptopEvent(typed = PairLaptopEvent.PayloadTyped(text = text)))

    fun waiting(): Pairing {
        val open = reduce(PairLaptopMachine.initial(), opened)
        open.effects shouldBe listOf(PairEffect.Assess)
        return reduce(open.model, PairInput.Readiness(Readiness.READY)).model
    }

    "opening asks whether the vault can pair; a keyed one waits for the code, an unkeyed one needs its words" {
        val ready = waiting().state
        ready.phase shouldBe PairLaptopState.Phase.PHASE_WAITING
        ready.scan_label shouldBe WordsCopy.PAIR_SCAN
        ready.primary_enabled shouldBe false

        val open = reduce(PairLaptopMachine.initial(), opened).model
        val words = reduce(open, PairInput.Readiness(Readiness.NEEDS_WORDS)).model.state
        words.phase shouldBe PairLaptopState.Phase.PHASE_NEEDS_WORDS
        words.notice shouldBe WordsCopy.PAIR_NEEDS_WORDS
        reduce(open, PairInput.Readiness(Readiness.NO_VAULT)).model.state.notice shouldBe WordsCopy.PAIR_NO_VAULT
    }

    "a vault that opened without its words is offered them back; `WordsTapped` closes the pairing for the re-key" {
        // LOCKER'S WALL HAS THE SAME DOOR (#1047 E1): the label is the state's,
        // so the view draws a control only where the machine put one.
        val open = reduce(PairLaptopMachine.initial(), opened).model
        val needs = reduce(open, PairInput.Readiness(Readiness.NEEDS_WORDS)).model
        needs.state.words_label shouldBe WordsCopy.PAIR_WORDS_ACTION
        needs.state.primary_label shouldBe WordsCopy.DONE
        val words = event(PairLaptopEvent(words = PairLaptopEvent.WordsTapped()))
        val tapped = reduce(needs, words)
        tapped.model.state.phase shouldBe PairLaptopState.Phase.PHASE_CLOSED
        tapped.effects shouldBe emptyList()

        // NO VAULT, NO WORDS TO ENTER: no door, and a stray tap changes nothing.
        val none = reduce(open, PairInput.Readiness(Readiness.NO_VAULT)).model
        none.state.words_label shouldBe ""
        reduce(none, words).model.state.phase shouldBe PairLaptopState.Phase.PHASE_NEEDS_WORDS
        // Nor anywhere else the door is not drawn.
        waiting().state.words_label shouldBe ""
        reduce(waiting(), words).model.state.phase shouldBe PairLaptopState.Phase.PHASE_WAITING
    }

    "Scan is drawn on every phone: the camera, with a photo beside it, or the photo picker without one" {
        val camera = waiting().state
        camera.scan_label shouldBe WordsCopy.PAIR_SCAN
        camera.scan_camera shouldBe true
        camera.photo_label shouldBe WordsCopy.PAIR_PHOTO

        // THE SIMULATOR HAS NO CAMERA: Scan still shows, and reads a photo.
        val open = reduce(PairLaptopMachine.initial(), event(PairLaptopEvent(opened = PairLaptopEvent.Opened(camera = false)))).model
        val none = reduce(open, PairInput.Readiness(Readiness.READY)).model
        none.state.phase shouldBe PairLaptopState.Phase.PHASE_WAITING
        none.state.scan_label shouldBe WordsCopy.PAIR_SCAN
        none.state.scan_camera shouldBe false
        none.state.photo_label shouldBe ""
        none.state.payload_label shouldBe WordsCopy.PAIR_PASTE_LABEL

        // `ScanTapped` and `PhotoTapped` ARE INTENTS: the shell opens its
        // camera or picker, and the machine moves only on what comes back.
        val scan = reduce(none, event(PairLaptopEvent(scan = PairLaptopEvent.ScanTapped())))
        scan.model shouldBe none
        scan.effects shouldBe emptyList()
        reduce(none, event(PairLaptopEvent(photo = PairLaptopEvent.PhotoTapped()))).model shouldBe none

        val read = reduce(none, event(PairLaptopEvent(scanned = PairLaptopEvent.Scanned(payload = "eyJ2IjoyfQ"))))
        read.model.state.phase shouldBe PairLaptopState.Phase.PHASE_PAIRING
        read.effects.single().shouldBeInstanceOf<PairEffect.Pair>()
    }

    "a photo with no square in it says so and keeps the field; nothing is spent" {
        val typed = reduce(waiting(), typed("half a code")).model
        val unread = reduce(typed, event(PairLaptopEvent(unread = PairLaptopEvent.PhotoUnread())))
        unread.effects shouldBe emptyList()
        unread.model.state.phase shouldBe PairLaptopState.Phase.PHASE_WAITING
        unread.model.state.notice shouldBe WordsCopy.PAIR_PHOTO_UNREAD
        unread.model.state.payload shouldBe "half a code"
        unread.model.state.scan_label shouldBe WordsCopy.PAIR_SCAN

        // Typing again clears the sentence, as it clears every other one.
        reduce(unread.model, typed("half a code.")).model.state.notice shouldBe ""

        // Heard only while the field is drawn.
        val pairing = reduce(reduce(waiting(), typed("abc")).model, primary).model
        pairing.state.phase shouldBe PairLaptopState.Phase.PHASE_PAIRING
        reduce(pairing, event(PairLaptopEvent(unread = PairLaptopEvent.PhotoUnread()))).model shouldBe pairing
        pairing.state.scan_label shouldBe ""
    }

    "the code is trimmed, the terminal's `pair` label is dropped, and nothing else is judged here" {
        // W17 OWNS THE PAYLOAD'S SHAPE. A shell that validated it would be a
        // second parser for a format it does not own.
        PairLaptopMachine.ticketOf("  eyJ2IjoxfQ  ") shouldBe "eyJ2IjoxfQ"
        PairLaptopMachine.ticketOf("pair      eyJ2IjoxfQ\n") shouldBe "eyJ2IjoxfQ"
        PairLaptopMachine.ticketOf("pairing-is-not-a-label") shouldBe "pairing-is-not-a-label"

        val pairing = reduce(reduce(waiting(), typed("pair  abc")).model, primary)
        pairing.model.state.phase shouldBe PairLaptopState.Phase.PHASE_PAIRING
        (pairing.effects.single() as PairEffect.Pair).toString() shouldNotContain "abc"
    }

    "an empty box is answered here, because there is nothing to send" {
        val step = reduce(reduce(waiting(), typed("   ")).model, primary)
        step.effects shouldBe emptyList()
        step.model.state.notice shouldBe WordsCopy.PAIR_EMPTY
    }

    "a scan pairs at once" {
        val step = reduce(waiting(), event(PairLaptopEvent(scanned = PairLaptopEvent.Scanned(payload = "eyJ2"))))
        step.model.state.phase shouldBe PairLaptopState.Phase.PHASE_PAIRING
        step.effects.single().shouldBeInstanceOf<PairEffect.Pair>()
    }

    "paired shows the core's safety number to compare and names the gateway; unreachable and nothing-to-compare are failures to retry" {
        val pairing = reduce(reduce(waiting(), typed("eyJ2")).model, primary).model
        val paired = reduce(pairing, paired()).model.state
        paired.phase shouldBe PairLaptopState.Phase.PHASE_PAIRED
        // W15-D5: THE DIGITS, VERBATIM — every group, as the laptop prints them.
        paired.safety_number shouldBe number
        // v2 CARRIES NO HEX ID TO LEAK: the answer is the gateway's own label
        // and the address it was reached at, and the body names both.
        paired.body shouldContain "Paired with Home laptop at 192.168.1.20:7443."
        paired.payload shouldBe ""
        paired.primary_label shouldBe WordsCopy.DONE

        val unreachable = reduce(pairing, refused(PairRefusal.UNREACHABLE)).model
        unreachable.state.phase shouldBe PairLaptopState.Phase.PHASE_FAILED
        unreachable.state.notice shouldBe WordsCopy.PAIR_UNREACHABLE
        // THE SAME TEXT, AGAIN.
        reduce(unreachable, primary).effects.single().shouldBeInstanceOf<PairEffect.Pair>()

        // THE COMPARISON IS THE WHOLE SECURITY PROPERTY. A screen asking a
        // member to compare a blank is worse than one that refused.
        reduce(pairing, paired(safety = " ")).model.state.notice shouldBe
            WordsCopy.PAIR_NOTHING_TO_COMPARE
    }

    "a laptop that answered and refused is not one that did not answer: each refusal says its own remedy" {
        // #1047 E5: a spent or unknown pairing code is not "your laptop did not
        // answer", which would send a member to wake a laptop that is awake.
        val pairing = reduce(reduce(waiting(), typed("eyJ2")).model, primary).model
        val notTaken = reduce(pairing, refused(PairRefusal.NOT_TAKEN)).model.state
        notTaken.phase shouldBe PairLaptopState.Phase.PHASE_FAILED
        notTaken.notice shouldBe WordsCopy.PAIR_NOT_TAKEN
        notTaken.primary_label shouldBe WordsCopy.TRY_AGAIN
        reduce(pairing, refused(PairRefusal.NOT_A_CODE)).model.state.notice shouldBe WordsCopy.PAIR_NOT_A_CODE
        reduce(pairing, refused(PairRefusal.UNREACHABLE)).model.state.notice shouldBe WordsCopy.PAIR_UNREACHABLE
        reduce(pairing, refused(PairRefusal.MOVED)).model.state.notice shouldBe WordsCopy.PAIR_MOVED
        // THE MEMBER CAN PASTE A NEW CODE straight into the failed screen.
        reduce(reduce(pairing, refused(PairRefusal.NOT_TAKEN)).model, typed("new")).model.state.notice shouldBe ""
    }

    "a moved vault is refused with nothing to retry: no field, no scan, no Try again, and one Done" {
        // THE ACTION THAT CAN SUCCEED, OR NONE (#1080 receipt, "for the
        // owner"). `VAULT_MOVED` means another phone holds this vault's writer
        // epoch, so the same pairing and a fresh code are answered the same
        // way. The three refusals a second attempt CAN change keep their key.
        val pairing = reduce(reduce(waiting(), typed("eyJ2")).model, primary).model
        for (retryable in listOf(PairRefusal.UNREACHABLE, PairRefusal.NOT_A_CODE, PairRefusal.NOT_TAKEN)) {
            withClue("$retryable") {
                val failed = reduce(pairing, refused(retryable)).model.state
                failed.primary_label shouldBe WordsCopy.TRY_AGAIN
                failed.payload_label shouldNotBe ""
            }
        }
        val moved = reduce(pairing, refused(PairRefusal.MOVED)).model
        moved.state.phase shouldBe PairLaptopState.Phase.PHASE_FAILED
        moved.state.notice shouldBe WordsCopy.PAIR_MOVED
        moved.state.primary_label shouldBe WordsCopy.DONE
        moved.state.primary_label shouldNotBe WordsCopy.TRY_AGAIN
        moved.state.payload_label shouldBe ""
        moved.state.scan_label shouldBe ""
        moved.state.photo_label shouldBe ""
        moved.state.secondary_label shouldBe ""
        moved.state.body shouldBe ""
        moved.state.primary_enabled shouldBe true
        // NOTHING TYPED OR SCANNED CHANGES IT, and nothing is sent.
        reduce(moved, typed("new")).model.state.notice shouldBe WordsCopy.PAIR_MOVED
        reduce(moved, event(PairLaptopEvent(scanned = PairLaptopEvent.Scanned(payload = "eyJ2")))).effects shouldBe emptyList()
        // DONE CLOSES, and pairs nothing.
        val done = reduce(moved, primary)
        done.effects shouldBe emptyList()
        done.model.state.phase shouldBe PairLaptopState.Phase.PHASE_CLOSED
        // A SCREEN OPENED AGAIN STARTS CLEAN: the bar does not outlive the sheet.
        reduce(done.model, opened).model.barred shouldBe false
        reduce(done.model, opened).model.state.phase shouldBe PairLaptopState.Phase.PHASE_UNSPECIFIED
    }

    "running: a pair that answered stores through the door and reopens the vault, once; a failed one reopens nothing" {
        runTest {
            val after = mutableListOf<String>()
            var answer: PairResult = PairResult.Paired(PairAnswer(safetyNumber = number))
            val seen = mutableListOf<String>()
            val flow = PairLaptopFlow(
                readiness = { Readiness.READY },
                door = { pairDoor(answer, seen) },
                after = { after += "reopened" },
                scope = CoroutineScope(Dispatchers.Unconfined),
            )
            flow.reduce(opened)
            flow.reduce(typed("pair eyJ2"))
            flow.reduce(primary)
            seen shouldBe listOf("eyJ2")
            after shouldBe listOf("reopened")
            flow.state.value.phase shouldBe PairLaptopState.Phase.PHASE_PAIRED

            answer = PairResult.Refused(PairRefusal.NOT_TAKEN)
            flow.reduce(opened)
            flow.reduce(typed("eyJ2"))
            flow.reduce(primary)
            after shouldBe listOf("reopened")
            flow.state.value.phase shouldBe PairLaptopState.Phase.PHASE_FAILED
        }
    }

    "the paired line names the gateway and where it is, and what a mismatch means" {
        val line = pairedLine(
            PairAnswer(safetyNumber = number, destinationLabel = "the kitchen laptop", destinationAddress = "192.168.1.20:7443"),
        )
        line shouldContain "safety number"
        line shouldContain "centraid-gateway"
        line shouldContain "the kitchen laptop at 192.168.1.20:7443"
        line shouldContain "pair again on a network you trust"
        // The digits are the state's own field, drawn apart.
        line shouldNotContain number
    }

    "a gateway with no label is still named, and no address is left out rather than blank" {
        val line = pairedLine(PairAnswer(safetyNumber = number))
        line shouldContain "Paired with your backup device."
        line shouldNotContain " at ."
    }
})
