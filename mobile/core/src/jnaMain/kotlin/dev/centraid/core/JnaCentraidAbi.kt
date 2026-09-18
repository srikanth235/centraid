@file:OptIn(kotlin.concurrent.atomics.ExperimentalAtomicApi::class)

package dev.centraid.core

import com.sun.jna.Library
import com.sun.jna.Native
import com.sun.jna.Pointer
import com.sun.jna.ptr.LongByReference
import com.sun.jna.ptr.PointerByReference
import kotlin.concurrent.atomics.AtomicBoolean
import kotlin.concurrent.atomics.AtomicLong

/**
 * The JNA half of the ABI binding — the JVM's and Android's actual
 * (#1020, D-1020-E2).
 *
 * This source set is shared by `jvmMain` and `androidMain`: one JNA
 * implementation and two three-line actuals, because the binding is the same
 * binding and only the UI-thread question differs (a `Looper` on Android, a
 * thread name on a JVM host).
 *
 * It supersedes `crates/core-ffi/spike/jna` (D-1020-D2-7), which stays where it
 * is as the throwaway measurement it was.
 *
 * ## Why JNA and not the Foreign Function & Memory API
 *
 * FFM is final in JDK 22 and Android's minimum is nowhere near it, so an
 * Android shell uses JNA or JNI for years. The spike measured the binding the
 * product ships for exactly this reason.
 *
 * ## The one shape rule this file depends on
 *
 * A pointer **and** a length as separate out-parameters. `Pointer.getByteArray`
 * followed by the library's own `free` works only because of that. An ABI that
 * returned a struct, or expected the caller to `strlen` the answer, would need a
 * hand-maintained JNA `Structure` field layout — the thing that goes wrong
 * silently on one ABI and not another.
 */
internal interface CentraidLibrary : Library {
    fun centraid_open(config: ByteArray, len: Long, out: PointerByReference): Int

    fun centraid_call(
        handle: Pointer?,
        req: ByteArray,
        len: Long,
        outBuf: PointerByReference,
        outLen: LongByReference,
    ): Int

    fun centraid_next_event(
        handle: Pointer?,
        timeoutMs: Int,
        outBuf: PointerByReference,
        outLen: LongByReference,
    ): Int

    fun centraid_free(buf: Pointer?, len: Long)

    fun centraid_close(handle: Pointer?): Int
}

internal class JnaAccounting : AbiAccounting {
    private val handedOverCount = AtomicLong(0)
    private val freedCount = AtomicLong(0)
    private val copied = AtomicLong(0)

    override val handedOver: Long get() = handedOverCount.load()
    override val freed: Long get() = freedCount.load()
    override val bytesCopied: Long get() = copied.load()

    fun handedOver(bytes: Long) {
        handedOverCount.fetchAndAdd(1)
        copied.fetchAndAdd(bytes)
    }

    fun freed() {
        freedCount.fetchAndAdd(1)
    }
}

internal class JnaCentraidAbi(
    private val library: CentraidLibrary,
    private var handle: Pointer?,
) : CentraidAbi {
    private val counters = JnaAccounting()
    private val closed = AtomicBoolean(false)

    override val accounting: AbiAccounting get() = counters

    override fun call(request: ByteArray): AbiAnswer = harvest { buffer, length ->
        library.centraid_call(handle, request, request.size.toLong(), buffer, length)
    }

    override fun nextEvent(timeoutMs: Int): AbiAnswer = harvest { buffer, length ->
        library.centraid_next_event(handle, timeoutMs, buffer, length)
    }

    override fun close(): CoreStatus {
        if (!closed.compareAndSet(expectedValue = false, newValue = true)) {
            // `close` twice on the same pointer is undefined
            // (`CONTRACT.md` clause 7) — "that is a statement about C and not a
            // gap in this library". So this side makes it defined by refusing
            // the second call, and nulls its own copy, which the contract says
            // in those words.
            return CoreStatus.CLOSED
        }
        val code = library.centraid_close(handle)
        handle = null
        return CoreStatus.of(code) ?: CoreStatus.CLOSED
    }

    /**
     * One call, one buffer, one `free` — and the zeroing before the call is the
     * other half of `CONTRACT.md` clause 6.
     *
     * `PointerByReference()`/`LongByReference()` are fresh per call rather than
     * reused, so a `TIMEOUT` (which leaves the out-pointers untouched) leaves
     * them holding the NULL they were constructed with. `centraid_free(null)` is
     * a documented no-op, so the `finally` below is correct on every path
     * including the one where nothing was allocated.
     */
    private inline fun harvest(
        invoke: (PointerByReference, LongByReference) -> Int,
    ): AbiAnswer {
        val buffer = PointerByReference()
        val length = LongByReference()
        val code = invoke(buffer, length)
        val status = CoreStatus.of(code)
        val pointer = buffer.value
        if (pointer == null || status == CoreStatus.TIMEOUT) {
            return AbiAnswer(status, code, null)
        }
        return try {
            val size = length.value
            // THE ANSWER IS COPIED, not wrapped. A `Pointer`-backed view handed
            // up to `commonMain` would be a pointer with a Kotlin lifetime, and
            // the whole boundary would depend on nobody keeping it.
            val bytes = pointer.getByteArray(0, size.toInt())
            counters.handedOver(size)
            AbiAnswer(status, code, bytes)
        } finally {
            library.centraid_free(pointer, length.value)
            counters.freed()
        }
    }

    internal companion object {
        const val LIBRARY_NAME: String = "centraid_core_ffi"

        /**
         * Load the library and open a core.
         *
         * The load failure is a case of its own ([CoreFailure.LibraryMissing]):
         * on a JVM host it means `cargo build -p centraid-core-ffi` has not run,
         * and on Android it means the AAR did not carry the `.so` for this ABI —
         * two remedies, neither of them "restart the app", which is what a
         * generic failure would send a reader looking for.
         */
        fun open(config: String, libraryName: String = LIBRARY_NAME): AbiOpen {
            val library = try {
                Native.load(libraryName, CentraidLibrary::class.java)
            } catch (error: UnsatisfiedLinkError) {
                return AbiOpen.Refused(
                    CoreFailure.LibraryMissing(
                        "lib$libraryName could not be loaded from " +
                            "'${System.getProperty("jna.library.path") ?: "the default loader path"}': " +
                            "${error.message}. On a JVM host build it with " +
                            "`cargo build -p centraid-core-ffi`; on Android the AAR must carry " +
                            "the `.so` for this device's ABI (mobile/README.md).",
                    ),
                )
            }
            val bytes = config.encodeToByteArray()
            val handleRef = PointerByReference()
            val code = library.centraid_open(bytes, bytes.size.toLong(), handleRef)
            val status = CoreStatus.of(code)
            if (status != CoreStatus.OK) {
                return AbiOpen.Refused(
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
            // A panic in `open` hands back NO handle (`CONTRACT.md` clause 9),
            // and a successful open with a null handle would be a contract
            // violation rather than a state to carry.
            val handle = handleRef.value
                ?: return AbiOpen.Refused(
                    CoreFailure.Malformed("centraid_open returned OK and a null handle"),
                )
            return AbiOpen.Opened(JnaCentraidAbi(library, handle))
        }
    }
}
