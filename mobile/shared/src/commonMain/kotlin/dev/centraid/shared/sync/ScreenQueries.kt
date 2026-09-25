package dev.centraid.shared.sync

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.Envelope
import centraid.core.v1.Request
import centraid.screen.v1.ReadFailure
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenHost
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * WHAT ONE APP SCREEN ASKS THE CORE, WHEN A PAGE READ CANNOT SAY IT (#1046).
 *
 * [ScreenReads]' sibling. A `PageRequest` names one table, and an app's own
 * query does not fit in one: Agenda's `upcoming` joins six-plus tables and
 * expands every repeating series through the one recurrence engine
 * (D-1020-S1), so a Kotlin rebuild of it would be a second engine. The core
 * runs it (`app_query.proto`) and answers a TYPED message, and this is the
 * screen's half: which queries, and what the answers become.
 *
 * ## Several queries, ONE event
 *
 * [requests] answers a LIST, run in order and delivered to [arrived] together.
 * Agenda's home is an `upcoming` range, the day context that decorates it and
 * the parties an event can invite, and its data case cannot be constructed
 * from any one of them — `HomeSession.attachReads`' ruling on the two shapes of
 * a multi-read screen puts that fold in one place, and this is that place.
 *
 * ## [tables] is checked against the machine
 *
 * An app query reads several tables and the core does not say which, so the
 * screen declares them, and `AppReadsSpec` asserts they are EXACTLY the tables
 * its machine's `rowsChanged` reacts to, over every table in the vault DDL. A
 * table read and not declared is a screen that goes stale on sync with nothing
 * red; one declared and not read is a re-read nobody needed.
 *
 * ## The device clock is an argument
 *
 * Most app queries state a `tz` (every app's, not only Agenda's), and an
 * empty one on a freshly founded vault is REFUSED (`agenda.proto`'s zone rule) — so the runtime reads the
 * platform's zone at every read and hands it in. A reads object that captured
 * a zone would place a traveller's morning in the city they left.
 */
public interface ScreenQueries<S, E> {
    /** The `screenId` this screen's `ReadPage` effects carry. */
    public val screenId: String

    /** Every table the queries read, and exactly the ones `rowsChanged` names. */
    public val tables: Set<String>

    /**
     * The queries for this read, in the order they run, or null when the
     * screen cannot yet say what to read. An EMPTY list is the same refusal:
     * a read of nothing is not a read.
     *
     * [now] is one reading for the whole list, so two queries of one read
     * never straddle a zone change or a midnight between them.
     */
    public fun requests(state: S, now: DeviceClock.Reading): List<AppQueryRequest>?

    /**
     * Every answer, in request order, as this screen's `DataArrived`.
     *
     * A screen that needs to know WHAT was asked overrides the two-argument
     * form instead, and may leave this one unimplemented.
     */
    public fun arrived(answers: List<AppQueryResponse>): E =
        error("$screenId implements neither arrived(answers) nor arrived(answers, requests)")

    /**
     * Every answer beside the request it answers, in order — so a machine can
     * tell an answer to a search term the member has since changed from one to
     * the term on screen, and drop the stale one. The runtime calls this; the
     * default forgets the requests.
     */
    public fun arrived(answers: List<AppQueryResponse>, requests: List<AppQueryRequest>): E = arrived(answers)

    /** The refusal, as this screen's `ReadRefused`. */
    public fun refused(failure: ReadFailure): E

    /**
     * THE VAULT WOULD NOT LET THIS APP READ — a STATE, not an error
     * (`app_query.proto`): a screen that draws the ask overrides this.
     *
     * The default is the refusal with the vault's own sentence, which is the
     * right answer for every screen that has no designed denied state. Today
     * nothing produces one — the phone is the owner and its door evaluates no
     * grant (#1029 §1) — and the arm is carried so a door that grows a consent
     * check changes no shell.
     */
    public fun denied(denial: AppQueryDenial): E = refused(deniedFailure(denial))
}

/**
 * THE EFFECT RUNNER FOR A [ScreenQueries] SCREEN (#1046).
 *
 * [ScreenRuntime]'s rules, kept rather than restated: the collector starts
 * [CoroutineStart.UNDISPATCHED] so the first `ReadPage` cannot be emitted into
 * an empty room; the core is a SUPPLIER so a vault switch is picked up by the
 * next read; a screen that cannot say what to read and a device with no vault
 * are told so in a sentence; an error is `sentenceFor(error.code)` and
 * `Error.detail` never reaches a member. A write is [serveWrite], the same
 * function [ScreenRuntime] serves one with.
 *
 * `ReadPage.afterCursor` is ignored: an app query is not a keyset walk, and a
 * screen that pages one says so in its own request.
 */
public class ScreenQueryRuntime<S, E>(
    private val core: () -> CentraidCore?,
    private val host: ScreenHost<S, E>,
    private val queries: ScreenQueries<S, E>,
    private val clock: DeviceClock,
    private val scope: CoroutineScope,
    /** Null for a screen with no write. See [ScreenWrites]. */
    private val writes: ScreenWrites<S, E>? = null,
    /** Why this vault refuses writes, or null. See [ScreenRuntime]'s field. */
    private val readOnly: () -> String? = { null },
    /** Whether the screen was left. See [ScreenRuntime]'s field. */
    private val left: () -> Boolean = { false },
    /** Where a write that failed after its screen was left is told. */
    private val stranded: StrandedWrites? = null,
) {
    /** Collect this host's effects and serve this screen's. See [ScreenRuntime.start]. */
    public fun start(): Job = scope.launch(start = CoroutineStart.UNDISPATCHED) {
        host.effects.collect { effect ->
            if (effect is ScreenEffect.ReadPage && effect.screenId == queries.screenId) {
                scope.launch { serve() }
            }
            if (effect is ScreenEffect.SubmitWrite && writes != null) {
                // PINNED AT EMIT. See [ScreenRuntime.start].
                val pinned = PinnedVault(core(), readOnly())
                scope.launch { serveWrite(effect, writes, host, pinned, left, stranded) }
            }
            if (effect is ScreenEffect.Schedule && effect.screenId == queries.screenId) {
                scope.launch { serveSchedule(effect, host) }
            }
        }
    }

    private suspend fun serve() {
        val now = clock.read()
        val requests = queries.requests(host.state.value, now)
        val event = if (requests.isNullOrEmpty()) {
            // NOT SILENCE — [ScreenRuntime.serve]'s rule: a screen that asked
            // and heard nothing sits on its loading state for ever.
            queries.refused(Reads.refused(NOTHING_TO_READ))
        } else {
            when (val outcome = askCore(core(), requests)) {
                is AppQueryOutcome.Answered -> queries.arrived(outcome.answers, requests)
                is AppQueryOutcome.Denied -> queries.denied(outcome.denial)
                is AppQueryOutcome.Refused -> queries.refused(outcome.failure)
            }
        }
        host.send(event)
    }
}

/** What a run of app queries came back as. Never a nullable list. */
internal sealed interface AppQueryOutcome {
    /** Every query answered, in request order. */
    data class Answered(val answers: List<AppQueryResponse>) : AppQueryOutcome

    /** One query was denied; the rest were not asked. */
    data class Denied(val denial: AppQueryDenial) : AppQueryOutcome

    /** One query could not be answered at all; the rest were not asked. */
    data class Refused(val failure: ReadFailure) : AppQueryOutcome
}

/**
 * RUN [requests] IN ORDER, AND STOP AT THE FIRST THAT DOES NOT ANSWER (#1046).
 *
 * Shared by [ScreenQueryRuntime] and Home's Agenda tile, because "what does a
 * member read when an app query fails" has one answer, the one
 * `ReadFailures.kt` gives page reads.
 *
 * **ONE FAILURE FAILS THE READ.** The answers are folded into one state, and a
 * state built from two of three answers is a screen that draws a Day with no
 * birthdays on it as if there were none — the short answer that reads as a
 * whole one (D-1020-D3-12). So the first query that is denied or refused ends
 * the run, and nothing after it is asked.
 *
 * A zone the platform could not name is refused HERE, before the core is
 * asked: the core would refuse it too, but as `INVALID_REQUEST`, whose sentence
 * says nothing a member can act on.
 */
internal suspend fun askCore(
    handle: CentraidCore?,
    requests: List<AppQueryRequest>,
): AppQueryOutcome {
    if (handle == null) return AppQueryOutcome.Refused(Reads.refused(NO_VAULT))
    if (requests.any { it.zone()?.isBlank() == true }) {
        return AppQueryOutcome.Refused(Reads.refused(NO_ZONE))
    }
    val answers = ArrayList<AppQueryResponse>(requests.size)
    for (query in requests) {
        val request = Envelope(request_id = 0, request = Request(app_query = query))
        val answer = when (val outcome = handle.call(request)) {
            is CoreOutcome.Failed -> return AppQueryOutcome.Refused(fromCore(outcome.failure))
            is CoreOutcome.Answered -> {
                val response = outcome.value.response?.app_query
                val error = outcome.value.error
                when {
                    response != null -> response
                    // `Error.detail` IS FOR LOGS AND NEVER FOR A MEMBER — the
                    // rule `ScreenRuntime.serve` states. The code chooses.
                    error != null -> return AppQueryOutcome.Refused(sentenceFor(error.code))
                    else -> return AppQueryOutcome.Refused(Reads.refused(NEITHER))
                }
            }
        }
        answer.denied?.let { return AppQueryOutcome.Denied(it) }
        answers += answer
    }
    return AppQueryOutcome.Answered(answers)
}

/** The refusal a denial becomes on a screen with no designed denied state. */
internal fun deniedFailure(denial: AppQueryDenial): ReadFailure =
    Reads.refused(denial.message?.takeIf { it.isNotBlank() } ?: DENIED)

/**
 * The `tz` a query states, or null for one that states none.
 *
 * EVERY ARM THAT CARRIES A `tz` IS LISTED — `ZonePrecheckSpec` reads the
 * core protos and fails when an arm with a `string tz` field is missing here,
 * so a new app's query cannot slip past the pre-check into `INVALID_REQUEST`.
 */
internal fun AppQueryRequest.zone(): String? =
    agenda_upcoming?.tz ?: agenda_day_context?.tz ?: agenda_search?.tz ?: agenda_event?.tz
        ?: tasks_board?.tz ?: tasks_task?.tz ?: tasks_projects?.tz ?: tasks_search?.tz ?: tasks_catch_up?.tz
        ?: docs_drive?.tz ?: docs_search?.tz ?: docs_document?.tz ?: docs_activity?.tz
        ?: notes_library?.tz ?: notes_journal?.tz ?: notes_trash?.tz ?: notes_history?.tz
        ?: people_roster?.tz ?: people_touch?.tz ?: people_person?.tz
        ?: tally_dashboard?.tz ?: tally_expense?.tz ?: tally_spending?.tz ?: tally_trash?.tz

private const val NOTHING_TO_READ = "Centraid does not know what to read here."
private const val NO_VAULT = "No vault is open on this device."
private const val NO_ZONE = "This device did not say which time zone it is in."
private const val NEITHER = "The vault answered with neither an answer nor a reason."
private const val DENIED = "You do not have access to this."
