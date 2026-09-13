@file:OptIn(ExperimentalForeignApi::class, kotlin.concurrent.atomics.ExperimentalAtomicApi::class)

package dev.centraid.core

import dev.centraid.core.cinterop.Handle
import dev.centraid.core.cinterop.centraid_call
import dev.centraid.core.cinterop.centraid_close
import dev.centraid.core.cinterop.centraid_free
import dev.centraid.core.cinterop.centraid_next_event
import dev.centraid.core.cinterop.centraid_open
import kotlinx.cinterop.CPointer
import kotlinx.cinterop.CPointerVar
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.UByteVar
import kotlinx.cinterop.alloc
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.ptr
import kotlinx.cinterop.readBytes
import kotlinx.cinterop.reinterpret
import kotlinx.cinterop.usePinned
import kotlinx.cinterop.value
import platform.Foundation.NSThread
import platform.posix.size_tVar
import kotlin.concurrent.atomics.AtomicBoolean
import kotlin.concurrent.atomics.AtomicLong

/**
 * iOS's actual: cinterop over the same five symbols (#1020, D-1020-E2).
 *
 * **THIS FILE IS NOT COMPILED IN CI TODAY.** Kotlin/Native's iOS targets need a
 * macOS host, and `cargo xtask gate`'s `mobile-jvm` step runs on Linux. What
 * proves it is the owner hand-off in `mobile/README.md`
 * (`./gradlew :shared:linkDebugFrameworkIosSimulatorArm64`), and the risk of an
 * unbuilt actual is named in the receipt rather than hidden behind a green JVM
 * run. Nothing above `:core` can tell the two actuals apart, which is the point
 * of `CentraidAbi`.
 *
 * ## `usePinned` and clause 2
 *
 * The request bytes are pinned for the duration of the call and no longer,
 * which is exactly what `CONTRACT.md` clause 2 permits: "a Swift
 * `withUnsafeBytes` closure may end" the instant the call returns. A
 * `ByteArray` handed to the core outside a `usePinned` block would be a pointer
 * the Kotlin/Native garbage collector is free to move.
 *
 * ## `readBytes` and clause 1
 *
 * The answer is COPIED with `readBytes` and then released with `centraid_free`
 * — never wrapped in a `Data(bytesNoCopy:)` with a deallocator, which
 * `CONTRACT.md` clause 1 names as the mistake to avoid: Rust's allocator is not
 * the C one.
 */
internal class CinteropCentraidAbi(
    private var handle: CPointer<Handle>?,
) : CentraidAbi {
    private val handedOverCount = AtomicLong(0)
    private val freedCount = AtomicLong(0)
    private val copiedBytes = AtomicLong(0)
    private val closed = AtomicBoolean(false)

    override val accounting: AbiAccounting = object : AbiAccounting {
        override val handedOver: Long get() = handedOverCount.load()
        override val freed: Long get() = freedCount.load()
        override val bytesCopied: Long get() = copiedBytes.load()
    }

    override fun call(request: ByteArray): AbiAnswer = memScoped {
        val outBuffer = alloc<CPointerVar<UByteVar>>()
        val outLength = alloc<size_tVar>()
        val code = request.usePinned { pinned ->
            centraid_call(
                handle,
                if (request.isEmpty()) null else pinned.addressOf(0).reinterpret(),
                request.size.convertToSize(),
                outBuffer.ptr,
                outLength.ptr,
            )
        }
        harvest(code, outBuffer.value, outLength.value.toLong())
    }

    override fun nextEvent(timeoutMs: Int): AbiAnswer = memScoped {
        val outBuffer = alloc<CPointerVar<UByteVar>>()
        val outLength = alloc<size_tVar>()
        val code = centraid_next_event(
            handle,
            timeoutMs.toUInt(),
            outBuffer.ptr,
            outLength.ptr,
        )
        harvest(code, outBuffer.value, outLength.value.toLong())
    }

    override fun close(): CoreStatus {
        if (!closed.compareAndSet(expectedValue = false, newValue = true)) return CoreStatus.CLOSED
        val code = centraid_close(handle)
        handle = null
        return CoreStatus.of(code) ?: CoreStatus.CLOSED
    }

    private fun harvest(
        code: Int,
        pointer: CPointer<UByteVar>?,
        length: Long,
    ): AbiAnswer {
        val status = CoreStatus.of(code)
        if (pointer == null || status == CoreStatus.TIMEOUT) return AbiAnswer(status, code, null)
        return try {
            val bytes = pointer.readBytes(length.toInt())
            handedOverCount.fetchAndAdd(1)
            copiedBytes.fetchAndAdd(length)
            AbiAnswer(status, code, bytes)
        } finally {
            centraid_free(pointer, length.convertToSize())
            freedCount.fetchAndAdd(1)
        }
    }
}

internal actual fun openCentraidAbi(config: String, uiThreadName: String): AbiOpen = memScoped {
    val bytes = config.encodeToByteArray()
    val out = alloc<CPointerVar<Handle>>()
    val code = bytes.usePinned { pinned ->
        centraid_open(
            pinned.addressOf(0).reinterpret(),
            bytes.size.convertToSize(),
            out.ptr,
        )
    }
    val status = CoreStatus.of(code)
    if (status != CoreStatus.OK) {
        return@memScoped AbiOpen.Refused(
            when (status) {
                CoreStatus.BAD_ARGUMENT -> CoreFailure.BadArgument(
                    "centraid_open refused the configuration JSON",
                )
                CoreStatus.MALFORMED -> CoreFailure.Malformed(
                    "centraid_open could not read the configuration JSON",
                )
                CoreStatus.PANICKED -> CoreFailure.Poisoned("open")
                else -> CoreFailure.UnknownStatus(code)
            },
        )
    }
    val handle = out.value
        ?: return@memScoped AbiOpen.Refused(
            CoreFailure.Malformed("centraid_open returned OK and a null handle"),
        )
    AbiOpen.Opened(CinteropCentraidAbi(handle))
}

/**
 * iOS ASKS `NSThread`, not a name.
 *
 * `uiThreadName` is still carried into the core's configuration so a core-side
 * diagnostic can name the thread, but the assertion here does not read it: on
 * Apple platforms the main thread is a platform fact and not a string.
 */
internal actual fun assertNotOnUiThread(operation: String, uiThreadName: String) {
    if (NSThread.isMainThread()) {
        throw UiThreadCallError(NSThread.currentThread.name ?: "main")
    }
}

/**
 * `size_t` is 64-bit on every Apple target Centraid ships to (arm64 and
 * x86_64 simulators), so this is a widening conversion and not a truncation.
 * Written as one function so the claim lives in one place.
 */
private fun Int.convertToSize(): platform.posix.size_t = toULong()
