@file:OptIn(kotlin.concurrent.atomics.ExperimentalAtomicApi::class)

package dev.centraid.core

import centraid.core.v1.Envelope
import centraid.core.v1.Event
import centraid.core.v1.Hello
import centraid.core.v1.Request
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.concurrent.atomics.AtomicBoolean
import kotlin.jvm.JvmStatic

/** Where the shell believes the core's own file lives, and who it is. */
public data class CoreConfiguration(
    /**
     * The seat file. Named after the `(gatewayId, vaultId)` pair by
     * `dev.centraid.shared.mount.MountKey` — **never a placeholder**
     * (census §E seam 2: the literal `"manual"` named a file whose path moved
     * the moment a real endpoint arrived, orphaning every queued write).
     */
    public val databasePath: String,
    public val role: CoreRole,
    /** The gateway's endpoint id, hex. Absent only for a gateway role. */
    public val gatewayHex: String? = null,
    public val create: Boolean = false,
    /**
     * The digest this shell's own build recorded for the core it intends to
     * use. [ArtifactIdentity.DEV] means "not checked, and say so".
     */
    public val expectedDigest: String = ArtifactIdentity.DEV,
) {
    internal fun toJson(uiThreadName: String): String = buildString {
        append('{')
        append("\"path\":").append(quote(databasePath))
        append(",\"role\":").append(quote(role.wire))
        if (gatewayHex != null) append(",\"gateway\":").append(quote(gatewayHex))
        append(",\"create\":").append(create)
        append(",\"uiThreadName\":").append(quote(uiThreadName))
        append('}')
    }

    private fun quote(value: String): String = buildString {
        append('"')
        for (character in value) {
            when (character) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (character < ' ') append("\\u").append(
                    character.code.toString(16).padStart(4, '0'),
                ) else append(character)
            }
        }
        append('"')
    }
}

public enum class CoreRole(internal val wire: String) {
    GATEWAY("gateway"),
    SEAT_REPLICATED("seat-replicated"),
    SEAT_THIN("seat-thin"),
}

/** Where the handle is. There is no fourth state. */
public sealed interface CoreLifecycle {
    public data object Open : CoreLifecycle

    /** [close] was called, or the reader was handed the terminal answer. */
    public data object Closed : CoreLifecycle

    /** `CONTRACT.md` clause 9. The shell restarts the core deliberately. */
    public data class Poisoned(val diagnosticId: String) : CoreLifecycle
}

/**
 * The core, as the shell holds it (#1020, D-1020-E2).
 *
 * ## One core per device process (R-1020-24)
 *
 * [open] refuses a second handle in the same process. In v0 the rule was a
 * `<seat>.lease.json` sidecar plus `useNewConnection: true`, and **both halves
 * were needed and neither was enough** (census §E seam 1). With the core owning
 * the file the two mechanisms collapse into one — but only if nothing else in
 * the process opens a second one, which is why Share, Autofill and Widget
 * extensions never open the vault and never start iroh.
 *
 * ## Threading
 *
 * [call] is `suspend` and hops to [dispatcher] before it touches the ABI, and
 * it asserts it is not on the UI thread after the hop. Both: the hop is what
 * makes it correct and the assertion is what catches the call site that reaches
 * the ABI another way.
 *
 * ## Events
 *
 * One core-owned reader coroutine calls `next_event` in a loop and feeds
 * [events]. The flow has a bounded buffer and **suspends** rather than dropping,
 * because the core's own queue drops nothing (`CONTRACT.md` clause 5): a
 * stalled consumer must stall the reader so the core's queue fills and the core
 * reports `HealthEvent{stalled}`. A `DROP_OLDEST` buffer here would turn a
 * reportable stall into a screen that stays wrong until something else touches
 * the same row, which may be never.
 */
public class CentraidCore private constructor(
    private val abi: CentraidAbi,
    private val dispatcher: CoroutineDispatcher,
    private val uiThreadName: String,
    /** Set when [open] ran the identity check and it did not run. */
    public val identityWarning: String?,
    public val reportedIdentity: ArtifactIdentity,
) {
    private val supervisor = SupervisorJob()
    private val scope = CoroutineScope(supervisor + dispatcher)
    private val _lifecycle = MutableStateFlow<CoreLifecycle>(CoreLifecycle.Open)
    private val _events = MutableSharedFlow<Event>(
        replay = 0,
        extraBufferCapacity = EVENT_BUFFER,
        onBufferOverflow = BufferOverflow.SUSPEND,
    )

    private val readerStarted = AtomicBoolean(false)

    public val lifecycle: StateFlow<CoreLifecycle> = _lifecycle.asStateFlow()

    public val events: SharedFlow<Event> = _events.asSharedFlow()

    /** Buffers handed over and buffers freed. Equal, always. */
    public val buffersHandedOver: Long get() = abi.accounting.handedOver

    public val buffersFreed: Long get() = abi.accounting.freed

    public val bytesCopied: Long get() = abi.accounting.bytesCopied

    /**
     * One request, one answer.
     *
     * The `Error` body is turned into [CoreFailure.Refused] rather than handed
     * up as an envelope: a caller that had to re-check `body.error` on every
     * answer is a caller that will forget once.
     */
    public suspend fun call(request: Envelope): CoreOutcome<Envelope> =
        withContext(dispatcher) {
            assertNotOnUiThread("centraid_call", uiThreadName)
            when (val state = _lifecycle.value) {
                is CoreLifecycle.Closed -> return@withContext CoreOutcome.Failed(CoreFailure.Closed)
                is CoreLifecycle.Poisoned ->
                    return@withContext CoreOutcome.Failed(CoreFailure.Poisoned(state.diagnosticId))
                CoreLifecycle.Open -> Unit
            }
            interpret(abi.call(request.encode()))
        }

    /**
     * Start the one reader. Idempotent, and there is never a second: `next_event`
     * blocks on a bounded queue and two readers would interleave a change
     * stream whose order is the only thing that makes it applicable.
     */
    public fun startReader(timeoutMs: Int = READER_TIMEOUT_MS): Job {
        check(readerStarted.compareAndSet(expectedValue = false, newValue = true)) {
            "the core's reader is already running; there is exactly one"
        }
        return scope.launch(start = CoroutineStart.DEFAULT) {
            while (_lifecycle.value == CoreLifecycle.Open) {
                val answer = abi.nextEvent(timeoutMs)
                when (answer.status) {
                    CoreStatus.TIMEOUT -> continue
                    CoreStatus.OK -> {
                        val bytes = answer.bytes ?: continue
                        val envelope = runCatching { Envelope.ADAPTER.decode(bytes) }.getOrNull()
                        val event = envelope?.event ?: continue
                        // EMIT AND SUSPEND. See the class comment.
                        _events.emit(event)
                    }
                    // THE TERMINAL ANSWER (`CONTRACT.md` clause 7). Accepted
                    // events came out first; this is the end of the stream.
                    CoreStatus.CLOSED -> {
                        _lifecycle.value = CoreLifecycle.Closed
                        return@launch
                    }
                    CoreStatus.PANICKED -> {
                        _lifecycle.value = CoreLifecycle.Poisoned(diagnosticIdOf(answer.bytes))
                        return@launch
                    }
                    else -> {
                        // BAD_ARGUMENT / MALFORMED / an unknown code from the
                        // reader is a shell bug, not a core state: stop reading
                        // rather than spinning on it once per timeout.
                        _lifecycle.value = CoreLifecycle.Closed
                        return@launch
                    }
                }
            }
        }
    }

    /**
     * One `next_event`, on the caller's thread, with no reader running.
     *
     * `internal` and used by the measurement spec: the timeout path's cost is a
     * number this repository wants, and it is not reachable through
     * [startReader] without also measuring a coroutine hop and a flow emit.
     */
    internal suspend fun drainOnce(timeoutMs: Int): CoreStatus? =
        withContext(dispatcher) { abi.nextEvent(timeoutMs).status }

    /** Close the core. Unblocks the reader with the terminal answer. */
    public fun close() {
        if (_lifecycle.value == CoreLifecycle.Closed) return
        abi.close()
        _lifecycle.value = CoreLifecycle.Closed
        supervisor.cancel()
        openHandles.release()
    }

    private fun interpret(answer: AbiAnswer): CoreOutcome<Envelope> {
        val status = answer.status
            ?: return CoreOutcome.Failed(CoreFailure.UnknownStatus(answer.rawCode))
        return when (status) {
            CoreStatus.OK -> {
                val bytes = answer.bytes
                    ?: return CoreOutcome.Failed(
                        CoreFailure.Malformed("the ABI reported OK with no buffer"),
                    )
                val envelope = runCatching { Envelope.ADAPTER.decode(bytes) }.getOrNull()
                    ?: return CoreOutcome.Failed(
                        CoreFailure.Malformed("${bytes.size} bytes that are not an Envelope"),
                    )
                val error = envelope.error
                if (error != null) {
                    CoreOutcome.Failed(
                        CoreFailure.Refused(
                            code = error.code.value,
                            detail = error.detail,
                            diagnosticId = error.diagnostic_id,
                            sentence = error.detail.ifBlank { "Centraid refused that." },
                        ),
                    )
                } else {
                    CoreOutcome.Answered(envelope)
                }
            }
            CoreStatus.CLOSED -> {
                _lifecycle.value = CoreLifecycle.Closed
                CoreOutcome.Failed(CoreFailure.Closed)
            }
            CoreStatus.PANICKED -> {
                val diagnosticId = diagnosticIdOf(answer.bytes)
                // POISON IS STICKY AND THE FIRST ONE IS THE ONE FILED
                // (`CONTRACT.md` clause 9): a later panic is a symptom of
                // running on poisoned state, and overwriting loses the cause.
                if (_lifecycle.value !is CoreLifecycle.Poisoned) {
                    _lifecycle.value = CoreLifecycle.Poisoned(diagnosticId)
                }
                CoreOutcome.Failed(
                    CoreFailure.Poisoned((_lifecycle.value as CoreLifecycle.Poisoned).diagnosticId),
                )
            }
            CoreStatus.MALFORMED -> CoreOutcome.Failed(
                CoreFailure.Malformed("the core could not decode the request this shell encoded"),
            )
            CoreStatus.BAD_ARGUMENT -> CoreOutcome.Failed(
                CoreFailure.BadArgument("the binding handed the ABI an impossible argument"),
            )
            CoreStatus.TIMEOUT -> CoreOutcome.Failed(
                CoreFailure.BadArgument("centraid_call cannot time out; only next_event can"),
            )
        }
    }

    private fun diagnosticIdOf(bytes: ByteArray?): String {
        if (bytes == null) return "unknown"
        val envelope = runCatching { Envelope.ADAPTER.decode(bytes) }.getOrNull()
        return envelope?.error?.diagnostic_id?.ifBlank { "unknown" } ?: "unknown"
    }

    public companion object {
        /**
         * Sized to the core's own queue (`EVENT_QUEUE_CAP` = 1024,
         * `crates/core`). Larger would hide the core's stall report behind a
         * buffer of this side's own; smaller would report a stall the core is
         * not having.
         */
        public const val EVENT_BUFFER: Int = 1024

        /**
         * One second. Short enough that [close] is felt promptly, long enough
         * that an idle core is not woken sixty times a minute — and it is a
         * timeout and not a poll because `next_event` blocks on the queue.
         */
        public const val READER_TIMEOUT_MS: Int = 1_000

        internal val openHandles = SingleHandleGuard()

        /**
         * A core over an ABI the caller supplies. `internal`, and used only by
         * this module's own tests.
         *
         * It exists because `crates/core-ffi` has no fault-injection point: a
         * panicking core, an undefined status code and a full event queue
         * cannot be asked for through the five symbols, and the binding's
         * handling of all three is the half a shell depends on. See
         * `FakeCentraidAbi`'s header.
         */
        internal fun overAbi(
            abi: CentraidAbi,
            dispatcher: CoroutineDispatcher,
            uiThreadName: String,
        ): CentraidCore = CentraidCore(
            abi = abi,
            dispatcher = dispatcher,
            uiThreadName = uiThreadName,
            identityWarning = null,
            reportedIdentity = ArtifactIdentity.development,
        )

        /**
         * Open the core, run the handshake, and check the artifact identity.
         *
         * THE HANDSHAKE IS PART OF OPENING. `Hello` is the one request a thin
         * seat answers locally (`crates/core`'s `answerable_locally`), so it is
         * the only request that is safe to make before the shell knows what it
         * is talking to — and the identity check has to happen before the first
         * real read, not after it.
         */
        @JvmStatic
        public suspend fun open(
            configuration: CoreConfiguration,
            dispatcher: CoroutineDispatcher,
            uiThreadName: String,
        ): CoreOutcome<CentraidCore> = withContext(dispatcher) {
            assertNotOnUiThread("centraid_open", uiThreadName)
            if (!openHandles.acquire()) {
                return@withContext CoreOutcome.Failed(
                    CoreFailure.BadArgument(
                        "a core is already open in this process. ONE CORE PER DEVICE PROCESS " +
                            "(R-1020-24): app extensions never open the vault.",
                    ),
                )
            }
            val opened = openCentraidAbi(configuration.toJson(uiThreadName), uiThreadName)
            val abi = when (opened) {
                is AbiOpen.Refused -> {
                    openHandles.release()
                    return@withContext CoreOutcome.Failed(opened.failure)
                }
                is AbiOpen.Opened -> opened.abi
            }
            val handshake = abi.call(
                Envelope(request_id = 0, request = Request(hello = localHello())).encode(),
            )
            val hello = handshake.bytes
                ?.let { runCatching { Envelope.ADAPTER.decode(it) }.getOrNull() }
                ?.response
                ?.hello
            if (handshake.status != CoreStatus.OK || hello == null) {
                abi.close()
                openHandles.release()
                return@withContext CoreOutcome.Failed(
                    CoreFailure.Malformed(
                        "the core answered the handshake with status " +
                            "${handshake.rawCode} and no Hello",
                    ),
                )
            }
            val reported = identityOf(hello)
            when (val verdict = requireDigest(configuration.expectedDigest, reported)) {
                is IdentityVerdict.Stale -> {
                    abi.close()
                    openHandles.release()
                    CoreOutcome.Failed(verdict.failure)
                }
                is IdentityVerdict.Matched -> CoreOutcome.Answered(
                    CentraidCore(abi, dispatcher, uiThreadName, null, reported),
                )
                is IdentityVerdict.NotChecked -> CoreOutcome.Answered(
                    CentraidCore(abi, dispatcher, uiThreadName, verdict.warning, reported),
                )
            }
        }

        /** This build's end of the version window. */
        public fun localHello(): Hello = Hello(
            schema_version = SCHEMA_VERSION,
            min_supported = MIN_SUPPORTED,
            product_version = PRODUCT_VERSION,
            capabilities = emptyList(),
        )

        public const val SCHEMA_VERSION: Int = 1

        public const val MIN_SUPPORTED: Int = 1

        public const val PRODUCT_VERSION: String = "1.0.0-alpha.0"

        /**
         * THE IDENTITY IS NOT ON THE WIRE YET.
         *
         * `crates/centraid/src/identity.rs` says, in its own header, that when
         * `crates/core-ffi` is on the umbrella the module moves to
         * `crates/core` and "`open`'s handshake response carries an
         * `ArtifactIdentity` with these three field names, which is the
         * contract lane E's KMP side asserts against". `crates/core-ffi` IS on
         * the umbrella and the move has not happened: `Hello` carries
         * `schema_version`, `min_supported`, `product_version` and
         * `capabilities`, and no digest.
         *
         * So this reads what is there and reports `dev` for the digest, which
         * routes every released shell into [IdentityVerdict.Stale] with a
         * message naming the gap — never into a silent pass.
         * `contracts/handoff/E/findings.md` carries the proposed patch
         * (`ArtifactIdentity identity = 5;` on `Hello`, a fresh field number,
         * which `buf breaking` admits).
         */
        internal fun identityOf(hello: Hello): ArtifactIdentity = ArtifactIdentity(
            gitSha = ArtifactIdentity.DEV,
            digest = ArtifactIdentity.DEV,
            schemaVersion = hello.schema_version.toLong(),
        )
    }
}

/**
 * One handle per process (R-1020-24).
 *
 * A counter and not a boolean flag on [CentraidCore], because the point is that
 * the SECOND caller is refused — including the second caller in an app
 * extension that shares the process, which is the case v0's lease sidecar
 * existed to catch.
 */
internal class SingleHandleGuard {
    private val held = AtomicBoolean(false)

    fun acquire(): Boolean = held.compareAndSet(expectedValue = false, newValue = true)

    fun release() {
        held.store(false)
    }
}
