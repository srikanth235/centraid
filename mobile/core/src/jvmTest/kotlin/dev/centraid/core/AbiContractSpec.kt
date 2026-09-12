@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package dev.centraid.core

import app.cash.turbine.test
import centraid.core.v1.Envelope
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import java.io.File
import java.util.concurrent.Executors
import kotlin.time.Duration.Companion.seconds

/**
 * The ABI contract, from the Kotlin side (#1020, D-1020-E2;
 * `crates/core-ffi/CONTRACT.md`).
 *
 * Ten clauses are tested in Rust, through the C entry points. What is tested
 * here is the half those tests cannot reach: that the BINDING keeps the
 * caller's end of each clause. Clause 1's `free`-for-every-buffer is an
 * obligation of this side; clause 6's "a timeout allocates nothing" is a
 * `defer { free }` this side must not write; clause 8's typed error has to
 * arrive at a screen as a value.
 */
class AbiContractSpec : StringSpec({

    "the status codes are the committed header's" {
        // A copy that is checked rather than trusted. `CoreStatus` is written
        // out in `commonMain` because JNA reads no header at all and cinterop
        // reads one only on Apple hosts — two spellings of five numbers would
        // be two answers on two platforms.
        val header = File(
            System.getProperty("centraid.core.headerPath")
                ?: error("centraid.core.headerPath is unset; see mobile/core/build.gradle.kts"),
        )
        header.exists().shouldBeTrue()
        val defines = Regex("""#define CENTRAID_([A-Z_]+) (-?\d+)""")
            .findAll(header.readText())
            .associate { it.groupValues[1] to it.groupValues[2].toInt() }
        defines shouldBe mapOf(
            "OK" to 0,
            "BAD_ARGUMENT" to -1,
            "MALFORMED" to -2,
            "CLOSED" to -3,
            "PANICKED" to -4,
            "TIMEOUT" to -5,
        )
        CoreStatus.entries.associate { it.name to it.code } shouldBe defines
    }

    "an undefined status code is its own failure and never the nearest known one" {
        // A core one version ahead of a shell that invented a sixth code must
        // not have it read as CLOSED.
        CoreStatus.of(-6) shouldBe null
        val core = CentraidCore.overAbi(
            FakeCentraidAbi { AbiAnswer(null, -6, null) },
            Dispatchers.Default,
            UI_THREAD,
        )
        core.call(hello()) shouldBe CoreOutcome.Failed(CoreFailure.UnknownStatus(-6))
        core.close()
    }

    "clause 9: a panic poisons the handle, and the FIRST diagnostic id is the one kept" {
        val abi = FakeCentraidAbi { FakeCentraidAbi.panicked("diag-first") }
        val core = CentraidCore.overAbi(abi, Dispatchers.Default, UI_THREAD)
        core.call(hello()) shouldBe CoreOutcome.Failed(CoreFailure.Poisoned("diag-first"))
        core.lifecycle.value shouldBe CoreLifecycle.Poisoned("diag-first")

        // A later panic is a symptom of running on poisoned state; overwriting
        // would lose the cause. The fake would report a second id and does not
        // get to: the call never reaches the ABI once the handle is poisoned.
        val second = CentraidCore.overAbi(
            FakeCentraidAbi { FakeCentraidAbi.panicked("diag-second") },
            Dispatchers.Default,
            UI_THREAD,
        )
        second.call(hello())
        second.call(hello()) shouldBe CoreOutcome.Failed(CoreFailure.Poisoned("diag-second"))
        second.lifecycle.value shouldBe CoreLifecycle.Poisoned("diag-second")
        core.close()
        second.close()
    }

    "clause 7: close unblocks the reader with the terminal answer" {
        val abi = FakeCentraidAbi { FakeCentraidAbi.ok(Envelope(request_id = 1)) }
        val core = CentraidCore.overAbi(abi, Dispatchers.Default, UI_THREAD)
        // THE READER STARTS INSIDE THE SUBSCRIPTION, always. `events` is a
        // `SharedFlow` with `replay = 0`, so an event emitted before anyone
        // collects is not buffered — it is gone. That is correct for a screen
        // stream (a state nobody is rendering is not worth replaying) and it is
        // a trap for a test, which is why every spec here subscribes first.
        lateinit var reader: kotlinx.coroutines.Job
        core.events.test(timeout = 10.seconds) {
            reader = core.startReader(timeoutMs = 20)
            abi.offer(FakeCentraidAbi.stalled(depth = 7))
            awaitItem().health?.queue_depth shouldBe 7
        }
        core.close()
        withTimeout(5.seconds) { reader.join() }
        core.lifecycle.value shouldBe CoreLifecycle.Closed
    }

    "clause 8: a call after close is a typed value, not an exception and not a hang" {
        val core = CentraidCore.overAbi(
            FakeCentraidAbi { FakeCentraidAbi.ok(Envelope(request_id = 1)) },
            Dispatchers.Default,
            UI_THREAD,
        )
        core.close()
        core.call(hello()) shouldBe CoreOutcome.Failed(CoreFailure.Closed)
    }

    "clause 5: nothing is dropped, and every event arrives in order" {
        // The core's queue drops nothing and reports `HealthEvent{stalled}`. A
        // DROP_OLDEST buffer on this side would swallow the very backpressure
        // the core is trying to report, and the screen would stay wrong until
        // something else happened to touch the same row, which may be never.
        val abi = FakeCentraidAbi { FakeCentraidAbi.ok(Envelope(request_id = 1)) }
        val core = CentraidCore.overAbi(abi, Dispatchers.Default, UI_THREAD)
        val emitted = CentraidCore.EVENT_BUFFER + 16
        val seen = mutableListOf<Int>()
        core.events.test(timeout = 60.seconds) {
            core.startReader(timeoutMs = 20)
            repeat(emitted) { abi.offer(FakeCentraidAbi.stalled(depth = it)) }
            while (seen.size < emitted) {
                seen += awaitItem().health?.queue_depth ?: -1
            }
        }
        seen shouldBe List(emitted) { it }
        core.close()
    }

    "clause 5: a stalled consumer PARKS the reader instead of draining and dropping" {
        // The claim the buffer configuration actually makes. A collector that
        // never resumes must stop the reader once the buffer is full — so the
        // core's own queue fills, and the core is the one that reports the
        // stall. If the flow dropped instead, the reader would keep draining
        // and `handedOver` would reach everything offered.
        val abi = FakeCentraidAbi { FakeCentraidAbi.ok(Envelope(request_id = 1)) }
        val core = CentraidCore.overAbi(abi, Dispatchers.Default, UI_THREAD)
        val offered = CentraidCore.EVENT_BUFFER + 200
        val arrived = java.util.concurrent.CountDownLatch(1)
        val collector = kotlinx.coroutines.GlobalScope.launch(Dispatchers.Default) {
            core.events.collect {
                arrived.countDown()
                // Never resumes. This is the stalled consumer.
                kotlinx.coroutines.awaitCancellation()
            }
        }
        try {
            core.startReader(timeoutMs = 20)
            repeat(offered) { abi.offer(FakeCentraidAbi.stalled(depth = it)) }
            arrived.await(10, java.util.concurrent.TimeUnit.SECONDS).shouldBeTrue()
            // Let the reader run as far as it can, then look.
            Thread.sleep(1_500)
            val handedOver = core.buffersHandedOver
            (handedOver < offered.toLong()).shouldBeTrue()
            // One in the collector, the buffer's worth parked, and one in the
            // reader's hand waiting to be emitted.
            (handedOver <= CentraidCore.EVENT_BUFFER + 3L).shouldBeTrue()
            core.buffersFreed shouldBe handedOver
        } finally {
            collector.cancel()
            core.close()
        }
    }

    "clause 1: every buffer the binding is handed is freed, on every path" {
        val abi = FakeCentraidAbi { FakeCentraidAbi.ok(Envelope(request_id = 1)) }
        val core = CentraidCore.overAbi(abi, Dispatchers.Default, UI_THREAD)
        repeat(200) { core.call(hello()) }
        core.buffersHandedOver shouldBe 200L
        core.buffersFreed shouldBe core.buffersHandedOver
        core.close()
    }

    "the UI-thread assertion fires on a core whose dispatcher IS the UI thread" {
        // THE REALISTIC BUG (census §E seam 10): a shell hands `Dispatchers.Main`
        // to the core because `call` looked thread-agnostic. `call` hops to its
        // dispatcher before touching the ABI, so a correctly-configured core can
        // never be on the UI thread — which is why the assertion has to catch
        // the MISCONFIGURED one, and why the test constructs exactly that.
        val uiExecutor = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, UI_THREAD)
        }
        try {
            val uiDispatcher = uiExecutor.asCoroutineDispatcher()
            val core = CentraidCore.overAbi(
                FakeCentraidAbi { FakeCentraidAbi.ok(Envelope(request_id = 1)) },
                uiDispatcher,
                UI_THREAD,
            )
            val thrown = runCatching { core.call(hello()) }.exceptionOrNull()
            (thrown is UiThreadCallError).shouldBeTrue()
            thrown!!.message!! shouldContain "centraid_call was invoked on the UI thread"
            thrown.message!! shouldContain "on a device this is the freeze"
        } finally {
            uiExecutor.shutdownNow()
        }
    }

    "a call off the UI thread is not asserted" {
        val core = CentraidCore.overAbi(
            FakeCentraidAbi { FakeCentraidAbi.ok(Envelope(request_id = 1)) },
            Dispatchers.Default,
            UI_THREAD,
        )
        withContext(Dispatchers.IO) {
            core.call(hello()) shouldBe CoreOutcome.Answered(Envelope(request_id = 1))
        }
        core.close()
    }

    "an event that is not an Event body is skipped rather than ending the stream" {
        val abi = FakeCentraidAbi { FakeCentraidAbi.ok(Envelope(request_id = 1)) }
        val core = CentraidCore.overAbi(abi, Dispatchers.Default, UI_THREAD)
        core.events.test(timeout = 10.seconds) {
            core.startReader(timeoutMs = 20)
            abi.offerRaw(AbiAnswer(CoreStatus.OK, 0, byteArrayOf(0xff.toByte(), 0xff.toByte())))
            abi.offer(FakeCentraidAbi.stalled(depth = 3))
            awaitItem().health?.queue_depth shouldBe 3
        }
        core.close()
    }
}) {
    companion object {
        const val UI_THREAD: String = "centraid-ui"

        fun hello(): Envelope = Envelope(
            request_id = 0,
            request = centraid.core.v1.Request(hello = CentraidCore.localHello()),
        )
    }
}
