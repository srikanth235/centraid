package dev.centraid.shared.screen

import centraid.screen.v1.HomeEvent
import centraid.screen.v1.HomeState
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreConfiguration
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
