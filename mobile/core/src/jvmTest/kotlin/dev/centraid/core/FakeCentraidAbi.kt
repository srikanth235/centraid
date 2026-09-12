@file:OptIn(kotlin.concurrent.atomics.ExperimentalAtomicApi::class)

package dev.centraid.core

import centraid.core.v1.Envelope
import centraid.core.v1.Error
import centraid.core.v1.ErrorCode
import centraid.core.v1.Event
import centraid.core.v1.HealthEvent
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.atomics.AtomicLong

/**
 * A fake ABI, for the cases the real one cannot be asked to produce.
 *
 * WHY A FAKE AT ALL, when there is a real `libcentraid_core_ffi.so` on this
 * machine: `crates/core-ffi` has **no fault-injection point**. Its own clause-9
 * test says so — "a real panic inside a `call` would need a fault injection
 * point the ABI does not have" — and drives `Handle::poison` directly, which is
 * a Rust-side call no shell can make. So the binding's handling of `PANICKED`,
 * of an undefined status code, and of a full event queue is proved here, and
 * `contracts/handoff/E/findings.md` carries the patch that would let the real
 * library produce them (a `debug-fault` feature behind an `Admin` request, with
 * no sixth symbol).
 *
 * Everything the real library CAN be asked to do is tested against the real
 * library in [AbiRoundTripSpec]. A fake that shadowed a reachable case would be
 * a test of this file.
 */
internal class FakeCentraidAbi(
    private val answer: (ByteArray) -> AbiAnswer,
) : CentraidAbi {
    private val handedOverCount = AtomicLong(0)
    private val freedCount = AtomicLong(0)
    private val copied = AtomicLong(0)
    private val events = LinkedBlockingQueue<AbiAnswer>()

    var closes: Int = 0
        private set

    override val accounting: AbiAccounting = object : AbiAccounting {
        override val handedOver: Long get() = handedOverCount.load()
        override val freed: Long get() = freedCount.load()
        override val bytesCopied: Long get() = copied.load()
    }

    override fun call(request: ByteArray): AbiAnswer = answer(request).also { record(it) }

    override fun nextEvent(timeoutMs: Int): AbiAnswer {
        val next = events.poll(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
            ?: return AbiAnswer(CoreStatus.TIMEOUT, CoreStatus.TIMEOUT.code, null)
        record(next)
        return next
    }

    override fun close(): CoreStatus {
        closes++
        events.put(AbiAnswer(CoreStatus.CLOSED, CoreStatus.CLOSED.code, null))
        return CoreStatus.OK
    }

    fun offer(event: Event) {
        events.put(ok(Envelope(request_id = 0, event = event)))
    }

    fun offerRaw(answer: AbiAnswer) {
        events.put(answer)
    }

    private fun record(answer: AbiAnswer) {
        val bytes = answer.bytes ?: return
        handedOverCount.fetchAndAdd(1)
        copied.fetchAndAdd(bytes.size.toLong())
        // The fake frees in the same breath it copies, exactly as
        // `JnaCentraidAbi.harvest`'s `finally` does.
        freedCount.fetchAndAdd(1)
    }

    companion object {
        fun ok(envelope: Envelope): AbiAnswer =
            AbiAnswer(CoreStatus.OK, CoreStatus.OK.code, envelope.encode())

        fun panicked(diagnosticId: String): AbiAnswer = AbiAnswer(
            CoreStatus.PANICKED,
            CoreStatus.PANICKED.code,
            Envelope(
                request_id = 0,
                error = Error(
                    code = ErrorCode.ERROR_CODE_INTERNAL,
                    detail = "a panic was caught",
                    diagnostic_id = diagnosticId,
                ),
            ).encode(),
        )

        fun stalled(depth: Int): Event = Event(
            health = HealthEvent(
                stalled = true,
                queue_depth = depth,
                capacity = CentraidCore.EVENT_BUFFER,
                behind = depth.toLong(),
            ),
        )
    }
}
