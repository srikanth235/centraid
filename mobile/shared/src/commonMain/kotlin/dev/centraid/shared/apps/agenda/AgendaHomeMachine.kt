package dev.centraid.shared.apps.agenda

import centraid.core.v1.AgendaDayContext
import centraid.core.v1.AgendaSearch
import centraid.core.v1.AgendaUpcoming
import centraid.core.v1.AppQueryDenial
import centraid.screen.v1.AgendaBandTab
import centraid.screen.v1.AgendaChrome
import centraid.screen.v1.AgendaFact
import centraid.screen.v1.AgendaHomeEvent
import centraid.screen.v1.AgendaHomeState
import centraid.screen.v1.AgendaToolbar
import centraid.screen.v1.Loading
import centraid.screen.v1.SeatState
import dev.centraid.design.copy.AgendaCopy
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import dev.centraid.shared.kit.time.plusDays

/**
 * WHAT THE MACHINE HOLDS: the state a view draws, and what never reaches one.
 *
 * [screen] is the contract — encoded for SwiftUI, collected by Compose. The
 * rest is the machine's own:
 *
 * - [answers] are the core's RAW typed answers, kept so a local change (a
 *   calendar hidden, search closed, Schedule to Waiting) re-folds without a
 *   re-read. They live here and not on `AgendaHomeState` because a view has no
 *   business with them, and not on `AgendaHomeEvent` because `screen.proto`
 *   cannot import `centraid.core.v1` cleanly — `crates/api-proto` includes the
 *   two packages as sibling modules, and the `super::super::core` path prost
 *   generates out of `screen_v1` does not resolve.
 * - [reading] and [readQueued] keep ONE read in flight. An answer does not say
 *   which request it answers, so a read asked while another is out is queued,
 *   and the answer to the older one is dropped rather than drawn under a day
 *   it was not for — `PhotosGridState.reading`'s rule.
 * - [heldWindow] names the window [answers]' upcoming list was read for, or is
 *   null when it must be read again (a change event, a refresh). A search
 *   keystroke asks for the upcoming list only when it is not held.
 */
public data class AgendaHome(
    public val screen: AgendaHomeState,
    public val answers: AgendaAnswers? = null,
    public val reading: Boolean = false,
    public val readQueued: Boolean = false,
    public val heldWindow: String? = null,
)

/** The last answers the fold was built from. `search` only while a term is. */
public data class AgendaAnswers(
    public val upcoming: AgendaUpcoming,
    public val context: AgendaDayContext,
    public val search: AgendaSearch? = null,
)

/**
 * WHAT REACHES THE MACHINE: a view's event, or the core's answer.
 *
 * The answer is Kotlin-side for [AgendaHome]'s reason. A view only ever sends
 * [View]; [Answered] and [Denied] come from [AgendaReads].
 */
public sealed interface AgendaInput {
    public data class View(public val event: AgendaHomeEvent) : AgendaInput

    /**
     * The answers to one read, BY ARM. [upcoming] is null when it was not
     * asked — a search keystroke over a window already held.
     */
    public data class Answered(
        public val upcoming: AgendaUpcoming?,
        public val context: AgendaDayContext?,
        public val search: AgendaSearch?,
    ) : AgendaInput

    public data class Denied(public val denial: AppQueryDenial) : AgendaInput

    /**
     * THE SESSION'S HELD WRITES ([AgendaMarks]), as the two overlays the rows
     * draw: events with a write in flight, and events with a cancellation in
     * flight. Re-folds; never reads.
     */
    public data class Marks(
        public val pendingEventIds: List<String>,
        public val cancelAskedEventIds: List<String>,
    ) : AgendaInput
}

/**
 * AGENDA'S HOME ON THE PHONE (#1046): Day, Schedule and Waiting, with Search
 * as a mode and More as a sheet.
 *
 * The band is v0's (A-touchviews, #882) — Day, Schedule, Waiting, Search,
 * More; there is no month or hour grid. Opening lands on Day, anchored on the
 * `today` the core answers, never on a device-clock guess.
 *
 * ## What re-reads and what re-folds
 *
 * A read is a WINDOW: the anchor and the destination's span (a day, or
 * [LIST_DAYS]). Changing either re-reads, and the list is skeletons until the
 * new window lands — a day's rows are not drawn under another day's heading.
 * Everything else is local and re-folds [AgendaHome.answers]: hiding a
 * calendar, Schedule to Waiting (one window), closing search, opening a due
 * shelf. A search term re-reads the search and, only when it is not held, the
 * upcoming list; the rows on screen stay while it does.
 *
 * ## Views decide nothing
 *
 * Every string, flag and hue key a view draws is set here or by
 * [AgendaFold]. The band, the day bar and the fixed words are recomputed on
 * every step ([decorate]), so no view derives one from another field.
 */
public object AgendaHomeMachine : ScreenMachine<AgendaHome, AgendaInput> {
    public const val SCREEN_ID: String = "agenda.home"

    /** Schedule's and Waiting's reach from the anchor, in days (v0's). */
    public const val LIST_DAYS: Int = 120

    /**
     * THE TABLES THIS SCREEN'S QUERIES READ — the event and its calendar
     * edge, guests, a series' skipped and moved occurrences, calendars, the
     * people a birthday and a guest name come from, and the tasks the due
     * shelf lists. `AgendaReads.tables` is this set, and `AppReadsSpec`
     * asserts [rowsChanged] answers for exactly it over every vault table.
     */
    public val TABLES: Set<String> = setOf(
        "core_event",
        "schedule_event_ext",
        "schedule_attendee",
        "schedule_recurrence_exception",
        "schedule_calendar",
        "core_party",
        "schedule_task",
    )

    override fun initial(): AgendaHome = decorate(
        AgendaHome(
            screen = AgendaHomeState(
                destination = AgendaHomeState.Destination.DESTINATION_DAY,
                sheet = AgendaHomeState.Sheet.SHEET_NONE,
                loading = Loading(first_load = true),
            ),
        ),
    )

    override fun reduce(state: AgendaHome, event: AgendaInput): Step<AgendaHome> {
        val step = when (event) {
            is AgendaInput.View -> view(state, event.event)
            is AgendaInput.Answered -> answered(state, event)
            is AgendaInput.Denied -> denied(state, event.denial)
            is AgendaInput.Marks -> refold(
                state.copy(
                    screen = state.screen.copy(
                        pending_event_ids = event.pendingEventIds,
                        cancel_asked_event_ids = event.cancelAskedEventIds,
                    ),
                ),
            )
        }
        return Step(decorate(step.state), step.effects)
    }

    override fun rowsChanged(table: String, keys: List<String>): AgendaInput? =
        if (table in TABLES) {
            AgendaInput.View(
                AgendaHomeEvent(rows_changed = AgendaHomeEvent.RowsChanged(table = table)),
            )
        } else {
            null
        }

    override fun seatChanged(seat: SeatState): AgendaInput =
        AgendaInput.View(AgendaHomeEvent(seat_changed = AgendaHomeEvent.SeatChanged(seat = seat)))

    // ---------------------------------------------------------------------
    // The window
    // ---------------------------------------------------------------------

    /** Days a destination reads from the anchor. */
    public fun spanOf(destination: AgendaHomeState.Destination): Int =
        if (destination == AgendaHomeState.Destination.DESTINATION_SCHEDULE ||
            destination == AgendaHomeState.Destination.DESTINATION_WAITING
        ) {
            LIST_DAYS
        } else {
            1
        }

    /** The window a state reads: its span and its anchor. */
    public fun windowKey(screen: AgendaHomeState): String =
        "${spanOf(screen.destination)}|${screen.anchor_day}"

    /** The term search is answering, or null when search is not reading. */
    public fun activeTerm(screen: AgendaHomeState): String? =
        screen.search_term.trim().takeIf { screen.search_open && it.isNotEmpty() }

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    private fun view(state: AgendaHome, event: AgendaHomeEvent): Step<AgendaHome> {
        val screen = state.screen
        return when {
            event.opened != null -> {
                val destination = event.opened.destination
                    .takeUnless { it == AgendaHomeState.Destination.DESTINATION_UNSPECIFIED }
                    ?: AgendaHomeState.Destination.DESTINATION_DAY
                // LANDS AT TODAY: the anchor is emptied and the answer names
                // the day. Hidden calendars are the session's and stay.
                read(
                    state.copy(
                        screen = screen.copy(
                            destination = destination,
                            anchor_day = "",
                            search_open = false,
                            search_term = "",
                            sheet = AgendaHomeState.Sheet.SHEET_NONE,
                            due_open_days = emptyList(),
                            loading = Loading(first_load = true),
                            failure = null,
                            denied = null,
                            data_ = null,
                        ),
                        answers = null,
                        heldWindow = null,
                    ),
                )
            }

            event.refreshed != null -> read(
                state.copy(screen = overRowsOrSkeleton(screen), heldWindow = null),
            )

            event.destination != null -> moveTo(state, event.destination.destination)

            event.band != null -> when (event.band.key) {
                BAND_DAY -> moveTo(state, AgendaHomeState.Destination.DESTINATION_DAY)
                BAND_SCHEDULE -> moveTo(state, AgendaHomeState.Destination.DESTINATION_SCHEDULE)
                BAND_WAITING -> moveTo(state, AgendaHomeState.Destination.DESTINATION_WAITING)
                BAND_SEARCH -> refold(openSearch(state))
                BAND_MORE -> Step(
                    state.copy(screen = screen.copy(sheet = AgendaHomeState.Sheet.SHEET_MORE)),
                )
                else -> Step(state)
            }

            event.day_stepped != null -> {
                val anchor = screen.anchor_day
                val moved = if (anchor.isEmpty() || event.day_stepped.days == 0) {
                    null
                } else {
                    plusDays(anchor, event.day_stepped.days)
                }
                if (moved == null) Step(state) else reanchor(state, moved)
            }

            event.today != null -> {
                val today = heldToday(state)
                if (today.isEmpty() || today == screen.anchor_day) Step(state) else reanchor(state, today)
            }

            event.search_opened != null -> refold(openSearch(state))

            event.search_term != null -> {
                val opened = openSearch(state)
                val typed = opened.copy(
                    screen = opened.screen.copy(search_term = event.search_term.term),
                )
                if (activeTerm(typed.screen) == null) {
                    // NO TERM, NO SEARCH: the window's own list, re-folded.
                    refold(typed.copy(answers = typed.answers?.copy(search = null)))
                } else {
                    // THE ROWS STAY while the hits read: a keystroke that
                    // blanked the list would flash on every letter.
                    read(typed)
                }
            }

            event.search_closed != null -> closeSearch(state)

            event.calendar_toggled != null -> {
                val id = event.calendar_toggled.calendar_id
                val hidden = screen.hidden_calendar_ids
                refold(
                    state.copy(
                        screen = screen.copy(
                            hidden_calendar_ids = if (id in hidden) hidden - id else hidden + id,
                        ),
                    ),
                )
            }

            event.sheet_opened != null -> {
                val sheet = event.sheet_opened.sheet
                if (sheet == AgendaHomeState.Sheet.SHEET_UNSPECIFIED) {
                    Step(state)
                } else {
                    Step(state.copy(screen = screen.copy(sheet = sheet)))
                }
            }

            event.sheet_closed != null ->
                Step(state.copy(screen = screen.copy(sheet = AgendaHomeState.Sheet.SHEET_NONE)))

            event.due_toggled != null -> {
                val day = event.due_toggled.day
                val open = screen.due_open_days
                refold(
                    state.copy(
                        screen = screen.copy(
                            due_open_days = if (day in open) open - day else open + day,
                        ),
                    ),
                )
            }

            // A FAILED READ IS NOT AN EMPTY AGENDA. No retry from here: a
            // retry is the member's (`Refreshed`) or a change event's.
            event.refused != null ->
                if (state.readQueued) {
                    reissue(state)
                } else {
                    Step(
                        state.copy(
                            reading = false,
                            screen = screen.copy(
                                loading = null,
                                data_ = null,
                                denied = null,
                                failure = event.refused.failure,
                            ),
                        ),
                    )
                }

            // A ROW MOVED. The held upcoming list is stale whatever search is
            // doing, so the next read asks for it again.
            event.rows_changed != null -> read(
                state.copy(screen = overRowsOrSkeleton(screen), heldWindow = null),
            )

            event.seat_changed != null ->
                Step(state.copy(screen = screen.copy(seat = event.seat_changed.seat)))

            // INTENTS: the shell routes them, and nothing here changes.
            event.new_event != null -> Step(state)
            event.event_picked != null -> Step(state)

            else -> Step(state)
        }
    }

    /**
     * A destination, by the band or by the shell. Picking one LEAVES SEARCH —
     * the band has one current tab, and a destination picked is the member
     * choosing the list over the hits.
     */
    private fun moveTo(state: AgendaHome, destination: AgendaHomeState.Destination): Step<AgendaHome> {
        if (destination == AgendaHomeState.Destination.DESTINATION_UNSPECIFIED) return Step(state)
        val left = closedSearch(state)
        val moved = left.copy(
            screen = left.screen.copy(
                destination = destination,
                sheet = AgendaHomeState.Sheet.SHEET_NONE,
            ),
        )
        return if (holdsWindow(moved)) refold(moved) else newWindow(moved)
    }

    /** A new anchor day: a new window, always. */
    private fun reanchor(state: AgendaHome, day: String): Step<AgendaHome> =
        newWindow(state.copy(screen = state.screen.copy(anchor_day = day)))

    /**
     * A WINDOW THE MACHINE DOES NOT HOLD. Skeletons, not the old window's rows
     * under the new window's heading — the day bar stays up, because it is on
     * the state and not in `data`.
     */
    private fun newWindow(state: AgendaHome): Step<AgendaHome> = read(
        state.copy(
            screen = state.screen.copy(
                loading = Loading(first_load = true),
                failure = null,
                denied = null,
                data_ = null,
            ),
        ),
    )

    private fun openSearch(state: AgendaHome): AgendaHome = state.copy(
        screen = state.screen.copy(search_open = true, sheet = AgendaHomeState.Sheet.SHEET_NONE),
    )

    /** Search shut, and its term CLEARED (v0 kept it — a defect not carried). */
    private fun closedSearch(state: AgendaHome): AgendaHome = state.copy(
        screen = state.screen.copy(search_open = false, search_term = ""),
        answers = state.answers?.copy(search = null),
    )

    private fun closeSearch(state: AgendaHome): Step<AgendaHome> {
        val closed = closedSearch(state)
        return if (holdsWindow(closed)) refold(closed) else newWindow(closed)
    }

    /** The held upcoming list is this state's window. */
    private fun holdsWindow(state: AgendaHome): Boolean =
        state.answers != null && state.heldWindow == windowKey(state.screen)

    /** A read that keeps the rows on screen when there are rows, else skeletons. */
    private fun overRowsOrSkeleton(screen: AgendaHomeState): AgendaHomeState =
        if (screen.data_ != null) {
            screen
        } else {
            screen.copy(loading = Loading(first_load = true), failure = null, data_ = null)
        }

    // ---------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------

    /** Ask for a read, or queue one behind the read already out. */
    private fun read(state: AgendaHome): Step<AgendaHome> =
        if (state.reading) {
            Step(state.copy(readQueued = true))
        } else {
            Step(
                state.copy(reading = true, readQueued = false),
                listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)),
            )
        }

    /** The answer in hand is for a state since left: ask again, draw nothing. */
    private fun reissue(state: AgendaHome): Step<AgendaHome> = Step(
        state.copy(reading = true, readQueued = false),
        listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)),
    )

    private fun answered(state: AgendaHome, answer: AgendaInput.Answered): Step<AgendaHome> {
        if (state.readQueued) return reissue(state)
        val upcoming = answer.upcoming ?: state.answers?.upcoming
        val context = answer.context ?: state.answers?.context
        if (upcoming == null || context == null) {
            // A SHORT ANSWER IS NOT A WHOLE ONE. Neither can be made up.
            return Step(
                state.copy(
                    reading = false,
                    screen = state.screen.copy(
                        loading = null,
                        data_ = null,
                        denied = null,
                        failure = Reads.refused(AgendaCopy.READ_INCOMPLETE),
                    ),
                ),
            )
        }
        val today = context.today.ifEmpty { upcoming.today }
        val screen = state.screen.copy(anchor_day = state.screen.anchor_day.ifEmpty { today })
        val held = AgendaAnswers(
            upcoming = upcoming,
            context = context,
            // A SEARCH CLOSED WHILE ITS HITS WERE READING IS NOT REOPENED.
            search = answer.search.takeIf { activeTerm(screen) != null },
        )
        return refold(
            state.copy(
                screen = screen,
                answers = held,
                reading = false,
                heldWindow = if (answer.upcoming != null) windowKey(screen) else state.heldWindow,
            ),
            force = true,
        )
    }

    private fun denied(state: AgendaHome, denial: AppQueryDenial): Step<AgendaHome> {
        if (state.readQueued) return reissue(state)
        return Step(
            state.copy(
                reading = false,
                screen = state.screen.copy(
                    loading = null,
                    failure = null,
                    data_ = null,
                    denied = AgendaFold.denied(denial),
                    search_open = false,
                    search_term = "",
                    sheet = AgendaHomeState.Sheet.SHEET_NONE,
                ),
            ),
        )
    }

    /**
     * FOLD THE HELD ANSWERS AGAIN — only over a screen already drawing data,
     * unless [force]: a local change during a skeleton or a failure must not
     * conjure rows out of an older window.
     */
    private fun refold(state: AgendaHome, force: Boolean = false): Step<AgendaHome> {
        val answers = state.answers ?: return Step(state)
        if (!force && state.screen.data_ == null) return Step(state)
        return Step(
            state.copy(
                screen = state.screen.copy(
                    loading = null,
                    failure = null,
                    denied = null,
                    data_ = AgendaFold.fold(state.screen, answers),
                ),
            ),
        )
    }

    private fun heldToday(state: AgendaHome): String =
        state.answers?.let { it.context.today.ifEmpty { it.upcoming.today } } ?: ""

    // ---------------------------------------------------------------------
    // What every state carries: the band, the day bar, the fixed words
    // ---------------------------------------------------------------------

    private fun decorate(state: AgendaHome): AgendaHome {
        val screen = state.screen
        return state.copy(
            screen = screen.copy(
                band = if (screen.denied != null) emptyList() else band(screen),
                toolbar = toolbar(screen, heldToday(state)),
                chrome = CHROME,
            ),
        )
    }

    private fun band(screen: AgendaHomeState): List<AgendaBandTab> {
        val sheetUp = screen.sheet == AgendaHomeState.Sheet.SHEET_MORE ||
            screen.sheet == AgendaHomeState.Sheet.SHEET_READS
        fun tab(key: String, label: String, icon: String, of: AgendaHomeState.Destination) =
            AgendaBandTab(
                key = key,
                label = label,
                icon_key = icon,
                current = screen.destination == of && !screen.search_open,
            )
        return listOf(
            tab(BAND_DAY, AgendaCopy.BAND_DAY, "Clock", AgendaHomeState.Destination.DESTINATION_DAY),
            tab(
                BAND_SCHEDULE,
                AgendaCopy.BAND_SCHEDULE,
                "List",
                AgendaHomeState.Destination.DESTINATION_SCHEDULE,
            ),
            tab(
                BAND_WAITING,
                AgendaCopy.BAND_WAITING,
                "Inbox",
                AgendaHomeState.Destination.DESTINATION_WAITING,
            ),
            AgendaBandTab(
                key = BAND_SEARCH,
                label = AgendaCopy.BAND_SEARCH,
                icon_key = "Search",
                current = screen.search_open,
            ),
            AgendaBandTab(
                key = BAND_MORE,
                label = AgendaCopy.BAND_MORE,
                icon_key = "more",
                current = sheetUp,
            ),
        )
    }

    private fun toolbar(screen: AgendaHomeState, today: String): AgendaToolbar {
        val anchor = screen.anchor_day
        val shown = anchor.isNotEmpty() &&
            today.isNotEmpty() &&
            screen.denied == null &&
            activeTerm(screen) == null
        if (!shown) return AgendaToolbar(shown = false)
        val isDay = screen.destination == AgendaHomeState.Destination.DESTINATION_DAY
        val range = if (isDay) {
            when (anchor) {
                today -> AgendaCopy.TODAY
                plusDays(today, 1) -> AgendaCopy.TOMORROW
                plusDays(today, -1) -> AgendaCopy.YESTERDAY
                else -> AgendaFold.longDay(anchor)
            }
        } else if (anchor == today) {
            AgendaCopy.FROM_TODAY
        } else {
            "${AgendaCopy.FROM} ${AgendaFold.longDay(anchor)}"
        }
        return AgendaToolbar(
            shown = true,
            range_label = range,
            month_label = AgendaFold.monthYear(anchor),
            at_today = anchor == today,
        )
    }

    private val CHROME: AgendaChrome = AgendaChrome(
        title = AgendaCopy.APP_TITLE,
        new_event = AgendaCopy.NEW_EVENT,
        today = AgendaCopy.TODAY,
        previous_day = AgendaCopy.PREVIOUS_DAY,
        next_day = AgendaCopy.NEXT_DAY,
        search_placeholder = AgendaCopy.SEARCH_PLACEHOLDER,
        search_label = AgendaCopy.SEARCH_LABEL,
        search_close = AgendaCopy.CLOSE,
        retry = AgendaCopy.RETRY,
        loading = AgendaCopy.LOADING,
        more_title = AgendaCopy.MORE_TITLE,
        calendars_heading = AgendaCopy.RAIL_CALENDARS,
        reads_title = AgendaCopy.READS_TITLE,
        reads_facts = listOf(
            AgendaFact(
                label = AgendaCopy.READS_FACT_READS,
                detail = AgendaCopy.READS_FACT_READS_VALUE,
            ),
            AgendaFact(
                label = AgendaCopy.READS_FACT_WRITES,
                detail = AgendaCopy.READS_FACT_WRITES_VALUE,
            ),
            AgendaFact(
                label = AgendaCopy.READS_FACT_LEAVES,
                detail = AgendaCopy.READS_FACT_LEAVES_VALUE,
            ),
        ),
        home = AgendaCopy.BAND_HOME,
        shelf_label = AgendaCopy.SHELF_A11Y,
    )

    /** `AgendaBandTab.key`s — what `BandPicked` carries. */
    public const val BAND_DAY: String = "day"
    public const val BAND_SCHEDULE: String = "schedule"
    public const val BAND_WAITING: String = "waiting"
    public const val BAND_SEARCH: String = "search"
    public const val BAND_MORE: String = "more"
}
