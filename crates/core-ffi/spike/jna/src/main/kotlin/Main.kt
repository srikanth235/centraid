package dev.centraid.spike

import com.sun.jna.Library
import com.sun.jna.Native
import com.sun.jna.Pointer
import com.sun.jna.PointerType
import com.sun.jna.ptr.PointerByReference
import java.io.File

/**
 * The JVM half of the binding spike, host side (#1020, D-1020-D2-7).
 *
 * Measures the same thing `spike/spike.c` measures — ten thousand bounded reads
 * across the C ABI — through JNA, so the two numbers are comparable and the
 * *marshalling* cost of the JVM binding is visible on its own.
 *
 * **These are `ci-linux-x64-4c` numbers.** The device half (JNA on Android,
 * cinterop on iOS, the Swift wrapper) is wave 3 lane E's and is an owner
 * hand-off; there is no device here.
 *
 * ## The one thing this file exists to prove about the shape
 *
 * A shell must be able to free what the library allocated, and JNA's natural
 * idiom is [Pointer.getByteArray] followed by the library's own free. That works
 * only because the ABI hands back a pointer *and* a length as separate
 * out-parameters. An ABI that returned a struct, or that expected the caller to
 * `strlen` the answer, would need a JNA `Structure` with a hand-maintained
 * field layout — which is the thing that goes wrong silently on one ABI and not
 * another. Five symbols and two out-parameters is the shape that avoids it.
 */

/** An opaque handle. A [PointerType] so Kotlin cannot confuse it with a buffer. */
class Handle : PointerType()

private interface Centraid : Library {
    fun centraid_open(config: ByteArray, len: Long, out: PointerByReference): Int

    fun centraid_call(
        handle: Pointer?,
        req: ByteArray,
        len: Long,
        outBuf: PointerByReference,
        outLen: com.sun.jna.ptr.LongByReference,
    ): Int

    fun centraid_next_event(
        handle: Pointer?,
        timeoutMs: Int,
        outBuf: PointerByReference,
        outLen: com.sun.jna.ptr.LongByReference,
    ): Int

    fun centraid_free(buf: Pointer?, len: Long)

    fun centraid_close(handle: Pointer?): Int
}

private const val CENTRAID_OK = 0
private const val CENTRAID_TIMEOUT = -5
private const val CALLS = 10_000

private fun percentile(sorted: LongArray, fraction: Double): Long {
    if (sorted.isEmpty()) return 0
    val rank = (fraction * sorted.size).toInt().coerceIn(0, sorted.size - 1)
    return sorted[rank]
}

fun main() {
    val libraryDir = System.getenv("CENTRAID_LIB_DIR")
        ?: error("CENTRAID_LIB_DIR must name the directory holding libcentraid_core_ffi.so")
    val vaultPath = System.getenv("CENTRAID_VAULT")
        ?: error("CENTRAID_VAULT must name the vault file to open")
    val requestPath = System.getenv("CENTRAID_REQUEST")
        ?: error("CENTRAID_REQUEST must name a file holding one encoded Envelope")

    // `jna.library.path` rather than an absolute load, so the same harness runs
    // against a debug and a release artifact without a code change.
    System.setProperty("jna.library.path", libraryDir)
    val library = Native.load("centraid_core_ffi", Centraid::class.java)

    val request = File(requestPath).readBytes()
    require(request.isNotEmpty()) { "$requestPath is empty" }

    // --- open ---------------------------------------------------------------

    val config = """{"path":"$vaultPath","role":"gateway","create":true}"""
        .toByteArray(Charsets.UTF_8)
    val handleRef = PointerByReference()
    val openStarted = System.nanoTime()
    val openCode = library.centraid_open(config, config.size.toLong(), handleRef)
    val openMs = (System.nanoTime() - openStarted) / 1_000_000.0
    check(openCode == CENTRAID_OK) { "centraid_open failed: $openCode" }
    val handle: Pointer = handleRef.value ?: error("centraid_open returned a null handle")

    try {
        // --- warm up, unmeasured -------------------------------------------
        //
        // The first calls pay for JNA's method-handle setup and the JIT's first
        // look at this loop. Measuring them would measure the JVM starting.
        repeat(500) {
            val buf = PointerByReference()
            val len = com.sun.jna.ptr.LongByReference()
            val code = library.centraid_call(handle, request, request.size.toLong(), buf, len)
            check(code == CENTRAID_OK) { "warm-up call failed: $code" }
            library.centraid_free(buf.value, len.value)
        }

        // --- ten thousand bounded reads ------------------------------------

        val samples = LongArray(CALLS)
        var totalBytes = 0L
        val loopStarted = System.nanoTime()
        for (index in 0 until CALLS) {
            val buf = PointerByReference()
            val len = com.sun.jna.ptr.LongByReference()
            val started = System.nanoTime()
            val code = library.centraid_call(handle, request, request.size.toLong(), buf, len)
            samples[index] = System.nanoTime() - started
            check(code == CENTRAID_OK) { "call $index failed: $code" }
            // THE ANSWER IS READ. A spike that only freed the buffer would
            // measure a call whose bytes never crossed into the JVM, and the
            // copy across that boundary is exactly what a JVM binding costs.
            val bytes = buf.value.getByteArray(0, len.value.toInt())
            totalBytes += bytes.size
            library.centraid_free(buf.value, len.value)
        }
        val loopMs = (System.nanoTime() - loopStarted) / 1_000_000.0
        samples.sort()

        // --- drain the event queue -----------------------------------------
        //
        // Zero events is the expected answer: nothing in this harness produces
        // any. What it measures is that the timeout path costs nothing and
        // allocates nothing (CONTRACT.md clause 6) — a `free` here would be the
        // bug the clause exists to prevent, and its absence is the test.

        var events = 0
        val drainStarted = System.nanoTime()
        while (true) {
            val buf = PointerByReference()
            val len = com.sun.jna.ptr.LongByReference()
            val code = library.centraid_next_event(handle, 1, buf, len)
            if (code == CENTRAID_TIMEOUT) break
            if (code != CENTRAID_OK) break
            events++
            library.centraid_free(buf.value, len.value)
            if (events >= 100_000) break
        }
        val drainMs = (System.nanoTime() - drainStarted) / 1_000_000.0

        println(
            """
            {
              "harness": "jna",
              "hardware": "ci-linux-x64-4c",
              "jvm": "${System.getProperty("java.version")}",
              "jna": "${com.sun.jna.Native.VERSION}",
              "openMs": ${"%.3f".format(openMs)},
              "calls": $CALLS,
              "p50Us": ${"%.2f".format(percentile(samples, 0.50) / 1000.0)},
              "p95Us": ${"%.2f".format(percentile(samples, 0.95) / 1000.0)},
              "p99Us": ${"%.2f".format(percentile(samples, 0.99) / 1000.0)},
              "callsPerSecond": ${"%.0f".format(if (loopMs > 0) CALLS * 1000.0 / loopMs else 0.0)},
              "answerBytesMean": ${"%.0f".format(totalBytes.toDouble() / CALLS)},
              "events": $events,
              "eventsPerSecond": ${"%.0f".format(if (drainMs > 0) events * 1000.0 / drainMs else 0.0)}
            }
            """.trimIndent()
        )
    } finally {
        // The handle is closed even on a failure: a spike that leaked a SQLite
        // handle on every crashing run would leave WAL files behind and the
        // next run would measure a different file.
        library.centraid_close(handle)
    }
}
