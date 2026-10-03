package dev.centraid.shared

import centraid.core.v1.HandoffPart
import centraid.core.v1.Settled
import dev.centraid.shared.sync.BackgroundUploads
import dev.centraid.shared.sync.LedgerChange
import dev.centraid.shared.sync.UploadDoors
import dev.centraid.shared.sync.UploadLoop
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest

/**
 * THE MOVER'S KOTLIN HALF (#1080 ruling 2; seam contract §2, A6, A11).
 *
 * The iOS background `URLSession` is Swift's and no machine here runs it; what
 * is proved here is everything it is handed and everything it reports: the
 * order after a pass (reconcile, then handoff, then enqueue), the probe that
 * keeps a session from being throttled, the cap on the OS's hands, and the
 * settle routed to the vault the part belongs to.
 */
class UploadLoopSpec : StringSpec({

    fun part(name: String, vault: String = "v1") = HandoffPart(
        name = name,
        path = "/spool/$name",
        url = "https://192.168.1.20:7443/v2/v/$vault/o/$name",
        method = "PUT",
        size = 1_024,
        gateway_id = "gw-1",
        vault_id = vault,
    )

    "a pass ends with reconcile, then handoff, then enqueue, and the parts go over whole" {
        runTest {
            val uploads = LoopUploads()
            val doors = LoopDoors(batch = listOf(part("a"), part("b")))
            val loop = UploadLoop(uploads)
            loop.attach(UploadLoop.Binding(vaults = { listOf("v1") }, doorsFor = { doors }, resubmit = {}))
            loop.afterPass("v1") shouldBe 2
            doors.calls shouldBe listOf("reconcile", "handoff(${UploadLoop.BATCH_BYTES}, ${UploadLoop.BATCH_PARTS})")
            uploads.enqueued shouldBe listOf(listOf(part("a"), part("b")))
        }
    }

    "an unreachable gateway enqueues nothing and asks for the next window" {
        runTest {
            val uploads = LoopUploads()
            val doors = LoopDoors(probe = LedgerChange(confirmed = 0, requeued = 0, reachable = false))
            var resubmits = 0
            val loop = UploadLoop(uploads)
            loop.attach(UploadLoop.Binding(vaults = { listOf("v1") }, doorsFor = { doors }, resubmit = { resubmits += 1 }))
            loop.afterPass("v1") shouldBe 0
            doors.calls shouldBe listOf("reconcile")
            uploads.enqueued.shouldBeEmpty()
            resubmits shouldBe 1
        }
    }

    "no core, or an arm not yet available, is nothing to do and no reason to retry" {
        runTest {
            val uploads = LoopUploads()
            val unready = LoopDoors(probe = null)
            var resubmits = 0
            val loop = UploadLoop(uploads)
            loop.attach(
                UploadLoop.Binding(
                    vaults = { listOf("v1", "gone") },
                    doorsFor = { vault -> if (vault == "v1") unready else null },
                    resubmit = { resubmits += 1 },
                ),
            )
            loop.afterPass("v1") shouldBe 0
            loop.afterPass("gone") shouldBe 0
            unready.calls shouldBe listOf("reconcile")
            uploads.enqueued.shouldBeEmpty()
            resubmits shouldBe 0
        }
    }

    "the OS is never handed more than the cap at once" {
        runTest {
            val uploads = LoopUploads(pending = UploadLoop.MAX_IN_FLIGHT - 2)
            val doors = LoopDoors(batch = listOf(part("a")))
            val loop = UploadLoop(uploads)
            loop.attach(UploadLoop.Binding(vaults = { listOf("v1") }, doorsFor = { doors }, resubmit = {}))
            loop.afterPass("v1")
            doors.calls.last() shouldBe "handoff(${UploadLoop.BATCH_BYTES}, 2)"
            // FULL HANDS ASK FOR NOTHING: the core marks what it hands off.
            uploads.pending = UploadLoop.MAX_IN_FLIGHT
            doors.calls.clear()
            loop.afterPass("v1") shouldBe 0
            doors.calls shouldBe listOf("reconcile")
        }
    }

    "each finished task settles in its own vault's core, routed by the vault id" {
        runTest {
            val first = LoopDoors()
            val second = LoopDoors()
            val loop = UploadLoop(LoopUploads())
            loop.attach(
                UploadLoop.Binding(
                    vaults = { listOf("v1", "v2") },
                    doorsFor = { vault -> mapOf("v1" to first, "v2" to second)[vault] },
                    resubmit = {},
                ),
            )
            loop.settled(name = "a", httpStatus = 201, error = null, gatewayId = "gw-1", vaultId = "v2")
            loop.settled(name = "b", httpStatus = 0, error = "offline", gatewayId = "gw-1", vaultId = "v1")
            // A VAULT THIS PHONE NO LONGER HOLDS settles nowhere.
            loop.settled(name = "c", httpStatus = 201, error = null, gatewayId = "gw-1", vaultId = "v9")
            second.settled shouldBe listOf(Settled(name = "a", http_status = 201, error = "", gateway_id = "gw-1", vault_id = "v2"))
            first.settled shouldBe listOf(Settled(name = "b", http_status = 0, error = "offline", gateway_id = "gw-1", vault_id = "v1"))
        }
    }

    "a drained session hands every open vault's next batch off" {
        runTest {
            val uploads = LoopUploads()
            val first = LoopDoors(batch = listOf(part("a")))
            val second = LoopDoors(batch = listOf(part("b", vault = "v2")))
            val loop = UploadLoop(uploads)
            loop.attach(
                UploadLoop.Binding(
                    vaults = { listOf("v1", "v2") },
                    doorsFor = { vault -> mapOf("v1" to first, "v2" to second)[vault] },
                    resubmit = {},
                ),
            )
            loop.sessionDrained()
            uploads.enqueued shouldBe listOf(listOf(part("a")), listOf(part("b", vault = "v2")))
        }
    }

    "a report that arrives before the session waits for it, and one that waits too long is dropped" {
        runTest {
            // A RELAUNCH DELIVERS FINISHED TASKS before the vaults are open.
            val doors = LoopDoors()
            val early = UploadLoop(LoopUploads())
            val waiting = launch { early.settled("a", 201, null, "gw-1", "v1") }
            testScheduler.advanceTimeBy(UploadLoop.ATTACH_WAIT_MS / 2)
            early.attach(UploadLoop.Binding(vaults = { listOf("v1") }, doorsFor = { doors }, resubmit = {}))
            waiting.join()
            doors.settled.map { it.name } shouldBe listOf("a")

            // NO SESSION AT ALL: the report is dropped, and `reconcile` squares
            // the ledger from the gateway on the next pass.
            val never = UploadLoop(LoopUploads())
            never.settled("b", 201, null, "gw-1", "v1")
            never.afterPass("v1") shouldBe 0
        }
    }
})

private class LoopUploads(var pending: Int = 0) : BackgroundUploads {
    val enqueued = mutableListOf<List<HandoffPart>>()

    override fun enqueue(batch: List<HandoffPart>) {
        enqueued += batch
    }

    override fun pending(): Int = pending

    override fun cancelAll() = Unit
}

private class LoopDoors(
    private val probe: LedgerChange? = LedgerChange(confirmed = 0, requeued = 0, reachable = true),
    private val batch: List<HandoffPart> = emptyList(),
) : UploadDoors {
    val calls = mutableListOf<String>()
    val settled = mutableListOf<Settled>()

    override suspend fun reconcile(): LedgerChange? {
        calls += "reconcile"
        return probe
    }

    override suspend fun handoff(maxBytes: Long, maxParts: Int): List<HandoffPart>? {
        calls += "handoff($maxBytes, $maxParts)"
        return batch
    }

    override suspend fun settle(settled: List<Settled>): LedgerChange? {
        this.settled += settled
        return LedgerChange(confirmed = settled.size, requeued = 0)
    }
}
