package dev.centraid.shared.shell

import centraid.core.v1.Envelope
import centraid.core.v1.PageRequest
import centraid.core.v1.Request
import centraid.screen.v1.HomeEvent
import centraid.screen.v1.ReadFailure
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.sync.AppQueryOutcome
import dev.centraid.shared.sync.askCore
import dev.centraid.shared.sync.deniedFailure
import dev.centraid.shared.sync.fromCore
import dev.centraid.shared.sync.sentenceFor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * THE EFFECT RUNNER — what turns Home's `ReadPage` into a real read
 * (#1020, wave A; #1025 live-home).
 *
 * `ScreenHost` publishes a state and then emits effects; up to now nothing on
 * either shell collected them, so `HomeMachine` asked for its tiles on every
 * open and no read was ever issued. Home has been drawing its seeded `LOADING`
 * state for that reason and no other.
 *
 * **The runner is the shell's, not the machine's.** A reducer that could read
 * is a reducer that can block, fail, retry and hold a handle, and then nothing
 * about a screen is testable without a vault. So the machine names what it
 * wants as DATA and this class is the only thing in the module that knows a
 * core exists.
 *
 * **ONE READ PER APP, FANNED OUT, EACH LANDING ON ITS OWN.** Home is the only
 * screen that reads more than one thing, and a Home that waited for the slowest
 * app would be a Home nobody sees. Each read sends its own event the moment it
 * answers.
 *
 * **A refused read is `TileRefused`, never an empty `TileArrived`.** That is
 * the fourth state's whole purpose: a tile whose read failed has not learned
 * that its app holds nothing, and grading it `EMPTY` would put the app into
 * first moves and tell a member to start filling something that may already be
 * full.
 *
 * **The core is a SUPPLIER, matching [dev.centraid.shared.sync.ScreenRuntime]
 * (R-HOME-2).** Capturing the handle at construction left Home the one screen
 * that kept reading a vault the member had left after S7-13 kept every holding
 * open, and cancelling-then-restarting the collector on each identity change
 * raced `publishLockup`'s `ReadPage` against a `SharedFlow` with `replay = 0`
 * so every tile sat LOADING forever.
 */
public class HomeRuntime(
    private val core: () -> CentraidCore?,
    private val host: ScreenHost<centraid.screen.v1.HomeState, HomeEvent>,
    private val scope: CoroutineScope,
    /**
     * The device's zone and wall clock, read at every Agenda tile read
     * (#1046). The one tile that answers civil time has to say which zone.
     */
    private val clock: DeviceClock,
) {
    /**
     * Collect this host's effects and serve them for as long as [scope] lives.
     *
     * Started before the first event is sent, because a runner attached after
     * the open would miss the read the open asked for.
     *
     * **[CoroutineStart.UNDISPATCHED], because "started before" has to mean
     * SUBSCRIBED before.** `ScreenHost.effects` is a `SharedFlow` with
     * `replay = 0`: an effect emitted while nothing is collecting is DROPPED,
     * and `EFFECT_BUFFER` does not change that — a shared flow's buffer holds
     * values for subscribers that exist, never for one that has not arrived.
     * `HomeSession.open` starts this runtime and then sends `Opened` on the
     * next line, so with a plain `scope.launch` the two raced on the
     * dispatcher: when the send won, Home's `ReadPage` went nowhere, no tile
     * read was ever issued, and every tile sat on its seeded `LOADING` state
     * for ever — the exact defect this class was written to close, reappearing
     * as an intermittent one. It reproduced on roughly half the launches of the
     * iOS shell on a simulator. Undispatched, `collect` registers its slot
     * synchronously on the calling thread, so `start()` returning means the
     * effects have somewhere to land.
     */
    public fun start(): Job = scope.launch(start = CoroutineStart.UNDISPATCHED) {
        host.effects.collect { effect ->
            when (effect) {
                is ScreenEffect.ReadPage ->
                    if (effect.screenId == HomeMachine.SCREEN_ID) readAllTiles()
                // Every other effect belongs to a screen this runtime does not
                // serve, or to a plane that is not built. Ignored rather than
                // failed: a runner that threw on an effect it does not own
                // would take the screen down over somebody else's business.
                else -> Unit
            }
        }
    }

    /** Every tile's read, fanned out: the page reads, and Agenda's app query. */
    public fun readAllTiles() {
        HomeReads.READS.forEach { read -> scope.launch { readTile(read) } }
        scope.launch { readAgenda() }
    }

    private suspend fun readTile(read: HomeReads.TileRead) {
        when (val answer = page(read.query, HomeReads.LIMIT)) {
            is Read.Rows -> host.send(
                HomeReads.arrived(
                    appId = read.appId,
                    rows = answer.rows,
                    capped = answer.rows.size >= HomeReads.LIMIT,
                ),
            )
            is Read.Refused -> host.send(refused(read.appId, answer.failure))
        }
    }

    /**
     * AGENDA'S TILE, THROUGH THE APP-QUERY ARM (#1046).
     *
     * Not a page read: the next occurrence of a repeating event is the core's
     * recurrence engine's to answer ([HomeAgendaTile]). Same law as every
     * other tile — its own event the moment it lands, and a read that did not
     * land is `TileRefused`, never an empty tile. A DENIED read is refused
     * too: a launcher tile has no designed ask, and grading it `EMPTY` would
     * send the member to first moves for an app that may be full.
     */
    private suspend fun readAgenda() {
        val request = HomeAgendaTile.request(clock.read())
        val event = when (val outcome = askCore(core(), listOf(request))) {
            is AppQueryOutcome.Answered -> outcome.answers.single().agenda_upcoming
                ?.let(HomeAgendaTile::arrived)
                ?: refused(HomeAgendaTile.APP_ID, Reads.refused(WRONG_ANSWER))
            is AppQueryOutcome.Denied ->
                refused(HomeAgendaTile.APP_ID, deniedFailure(outcome.denial))
            is AppQueryOutcome.Refused -> refused(HomeAgendaTile.APP_ID, outcome.failure)
        }
        host.send(event)
    }

    private fun refused(appId: String, failure: ReadFailure): HomeEvent =
        HomeEvent(tile_refused = HomeEvent.TileRefused(app_id = appId, failure = failure))

    /**
     * WHAT ONE READ CAME BACK AS, and never a nullable pair.
     *
     * A refused read is its own case carrying the FAILURE, because Home's
     * fourth tile state depends on telling "this app holds nothing" apart from
     * "this app could not be asked": grading a failed read `EMPTY` puts the app
     * into first moves and tells a member to start filling something that may
     * already be full.
     */
    private sealed interface Read {
        data class Rows(val rows: List<centraid.core.v1.Row>) : Read

        data class Refused(val failure: ReadFailure) : Read
    }

    private suspend fun page(
        query: centraid.core.v1.PageQuery,
        limit: Int,
    ): Read {
        val handle = core()
            ?: return Read.Refused(Reads.refused("No vault is open on this device."))
        val request = Envelope(
            request_id = 0,
            request = Request(page = PageRequest(query = query, limit = limit)),
        )
        return when (val outcome = handle.call(request)) {
            is CoreOutcome.Failed -> Read.Refused(fromCore(outcome.failure))
            is CoreOutcome.Answered -> {
                val page = outcome.value.response?.page
                val error = outcome.value.error
                when {
                    page != null -> Read.Rows(page.rows)
                    // `Error.detail` IS FOR LOGS AND NEVER FOR A MEMBER. It
                    // carries whatever the failing layer said, including a
                    // SQLite `RAISE(ABORT)` — and one reached a member's screen
                    // through exactly this field in wave 3 (lane E, finding 2).
                    // The code chooses the sentence; the detail is dropped here
                    // because this runtime has nowhere to log it that a support
                    // bundle would read.
                    error != null -> Read.Refused(sentenceFor(error.code))
                    else -> Read.Refused(
                        Reads.refused("The vault answered with neither a page nor a reason."),
                    )
                }
            }
        }
    }

    private companion object {
        /** An answer at another query's arm: a core bug, said as a refusal. */
        const val WRONG_ANSWER: String = "The vault answered a different question."
    }
}
