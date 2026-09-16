package dev.centraid.shared.shell

import centraid.core.v1.Command
import centraid.core.v1.Envelope
import centraid.core.v1.Request
import centraid.screen.v1.HomeEvent
import centraid.screen.v1.HomeState
import centraid.screen.v1.SeatState
import centraid.screen.v1.VaultLockup
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import dev.centraid.shared.platform.NetworkStatus
import dev.centraid.shared.platform.PlatformServices
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.sync.ChangeStream
import dev.centraid.shared.sync.LinkConditions
import dev.centraid.shared.sync.RadioResume
import dev.centraid.shared.sync.ScreenFetches
import dev.centraid.shared.sync.ScreenReads
import dev.centraid.shared.sync.ScreenRuntime
import dev.centraid.shared.sync.ScreenWrites
import dev.centraid.shared.sync.SyncWindowPolicy
import dev.centraid.shared.sync.TailResume
import dev.centraid.shared.sync.TransferRule
import dev.centraid.shared.sync.WakeReason
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
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
     * R-1020-24 is one core per process and `SingleHandleGuard` refuses a
     * second, so Tally, Photos and Notes read through the handle this session
     * already holds. Until this method existed nothing served their `ReadPage`
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
        /** Null for a screen with no download affordance. See [ScreenFetches]. */
        fetches: ScreenFetches<E>? = null,
    ): Job {
        changes.route(host)
        return ScreenRuntime(
            core = { core },
            host = host,
            reads = reads,
            scope = scope,
            writes = writes,
            fetches = fetches,
            // THE SHELL STATES THE WINDOW, here as in `passOn` above. A tap's
            // window is a FOREGROUND one — the member is looking at the screen
            // — and it carries the radio's `metered` and the member's rule so
            // the core's echo is honest; neither can change the outcome, since
            // the one-item narrowing is checked before the rule (D-1025-S7-63).
            window = { SyncWindowPolicy.current(WakeReason.FOREGROUND, services) },
        ).start()
    }

    /**
     * ADMIT A VAULT ONTO THIS DEVICE (#1020, D-1020-B7; #1025 S7-9).
     *
     * **It does not ride this session's core, and that is the fix.** It used
     * to: `Request::Pair` went down the live handle, `Handle::pair` bootstrapped
     * the new vault's first copy into the file that handle was open on, and the
     * vault the member was reading was replaced. [Shelf.admit] always pairs
     * from a fresh file, and the first vault and the Nth take the identical
     * path.
     *
     * The session REBINDS afterwards, because the shelf has moved the
     * foreground to the vault just admitted.
     *
     * A refusal is a CODE from the shelf and the sentence is made HERE, from
     * this table. A failure's own words are for a log — the simulator showed a
     * member "the gateway is unreachable: the gateway did not answer the
     * pairing request", which is a Rust error's `Display` and not a sentence
     * anyone should read. And the two "no" cases read the same on purpose: a
     * member holding a screenshot of an old QR must not learn from the answer
     * whether that ticket ever existed.
     */
    public suspend fun pair(ticket: String, deviceName: String, platform: String): PairOutcome {
        return when (val outcome = shelf.admit(ticket, deviceName, platform)) {
            is Shelf.AdmitOutcome.Refused -> PairOutcome.Refused(
                when (outcome.because) {
                    Shelf.AdmitRefusal.ALREADY_HELD ->
                        "This device already holds that vault."
                    Shelf.AdmitRefusal.UNREACHABLE ->
                        "Centraid could not reach that gateway. Check it is running and try again."
                    Shelf.AdmitRefusal.BAD_TICKET ->
                        "That pairing code was not accepted. Show a new one."
                    Shelf.AdmitRefusal.NO_CORE ->
                        "Centraid could not pair this device right now."
                },
            )
            is Shelf.AdmitOutcome.Admitted -> {
                rebind()
                // THE VAULT'S OWN NAME WHEN THERE IS ONE, and an honest
                // sentence when there is not. The ticket carries the gateway's
                // `--vault-name` flag, which on a seeded demo says "Centraid"
                // over a vault called "Tahoe Demo", so a sheet that printed it
                // as fact would name the wrong thing at the one moment a member
                // is checking they paired with what they meant to.
                if (outcome.copyLanded) {
                    PairOutcome.Paired(outcome.holding.name)
                } else {
                    PairOutcome.Copying
                }
            }
        }
    }

    /**
     * FORGET A VAULT (#1025 S7-9).
     *
     * The inverse of [pair]: [Shelf.forget] closes the core, drops the holding,
     * and deletes the replica, its byte store, its sidecars, its pairing record
     * and this device's endpoint key for it. The session rebinds onto whatever
     * the shelf brought forward, which is the first remaining holding, or the
     * pairing path on a device that now holds none.
     *
     * **The gateway keeps this device enrolled.** See [Shelf.forget].
     */
    public suspend fun forget(vaultId: String) {
        shelf.forget(vaultId)
        rebind()
    }

    /**
     * RUN ONE ROUND OVER THE SHELF (#1025 S7-9).
     *
     * A round is one pass PER HOLDING, foreground first, under the one window
     * [SyncWindowPolicy] decided — one deadline shared by the whole round, not
     * a fresh deadline per vault, because the OS gave this wake one budget and
     * a walk that re-read the policy per holding would spend it N times.
     *
     * **Foreground first, always.** The vault the member is looking at gets the
     * budget while there is budget: a round that walked the directory's order
     * would spend a metered window on a vault nobody has open and leave the one
     * on screen stale.
     *
     * **Bytes are the window's decision and not a second mechanism.** A metered
     * window already carries `metered`, which is exactly "rows still pull;
     * bytes do not" ([dev.centraid.shared.sync.TransferRule]), so a
     * background holding on a metered link moves rows and intents and no
     * originals without this function deciding anything. On an unmetered link
     * every holding gets a full pass. The shell computes nothing here; it
     * chooses the ORDER and states the window once.
     *
     * Each holding's outcome is recorded on the shelf on the way past, which is
     * what moves its state — and therefore its row in the switcher and, for the
     * foreground one, the header's second line.
     *
     * Answers the FOREGROUND holding's outcome, because that is the one whose
     * sentence a member is about to read. The others moved the roster.
     */
    public suspend fun syncNow(wake: WakeReason = WakeReason.FOREGROUND): SyncOutcome {
        // `Sync now` IS "RECONNECT THE TAIL" (#1025 S2, D-1025-S7-40).
        //
        // There is one mechanism for becoming current and a button cannot be a
        // second one. When a tail is already open this device is current within
        // one round trip, and a pass would be a second dial to learn what the
        // open stream already knows — so the answer is a sentence, and the
        // member is told the true thing rather than shown a spinner that means
        // nothing.
        // A MARKED TAIL OVER AN UNREACHABLE LAST PASS IS NOT LIVE (R-SHELL-1).
        // `openTail` sets `tailing` when the stream is asked for; Sync now must
        // still dial when the last answer was unreachable rather than claim the
        // vault is live.
        val front = shelf.foregroundHolding()
        if (front?.tailing == true && front.outcome?.unreachable != true) {
            return SyncOutcome(
                tailOpen = true,
                sentence = "This vault is live \u2014 changes arrive as they happen.",
            )
        }
        val outcome = round(wake)
        // AND THE TAIL IS REOPENED, because that is what the button is for: a
        // foreground wake that ended with no tail open is a device that would
        // otherwise sit on its cursor until the member tapped again.
        if (wake == WakeReason.FOREGROUND) {
            cancelReconnect()
            if (outcome.unreachable) {
                scheduleReconnect()
            } else {
                reconnectAttempt = 0
                openTail()
            }
        }
        return outcome
    }

    /**
     * FOREGROUND: catch every holding up, then hold the front one's log open
     * (#1025 S2, D-1025-S7-40).
     *
     * The one thing a shell does when a member arrives. The round is what it
     * always was — foreground holding first, every holding under the one
     * window, the metered rule unchanged — and the tail is opened after it, on
     * the foreground holding only, because a tail is a stream and a phone
     * holding four vaults would hold four.
     *
     * **There is no timer here and none anywhere else.** A foreground interval
     * is a deleted concept: between the catch-up and the tail closing, this
     * device is current within one round trip. Airplane mode off is not a
     * timer either: [watchRadio] hears the path come back and runs this same
     * occasion again (R-SHELL-4).
     */
    public suspend fun foreground(): SyncOutcome {
        cancelReconnect()
        looking = true
        return catchUpThenTail(lookGen)
    }

    /**
     * THE MEMBER LEFT: close the tail and stop listening for a radio resume.
     *
     * Distinct from [stopTail], which lock and suspend still call. A radio
     * that returns while the member is not looking must not open a tail
     * behind a backgrounded app (D-1025-S7-40, D-1025-S7-41); [lookGen]
     * makes a resume that was already in flight skip [openTail] after this.
     */
    public suspend fun leftTheForeground() {
        lookGen += 1
        looking = false
        cancelReconnect()
        stopTail()
    }

    /**
     * BACKGROUND: close the tail, then one bounded round under the platform's
     * deadline.
     *
     * The tail goes FIRST. The window the OS gives a background refresh is the
     * whole of what this device has, and a stream still parked on a quiet
     * gateway would spend it waiting for a commit nobody is making.
     */
    public suspend fun background(wake: WakeReason = WakeReason.SCHEDULED): SyncOutcome {
        lookGen += 1
        looking = false
        cancelReconnect()
        stopTail()
        return round(wake)
    }

    /**
     * CLOSE THE TAIL. What lock and suspend do.
     *
     * A COMMAND AND NOT A CANCELLATION: the coroutine is blocked inside the
     * core, and cancelling it from out here would abandon a page half applied.
     * The core closes the stream at a page boundary and the call returns with
     * what it moved, which is then recorded like any other pass.
     *
     * Foreground-lost goes through [leftTheForeground] so a later radio-up
     * does not reopen the stream while the member is in the app switcher.
     */
    public suspend fun stopTail() {
        // A LOCK OR LEAVE IS NOT A RESTART. Cancel any backoff first so a
        // job that already settled cannot reopen the stream behind us.
        cancelReconnect()
        val open = tailing ?: return
        stopping = true
        try {
            shelf.core()?.call(
                Envelope(
                    request = Request(
                        command = Command(name = SEAT_TAIL_STOP_COMMAND, invoke_key = "shell"),
                    ),
                ),
            )
            // ORDERED: tell the core first, then wait for the job that is blocked
            // inside it. The other way round waits forever.
            open.join()
            tailing = null
        } finally {
            stopping = false
        }
    }

    /**
     * THE RADIO IS A STREAM (#1025, R-SHELL-4).
     *
     * [NetworkStatus.onChange] fires when the path moves. Airplane mode on
     * lowers reachability (the header may not wait for a hung QUIC socket);
     * airplane mode off, while the member is still looking, is the foreground
     * occasion again — catch up, then hold the tail. A path that stays
     * satisfied while a gateway is down is [TailResume]'s: the dead stream is
     * reopened on a backoff, which is not a poll of a live tail.
     */
    private fun watchRadio() {
        services.networkStatus.onChange { reading ->
            scope.launch { onRadio(reading) }
        }
        scope.launch {
            if (radioOnline == null) {
                radioOnline = services.networkStatus.current().online
            }
        }
    }

    private suspend fun onRadio(reading: NetworkStatus.Reading) {
        val act = RadioResume.act(looking, radioOnline, reading.online)
        radioOnline = reading.online
        when (act) {
            RadioResume.Act.NONE -> Unit
            RadioResume.Act.LOST -> radioLost()
            RadioResume.Act.RESUME -> resumeRadio()
        }
    }

    /**
     * The path went unsatisfied. Lower reachability; do not raise it
     * (trap unreachable-vault). A clean [stopTail] can return a successful
     * outcome, so the holding is marked unreachable here — otherwise the
     * header would keep "synced" over airplane mode.
     */
    private suspend fun radioLost() {
        cancelReconnect()
        stopTail()
        val holding = shelf.foregroundHolding() ?: return
        val outcome = SyncOutcome(
            unreachable = true,
            sentence = "This device is offline.",
        )
        shelf.tailClosed(holding.vaultId, outcome)
        publishSeat(outcome)
        publishLockup()
    }

    /**
     * The path came back while the member is looking. Same occasion as
     * [foreground], without claiming the member just arrived: [lookGen]
     * drops the tail open if they left during the round.
     */
    private suspend fun resumeRadio() {
        val gen = lookGen
        if (!looking) return
        catchUpThenTail(gen)
    }

    /**
     * Catch up, then hold the tail — or, if the gateway did not answer, schedule
     * the reopen (R-SHELL-5). Shared by [foreground], airplane-mode up, and the
     * dead-tail backoff so a restart and a radio-up cannot diverge.
     */
    private suspend fun catchUpThenTail(gen: Int): SyncOutcome {
        val outcome = round(WakeReason.FOREGROUND)
        if (!looking || lookGen != gen) return outcome
        if (outcome.unreachable) {
            scheduleReconnect()
            return outcome
        }
        reconnectAttempt = 0
        openTail()
        return outcome
    }

    private fun cancelReconnect() {
        reconnect?.cancel()
        reconnect = null
    }

    private fun scheduleReconnect() {
        if (!TailResume.shouldReconnect(looking, stopping, radioOnline)) return
        cancelReconnect()
        val gen = lookGen
        val wait = TailResume.backoffMs(reconnectAttempt)
        reconnectAttempt += 1
        reconnect = scope.launch {
            delay(wait)
            if (lookGen != gen) return@launch
            resumeRadio()
        }
    }

    /**
     * Hold the foreground holding's log open until something closes it.
     *
     * Launched rather than awaited, and that is the whole point: the tail lasts
     * as long as the member is looking at the app, and the pages it applies
     * reach the screen as change events rather than as this function's return
     * value.
     */
    private suspend fun openTail() {
        if (tailing?.isActive == true) return
        val holding = shelf.foregroundHolding() ?: return
        val core = shelf.awaken(holding.vaultId) ?: return
        val window = SyncWindowPolicy.current(WakeReason.FOREGROUND, services, tail = true)
        // MARKED WHEN THE STREAM IS ASKED FOR, which is AFTER the round above
        // reported: there is no window in which the header says ONLINE over a
        // device that has not spoken to its gateway.
        shelf.tailOpened(holding.vaultId)
        // THE LOCKUP MOVES WITH THE MARK: roster alone updates the switcher
        // rows; the header reads `vault_changed`, so a freshly opened (or
        // freshly failed) tail must republish here too.
        publishLockup()
        tailing = scope.launch {
            val outcome = passOn(core, window)
            shelf.tailClosed(holding.vaultId, outcome)
            publishSeat(outcome)
            // A DEAD OR SETTLED TAIL MUST REACH THE HEADER (R-SHELL-1). Without
            // this, `tailClosed` updates the holding and the roster while the
            // published lockup keeps the previous ONLINE/"synced" line for the
            // whole outage.
            publishLockup()
            // A DEAD TAIL WHILE LOOKING IS REOPENED (R-SHELL-5). Gateway
            // restart does not move the radio, so [RadioResume] cannot see it.
            // Our own stop and a leave do not come through here as a resume.
            if (TailResume.shouldReconnect(looking, stopping, radioOnline)) {
                scheduleReconnect()
            }
        }
    }

    /** One bounded pass on every holding, foreground first. */
    private suspend fun round(wake: WakeReason): SyncOutcome {
        val window = SyncWindowPolicy.current(wake, services)
        // THE RULE THE SCREENS LABEL CELLS BY (#1025 S4). One place, the same
        // window the pass runs under, so a grid cannot draw a download arrow
        // under one rule while the pass plans under another.
        LinkConditions.rule = TransferRule.read(services.secureStore)
        LinkConditions.metered = window.metered
        val order = shelf.all()
        if (order.isEmpty()) {
            // NO VAULT IS NOT A FAILED PASS, but it is also not a pass: there
            // is nothing to reach. The sentence is what a member reads on a
            // device that has not paired yet.
            return SyncOutcome(unreachable = true, sentence = "No vault is open.")
        }
        var front: SyncOutcome? = null
        for (holding in order) {
            // AWAKEN AND NOT bringToFront (#1025 S7-13). Every holding's core
            // is already open, so the round reads each one where it stands; it
            // does not move the foreground and has nothing to move back. A
            // resting holding — one the OS made the shelf close — is reopened
            // here and stays open.
            val core = shelf.awaken(holding.vaultId) ?: continue
            shelf.passStarted(holding.vaultId)
            val outcome = passOn(core, window)
            // THE NAME, RE-READ AFTER THE PASS THAT MAY HAVE BROUGHT IT. A
            // vault whose first copy landed in this very pass can finally say
            // what it is called, and until then it is wearing the ticket's
            // placeholder.
            val named = VaultRoster.identify(core)
            shelf.passSettled(holding.vaultId, outcome, named?.vault_name)
            if (front == null) front = outcome
        }
        // THE FOREGROUND NEVER MOVED, so there is nothing to move back. What
        // the rebind is still for is the LOCKUP: a pass has just changed this
        // vault's state, and rebinding onto the core already bound publishes it
        // without touching the runtime or the reader.
        rebind()
        val answer = front ?: SyncOutcome(unreachable = true, sentence = "No vault is open.")
        publishSeat(answer)
        return answer
    }

    /** One pass on one open core. */
    private suspend fun passOn(
        core: CentraidCore,
        window: centraid.core.v1.SyncWindow,
    ): SyncOutcome {
        val answer = core.call(
            Envelope(
                request = Request(
                    command = Command(
                        name = SEAT_SYNC_COMMAND,
                        invoke_key = "shell",
                        // THE WINDOW IS THE SHELL'S TO STATE (#1025 S2, S5).
                        // How long this pass has and what it may spend are the
                        // OS's numbers and the radio's, and the core used to
                        // hold both as constants. `SyncWindowPolicy` is the one
                        // place they are decided, and the round states it once.
                        sync_window = window,
                    ),
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
                // THE REPORT, RENDERED (#1025 S7). It rides as canonical JSON
                // in `output`, which is every command's answer shape, so no
                // shell needs a second decoder — and every value below is read
                // out of it verbatim. **Nothing here decides anything**: which
                // stage stopped, why, and what a member is owed are all the
                // core's answers, because a shell that inferred them from
                // counts is how "Synced: 0 changes" ended up over a write that
                // was going nowhere.
                val body = outcome?.output?.utf8()
                val fromWindow = body?.objectField("window")
                SyncOutcome(
                    rowsApplied = body?.intField("rowsApplied") ?: 0L,
                    blobsCompleted = body?.intField("blobsCompleted") ?: 0L,
                    bytesMoved = body?.intField("bytesMoved") ?: 0L,
                    unreachable = body?.boolField("unreachable") ?: true,
                    sentence = outcome?.reason.orEmpty(),
                    behind = body?.intField("behind") ?: 0L,
                    tailOpen = body?.boolField("tailOpen") ?: false,
                    cutByTheDeadline = body?.boolField("cutByTheDeadline") ?: false,
                    parked = body?.boolField("parked") ?: false,
                    originalsWithheld = body?.objectField("stages")
                        ?.objectField("bytes")?.intField("withheld") ?: 0L,
                    budget = fromWindow?.stringField("budget").orEmpty(),
                    metered = fromWindow?.boolField("metered") ?: false,
                    bootstrap = body?.stageField("bootstrap") ?: StageReport(),
                    copyFetched = body?.objectField("stages")
                        ?.objectField("bootstrap")?.intField("bytesFetched") ?: 0L,
                    copyTotal = body?.objectField("stages")
                        ?.objectField("bootstrap")?.intField("bytesTotal") ?: 0L,
                    rows = body?.stageField("rows") ?: StageReport(),
                    intents = body?.stageField("intents") ?: StageReport(),
                    bytes = body?.stageField("bytes") ?: StageReport(),
                )
            }
        }
    }

    /**
     * SAY WHAT THIS SEAT IS, after a pass that just found out (#1025 S5,
     * D-1025-S5-6).
     *
     * Composed from the two things the shell genuinely knows: the platform's
     * connectivity answer, and whether the pass it just ran reached the
     * gateway. `centraid.core.v1.ConnectivityEvent` exists on the event stream
     * and **has no producer in `crates/core`**, so sourcing it from there would
     * be sourcing it from nothing; when it gains one, this is the function that
     * changes and no screen does.
     *
     * `platformRefused` is not online. `WriteGate`'s own comment says why: a
     * pass asks the platform for the real answer rather than assuming a radio,
     * and an unknown answer is not a yes — a guess here sends a write into a
     * void.
     *
     * Durability is the PASS's answer and not the radio's: a seat that reached
     * its gateway this window wrote authoritatively, and one that did not is
     * local-only whatever the Wi-Fi says. Those are different questions and
     * this is the one a member means by "is my work safe".
     */
    private suspend fun publishSeat(outcome: SyncOutcome) {
        val reading = services.networkStatus.current()
        changes.publishSeat(
            SeatState(
                availability = if (core == null) {
                    SeatState.Availability.AVAILABILITY_WAITING_FOR_MOUNT
                } else {
                    SeatState.Availability.AVAILABILITY_READY
                },
                durability = if (outcome.unreachable || outcome.blocked != null) {
                    SeatState.Durability.DURABILITY_LOCAL_ONLY
                } else {
                    SeatState.Durability.DURABILITY_AUTHORITATIVE
                },
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
        // THE TAIL FIRST (#1025 S2, D-1025-S7-40). A core closed under a pass
        // that is blocked inside it is the one teardown order that hangs, and a
        // tail is a pass that does not end on its own.
        lookGen += 1
        looking = false
        cancelReconnect()
        stopTail()
        shelf.closeAll()
        scope.cancel()
    }

    /**
     * THE OS IS ASKING FOR MEMORY BACK (#1025 S7-13).
     *
     * Wired from iOS's `didReceiveMemoryWarning` and Android's `onTrimMemory`.
     * Every background vault's core closes; the foreground's stays, because a
     * memory warning is not a reason to empty the screen a member is reading.
     * A rested vault reopens on the next tap or the next sync round.
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
     * **REBINDING TO THE CORE ALREADY BOUND IS NOT A REBIND** (syncNow's
     * closing rebind when the foreground has not moved). Early-return is
     * valid only when the foreground core identity is unchanged (R-HOME-1);
     * the lockup is still published because a pass has just moved this
     * vault's state.
     */
    private suspend fun rebind(): Unit = rebinding.withLock {
        val open = core
        if (open != null && open === bound) {
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
        publishLockup()
    }

    /**
     * The core the change reader is currently pointed at.
     *
     * Compared by IDENTITY and not by vault id. A switch moves the foreground
     * to another holding's already-open core (D-1025-S7-13), so this changes
     * on every real A→B move; the early-return above is the syncNow case
     * where it does not. It still has to be identity for a holding woken
     * from [Shelf.rest] and a re-pair, where the handle under one vault id
     * is replaced.
     */
    private var bound: CentraidCore? = null

    /**
     * THE JOB HOLDING THE FOREGROUND HOLDING'S LOG OPEN (#1025 S2,
     * D-1025-S7-40).
     *
     * ONE, because a tail is a stream and a device holding four vaults would
     * hold four. The other holdings get a bounded catch-up on the round, which
     * is what "a tail with an immediate close" is.
     *
     * Null is a session with no tail open: a background window, a locked
     * device, a radio that dropped, or a foreground that has not reached its
     * gateway yet. A *live* tail has no interval (D-1025-S7-40). A *dead* one
     * while the member is looking is reopened on a backoff (R-SHELL-5).
     */
    private var tailing: Job? = null

    /**
     * THE MEMBER IS LOOKING AT THE APP (R-SHELL-4).
     *
     * True between [foreground] and [leftTheForeground] / [background]. A
     * radio that returns only reopens the tail while this is true; [lookGen]
     * invalidates an in-flight resume so a leave during the round cannot
     * open a stream behind the app switcher.
     */
    private var looking: Boolean = false
    private var lookGen: Int = 0

    /**
     * True only while [stopTail] is asking the core to close the stream, so
     * the job that then settles does not schedule a reconnect of a stop we
     * issued (lock, leave, radio-down).
     */
    private var stopping: Boolean = false

    /** Backoff job for a dead tail (R-SHELL-5). Null while nothing is waiting. */
    private var reconnect: Job? = null
    private var reconnectAttempt: Int = 0

    /**
     * Last radio reading this session heard. Null until [watchRadio] seeds
     * it or the first [NetworkStatus.onChange] arrives; see [RadioResume].
     */
    private var radioOnline: Boolean? = null

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
         * Open a session over the replicas at [replicaDir] (#1025 S5,
         * D-1025-S5-2; #1025 S7-9).
         *
         * ## A DIRECTORY, NOT A LIST OF PATHS, AND A SEAT, NOT A GATEWAY
         *
         * Both halves of this signature changed in S5 and both were wrong for
         * the same reason: wave A's shell opened whatever `.db` files had been
         * PLACED in its container, as a `GATEWAY`, because there was no way for
         * a phone to get a vault of its own. `mobile/scripts/demo-vault.sh`
         * copied a gateway-role artifact in — a vault with every private table
         * and the device's own authority over rows it was supposed to be a copy
         * of — and the role in the config said so honestly.
         *
         * [D-1025-S1-1] built the real path: open unpaired, pair, and the
         * pairing takes the copy. So the shelf opens `SEAT_REPLICATED` cores at
         * replica paths, and a file may not exist yet — `Core::open` on a
         * missing seat path answers a handle whose reads are `Unpaired`, which
         * is a screen a member can read and not a crash.
         *
         * ## The order is load-bearing
         *
         * 1. [Shelf.load] runs FIRST, and with nothing else open: it probes
         *    each replica in turn to name it, and `SingleHandleGuard` allows
         *    one core per process (R-1020-24). It ends holding the foreground
         *    vault's core, which is the one everything below binds to.
         * 2. The runtime collects effects BEFORE `Opened` is sent, because
         *    `ScreenHost` buffers only `EFFECT_BUFFER` of them and the read
         *    Home asks for on open is the first one emitted. A runner attached
         *    afterwards would miss it and every tile would sit `LOADING` for
         *    ever.
         * 3. The change stream starts with the runtime and not later, because
         *    a bootstrap's first rows land during the first pass — a consumer
         *    attached after it would show a springboard of the counts the vault
         *    had before it was filled.
         */
        public suspend fun open(
            replicaDir: String,
            services: PlatformServices,
            dispatcher: CoroutineDispatcher,
            uiThreadName: String,
        ): HomeSession {
            val scope = CoroutineScope(SupervisorJob() + dispatcher)
            val host = ScreenHost(HomeMachine)
            val shelf = Shelf(replicaDir, services, dispatcher, uiThreadName)
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
            // THE RADIO, FOR THE LIFE OF THE SESSION (R-SHELL-4). Seeded here
            // so a monitor's first "path is satisfied" is not a resume.
            session.watchRadio()
            host.send(HomeEvent(opened = HomeEvent.Opened()))
            return session
        }
    }
}
