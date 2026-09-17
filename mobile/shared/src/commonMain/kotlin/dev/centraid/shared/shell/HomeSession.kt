package dev.centraid.shared.shell

import centraid.screen.v1.HomeEvent
import centraid.screen.v1.HomeState
import centraid.screen.v1.SeatState
import centraid.screen.v1.VaultLockup
import dev.centraid.core.CentraidCore
import dev.centraid.shared.platform.PlatformServices
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.sync.ChangeStream
import dev.centraid.shared.sync.ScreenReads
import dev.centraid.shared.sync.ScreenRuntime
import dev.centraid.shared.sync.ScreenWrites
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
 * ## A VIEW OVER THE SHELF'S FOREGROUND HOLDING (#1025 S7-9)
 *
 * This used to own the set of vaults itself: it took a `pathsById` map from a
 * one-shot survey, held the pairing store, held a `link` it moved by hand, and
 * pairing rode its LIVE core — which destroyed the vault that core was open on.
 * [Shelf] owns all of that now. What is left here is the part that was always
 * this object's: a [ScreenHost] that reduces, a [HomeRuntime] that serves its
 * effects, a [ChangeStream] that feeds it what arrives, and the job of pointing
 * all three at whichever core the shelf has in front.
 *
 * **A switch is a REBIND and not a reopen of this session.** [rebind]
 * re-points the change reader and publishes the new lockup; [HomeRuntime]
 * already reads the core through a supplier (R-HOME-2), so it keeps collecting
 * — cancelling it raced the switch's `ReadPage` against a `SharedFlow` with
 * `replay = 0` and left every tile LOADING forever (#1025 live-home). App
 * screens stay attached the same way. Since D-1025-S7-13 / D-1025-S7-17 every
 * held vault's core stays open; a switch is a pointer move on the shelf.
 *
 * **The order in [open] is load-bearing.** The runtime collects effects BEFORE
 * `Opened` is sent, because `ScreenHost` buffers only `EFFECT_BUFFER` of them
 * and the read Home asks for on open is the first one emitted. A runner
 * attached afterwards would miss it and every tile would sit `LOADING` for ever.
 *
 * **A core that will not open is not a crash.** The screen still runs; it draws
 * the seeded `LOADING` grid and then nothing lands, which is honest — the
 * alternative is an app that will not start because a file is missing.
 */
public class HomeSession private constructor(
    private val scope: CoroutineScope,
    private val host: ScreenHost<HomeState, HomeEvent>,
    private val services: PlatformServices,
    /**
     * EVERY VAULT THIS DEVICE HOLDS, and the only thing that adds or removes
     * one. See [Shelf].
     */
    public val shelf: Shelf,
    private var runtime: Job?,
    /**
     * The one consumer of the core's change stream (#1025 S5).
     *
     * It is the SESSION's and not a screen's, because it outlives every screen:
     * a list the member has scrolled away from must be right when they come
     * back, and a stream that started when a screen appeared would leave it
     * stale for exactly as long as it was not visible.
     */
    public val changes: ChangeStream,
    private var changeReader: Job?,
) {
    public val state: StateFlow<HomeState> get() = host.state

    /**
     * THE FOREGROUND HOLDING'S CORE, ASKED OF THE SHELF EVERY TIME.
     *
     * A property and not a field, and that is what makes a switch a rebind: the
     * effect runner and every attached app screen take the core as a SUPPLIER,
     * so the shelf moving the foreground is picked up by the next read rather
     * than leaving anything bound to a closed handle.
     */
    private val core: CentraidCore? get() = shelf.core()

    /** Whether this session has a core behind it at all. */
    public val live: Boolean get() = core != null

    public fun send(event: HomeEvent) {
        scope.launch { host.send(event) }
    }

    /**
     * PUT AN APP SCREEN ON THIS SESSION'S CORE (#1025 S5, lane L5).
     *
     * The three app screens have no core of their own and must not get one:
     * R-1020-24 is one core per VAULT FILE — re-keyed from "per process" by
     * #1025 S7-13, so the shelf can hold every vault open at once — and
     * `SingleHandleGuard` refuses a second handle on the file this session is
     * already reading. So Tally, Photos and Notes read through the handle this
     * session holds. Until this method existed nothing served their `ReadPage`
     * effects at all and all three sat on their seeded `LOADING` state for ever.
     *
     * **Both halves, every time.** The runtime serves what the screen ASKS for;
     * `changes.route` delivers what arrives from sync without being asked. A
     * screen given only the first is the product as it was before S5 — it
     * answers a tap and never moves on its own.
     *
     * **It survives a vault switch without being re-attached.**
     * [ScreenRuntime] takes the core as a SUPPLIER — `{ core }`, read at each
     * read — so a switch that closes one core and opens another is picked up by
     * the next read rather than leaving this screen bound to a closed handle.
     * The routing needs no repair either: `ChangeStream.route` is registration
     * on the stream object, which outlives the cores, and [attach] restarts the
     * reader against whichever core is open.
     *
     * Registration is additive and there is no removal, for the reason
     * `ChangeStream.route` gives: a screen the member has scrolled away from
     * must be right when they come back.
     */
    public fun <S, E> attachScreen(
        host: ScreenHost<S, E>,
        reads: ScreenReads<S, E>,
        /** Null for a screen with no write. See [ScreenWrites]. */
        writes: ScreenWrites<S, E>? = null,
    ): Job {
        changes.route(host)
        return ScreenRuntime(
            core = { core },
            host = host,
            reads = reads,
            scope = scope,
            writes = writes,
            // READ OFF THE SHELF AT THE MOMENT OF THE WRITE (#1029 F1). A
            // vault frozen while the member was mid-edit must refuse the save
            // they then press, and a value read at attach would not.
            readOnly = { if (shelf.foregroundHolding()?.readOnly == true) Shelf.MOVED_SENTENCE else null },
        ).start()
    }

    /**
     * MAKE A VAULT ON THIS PHONE (#1029 §1).
     *
     * What replaces `pair`, which redeemed a ticket against a gateway and took
     * a copy of a vault that lived somewhere else. The phone is the vault, so
     * the shell founds one: [Shelf.found] names a fresh file, opens it with
     * `create`, and the session REBINDS onto it because the shelf has moved the
     * foreground to the vault just made.
     *
     * A refusal is a CODE from the shelf and the sentence is made HERE, from
     * this table. A failure's own words are for a log — the simulator once
     * showed a member a Rust error's `Display` — and a sentence a member reads
     * is the shell's to write.
     */
    public suspend fun found(): FoundResult =
        when (val outcome = shelf.found()) {
            is Shelf.FoundOutcome.Founded -> {
                rebind()
                FoundResult.Made(outcome.holding.name)
            }
            is Shelf.FoundOutcome.Refused -> FoundResult.Refused(
                when (outcome.because) {
                    Shelf.FoundRefusal.NO_CORE ->
                        "Centraid could not make a vault on this device."
                    // THE SENTENCE NAMES THE GAP RATHER THAN BLAMING THE
                    // DEVICE. See [Shelf.FoundRefusal.NOT_FOUNDED]: the file
                    // is made and nothing over the ABI founds the vault in it.
                    Shelf.FoundRefusal.NOT_FOUNDED ->
                        "This build of Centraid cannot make a new vault yet."
                    Shelf.FoundRefusal.ALREADY_HELD ->
                        "This device already holds that vault."
                },
            )
        }

    /**
     * THIS VAULT MOVED TO THE MEMBER'S OTHER PHONE (#1029 F1).
     *
     * Freezes it: writes are refused with [Shelf.MOVED_SENTENCE] and reads go
     * on working. **Nothing is deleted and nothing is taken back.** Both phones
     * hold the same seed, so this is cooperation and not enforcement — see
     * [Shelf.Moved].
     *
     * The session republishes so the frozen holding's line is on screen without
     * waiting for the next touch.
     *
     * ## Its one caller
     *
     * Whatever learns the vault moved, which is #1029 W5's restore client: it
     * holds the lease and hears the supersession. There is no typed error to
     * key this on yet — `error.proto` has no `ERROR_CODE_VAULT_MOVED` and
     * `crates/api-proto` is another lane's — and when there is, the mapping
     * calls this and nothing else changes. [Shelf.freeze] has the whole note.
     */
    public suspend fun vaultMoved(vaultId: String, atIso: String, unacked: Long) {
        shelf.freeze(vaultId, atIso, unacked)
        publishLockup()
    }

    /**
     * "N changes since <date>" for the vault in front, or null (#1029 F1).
     *
     * Read by the chrome on both shells. It is NOT on `VaultLockup`, and that
     * is a gap rather than a choice: the screen contract has three vault states
     * and no slot for a frozen one or for its line, and the message lives in
     * `crates/api-proto` — another lane's. Until it has one, the freeze reaches
     * a member through the write refusal (which every screen already renders)
     * and through this.
     */
    public val frozenLine: String? get() = shelf.foregroundHolding()?.frozenLine

    /**
     * FORGET A VAULT (#1025 S7-9).
     *
     * The inverse of [found]: [Shelf.forget] closes the core, drops the
     * holding, and deletes the file, its byte store and its sidecars. The
     * session rebinds onto whatever the shelf brought forward, which is the
     * first remaining holding, or none.
     *
     * **On a phone that IS the vault this destroys the member's rows**, and
     * there is no copy elsewhere to fall back to. See [Shelf.forget].
     */
    public suspend fun forget(vaultId: String) {
        shelf.forget(vaultId)
        rebind()
    }

    /**
     * SAY WHAT THIS DEVICE IS (#1025 S5, D-1025-S5-6; reshaped by #1029 §1).
     *
     * Three facts, and each one is now about THIS DEVICE rather than about a
     * link to a gateway:
     *
     * * **Availability** — is a vault open here at all.
     * * **Durability** — `AUTHORITATIVE`, always, and that is the change. It
     *   used to be the last pass's answer: a seat that reached its gateway this
     *   window wrote authoritatively and one that did not was `LOCAL_ONLY`,
     *   which is to say its writes were in an outbox somebody else had to
     *   accept. The phone is the vault. A write that commits here IS the
     *   record, so there is no state in which a member's work is held
     *   provisionally, and reporting one would be this shell inventing a doubt.
     * * **Connectivity** — the platform's own reading, which is still a fact a
     *   member reads and still nothing the vault depends on.
     *
     * `centraid.core.v1.ConnectivityEvent` exists on the event stream and has
     * no producer in `crates/core`; when it gains one, this is the function
     * that changes and no screen does.
     */
    private suspend fun publishSeat() {
        val reading = services.networkStatus.current()
        changes.publishSeat(
            SeatState(
                availability = if (core == null) {
                    SeatState.Availability.AVAILABILITY_WAITING_FOR_MOUNT
                } else {
                    SeatState.Availability.AVAILABILITY_READY
                },
                durability = SeatState.Durability.DURABILITY_AUTHORITATIVE,
                connectivity = when {
                    reading.platformRefused ->
                        SeatState.Connectivity.CONNECTIVITY_UNKNOWN_PLATFORM_REFUSED
                    !reading.online -> SeatState.Connectivity.CONNECTIVITY_OFFLINE
                    reading.metered -> SeatState.Connectivity.CONNECTIVITY_ONLINE_METERED
                    else -> SeatState.Connectivity.CONNECTIVITY_ONLINE_UNMETERED
                },
            ),
        )
    }

    /**
     * Close the session and the core the shelf is holding.
     *
     * The shelf's holdings are NOT forgotten — they are files on disk and a
     * closed app still holds its vaults. Only [forget] removes one.
     */
    public suspend fun close() {
        shelf.closeAll()
        scope.cancel()
    }

    /**
     * THE OS IS ASKING FOR MEMORY BACK (#1025 S7-13).
     *
     * Wired from iOS's `didReceiveMemoryWarning` and Android's `onTrimMemory`.
     * Every background vault's core closes; the foreground's stays, because a
     * memory warning is not a reason to empty the screen a member is reading.
     * A rested vault reopens on the next tap.
     */
    public suspend fun rest() {
        shelf.rest()
    }

    /**
     * POINT THE CHANGE READER AT WHATEVER IS IN FRONT, and make sure the
     * Home effect runner is collecting (R-HOME-1, #1025 live-home).
     *
     * [HomeRuntime] takes the core as a SUPPLIER — `{ core }`, read at each
     * page — so a switch that moves the shelf's foreground is picked up by the
     * next tile read without tearing the collector down. Cancelling it on
     * every identity change was the live bug: `start()` schedules `collect`
     * asynchronously, `publishLockup` then emits `ReadPage` into a
     * `SharedFlow` with `replay = 0`, and every tile stayed LOADING forever
     * while Photos (already collecting through the same supplier pattern)
     * drew.
     *
     * The change reader IS per CORE and restarts here (#1025 S7-13):
     * `CentraidCore.startReader` is idempotent and its job lives on the
     * core's own scope; this session's consumer must follow the foreground.
     *
     * **REBINDING TO THE CORE ALREADY BOUND IS NOT A REBIND.** Early-return is
     * valid only when the foreground core identity is unchanged (R-HOME-1);
     * the lockup and the seat line are still published, because a caller that
     * rebound had a reason to think something moved.
     */
    private suspend fun rebind(): Unit = rebinding.withLock {
        val open = core
        if (open != null && open === bound) {
            publishSeat()
            publishLockup()
            return@withLock
        }
        changeReader?.cancelAndJoin()
        changeReader = null
        bound = open
        when {
            open == null -> {
                runtime?.cancelAndJoin()
                runtime = null
            }
            runtime == null -> {
                runtime = HomeRuntime(core = { core }, host = host, scope = scope).start()
            }
        }
        if (open != null) {
            changeReader = changes.start(open, scope)
        }
        // THE SEAT LINE TRAVELS WITH THE BINDING, and this is now the only
        // place it is published: it used to ride every pass's outcome, and
        // there are no passes. What it says — is a vault open, is a write
        // durable, what does the radio report — changes exactly when the
        // foreground does.
        publishSeat()
        publishLockup()
    }

    /**
     * The core the change reader is currently pointed at.
     *
     * Compared by IDENTITY and not by vault id. A switch moves the foreground
     * to another holding's already-open core (D-1025-S7-13), so this changes
     * on every real A→B move; the early-return above is the case where a
     * caller rebinds onto the core already bound. It still has to be identity
     * for a holding woken from [Shelf.rest], where the handle under one vault
     * id is replaced.
     */
    private var bound: CentraidCore? = null

    /**
     * ONE REBIND AT A TIME. Two interleaved would leave one cancelling the
     * runtime the other had just started, and Home would sit on its loading
     * grid with nothing serving it.
     */
    private val rebinding = Mutex()

    /**
     * The foreground vault's lockup, and it is the SHELF's row.
     *
     * The name and the colour come from the holding — which read them out of
     * the replica's own `core_vault` row — and the state is derived by
     * [Shelf.Holding.state] from what the last pass actually did. Nothing here
     * decides either, which is the point: the header's second line and the
     * switcher row for the same vault are one value rendered twice, and cannot
     * disagree the way a session-held `link` and a launch-time survey did.
     *
     * A device holding NOTHING sends an empty lockup rather than none: the
     * member still gets "No vault yet" over a Home that is reading something,
     * which is honest, and the alternative is a lockup that silently never
     * appears. `STATE_UNSPECIFIED` rides it, and is what it should be — a Home
     * nobody has told anything yet draws no second line rather than a claim.
     *
     * **Sent again after every round, and that is not a switch.** `HomeMachine`
     * compares the incoming lockup to the one it holds and moves only the
     * lockup when they name the same vault, so a line going `syncing` →
     * `synced` costs nothing and does not throw away a tile.
     */
    private suspend fun publishLockup() {
        val lockup = shelf.foregroundHolding()?.lockup() ?: VaultLockup()
        host.send(HomeEvent(vault_changed = HomeEvent.VaultChanged(vault = lockup)))
    }

    /**
     * Serve the effects this session owns, rather than the ones a core serves.
     *
     * [HomeRuntime] turns `ReadPage` into a read; a `SwitchVault` is not a read
     * at all — it is the shelf's foreground — so it is served here, by the
     * object that owns the binding. Two collectors on one `SharedFlow` each see
     * every effect and each ignores what is not theirs.
     */
    private fun serveSwitches(): Job = scope.launch {
        host.effects.collect { effect ->
            if (effect is ScreenEffect.SwitchVault) switchTo(effect.vaultId)
        }
    }

    /**
     * THE ROSTER, FORWARDED AS IT MOVES (#1025 S7-9).
     *
     * One collector on [Shelf.roster] for the life of the session. It replaces
     * the single `VaultsListed` the old `open` sent once and never again — so a
     * vault admitted a minute after launch did not exist to any screen until
     * the app was relaunched, and a vault that went offline kept whatever the
     * launch survey had guessed about it.
     */
    private fun serveRoster(): Job = scope.launch {
        shelf.roster.collect { vaults ->
            host.send(HomeEvent(roster_changed = HomeEvent.RosterChanged(vaults = vaults)))
        }
    }

    /**
     * RE-POINT THE WHOLE APP AT ANOTHER VAULT.
     *
     * An id with no holding, or a file that will not open, leaves the session
     * on the vault it was on — [Shelf.bringToFront] answers null and reopens
     * what was there. That is the honest outcome: the member is still reading
     * something real.
     */
    private suspend fun switchTo(vaultId: String) {
        shelf.bringToFront(vaultId) ?: return
        // THE LOCKUP IS WHAT STARTS THE RELOAD: the machine sees a vault whose
        // id differs from the one it is holding, throws away every tile it read
        // out of the old vault, and asks for the new one's — which the
        // supplier-backed runtime already collecting serves against the
        // foreground core (R-HOME-1).
        rebind()
    }

    public companion object {
        /**
         * Open a session over the vaults at [vaultDir] (#1025 S5, D-1025-S5-2;
         * #1025 S7-9; #1029 §1).
         *
         * ## A DIRECTORY, NOT A LIST OF PATHS
         *
         * Wave A's shell opened whatever `.db` files had been PLACED in its
         * container, as a `GATEWAY`, because there was no way for a phone to
         * get a vault of its own: `mobile/scripts/demo-vault.sh` copied a
         * gateway-role artifact in. S5 replaced that with a pairing, and #1029
         * replaces the pairing with the phone founding its own — so the
         * directory is the roster, [Shelf] opens every file in it the same way,
         * and an EMPTY directory is the ordinary first run rather than an
         * error.
         *
         * ## The order is load-bearing
         *
         * 1. [Shelf.load] runs FIRST: it opens each file in turn and asks it
         *    which vault it is. It ends holding every vault's core, and the
         *    foreground one is what everything below binds to.
         * 2. The runtime collects effects BEFORE `Opened` is sent, because
         *    `ScreenHost` buffers only `EFFECT_BUFFER` of them and the read
         *    Home asks for on open is the first one emitted. A runner attached
         *    afterwards would miss it and every tile would sit `LOADING` for
         *    ever.
         * 3. The change stream starts with the runtime and not later, because
         *    a screen attached after the first rows land would show a
         *    springboard of the counts the vault had before them.
         */
        public suspend fun open(
            vaultDir: String,
            services: PlatformServices,
            dispatcher: CoroutineDispatcher,
            uiThreadName: String,
        ): HomeSession {
            val scope = CoroutineScope(SupervisorJob() + dispatcher)
            val host = ScreenHost(HomeMachine)
            val shelf = Shelf(vaultDir, services, dispatcher, uiThreadName)
            // FIRST, and with nothing else open. See the header.
            shelf.load()
            val session = HomeSession(
                scope = scope,
                host = host,
                services = services,
                shelf = shelf,
                runtime = null,
                changes = ChangeStream(),
                changeReader = null,
            )
            session.changes.route(host)
            session.serveSwitches()
            // THE ROSTER COLLECTOR BEFORE THE REBIND, so the roster the shelf
            // is already holding reaches Home rather than being the one value
            // that arrives only on the next change.
            session.serveRoster()
            session.rebind()
            host.send(HomeEvent(opened = HomeEvent.Opened()))
            return session
        }
    }
}
