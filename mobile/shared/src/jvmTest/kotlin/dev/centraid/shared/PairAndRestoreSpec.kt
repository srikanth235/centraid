package dev.centraid.shared

import dev.centraid.shared.custody.CustodyCopy
import dev.centraid.shared.custody.PairAnswer
import dev.centraid.shared.custody.PairDoor
import dev.centraid.shared.custody.PairMachine
import dev.centraid.shared.custody.RestoreAnswer
import dev.centraid.shared.custody.RestoreDoor
import dev.centraid.shared.custody.RestoreMachine
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import kotlinx.coroutines.test.runTest

/** The two flows a phone has that are not about a vault it already holds (#1029 W18-4). */
class PairAndRestoreSpec : StringSpec({

    fun pairDoor(answer: PairAnswer?, seen: MutableList<String> = mutableListOf()) =
        object : PairDoor {
            override suspend fun pair(payload: String): PairAnswer? {
                seen += payload
                return answer
            }
        }

    fun restoreDoor(answer: RestoreAnswer?, seen: MutableList<Pair<List<String>, String?>>) =
        object : RestoreDoor {
            override suspend fun restore(
                words: List<String>,
                endpoint: String?,
            ): RestoreAnswer? {
                seen += words to endpoint
                return answer
            }
        }

    "the payload is trimmed once and otherwise handed over untouched" {
        runTest {
            // W17 OWNS THE PAYLOAD'S SHAPE. A shell that validated it would be a
            // second parser for a format it does not own.
            val seen = mutableListOf<String>()
            val machine = PairMachine(pairDoor(PairAnswer("11 22 33", "silver"), seen))
            machine.offer("  eyJ2IjoxfQ  ")
            seen shouldBe listOf("eyJ2IjoxfQ")
        }
    }

    "an empty box is answered here, because there is nothing to send" {
        runTest {
            val machine = PairMachine(pairDoor(null))
            machine.offer("   ") shouldBe PairMachine.State.Refused(CustodyCopy.PAIR_EMPTY)
        }
    }

    "a pairing with no safety number is refused rather than shown" {
        runTest {
            // THE COMPARISON IS THE WHOLE SECURITY PROPERTY. A screen asking a
            // member to compare a blank is worse than one that refused.
            val machine = PairMachine(pairDoor(PairAnswer(safetyNumber = " ")))
            machine.offer("payload") shouldBe
                PairMachine.State.Refused(CustodyCopy.PAIR_NO_SAFETY_NUMBER)
        }
    }

    "the paired line names the number and says what to do with it" {
        val line = CustodyCopy.pairedLine(PairAnswer("55 19 04 88", "the kitchen laptop"))
        line shouldContain "55 19 04 88"
        line shouldContain "the kitchen laptop"
        line shouldContain "matches the one"
    }

    "restore refuses a phrase that is not 24 words, and says how many there are" {
        runTest {
            val seen = mutableListOf<Pair<List<String>, String?>>()
            val machine = RestoreMachine(restoreDoor(RestoreAnswer(2), seen))
            val state = machine.restore(List(23) { "abandon" })
            state shouldBe RestoreMachine.State.Refused(CustodyCopy.restoreWordCount(23))
            // AND NOTHING REACHED THE CORE. A short phrase is not a request.
            seen.size shouldBe 0
        }
    }

    "words are forgiven their case and their spacing, because that is not the check" {
        runTest {
            val seen = mutableListOf<Pair<List<String>, String?>>()
            RestoreMachine(restoreDoor(RestoreAnswer(1), seen))
                .restore(List(24) { " Abandon " })
            seen.single().first shouldBe List(24) { "abandon" }
        }
    }

    "a typed endpoint reaches the core, and an empty one is an absence" {
        runTest {
            // THE ABSENCE IS THE NORMAL CASE: the phone finds the laptop by
            // resolving the record the phrase derives, and a member types an
            // address only when DNS cannot answer.
            val seen = mutableListOf<Pair<List<String>, String?>>()
            val machine = RestoreMachine(restoreDoor(RestoreAnswer(1), seen))
            machine.restore(List(24) { "abandon" }, endpoint = "  ")
            machine.restore(List(24) { "abandon" }, endpoint = " ab12 ")
            seen.map { it.second } shouldBe listOf(null, "ab12")
        }
    }

    "a laptop holding nothing is not the phrase being wrong, and the sentence says so" {
        runTest {
            val machine = RestoreMachine(restoreDoor(RestoreAnswer(vaults = 0), mutableListOf()))
            val state = machine.restore(List(24) { "abandon" })
            state shouldBe RestoreMachine.State.Refused(CustodyCopy.RESTORE_NOTHING_HELD)
            CustodyCopy.RESTORE_NOTHING_HELD shouldContain "phrase is valid"
        }
    }

    "an unreachable laptop is an answer with a next move, not a failure" {
        runTest {
            val machine = RestoreMachine(restoreDoor(null, mutableListOf()))
            machine.restore(List(24) { "abandon" }) shouldBe
                RestoreMachine.State.Refused(CustodyCopy.RESTORE_UNREACHABLE)
            CustodyCopy.RESTORE_UNREACHABLE shouldContain "type the address"
        }
    }

    "the restoring line reports what BackupStatus says and claims nothing more" {
        CustodyCopy.restoringLine(RestoreAnswer(vaults = 2, pendingBytes = 4096)) shouldContain
            "Restoring 2 vaults"
        CustodyCopy.restoringLine(RestoreAnswer(vaults = 1)) shouldBe "Restored 1 vault."
    }
})
