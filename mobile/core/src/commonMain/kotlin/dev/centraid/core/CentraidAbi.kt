package dev.centraid.core

/**
 * The five functions, as Kotlin sees them (#1020, D-1020-E2).
 *
 * **Bytes in, bytes out, nothing retained.** An implementation hands back a
 * Kotlin [ByteArray] that it has already copied out of the library's buffer and
 * already released with `centraid_free`. That is the whole reason this
 * interface exists rather than `CentraidCore` calling JNA and cinterop
 * directly: `free`-for-every-buffer is one rule with two spellings, and a rule
 * with two spellings is a rule that is obeyed in one place.
 *
 * `CONTRACT.md` clause 1 and clause 2 in Kotlin terms:
 *   * inputs are borrowed for the call, so a [ByteArray] argument may be
 *     reused, garbage-collected or re-pinned the moment the call returns;
 *   * outputs are **copies**, so nothing here holds a pointer past a call and
 *     there is no `Cleaner`, no finalizer and no `Data(bytesNoCopy:)`.
 */
internal interface CentraidAbi {
    /** `centraid_call`. Synchronous, reentrant, and never on the UI thread. */
    fun call(request: ByteArray): AbiAnswer

    /** `centraid_next_event`. [CoreStatus.TIMEOUT] allocates nothing. */
    fun nextEvent(timeoutMs: Int): AbiAnswer

    /** `centraid_close`. Idempotent on this side: the pointer is nulled here. */
    fun close(): CoreStatus

    /**
     * Buffers this binding was handed, and buffers it released. Equal, always.
     *
     * `crates/core-ffi` exposes no allocation counter, so this counts the
     * binding's own obligation rather than the library's heap — which is the
     * half a shell can actually get wrong. The gap is a finding
     * (`contracts/handoff/E/findings.md`) with the patch that would close it.
     */
    val accounting: AbiAccounting
}

/** One answer from across the boundary: a status, and bytes when there are any. */
internal data class AbiAnswer(val status: CoreStatus?, val rawCode: Int, val bytes: ByteArray?) {
    // `data class` over a `ByteArray` gives reference equality on `bytes`, which
    // is why nothing compares these. Declared explicitly so a future reader does
    // not add an assertion that silently means "the same array".
    override fun equals(other: Any?): Boolean = this === other

    override fun hashCode(): Int = rawCode
}

/** Buffers handed over, buffers freed, bytes copied. See [CentraidAbi.accounting]. */
internal interface AbiAccounting {
    val handedOver: Long
    val freed: Long
    val bytesCopied: Long
}

/** What a platform's `centraid_open` produced. */
internal sealed interface AbiOpen {
    data class Opened(val abi: CentraidAbi) : AbiOpen

    data class Refused(val failure: CoreFailure) : AbiOpen
}

/**
 * `centraid_open`, per platform.
 *
 * `config` is the UTF-8 JSON the ABI documents:
 * `{"path":…,"role":…,"gateway":…?,"create":…?,"uiThreadName":…?}`. JSON and
 * not protobuf because a configuration is read once at startup by a
 * human-written call site and being able to log it verbatim is worth more than
 * the encoding (`crates/core-ffi/README.md`).
 */
internal expect fun openCentraidAbi(config: String, uiThreadName: String): AbiOpen

/**
 * The UI-thread assertion, per platform (#1020 Execution model; census §E
 * seam 10).
 *
 * IN BOTH ACTUALS, not one: a `StateFlow<ByteArray>` per screen with
 * `send(ByteArray)` looks thread-agnostic and is not, and the assertion is the
 * only thing that catches a well-meaning `LaunchedEffect`. The JVM and Android
 * actuals differ — Android has a `Looper` and the JVM has a thread name — which
 * is exactly why this is `expect` and not a shared string comparison.
 */
internal expect fun assertNotOnUiThread(operation: String, uiThreadName: String)
