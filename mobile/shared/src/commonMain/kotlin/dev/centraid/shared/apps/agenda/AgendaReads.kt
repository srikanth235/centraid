package dev.centraid.shared.apps.agenda

import centraid.core.v1.AgendaDayContextRequest
import centraid.core.v1.AgendaSearchRequest
import centraid.core.v1.AgendaUpcomingRequest
import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.screen.v1.AgendaHomeEvent
import centraid.screen.v1.ReadFailure
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.sync.ScreenQueries
import dev.centraid.shared.kit.time.civilDayOf
import dev.centraid.shared.kit.time.epochDayOf
import dev.centraid.shared.kit.time.floorDiv
import dev.centraid.shared.kit.time.plusDays
import dev.centraid.shared.sync.rfc3339FromEpochMillis

/**
 * WHAT AGENDA'S HOME ASKS THE CORE (#1046).
 *
 * Two queries for a window, and a third while a term is typed:
 *
 * - **Day**: `agenda.upcoming` over the anchor day, and `agenda.day-context`
 *   over the same day.
 * - **Schedule and Waiting**: the same two over [AgendaHomeMachine.LIST_DAYS]
 *   days from the anchor. Waiting is a filter over Schedule's window, so the
 *   two share one read and moving between them re-reads nothing.
 * - **Search** with a term: `agenda.search` ([SEARCH_LIMIT] hits) replaces the
 *   upcoming list, and the day context still decorates. The upcoming answer is
 *   asked again only when the one the machine holds is not for this window —
 *   so a keystroke is two queries, and closing search re-folds what is held.
 *
 * ## The window is padded, and the fold cuts it
 *
 * `agenda.upcoming` bounds are INSTANTS, and the instant the anchor's local
 * midnight falls on needs the zone's offset — zone arithmetic `commonMain`
 * does not do (`sync/Instants.kt`). So the bounds are the UTC midnights a day
 * either side of the window: every offset on Earth is inside ±14 hours, so
 * `[anchor − 1 day, end + 1 day)` in UTC covers the window's local days
 * whatever the zone. The core answers every occurrence's `local_days` in the
 * device's zone, and the machine keeps the days it drew; the pad is never
 * shown. Before the first answer the anchor is unknown, and the bounds are the
 * core's own "today" (`from` empty) and the device clock's instant a window on.
 *
 * `agenda.day-context` takes civil days, so it is asked for the window exactly.
 */
public object AgendaReads : ScreenQueries<AgendaHome, AgendaInput> {
    override val screenId: String = AgendaHomeMachine.SCREEN_ID

    /** `AgendaHomeMachine.rowsChanged` answers for exactly these. */
    override val tables: Set<String> = AgendaHomeMachine.TABLES

    /** `agenda.search`'s own ceiling. */
    public const val SEARCH_LIMIT: Int = 100

    private const val MILLIS_PER_DAY: Long = 86_400_000

    override fun requests(state: AgendaHome, now: DeviceClock.Reading): List<AppQueryRequest>? {
        val screen = state.screen
        val span = AgendaHomeMachine.spanOf(screen.destination)
        val anchor = screen.anchor_day
        val upcoming: AgendaUpcomingRequest
        val context: AgendaDayContextRequest
        if (anchor.isEmpty()) {
            // TODAY IS THE CORE'S: an empty `from` is the first instant of
            // today in the zone, and the answer's `today` becomes the anchor.
            upcoming = AgendaUpcomingRequest(
                from = "",
                to = rfc3339FromEpochMillis(now.epochMillis + (span + 1) * MILLIS_PER_DAY),
                tz = now.zone,
            )
            context = AgendaDayContextRequest(
                from = "",
                to = civilDayOf(floorDiv(now.epochMillis, MILLIS_PER_DAY) + span + 1),
                tz = now.zone,
            )
        } else {
            val before = instantOf(plusDays(anchor, -1)) ?: return null
            val after = instantOf(plusDays(anchor, span + 1)) ?: return null
            upcoming = AgendaUpcomingRequest(from = before, to = after, tz = now.zone)
            context = AgendaDayContextRequest(
                from = anchor,
                to = plusDays(anchor, span - 1) ?: return null,
                tz = now.zone,
            )
        }
        val term = AgendaHomeMachine.activeTerm(screen)
        val needUpcoming = term == null ||
            state.answers?.upcoming == null ||
            state.heldWindow != AgendaHomeMachine.windowKey(screen)
        return buildList {
            if (needUpcoming) add(AppQueryRequest(agenda_upcoming = upcoming))
            add(AppQueryRequest(agenda_day_context = context))
            if (term != null) {
                add(
                    AppQueryRequest(
                        agenda_search = AgendaSearchRequest(
                            term = term,
                            limit = SEARCH_LIMIT,
                            tz = now.zone,
                        ),
                    ),
                )
            }
        }
    }

    /** The answers BY ARM, not by position: which were asked depends on the state. */
    override fun arrived(answers: List<AppQueryResponse>): AgendaInput = AgendaInput.Answered(
        upcoming = answers.firstNotNullOfOrNull { it.agenda_upcoming },
        context = answers.firstNotNullOfOrNull { it.agenda_day_context },
        search = answers.firstNotNullOfOrNull { it.agenda_search },
    )

    override fun refused(failure: ReadFailure): AgendaInput = AgendaInput.View(
        AgendaHomeEvent(refused = AgendaHomeEvent.ReadRefused(failure = failure)),
    )

    /** The handoff's denied gate, not a refusal (`AgendaHomeState.denied`). */
    override fun denied(denial: AppQueryDenial): AgendaInput = AgendaInput.Denied(denial)

    /** UTC midnight opening [day], in the vault's instant spelling. */
    private fun instantOf(day: String?): String? =
        day?.let(::epochDayOf)?.let { rfc3339FromEpochMillis(it * MILLIS_PER_DAY) }
}
