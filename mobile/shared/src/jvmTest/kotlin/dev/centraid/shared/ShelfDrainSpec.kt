package dev.centraid.shared

import centraid.core.v1.Envelope
import dev.centraid.core.CentraidCore
import dev.centraid.shared.platform.NetworkStatus
import dev.centraid.shared.shell.Shelf
import dev.centraid.shared.sync.DrainAnswer
import dev.centraid.shared.sync.DrainDoor
import dev.centraid.shared.sync.DrainInput
import dev.centraid.shared.sync.DrainPass
import dev.centraid.shared.sync.NeededBytes
import dev.centraid.shared.sync.PassConditions
import dev.centraid.shared.sync.ShelfDrain
import dev.centraid.shared.sync.TransferRule
import dev.centraid.shared.sync.WakeReason
import dev.centraid.shared.sync.allDrained
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.test.runTest
import java.util.concurrent.atomic.AtomicInteger

/**
 * THE JOIN BETWEEN A WINDOW AND THE VAULTS (#1080, the shells; #1029 W18-6).
 *
 * `DrainPass` runs one vault's pass and the platforms know how long they have;
 * this walks the shelf between them, and it is the object every trigger on
 * both shells goes through.
 */
class ShelfDrainSpec : StringSpec({

    fun core(): CentraidCore =
        CentraidCore.answering(Dispatchers.Unconfined) { Envelope(request_id = 0) }

    fun holding(id: String, resting: Boolean = false, frozen: Boolean = false) = Shelf.Holding(
        vaultId = id,
        path = "/v/$id.sqlite3",
        name = id,
        core = if (resting) null else core(),
        moved = if (frozen) Shelf.Moved(atIso = "2026-09-21T00:00:00Z", unacked = 3) else null,
    )

    val empty = DrainAnswer(0, DrainAnswer.Stopped.EMPTY, ackedAtMs = 1)

    fun drain(
        held: List<Shelf.Holding>,
        answers: (DrainInput) -> DrainAnswer? = { empty },
        seen: MutableList<DrainInput> = mutableListOf(),
        now: () -> Long = { 0 },
        conditions: PassConditions = PassConditions(TransferRule.WIFI_ONLY, true, metered = false, charging = true),
        feed: suspend (String, List<NeededBytes>) -> Int = { _, _ -> 0 },
        outcomes: MutableList<ShelfDrain.Outcome> = mutableListOf(),
    ) = ShelfDrain(
        holdings = { held },
        doorFor = { DrainDoor { input -> seen += input; answers(input) } },
        nowMs = now,
        conditions = { conditions },
        feed = feed,
        onOutcome = { outcomes += it },
    )

    "every held vault is drained, not only the one in front" {
        runTest {
            // A BACKGROUND WINDOW BACKS UP THE DEVICE, not the screen the member
            // happened to leave open.
            val outcomes = drain(listOf(holding("a"), holding("b"))).scheduled(60_000)
            outcomes.map { it.vaultId } shouldBe listOf("a", "b")
            outcomes.map { it.reason }.toSet() shouldBe setOf(WakeReason.SCHEDULED)
        }
    }

    "the deadline is DIVIDED, so a second vault is not permanently unbacked-up" {
        runTest {
            val seen = mutableListOf<DrainInput>()
            drain(listOf(holding("a"), holding("b"), holding("c")), seen = seen).scheduled(90_000)
            seen.map { it.deadlineMs } shouldBe listOf(30_000L, 30_000L, 30_000L)
        }
    }

    "the foreground's 'no deadline' is passed through, not divided" {
        runTest {
            // A BUDGET OF NOTHING DIVIDED IS STILL NOTHING — `phone.proto`'s
            // `0` means "run until the spool is empty".
            val seen = mutableListOf<DrainInput>()
            drain(listOf(holding("a"), holding("b")), seen = seen).onBecameActive()
            seen.map { it.deadlineMs } shouldBe listOf(0L, 0L)
        }
    }

    "a RESTING holding is skipped, because waking one opens SQLite in a background window" {
        runTest {
            val seen = mutableListOf<DrainInput>()
            val outcomes = drain(
                listOf(holding("a"), holding("resting", resting = true)),
                seen = seen,
            ).scheduled(60_000)
            outcomes.map { it.vaultId } shouldBe listOf("a")
            // AND THE WHOLE BUDGET WENT TO THE ONE THAT COULD USE IT.
            seen.map { it.deadlineMs } shouldBe listOf(60_000L)
        }
    }

    "a FROZEN holding is skipped, because the gateway would refuse it anyway" {
        runTest {
            val outcomes = drain(listOf(holding("gone", frozen = true), holding("a"))).scheduled(60_000)
            outcomes.map { it.vaultId } shouldBe listOf("a")
        }
    }

    "a device holding nothing drainable runs nothing and is not an error" {
        runTest {
            drain(listOf(holding("resting", resting = true))).scheduled(60_000) shouldBe emptyList()
            drain(emptyList()).scheduled(60_000) shouldBe emptyList()
            // AND A WINDOW THAT HAD NOTHING TO DO DRAINED: there was nothing to send.
            emptyList<ShelfDrain.Outcome>().allDrained() shouldBe true
        }
    }

    "the pass per vault is KEPT, so a concurrent drain is still refused" {
        runTest {
            val shelf = drain(listOf(holding("a")))
            shelf.scheduled(60_000)
            val second = shelf.scheduled(60_000).single().outcome
            (second is DrainPass.Outcome.Ran) shouldBe true
        }
    }

    "a commit inside the debounce is DROPPED, not queued" {
        runTest {
            val clock = AtomicInteger(0)
            val seen = mutableListOf<DrainInput>()
            val shelf = drain(listOf(holding("a")), seen = seen, now = { clock.get().toLong() })
            // THE FIRST COMMIT AFTER LAUNCH RUNS: a `Long.MIN_VALUE` sentinel
            // once overflowed `now - last` and read every commit as debounced.
            shelf.afterCommit().size shouldBe 1
            clock.set(ShelfDrain.COMMIT_DEBOUNCE_MS.toInt() - 1)
            shelf.afterCommit() shouldBe emptyList()
            clock.set(ShelfDrain.COMMIT_DEBOUNCE_MS.toInt() + 1)
            shelf.afterCommit().size shouldBe 1
            seen.size shouldBe 2
        }
    }

    "becoming active is NOT debounced, because opening the app is worth a pass" {
        runTest {
            val seen = mutableListOf<DrainInput>()
            val shelf = drain(listOf(holding("a")), seen = seen, now = { 0 })
            shelf.onBecameActive()
            shelf.onBecameActive()
            seen.size shouldBe 2
        }
    }

    "the rule and the link cross with every pass, and an unknown reading is the expensive one" {
        runTest {
            // D-1025-S7-74: a guess wrong towards cheap spends a data plan; a
            // guess wrong towards expensive delays a photograph.
            val seen = mutableListOf<DrainInput>()
            drain(
                listOf(holding("a")),
                seen = seen,
                conditions = PassConditions(
                    TransferRule.WIFI_AND_CELLULAR_PHOTOS,
                    includeVideos = false,
                    metered = null,
                    charging = null,
                ),
            ).scheduled(20_000)
            val sent = seen.single()
            sent.rule shouldBe TransferRule.WIFI_AND_CELLULAR_PHOTOS
            sent.includeVideos shouldBe false
            sent.metered shouldBe true
            sent.charging shouldBe false
        }
    }

    "only the member's own asks and the app leaving force a snapshot" {
        runTest {
            val seen = mutableListOf<DrainInput>()
            val shelf = drain(listOf(holding("a")), seen = seen)
            shelf.onSessionOpened()
            shelf.onBecameActive()
            shelf.afterImport()
            shelf.scheduled(30_000)
            shelf.backUpNow()
            shelf.enteredBackground(25_000)
            shelf.afterRestore()
            seen.map { it.wantsSnapshot } shouldBe listOf(false, false, false, false, true, true, true)
            WakeReason.entries.filter { it.wantsSnapshot }.toSet() shouldBe
                setOf(WakeReason.BACK_UP_NOW, WakeReason.ENTERED_BACKGROUND, WakeReason.RESTORED)
        }
    }

    "only the button is the member asking: leaving the screen times a snapshot and asks nothing (#1080 A24)" {
        runTest {
            val seen = mutableListOf<DrainInput>()
            val shelf = drain(listOf(holding("a")), seen = seen)
            shelf.enteredBackground(25_000)
            shelf.backUpNow()
            shelf.afterRestore()
            shelf.scheduled(30_000)
            // LEAVING SENDS THE SNAPSHOT WITHOUT THE ASK: under MANUAL it must
            // not seal an original, nor a video off the charger.
            seen.map { it.wantsSnapshot to it.asked } shouldBe listOf(
                true to false,
                true to true,
                true to false,
                false to false,
            )
            WakeReason.entries.filter { it.asked } shouldBe listOf(WakeReason.BACK_UP_NOW)
        }
    }

    "a link that went down runs nothing, and a flapping one runs once per debounce" {
        runTest {
            val clock = AtomicInteger(0)
            val seen = mutableListOf<DrainInput>()
            val shelf = drain(listOf(holding("a")), seen = seen, now = { clock.get().toLong() })
            val up = NetworkStatus.Reading(online = true, metered = false, charging = false)
            val down = up.copy(online = false)
            shelf.onConnectivity(down) shouldBe emptyList()
            shelf.onConnectivity(up).size shouldBe 1
            shelf.onConnectivity(up) shouldBe emptyList()
            clock.set(ShelfDrain.COMMIT_DEBOUNCE_MS.toInt() + 1)
            shelf.onConnectivity(up).size shouldBe 1
            seen.size shouldBe 2
        }
    }

    "a commit a moment ago does not swallow the move to Wi-Fi" {
        runTest {
            val seen = mutableListOf<DrainInput>()
            val shelf = drain(listOf(holding("a")), seen = seen, now = { 0 })
            shelf.afterCommit()
            shelf.onConnectivity(NetworkStatus.Reading(online = true, metered = false, charging = false)).size shouldBe 1
            seen.size shouldBe 2
        }
    }

    "bytes the core asked for are streamed in and the pass runs again, without a second snapshot" {
        runTest {
            val need = NeededBytes("ab".repeat(32), osRef = "L/1", mediaType = "image/heic", size = 7)
            val seen = mutableListOf<DrainInput>()
            val fed = mutableListOf<List<NeededBytes>>()
            var round = 0
            drain(
                listOf(holding("a")),
                seen = seen,
                answers = {
                    round += 1
                    if (round == 1) empty.copy(needBytes = listOf(need)) else empty
                },
                feed = { vault, needs ->
                    vault shouldBe "a"
                    fed += needs
                    needs.size
                },
            ).backUpNow()
            fed shouldBe listOf(listOf(need))
            seen.map { it.wantsSnapshot } shouldBe listOf(true, false)
            // THE MEMBER'S ASK COVERS THE WHOLE PASS, every round of it (A24).
            seen.map { it.asked } shouldBe listOf(true, true)
        }
    }

    "the same ask twice is no progress, and a library that will not produce bytes cannot spin" {
        runTest {
            val need = NeededBytes("cd".repeat(32), osRef = "L/2", mediaType = "image/jpeg", size = 0)
            val seen = mutableListOf<DrainInput>()
            drain(
                listOf(holding("a")),
                seen = seen,
                answers = { empty.copy(needBytes = listOf(need)) },
                feed = { _, needs -> needs.size },
            ).onBecameActive()
            seen.size shouldBe 2
            // AND A FEED THAT LANDED NOTHING ENDS THE PASS AT ONCE.
            val again = mutableListOf<DrainInput>()
            drain(
                listOf(holding("a")),
                seen = again,
                answers = { empty.copy(needBytes = listOf(need)) },
                feed = { _, _ -> 0 },
            ).onBecameActive()
            again.size shouldBe 1
        }
    }

    "a second 'Back up now' joins the first, and both answer when it ends" {
        runTest {
            val entered = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            val calls = AtomicInteger(0)
            val shelf = ShelfDrain(
                holdings = { listOf(holding("a")) },
                doorFor = {
                    DrainDoor {
                        calls.incrementAndGet()
                        entered.complete(Unit)
                        release.await()
                        empty
                    }
                },
                nowMs = { 0 },
            )
            coroutineScope {
                val first = async { shelf.backUpNow() }
                entered.await()
                shelf.backingUp.value shouldBe true
                val second = async { shelf.backUpNow() }
                release.complete(Unit)
                first.await() shouldBe second.await()
            }
            calls.get() shouldBe 1
            shelf.backingUp.value shouldBe false
        }
    }

    "a pass that is OWED a snapshot waits for the running one instead of taking Busy" {
        runTest {
            val entered = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            val seen = mutableListOf<DrainInput>()
            val shelf = ShelfDrain(
                holdings = { listOf(holding("a")) },
                doorFor = {
                    DrainDoor { input ->
                        seen += input
                        if (seen.size == 1) {
                            entered.complete(Unit)
                            release.await()
                        }
                        empty
                    }
                },
                nowMs = { 0 },
            )
            coroutineScope {
                val foreground = async { shelf.onBecameActive() }
                entered.await()
                val leaving = async { shelf.enteredBackground(25_000) }
                release.complete(Unit)
                foreground.await()
                (leaving.await().single().outcome is DrainPass.Outcome.Ran) shouldBe true
            }
            seen.map { it.wantsSnapshot } shouldBe listOf(false, true)
        }
    }

    "every vault's outcome is reported the moment its pass ends, a MOVED one included" {
        runTest {
            val outcomes = mutableListOf<ShelfDrain.Outcome>()
            val moved = DrainAnswer(0, DrainAnswer.Stopped.MOVED, movedAtMs = 1_780_000_000_000)
            drain(
                listOf(holding("a"), holding("b")),
                answers = { moved },
                outcomes = outcomes,
            ).scheduled(10_000)
            outcomes.map { it.vaultId } shouldBe listOf("a", "b")
            outcomes.map { (it.outcome as DrainPass.Outcome.Ran).answer.stopped }.toSet() shouldBe
                setOf(DrainAnswer.Stopped.MOVED)
            outcomes.allDrained() shouldBe false
        }
    }
})
