package dev.centraid.shared.apps.agenda

import centraid.core.v1.AgendaDayContextRequest
import centraid.core.v1.AgendaSearchRequest
import centraid.core.v1.AgendaUpcomingRequest
import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandStatus
import centraid.core.v1.TasksBoardRequest
import centraid.core.v1.TasksCatchUpRequest
import centraid.core.v1.TasksProjectsRequest
import centraid.core.v1.TasksSearchRequest
import centraid.core.v1.TasksView
import centraid.screen.v1.AgendaHomeEvent
import centraid.screen.v1.AgendaHomeState
import centraid.screen.v1.ReadFailure
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.sync.ScreenQueries
import dev.centraid.shared.sync.ActOutcome
import dev.centraid.shared.sync.ScreenWrites
import dev.centraid.shared.kit.time.civilDayOf
import dev.centraid.shared.kit.time.epochDayOf
import dev.centraid.shared.kit.time.floorDiv
import dev.centraid.shared.kit.time.plusDays
import dev.centraid.shared.sync.rfc3339FromEpochMillis

/**
 * WHAT AGENDA'S HOME ASKS THE CORE (#1046, #1128).
 *
 * To-do asks `tasks.board` (INBOX) and `tasks.projects` and no event. Every
 * other place asks two queries for a window, and a third while a term is typed:
 *
 * - **Day**: `agenda.upcoming` over the anchor day, and `agenda.day-context`
 *   over the same day.
 * - **Schedule and Waiting**: the same two over [AgendaHomeMachine.LIST_DAYS]
 *   days from the anchor. Waiting is a filter over Schedule's window, so the
 *   two share one read and moving between them re-reads nothing.
 * - **Tasks on their days (R-1128-4)**: Day and Schedule also ask `tasks.board`
 *   TODAY (its Overdue group, then today) and UPCOMING (a group per later day),
 *   at the board's ceiling so a window is not cut short, and Day asks
 *   `tasks.catch-up` for the absence notice while its window holds today.
 *   Waiting asks no task. The boards do not depend on the anchor, but they are
 *   asked with every window read, so a day step never draws a stale one.
 * - **Search** with a term: `agenda.search` ([SEARCH_LIMIT] hits) replaces the
 *   upcoming list, `tasks.search` adds the tasks it found and the projects
 *   whose name it matched (Q-1128-1), and the day context still decorates.
 *   The upcoming answer (and the boards) are asked again only when the ones
 *   the machine holds are not for this window — so a keystroke is three
 *   queries, and closing search re-folds what is held.
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
public object AgendaReads : ScreenQueries<AgendaHome, AgendaInput>, ScreenWrites<AgendaHome, AgendaInput> {
    override val screenId: String = AgendaHomeMachine.SCREEN_ID

    /** `AgendaHomeMachine.rowsChanged` answers for exactly these. */
    override val tables: Set<String> = AgendaHomeMachine.TABLES

    /** The task writes (`task.*`) are Agenda's: it is the app the member is in (R-1128-5). */
    override val appId: String = "agenda"

    /** `agenda.search`'s own ceiling. */
    public const val SEARCH_LIMIT: Int = 100

    /** The dated boards' window: the board's own ceiling (`TodoPlace.MAX_WINDOW`). */
    public const val BOARD_LIMIT: Int = TodoPlace.MAX_WINDOW

    private const val MILLIS_PER_DAY: Long = 86_400_000

    override fun requests(state: AgendaHome, now: DeviceClock.Reading): List<AppQueryRequest>? {
        val screen = state.screen
        val zone = now.zone
        // TO-DO READS TASKS ALONE, unless a term is typed: then it is search,
        // which asks the events too.
        if (screen.destination == AgendaHomeState.Destination.DESTINATION_TODO &&
            AgendaHomeMachine.activeTerm(screen) == null
        ) {
            return listOf(
                AppQueryRequest(
                    tasks_board = TasksBoardRequest(
                        tz = zone,
                        limit = state.tasks.limit,
                        view = TasksView.TASKS_VIEW_INBOX,
                    ),
                ),
                AppQueryRequest(tasks_projects = TasksProjectsRequest(tz = zone)),
            )
        }
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
        val key = AgendaHomeMachine.windowKey(screen)
        val needUpcoming = term == null ||
            state.answers?.upcoming == null ||
            state.heldWindow != key
        // DAY AND SCHEDULE DRAW TASKS; WAITING AND TO-DO'S SEARCH DO NOT.
        val dated = screen.destination == AgendaHomeState.Destination.DESTINATION_DAY ||
            screen.destination == AgendaHomeState.Destination.DESTINATION_SCHEDULE
        val needBoards = dated && (term == null || state.tasks.today == null || state.tasks.heldDated != key)
        return buildList {
            if (needUpcoming) add(AppQueryRequest(agenda_upcoming = upcoming))
            add(AppQueryRequest(agenda_day_context = context))
            if (needBoards) {
                add(AppQueryRequest(tasks_board = TasksBoardRequest(tz = zone, limit = BOARD_LIMIT, view = TasksView.TASKS_VIEW_TODAY)))
                add(AppQueryRequest(tasks_board = TasksBoardRequest(tz = zone, limit = BOARD_LIMIT, view = TasksView.TASKS_VIEW_UPCOMING)))
                if (screen.destination == AgendaHomeState.Destination.DESTINATION_DAY && windowHoldsToday(state, span)) {
                    add(AppQueryRequest(tasks_catch_up = TasksCatchUpRequest(tz = zone)))
                }
            }
            if (term != null) {
                add(AppQueryRequest(tasks_search = TasksSearchRequest(term = term, limit = SEARCH_LIMIT, tz = zone)))
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

    /**
     * DOES THE WINDOW HOLD TODAY? Before the first answer the anchor is empty and
     * IS today; after it, today is the one the answers name.
     */
    private fun windowHoldsToday(state: AgendaHome, span: Int): Boolean {
        val anchor = state.screen.anchor_day
        if (anchor.isEmpty()) return true
        val today = state.answers?.let { it.context.today.ifEmpty { it.upcoming.today } }.orEmpty()
        return today.isNotEmpty() && today >= anchor && today <= (plusDays(anchor, span - 1) ?: anchor)
    }

    /** The answers BY ARM, not by position: which were asked depends on the state. */
    override fun arrived(answers: List<AppQueryResponse>): AgendaInput = AgendaInput.Answered(
        upcoming = answers.firstNotNullOfOrNull { it.agenda_upcoming },
        context = answers.firstNotNullOfOrNull { it.agenda_day_context },
        search = answers.firstNotNullOfOrNull { it.agenda_search },
        tasks = TasksAnswers(
            inbox = answers.firstNotNullOfOrNull { it.tasks_board?.takeIf { board -> board.view == TasksView.TASKS_VIEW_INBOX } },
            projects = answers.firstNotNullOfOrNull { it.tasks_projects },
            today = answers.firstNotNullOfOrNull { it.tasks_board?.takeIf { board -> board.view == TasksView.TASKS_VIEW_TODAY } },
            upcoming = answers.firstNotNullOfOrNull { it.tasks_board?.takeIf { board -> board.view == TasksView.TASKS_VIEW_UPCOMING } },
            catchUp = answers.firstNotNullOfOrNull { it.tasks_catch_up },
            search = answers.firstNotNullOfOrNull { it.tasks_search },
        ),
    )

    override fun refused(failure: ReadFailure): AgendaInput = AgendaInput.View(
        AgendaHomeEvent(refused = AgendaHomeEvent.ReadRefused(failure = failure)),
    )

    /** The handoff's denied gate, not a refusal (`AgendaHomeState.denied`). */
    override fun denied(denial: AppQueryDenial): AgendaInput = AgendaInput.Denied(denial)

    /** A task write's outcome, as the machine's own settle event. */
    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): AgendaInput =
        AgendaInput.View(AgendaHomeEvent(write_settled = WriteLaw.settledOf(status, sentence, invokeKey)))

    /** A To-do write's answer through THE ONE WRITE, with the inverse Undo sends. */
    override fun actSettled(outcome: ActOutcome, invokeKey: String): AgendaInput =
        AgendaInput.TaskActed(WriteLaw.settledOf(outcome, invokeKey), (outcome as? ActOutcome.Executed)?.inverse)

    /** UTC midnight opening [day], in the vault's instant spelling. */
    private fun instantOf(day: String?): String? =
        day?.let(::epochDayOf)?.let { rfc3339FromEpochMillis(it * MILLIS_PER_DAY) }
}
