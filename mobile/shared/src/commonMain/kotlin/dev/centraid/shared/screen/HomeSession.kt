package dev.centraid.shared.screen

import centraid.core.v1.Command
import centraid.core.v1.Envelope
import centraid.core.v1.ErrorCode
import centraid.core.v1.PairErrorCode
import centraid.core.v1.PairRequest
import centraid.core.v1.Request
import centraid.screen.v1.HomeEvent
import centraid.screen.v1.HomeState
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreConfiguration
import dev.centraid.core.CoreFailure
import dev.centraid.core.CoreOutcome
import dev.centraid.core.CoreRole
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okio.ByteString.Companion.toByteString

/**
 * HOME, WIRED TO A REAL VAULT — AND TO THE OTHERS THE DEVICE HOLDS
 * (#1020, wave A).
 *
 * One object holding the things a live screen needs and both shells were
 * assembling separately: the [ScreenHost] that reduces, the [CentraidCore] that
 * reads, the [HomeRuntime] that carries effects from the first to the second,
 * and the roster that says which other vaults a switch could point at. It lives
 * in `commonMain` because the wiring is identical on both sides and a shell
 * that assembled it itself would be a second chance to assemble it differently
 * — Android's Home drew an empty page for exactly that reason, having never
 * sent `Opened` at all.
 *
 * **The order in [open] is load-bearing, twice over.**
 *
 * 1. The roster survey runs FIRST, before any core is kept open, because
 *    `SingleHandleGuard` allows one core per process (R-1020-24) and a survey
 *    afterwards would be refused on every file. See [VaultRoster].
 * 2. The runtime collects effects BEFORE `Opened` is sent, because `ScreenHost`
 *    buffers only `EFFECT_BUFFER` of them and the read Home asks for on open is
 *    the first one emitted. A runner attached afterwards would miss it and
 *    every tile would sit `LOADING` for ever.
 *
 * **A core that will not open is not a crash.** The screen still runs; it draws
 * the seeded `LOADING` grid and then nothing lands, which is honest — the
 * alternative is an app that will not start because a file is missing.
 */
public class HomeSession private constructor(
    private val scope: CoroutineScope,
    private val host: ScreenHost<HomeState, HomeEvent>,
    private val dispatcher: CoroutineDispatcher,
    private val uiThreadName: String,
    /** `vault_id` to the file that holds it. The machine never sees a path. */
    private val pathsById: Map<String, String>,
    private var core: CentraidCore?,
    private var runtime: Job?,
) {
    public val state: StateFlow<HomeState> get() = host.state

    /** Whether this session has a core behind it at all. */
    public val live: Boolean get() = core != null

    /**
     * ONE RE-POINT AT A TIME.
     *
     * A switch closes a core and opens another, and two of them interleaved
     * would leave the guard held by one open while the other's close released
     * it — the process would end up with a core nobody is holding and a session
     * pointing at a handle that is gone. A member double-tapping two rows in
     * the sheet is exactly that race.
     */
    private val switching = Mutex()

    public fun send(event: HomeEvent) {
        scope.launch { host.send(event) }
    }

    /**
     * Redeem a pairing ticket (#1020, D-1020-B7).
     *
     * THROUGH THIS SESSION'S CORE, and that is the whole reason it lives here
     * rather than in a bridge of its own. R-1020-24 is one core per device
     * process: a second `CentraidCore` opened to do the pairing would be
     * refused by `SingleHandleGuard`, and a bridge that held its own would be a
     * second holder of the thing the guard exists to keep singular.
     *
     * `code` carries the ENCODED TICKET the camera read, not the ticket's
     * secret — see `Handle::pair`, which mints the real redemption. The shell
     * hands over exactly what it read off the screen and assembles nothing.
     */
    public suspend fun pair(ticket: String, deviceName: String, platform: String): PairOutcome {
        val core = this.core ?: return PairOutcome.NoCore
        val answer = core.call(
            Envelope(
                request = Request(
                    pair = PairRequest(
                        code = ticket.encodeToByteArray().toByteString(),
                        device_name = deviceName,
                        platform = platform,
                    ),
                ),
            ),
        )
        return when (answer) {
            // BY CODE, NOT BY WHATEVER TEXT ARRIVED. A failure's own words are
            // for a log — the simulator showed a member "the gateway is
            // unreachable: the gateway did not answer the pairing request",
            // which is a Rust error's Display and not a sentence anyone should
            // read. The pairing screen has three things to say and picks
            // between them itself.
            is CoreOutcome.Failed -> PairOutcome.Refused(
                when (val failure = answer.failure) {
                    is CoreFailure.Refused ->
                        if (failure.code == ErrorCode.ERROR_CODE_PEER_UNREACHABLE.value ||
                            failure.code == ErrorCode.ERROR_CODE_NO_RELAY_REACHABLE.value ||
                            failure.code == ErrorCode.ERROR_CODE_TIMEOUT.value
                        ) {
                            "Centraid could not reach that gateway. Check it is running and try again."
                        } else {
                            "That pairing code was not accepted. Show a new one."
                        }
                    else -> "Centraid could not pair this device right now."
                },
            )
            is CoreOutcome.Answered -> {
                // WIRE FLATTENS A `oneof` INTO NULLABLE FIELDS. There is no
                // `result` wrapper to read, and at most one of these is set.
                val paired = answer.value.response?.pair
                val ok = paired?.ok
                when {
                    ok != null -> PairOutcome.Paired(ok.vault_name)
                    // THE GATEWAY'S VOCABULARY IS THREE CODES AND CARRIES NO
                    // TEXT, so the sentence is made here. A member holding a
                    // screenshot of an old QR must not learn from the answer
                    // whether that ticket ever existed, which is why the two
                    // "no" cases read the same.
                    paired?.error?.code == PairErrorCode.PAIR_ERROR_CODE_EXPIRED_CODE ->
                        PairOutcome.Refused("That pairing code has expired. Show a new one.")
                    else ->
                        PairOutcome.Refused("That pairing code was not accepted. Show a new one.")
                }
            }
        }
    }

    /**
     * Run one sync pass and report what it moved.
     *
     * Rides `Command` because the C ABI is five symbols and means it: a sixth
     * entry point to trigger a sync would be a sixth entry point in production.
     * `seat.sync` is answered by the core before the vault sees it, so it never
     * reaches the command registry.
     */
    public suspend fun syncNow(): SyncOutcome {
        val core = this.core ?: return SyncOutcome(unreachable = true, sentence = "No vault is open.")
        val answer = core.call(
            Envelope(
                request = Request(
                    command = Command(name = SEAT_SYNC_COMMAND, invoke_key = "shell"),
                ),
            ),
        )
        return when (answer) {
            is CoreOutcome.Failed -> SyncOutcome(
                unreachable = true,
                sentence = answer.failure.sentence,
            )
            is CoreOutcome.Answered -> {
                val outcome = answer.value.response?.command
                SyncOutcome(
                    // The numbers ride as canonical JSON in `output`, which is
                    // every command's answer shape, so no shell needs a second
                    // decoder. Read positionally rather than parsed: a JSON
                    // parser in `commonMain` for five integers would be a
                    // dependency for nothing.
                    rowsApplied = outcome?.output?.utf8()?.intField("rowsApplied") ?: 0L,
                    blobsCompleted = outcome?.output?.utf8()?.intField("blobsCompleted") ?: 0L,
                    bytesMoved = outcome?.output?.utf8()?.intField("bytesMoved") ?: 0L,
                    unreachable = outcome?.output?.utf8()?.boolField("unreachable") ?: true,
                    sentence = outcome?.reason.orEmpty(),
                )
            }
        }
    }

    public fun close() {
        core?.close()
        core = null
        scope.cancel()
    }

    /**
     * Serve the effects this session owns, rather than the ones a core serves.
     *
     * [HomeRuntime] turns `ReadPage` into a read; a `SwitchVault` is not a read
     * at all — it is the core's own lifecycle — so it is served here, by the
     * object that owns that lifecycle. Two collectors on one `SharedFlow` each
     * see every effect and each ignores what is not theirs.
     */
    private fun serveSwitches(): Job = scope.launch {
        host.effects.collect { effect ->
            if (effect is ScreenEffect.SwitchVault) switchTo(effect.vaultId)
        }
    }

    /**
     * RE-POINT THE WHOLE APP AT ANOTHER VAULT.
     *
     * The old runtime is cancelled BEFORE the old core is closed: a read in
     * flight against a closing handle answers `CoreFailure.Closed`, which the
     * runtime would faithfully render as "Centraid stopped reading" on a tile
     * of a vault the member has already left.
     *
     * An id with no path, or a file that will not open, leaves the session on
     * the vault it was on. That is the honest outcome — the member is still
     * reading something real — and it is why the lockup is only re-read once a
     * core is actually open.
     */
    private suspend fun switchTo(vaultId: String): Unit = switching.withLock {
        val path = pathsById[vaultId] ?: return@withLock
        runtime?.cancelAndJoin()
        runtime = null
        core?.close()
        core = null
        val opened = openCore(path, dispatcher, uiThreadName) ?: return@withLock
        core = opened
        val next = HomeRuntime(opened, host, scope)
        runtime = next.start()
        // THE LOCKUP LAST, and it is what starts the reload: the machine sees a
        // vault whose id differs from the one it is holding, throws away every
        // tile it read out of the old vault, and asks for the new one's — which
        // the runtime above is already collecting.
        next.readLockup()
    }

    public companion object {
        /**
         * Open a session over the vaults at [vaultPaths], reading the first
         * that identifies.
         *
         * `GATEWAY`, and deliberately: on a phone with no endpoint this core is
         * the authority for a file that is sitting on the device, which is what
         * a throwaway demo vault IS. A `SEAT_REPLICATED` role would be claiming
         * a gateway this build cannot dial — `Handle::start_endpoint` is not
         * built and the gateway closes the seat lane — and a role that names a
         * relationship the product cannot form is a lie in a config file.
         *
         * `create = false`: the file is an ARTIFACT that was put there, and a
         * fresh empty one founded in its place would be a silently empty
         * product rather than a missing-file error.
         */
        public suspend fun open(
            vaultPaths: List<String>,
            dispatcher: CoroutineDispatcher,
            uiThreadName: String,
        ): HomeSession {
            val scope = CoroutineScope(SupervisorJob() + dispatcher)
            val host = ScreenHost(HomeMachine)
            // FIRST, and with nothing else open. See the class header.
            val survey = VaultRoster.survey(vaultPaths, dispatcher, uiThreadName)
            // The first vault that ANSWERED, not the first path: a path that
            // named a missing or unreadable file would otherwise open Home on
            // nothing while three readable vaults sat beside it.
            val active = survey.vaults.firstOrNull()?.vault_id
                ?.let { survey.pathsById[it] }
                ?: vaultPaths.firstOrNull()
            val core = active?.let { openCore(it, dispatcher, uiThreadName) }
            val session = HomeSession(
                scope = scope,
                host = host,
                dispatcher = dispatcher,
                uiThreadName = uiThreadName,
                pathsById = survey.pathsById,
                core = core,
                runtime = null,
            )
            session.serveSwitches()
            if (core != null) {
                val runtime = HomeRuntime(core, host, scope)
                session.runtime = runtime.start()
                runtime.readLockup()
            }
            // The roster AFTER the lockup: a Home that waited for every other
            // vault's file before naming its own would hold the member's vault
            // name hostage to files it is not reading.
            host.send(
                HomeEvent(vaults_listed = HomeEvent.VaultsListed(vaults = survey.vaults)),
            )
            host.send(HomeEvent(opened = HomeEvent.Opened()))
            return session
        }

        private suspend fun openCore(
            vaultPath: String,
            dispatcher: CoroutineDispatcher,
            uiThreadName: String,
        ): CentraidCore? = when (
            val outcome = CentraidCore.open(
                CoreConfiguration(
                    databasePath = vaultPath,
                    role = CoreRole.GATEWAY,
                    create = false,
                ),
                dispatcher,
                uiThreadName,
            )
        ) {
            is CoreOutcome.Answered -> outcome.value
            is CoreOutcome.Failed -> null
        }
    }
}
