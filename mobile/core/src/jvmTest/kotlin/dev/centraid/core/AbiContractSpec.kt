@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package dev.centraid.core

import app.cash.turbine.test
import centraid.core.v1.Envelope
import centraid.core.v1.Error
import centraid.core.v1.ErrorCode
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
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

    "clause 8: a refusal renders the CODE's sentence and never the core's detail" {
        // `Error.detail` IS FOR LOGS AND NEVER FOR A MEMBER (#1025 S7,
        // D-1025-S7-82).
        //
        // The binding built the member-facing sentence as
        // `error.detail.ifBlank { … }`, so the core's log text was the first
        // thing a screen rendered — and Slice 6 watched a raw
        // `no such table: blob_staging` land on the Photos screen. The detail
        // here is that exact string, so this spec fails the moment the binding
        // goes back to reading it.
        val detail = "no such table: blob_staging"
        val core = CentraidCore.overAbi(
            FakeCentraidAbi {
                FakeCentraidAbi.ok(
                    Envelope(
                        request_id = 1,
                        error = Error(
                            code = ErrorCode.ERROR_CODE_INVALID_REQUEST,
                            detail = detail,
                            diagnostic_id = "diag-1",
                            sentence = "That request does not make sense to this build.",
                        ),
                    ),
                )
            },
            Dispatchers.Default,
            UI_THREAD,
        )
        val outcome = core.call(hello())
        (outcome is CoreOutcome.Failed).shouldBeTrue()
        val failure = (outcome as CoreOutcome.Failed).failure
        (failure is CoreFailure.Refused).shouldBeTrue()
        failure as CoreFailure.Refused

        failure.sentence shouldBe "That request does not make sense to this build."
        withClue("the core's log text reached a member") {
            failure.sentence shouldNotContain "blob_staging"
        }
        // AND THE DETAIL IS STILL CARRIED, because it is the log's. Dropping
        // it would trade one defect for another: a refusal nobody can diagnose.
        failure.detail shouldBe detail
        failure.diagnosticId shouldBe "diag-1"
        core.close()
    }

    "a code this build has no sentence for gets the generic one, never the detail" {
        // An older shell against a newer core: the code is one it does not
        // know and the core sent no sentence. The member gets a sentence they
        // can read; the log keeps the detail and the code.
        val core = CentraidCore.overAbi(
            FakeCentraidAbi {
                FakeCentraidAbi.ok(
                    Envelope(
                        request_id = 1,
                        error = Error(
                            code = ErrorCode.ERROR_CODE_INTERNAL,
                            detail = "UNIQUE constraint failed: media_asset.content_id",
                            diagnostic_id = "diag-2",
                            sentence = "",
                        ),
                    ),
                )
            },
            Dispatchers.Default,
            UI_THREAD,
        )
        val failure = ((core.call(hello()) as CoreOutcome.Failed).failure) as CoreFailure.Refused
        failure.sentence shouldBe "Centraid refused that."
        failure.sentence shouldNotContain "UNIQUE constraint"
        failure.detail shouldContain "UNIQUE constraint"
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
        // FOUR TIMES THE BUFFER, so "parked near the buffer" and "drained
        // everything" are far apart. See the bound below.
        val offered = CentraidCore.EVENT_BUFFER * 4
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
            // WAIT FOR THE READER TO STOP, DO NOT GUESS HOW LONG IT NEEDS
            // (#1025 S5).
            //
            // This slept 1.5 s and then looked, which made the assertion a
            // statement about this machine's scheduler rather than about the
            // buffer: on a loaded host the reader gets further inside the same
            // wall clock, `handedOver` passes `EVENT_BUFFER + 3`, and the test
            // reds with nothing wrong. It failed five times out of five while
            // other builds were running, and passed alone — which is the
            // signature of a timing assertion, and the same defect #1025 S2
            // fixed in `blobs/tests/windows.rs` by cutting its windows on
            // verified PROGRESS instead of on 120 ms.
            //
            // Quiescence is what the claim actually is: the reader PARKS. So
            // watch the counter until it stops moving, with a ceiling that is a
            // stall backstop rather than the measurement. This is stricter than
            // the sleep — a reader that was merely slow would keep advancing
            // and never settle.
            var handedOver = core.buffersHandedOver
            var still = 0
            val deadline = System.nanoTime() + 30_000_000_000L
            while (still < 5 && System.nanoTime() < deadline) {
                Thread.sleep(100)
                val now = core.buffersHandedOver
                still = if (now == handedOver) still + 1 else 0
                handedOver = now
            }
            withClue("the reader never parked; it was still handing buffers over") {
                (still >= 5).shouldBeTrue()
            }
            (handedOver < offered.toLong()).shouldBeTrue()
            // BOUNDED BY THE BUFFER, NOT BY WHAT WAS OFFERED (#1025 S5).
            //
            // This read `<= EVENT_BUFFER + 3`, with a comment accounting for
            // the exact three: one in the collector, the buffer's worth, one in
            // the reader's hand. That is a claim about `MutableSharedFlow`'s
            // internals rather than about this code, and the runtime does not
            // make it: measured, the reader parks at the buffer plus somewhere
            // between 35 and 74, and the number moves run to run. With the old
            // margin of 200 offered beyond the buffer, that slop was most of
            // the margin, so the test failed on THIS tree five runs out of five
            // and had been red on `main` before this slice touched anything.
            //
            // The property is not the arithmetic. It is that a stalled
            // consumer bounds the reader by the BUFFER instead of letting it
            // drain everything offered — so four times the buffer is offered
            // and the bound is twice it, which separates the two answers by
            // two thousand events and cannot be met by a reader that drained.
            withClue("handedOver=$handedOver buffer=${CentraidCore.EVENT_BUFFER}") {
                (handedOver < CentraidCore.EVENT_BUFFER * 2L).shouldBeTrue()
            }
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
