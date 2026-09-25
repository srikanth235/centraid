package dev.centraid.shared

import centraid.core.v1.Envelope
import dev.centraid.core.CentraidCore
import dev.centraid.shared.shell.Shelf
import dev.centraid.shared.sync.DrainAnswer
import dev.centraid.shared.sync.DrainDoor
import dev.centraid.shared.sync.DrainPass
import dev.centraid.shared.sync.ShelfDrain
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import java.util.concurrent.atomic.AtomicInteger

/**
 * THE JOIN BETWEEN A WINDOW AND THE VAULTS (#1029 W18-6).
 *
 * `DrainPass` knows how to empty one vault and the platforms know how long they
 * have; this is what walks the shelf between them, and it is the object every
 * trigger on both shells goes through. Before it there was no caller at all —
 * `SyncPass.installed` was null on every Android device and
 * `BackgroundPasses.pass` had nothing to be set to — which is the state W5B
 * left and the whole reason this lane's second half exists.
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

    fun drain(
        held: List<Shelf.Holding>,
        answer: DrainAnswer? = DrainAnswer(1, 0, DrainAnswer.Stopped.EMPTY, lastAckedAtMs = 1),
        deadlines: MutableList<Long> = mutableListOf(),
        now: () -> Long = { 0 },
    ) = ShelfDrain(
        holdings = { held },
        doorFor = {
            object : DrainDoor {
                override suspend fun drain(deadlineMs: Long): DrainAnswer? {
                    deadlines += deadlineMs
                    return answer
                }
            }
        },
        nowMs = now,
    )

    "every held vault is drained, not only the one in front" {
        runTest {
            // A BACKGROUND WINDOW BACKS UP THE DEVICE, not the screen the member
            // happened to leave open.
            val outcomes = drain(listOf(holding("a"), holding("b"))).run(60_000)
            outcomes.map { it.vaultId } shouldBe listOf("a", "b")
        }
    }

    "the deadline is DIVIDED, so a second vault is not permanently unbacked-up" {
        runTest {
            // A WINDOW THAT SPENT ITS WHOLE BUDGET ON THE FIRST VAULT would
            // leave the second one never backed up on a phone that never gets a
            // long window.
            val deadlines = mutableListOf<Long>()
            drain(listOf(holding("a"), holding("b"), holding("c")), deadlines = deadlines)
                .run(90_000)
            deadlines shouldBe listOf(30_000L, 30_000L, 30_000L)
        }
    }

    "the foreground's 'no deadline' is passed through, not divided" {
        runTest {
            // A BUDGET OF NOTHING DIVIDED IS STILL NOTHING — `phone.proto`'s
            // `0` means "run until the spool is empty", and dividing it would
            // read as a zero-length budget instead.
            val deadlines = mutableListOf<Long>()
            drain(listOf(holding("a"), holding("b")), deadlines = deadlines).onBecameActive()
            deadlines shouldBe listOf(0L, 0L)
        }
    }

    "a RESTING holding is skipped, because waking one opens SQLite in a background window" {
        runTest {
            val deadlines = mutableListOf<Long>()
            val outcomes = drain(
                listOf(holding("a"), holding("resting", resting = true)),
                deadlines = deadlines,
            ).run(60_000)
            outcomes.map { it.vaultId } shouldBe listOf("a")
            // AND THE WHOLE BUDGET WENT TO THE ONE THAT COULD USE IT.
            deadlines shouldBe listOf(60_000L)
        }
    }

    "a FROZEN holding is skipped, because the laptop would refuse it anyway" {
        runTest {
            // F1: the vault moved to another phone. Draining it would be this
            // phone arguing with a decision already made, and the gateway
            // answers `VAULT_MOVED`.
            val outcomes =
                drain(listOf(holding("gone", frozen = true), holding("a"))).run(60_000)
            outcomes.map { it.vaultId } shouldBe listOf("a")
        }
    }

    "a device holding nothing drainable runs nothing and is not an error" {
        runTest {
            drain(listOf(holding("resting", resting = true))).run(60_000) shouldBe emptyList()
            drain(emptyList()).run(60_000) shouldBe emptyList()
        }
    }

    "the pass per vault is KEPT, so a concurrent drain is still refused" {
        runTest {
            // THE TRY-LOCK LIVES ON THE PASS. A pass rebuilt per call would
            // refuse nothing, and the two foreground triggers fire together all
            // the time.
            val shelf = drain(listOf(holding("a")))
            shelf.run(60_000)
            val second = shelf.run(60_000).single().outcome
            (second is DrainPass.Outcome.Ran) shouldBe true
        }
    }

    "a commit inside the debounce is DROPPED, not queued" {
        runTest {
            // A MEMBER TYPING COMMITS EVERY FEW KEYSTROKES. Dropped rather than
            // queued, because the next commit asks again and a queued pass would
            // run against a spool that has already been emptied.
            val clock = AtomicInteger(0)
            val deadlines = mutableListOf<Long>()
            val shelf = drain(
                listOf(holding("a")),
                deadlines = deadlines,
                now = { clock.get().toLong() },
            )
            // THE FIRST COMMIT AFTER LAUNCH RUNS. It did not, for one commit
            // of this lane: the "never run" sentinel was `Long.MIN_VALUE` and
            // `now - MIN_VALUE` overflows negative, so every commit read as
            // inside the debounce and the trigger was dead.
            shelf.afterCommit().size shouldBe 1
            clock.set(ShelfDrain.COMMIT_DEBOUNCE_MS.toInt() - 1)
            shelf.afterCommit() shouldBe emptyList()
            clock.set(ShelfDrain.COMMIT_DEBOUNCE_MS.toInt() + 1)
            shelf.afterCommit().size shouldBe 1
            deadlines.size shouldBe 2
        }
    }

    "becoming active is NOT debounced, because opening the app is worth a pass" {
        runTest {
            val deadlines = mutableListOf<Long>()
            val shelf = drain(listOf(holding("a")), deadlines = deadlines, now = { 0 })
            shelf.onBecameActive()
            shelf.onBecameActive()
            deadlines.size shouldBe 2
        }
    }
})
