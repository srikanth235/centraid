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
import kotlin.concurrent.atomics.AtomicReference
import kotlin.jvm.JvmStatic

/**
 * WHERE THE SHELL BELIEVES THE VAULT LIVES, AND NOTHING ELSE (#1029 §1).
 *
 * It carried a `CoreRole` and a `PairingRecord`, and both left with the seat
 * plane. The role — `gateway`, `seat-replicated`, `seat-thin` — was the core
 * branching on which kind of host it was running in, and the phone is the only
 * host that opens a vault now, so there is one kind of core and a word naming
 * which would be a word nothing reads. The record was this device's
 * relationship with a GATEWAY: the endpoint secret it dialled with, the public
 * half that gateway said it had enrolled, where the vault was reached and
 * whether that deployment had relays. There is nothing to dial.
 *
 * `crates/core-ffi`'s `config_from_json` reads exactly what is left — `path`,
 * `create`, `uiThreadName`, `expectedIdentity` — and IGNORES a `role` an older
 * shell still sends rather than refusing the open, which is the version-skew
 * case the handshake exists for.
 */
public data class CoreConfiguration(
    /**
     * The vault file.
     *
     * Named by the shell and by nothing else. It used to be named after the
     * VAULT — `centraid-replica-<vaultId>.sqlite3` — so that a device could
     * find a vault's enrolment record before opening the file; there is no
     * record, so the name is a label and `dev.centraid.shared.shell.Shelf`
     * asks each file which vault it is instead.
     */
    public val databasePath: String,
    /**
     * FOUND A VAULT HERE IF THERE IS NONE (#1029 §1).
     *
     * The phone is the vault, so a shell can make one — and `crates/core`'s
     * `CoreConfig::create` defaults to TRUE for exactly that reason: a caller
     * that named a path and said nothing else is founding a vault there. This
     * binding keeps the same default so the two sides cannot disagree about
     * what an unqualified open means.
     *
     * The shelf passes `false` for every open but a founding one. A file that
     * is not there is then a vault this device does not hold — answered as
     * "there is nothing here" rather than as a silently empty product.
     */
    public val create: Boolean = true,
    /**
     * The digest this shell's own build recorded for the core it intends to
     * use. [ArtifactIdentity.DEV] means "not checked, and say so".
     */
    public val expectedDigest: String = ArtifactIdentity.DEV,
) {
    internal fun toJson(uiThreadName: String): String = buildString {
        append('{')
        append("\"path\":").append(quote(databasePath))
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
 * ## One core per VAULT FILE, not one per process (R-1020-24, re-keyed by
 * #1025 S7-13)
 *
 * [open] refuses a second handle on the same file, and admits one on another
 * vault — which is what lets the shelf hold every vault this device has open at
 * once. The header on [SingleHandleGuard] has the whole argument. In v0 the rule
 * was a `<seat>.lease.json` sidecar plus `useNewConnection: true`, and **both
 * halves were needed and neither was enough** (census §E seam 1). With the core
 * owning the file the two mechanisms collapse into one — but only if nothing
 * else in the process opens a second handle on it, which is why Share, Autofill
 * and Widget extensions never open the vault.
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
    /**
     * The vault file this handle holds, which is the key [SingleHandleGuard]
     * filed it under. Empty for a core built over an injected ABI in a test,
     * which never took the guard.
     */
    private val vaultPath: String,
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

    /**
     * THE ONE READER, KEPT, so a second [startReader] answers the first
     * (#1025 S7-13).
     *
     * The doc on [startReader] always said "idempotent" and the code threw
     * instead. It was unreachable while a switch closed and reopened the
     * handle — every rebind got a fresh core with a fresh flag — and the first
     * switch onto an ALREADY-OPEN core crashed the app on the simulator:
     * `HomeSession.rebind` binds the vault it is moving to, and a vault the
     * member has been in before has had a reader.
     *
     * A reader per core rather than per binding is also the right lifetime on
     * its own terms. The reader drains `next_event`, and the core's queue is
     * bounded and drops nothing: a background vault whose reader stopped would
     * fill that queue and report itself stalled.
     */
    private var reader: Job? = null

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
     * Start the one reader. **Idempotent**: a second call answers the first
     * call's [Job] rather than starting a reader or throwing. `next_event`
     * blocks on a bounded queue and two readers would interleave a change
     * stream whose order is the only thing that makes it applicable.
     *
     * It lives on the CORE's scope, so it runs for as long as the core is open
     * and a shell rebinding away from this vault does not stop it — which is
     * what the bounded, drop-nothing queue requires (#1025 S7-13).
     */
    public fun startReader(timeoutMs: Int = READER_TIMEOUT_MS): Job {
        if (!readerStarted.compareAndSet(expectedValue = false, newValue = true)) {
            // THE FIRST CALLER'S READER, HANDED BACK. Two would interleave a
            // change stream whose order is the only thing that makes it
            // applicable — so there is one, and asking again is not an error.
            return reader ?: scope.launch { }
        }
        val started = scope.launch(start = CoroutineStart.DEFAULT) {
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
        reader = started
        return started
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
        openHandles.release(vaultPath)
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
                    // `Error.detail` IS FOR LOGS AND NEVER FOR A MEMBER
                    // (#1025 S7, D-1025-S7-82; the same rule `HomeRuntime` and
                    // `ScreenRuntime` already keep, and the same shape as
                    // #1020 wave 3 lane E finding 2).
                    //
                    // This binding built the member-facing sentence as
                    // `error.detail.ifBlank { … }`, so the core's LOG text was
                    // the first thing rendered — and Slice 6 watched a raw
                    // `no such table: blob_staging` land on the Photos screen.
                    // A detail is a sentence about the BUILD, written for
                    // whoever reads the log; it names tables, columns and
                    // SQLite's own vocabulary, it is not translated, and it is
                    // exactly the text a member can do nothing with.
                    //
                    // The sentence is the CODE's, and the core already sends
                    // it: `Error.sentence` is `centraid_core::error::
                    // sentence_for_code`, one sentence per code, written to be
                    // read. `detail` still rides along on [CoreFailure.Refused]
                    // — that field is the log's — and the fallback is the
                    // generic sentence for a code this build has no line for,
                    // never the detail.
                    CoreOutcome.Failed(
                        CoreFailure.Refused(
                            code = error.code.value,
                            detail = error.detail,
                            diagnosticId = error.diagnostic_id,
                            sentence = error.sentence.ifBlank { "Centraid refused that." },
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
            vaultPath = "",
            dispatcher = dispatcher,
            uiThreadName = uiThreadName,
            identityWarning = null,
            reportedIdentity = ArtifactIdentity.development,
        )

        /**
         * A core over a caller-supplied answer, for tests that need DISTINCT
         * handle identities without the FFI (#1025 live-home).
         *
         * Two calls produce two objects: Home's vault switch is an identity
         * change on the shelf, and a test that could not tell two cores apart
         * could not prove the runner re-pointed.
         */
        public fun answering(
            dispatcher: CoroutineDispatcher,
            answer: (Envelope) -> Envelope,
        ): CentraidCore {
            val abi = object : CentraidAbi {
                // Accounting is unused by Home's switch test; zeros keep the
                // ABI contract without pulling atomics into this factory.
                override val accounting: AbiAccounting = object : AbiAccounting {
                    override val handedOver: Long get() = 0
                    override val freed: Long get() = 0
                    override val bytesCopied: Long get() = 0
                }

                override fun call(request: ByteArray): AbiAnswer {
                    val bytes = answer(Envelope.ADAPTER.decode(request)).encode()
                    return AbiAnswer(CoreStatus.OK, CoreStatus.OK.code, bytes)
                }

                override fun nextEvent(timeoutMs: Int): AbiAnswer =
                    AbiAnswer(CoreStatus.TIMEOUT, CoreStatus.TIMEOUT.code, null)

                override fun close(): CoreStatus = CoreStatus.OK
            }
            return overAbi(abi, dispatcher, uiThreadName = "")
        }

        /**
         * Open the core, run the handshake, and check the artifact identity.
         *
         * THE HANDSHAKE IS PART OF OPENING. `Hello` is the one request that is
         * safe to make before the shell knows what build it is talking to, and
         * the identity check has to happen before the first real read rather
         * than after it.
         */
        @JvmStatic
        public suspend fun open(
            configuration: CoreConfiguration,
            dispatcher: CoroutineDispatcher,
            uiThreadName: String,
        ): CoreOutcome<CentraidCore> = withContext(dispatcher) {
            assertNotOnUiThread("centraid_open", uiThreadName)
            if (!openHandles.acquire(configuration.databasePath)) {
                return@withContext CoreOutcome.Failed(
                    CoreFailure.BadArgument(
                        "a core is already open on that vault in this process. ONE HANDLE PER " +
                            "VAULT FILE (R-1020-24): app extensions never open the vault.",
                    ),
                )
            }
            val opened = openCentraidAbi(configuration.toJson(uiThreadName), uiThreadName)
            val abi = when (opened) {
                is AbiOpen.Refused -> {
                    openHandles.release(configuration.databasePath)
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
                openHandles.release(configuration.databasePath)
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
                    openHandles.release(configuration.databasePath)
                    CoreOutcome.Failed(verdict.failure)
                }
                is IdentityVerdict.Matched -> CoreOutcome.Answered(
                    CentraidCore(
                        abi,
                        configuration.databasePath,
                        dispatcher,
                        uiThreadName,
                        null,
                        reported,
                    ),
                )
                is IdentityVerdict.NotChecked -> CoreOutcome.Answered(
                    CentraidCore(
                        abi,
                        configuration.databasePath,
                        dispatcher,
                        uiThreadName,
                        verdict.warning,
                        reported,
                    ),
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
 * ONE HANDLE PER VAULT FILE PER PROCESS (#1025 S7-13, re-keying R-1020-24).
 *
 * ## What the rule protects, and what it was read as
 *
 * R-1020-24 is that **app extensions never open the vault**: Share, Autofill
 * and Widget run in their own processes with small memory caps, and a second
 * core in one of them would be a second WRITER to a vault file and a second
 * iroh endpoint for one device. The hazard is two handles on ONE FILE.
 *
 * This guard was keyed on the process, which made "one core per process" the
 * rule, and that reading was over-broad in exactly one direction: it also
 * refused two handles on two DIFFERENT vaults, which share no file. It cost the
 * shelf a close-and-reopen on every vault switch and made `D-1020-HOME8`'s
 * survey-before-open dance necessary — every file had to be opened and closed
 * one at a time just to read its own name.
 *
 * The rule is unchanged for the case it exists for. An extension opening the
 * main app's vault is still two handles on one path, and still refused; an
 * extension in its own process was never reached by a process-keyed guard
 * anyway, which is why R-1020-24 is a rule about extensions rather than a
 * counter.
 *
 * ## The key is the path as given
 *
 * Not canonicalised, because `commonMain` has no filesystem and the shell hands
 * one absolute path per vault, built in one place
 * (`dev.centraid.shared.shell.Shelf`). A guard that pretended to canonicalise
 * would be claiming a property it cannot check.
 */
internal class SingleHandleGuard {
    // AN IMMUTABLE SET BEHIND A CAS, and not a lock: `commonMain` has no
    // portable monitor, the set is tiny, and the loser of a race must be
    // REFUSED rather than made to wait — two callers opening one replica is a
    // bug in the caller, not contention to be smoothed over.
    private val held = AtomicReference<Set<String>>(emptySet())

    /** True when this path was free, and it is now this caller's. */
    fun acquire(path: String): Boolean {
        while (true) {
            val before = held.load()
            if (path in before) return false
            if (held.compareAndSet(before, before + path)) return true
        }
    }

    fun release(path: String) {
        while (true) {
            val before = held.load()
            if (path !in before) return
            if (held.compareAndSet(before, before - path)) return
        }
    }
}
