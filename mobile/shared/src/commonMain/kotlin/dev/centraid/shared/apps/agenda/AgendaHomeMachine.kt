package dev.centraid.shared.apps.agenda

import centraid.core.v1.AgendaDayContext
import centraid.core.v1.AgendaSearch
import centraid.core.v1.AgendaUpcoming
import centraid.core.v1.ActInverse
import centraid.core.v1.AppQueryDenial
import centraid.screen.v1.AgendaBandTab
import centraid.screen.v1.AgendaChrome
import centraid.screen.v1.AgendaFact
import centraid.screen.v1.AgendaHomeData
import centraid.screen.v1.AgendaHomeEvent
import centraid.screen.v1.AgendaHomeState
import centraid.screen.v1.AgendaMoreRow
import centraid.screen.v1.AgendaToolbar
import centraid.screen.v1.Loading
import centraid.screen.v1.SeatState
import centraid.screen.v1.TasksQuickAdd
import centraid.screen.v1.WriteSettled
import dev.centraid.design.copy.AgendaCopy
import dev.centraid.design.copy.TasksCopy
import dev.centraid.shared.kit.SearchLaw
import dev.centraid.shared.catalog.Act
import dev.centraid.shared.nav.ScreenIds
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import dev.centraid.shared.kit.time.plusDays
import dev.centraid.shared.kit.tasks.TaskOpsLaw

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
 * - [tasks] are the same for the `tasks.*` answers and the task writes this
 *   phone has out (#1128): To-do's Inbox and projects, held beside the events.
 */
public data class AgendaHome(
    public val screen: AgendaHomeState,
    public val answers: AgendaAnswers? = null,
    public val reading: Boolean = false,
    public val readQueued: Boolean = false,
    public val heldWindow: String? = null,
    public val tasks: AgendaTasks = AgendaTasks(),
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

    /** A To-do write's answer, with the inverse the core gave for Undo (#1135). */
    public data class TaskActed(public val settled: WriteSettled, public val inverse: ActInverse?) : AgendaInput

    /**
     * The answers to one read, BY ARM. [upcoming] is null when it was not
     * asked — a search keystroke over a window already held — and [tasks]
     * carries the `tasks.*` arms of a To-do read.
     */
    public data class Answered(
        public val upcoming: AgendaUpcoming?,
        public val context: AgendaDayContext?,
        public val search: AgendaSearch?,
        public val tasks: TasksAnswers = TasksAnswers(),
    ) : AgendaInput

    /** To-do's quick add, with the task id the bridge minted. */
    public data class Add(public val taskId: String) : AgendaInput

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
 * AGENDA'S HOME ON THE PHONE (#1046, #1128): Day, Schedule, Waiting and To-do,
 * with Search as a mode and More as a sheet.
 *
 * The band holds places only (R-CHROME-5) — Day, Schedule, Waiting, To-do,
 * then More; there is no month or hour grid. To-do is the Inbox and the
 * projects ([TodoPlace]); it reads `tasks.*` and no event, and has no day bar. Search is the bar under the title
 * (R-CHROME-2), opened by `SearchOpened`, and the More sheet's rows are
 * computed here ([moreRows]) so both platforms draw one list. Opening lands on
 * Day, anchored on the `today` the core answers, never on a device-clock
 * guess.
 *
 * ## What re-reads and what re-folds
 *
 * A read is a WINDOW: the anchor and the destination's span (a day, or
 * [LIST_DAYS]). Changing either re-reads, and the list is skeletons until the
 * new window lands — a day's rows are not drawn under another day's heading.
 * Everything else is local and re-folds [AgendaHome.answers]: hiding a
 * calendar, Schedule to Waiting (one window), closing search, a task checked
 * off or filed. A search term re-reads the search and, only when it is not held, the
 * upcoming list; the rows on screen stay while it does.
 *
 * ## Views decide nothing
 *
 * Every string, flag and hue key a view draws is set here or by
 * [AgendaFold]. The band, the day bar and the fixed words are recomputed on
 * every step ([decorate]), so no view derives one from another field.
 */
public object AgendaHomeMachine : ScreenMachine<AgendaHome, AgendaInput> {
    public const val SCREEN_ID: String = ScreenIds.AGENDA_HOME

    /** Schedule's and Waiting's reach from the anchor, in days (v0's). */
    public const val LIST_DAYS: Int = 120

    /**
     * THE TABLES THIS SCREEN'S QUERIES READ — the event and its guests, a series' skipped and
     * moved days, the calendars, the people a birthday and a guest name come from, and the tasks,
     * their projects and sections, and the tags on a row's meta line. `AgendaReads.tables` is
     * this set, and `AppReadsSpec` asserts [rowsChanged] answers for exactly it over every vault
     * table.
     */
    public val TABLES: Set<String> = AgendaTables.HOME

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
            is AgendaInput.TaskActed -> ops(state, TaskOpsLaw.settled(state.tasks.ops, event.settled, event.inverse))
            is AgendaInput.Add -> add(state, event.taskId)
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

    /**
     * Days a destination reads from the anchor. To-do reads no event, but a
     * search over it asks the events for one day, so it answers 1 like Day.
     */
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
                // SEEDED WORDS (Notes' "Send to Agenda") wait in To-do's bar,
                // focused — and they name To-do as the place.
                val seed = event.opened.quick_add_title.trim()
                val destination = event.opened.destination
                    .takeUnless { it == AgendaHomeState.Destination.DESTINATION_UNSPECIFIED }
                    ?: if (seed.isNotEmpty()) TODO else AgendaHomeState.Destination.DESTINATION_DAY
                // LANDS AT TODAY: the anchor is emptied and the answer names
                // the day. Hidden calendars are the session's and stay.
                read(
                    state.copy(
                        screen = screen.copy(
                            destination = destination,
                            anchor_day = "",
                            search_open = false,
                            search_term = "",
                            search_corrected = "",
                            search_ask_row = null,
                            sheet = AgendaHomeState.Sheet.SHEET_NONE,
                            filing_task_id = "",
                            new_project_name = "",
                            quick_add = TasksQuickAdd(title = seed, focused = seed.isNotEmpty(), drawn = seed.isNotEmpty()),
                            loading = Loading(first_load = true),
                            failure = null,
                            denied = null,
                            data_ = null,
                        ),
                        answers = null,
                        heldWindow = null,
                        // THE WRITES STAY (their rows are still the vault's to
                        // answer); the answers do not.
                        tasks = AgendaTasks(ops = state.tasks.ops),
                    ),
                )
            }

            // A PULL, OR A ROW MOVED. The held upcoming list and To-do's
            // answers are stale whatever search is doing, so the next read asks
            // for them again.
            event.refreshed != null || event.rows_changed != null -> read(
                state.copy(
                    screen = overRowsOrSkeleton(screen),
                    heldWindow = null,
                    tasks = state.tasks.copy(heldTodo = false, heldDated = null),
                ),
            )

            event.destination != null -> moveTo(state, event.destination.destination)

            event.band != null -> when (event.band.key) {
                BAND_DAY -> moveTo(state, AgendaHomeState.Destination.DESTINATION_DAY)
                BAND_SCHEDULE -> moveTo(state, AgendaHomeState.Destination.DESTINATION_SCHEDULE)
                BAND_WAITING -> moveTo(state, AgendaHomeState.Destination.DESTINATION_WAITING)
                BAND_TODO -> moveTo(state, TODO)
                BAND_MORE -> Step(
                    state.copy(screen = screen.copy(sheet = AgendaHomeState.Sheet.SHEET_MORE)),
                )
                else -> Step(state)
            }

            // TO-DO HAS NO DAY: the bar is not drawn, and a stray step is nothing.
            event.day_stepped != null && screen.destination == TODO -> Step(state)

            event.today != null && screen.destination == TODO -> Step(state)

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

            event.search_opened != null -> refold(openSearch(shut(state)))

            event.search_term != null -> {
                val opened = openSearch(shut(state))
                val typed = opened.copy(
                    screen = opened.screen.copy(search_term = event.search_term.term, search_corrected = "", search_ask_row = null),
                )
                if (activeTerm(typed.screen) == null) {
                    // NO TERM, NO SEARCH: the window's own list, re-folded.
                    refold(withoutSearch(typed))
                } else {
                    // THE ROWS STAY while the hits read: a keystroke that
                    // blanked the list would flash on every letter.
                    read(typed)
                }
            }

            event.search_closed != null -> closeSearch(state)

            event.calendar_toggled != null -> toggleCalendar(state, event.calendar_toggled.calendar_id)

            // A MORE ROW, BY ITS KEY: the machine named every row, so it is
            // the one that knows what a key does. A key the sheet does not
            // hold now (a calendar gone since it was drawn) does nothing.
            event.more_row != null -> {
                val row = screen.more_rows.firstOrNull { it.key == event.more_row.key }
                when {
                    row == null -> Step(state)
                    row.key == MORE_READS ->
                        Step(state.copy(screen = screen.copy(sheet = AgendaHomeState.Sheet.SHEET_READS)))
                    row.key.startsWith(MORE_CALENDAR) ->
                        toggleCalendar(state, row.key.removePrefix(MORE_CALENDAR))
                    // A TASKS PLACE IS AN INTENT: the sheet closes, and the shell routes the key.
                    row.key in TASK_PLACES ->
                        Step(state.copy(screen = screen.copy(sheet = AgendaHomeState.Sheet.SHEET_NONE)))
                    else -> Step(state)
                }
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
                Step(
                    state.copy(
                        screen = screen.copy(
                            sheet = AgendaHomeState.Sheet.SHEET_NONE,
                            filing_task_id = "",
                            new_project_name = "",
                        ),
                    ),
                )

            // ---- TASKS (#1128): checked off in place, filed, added, projects ----

            event.task_checked != null -> {
                val task = TodoPlace.find(state.tasks, event.task_checked.task_id) ?: return Step(state)
                ops(state, TaskOpsLaw.checked(state.tasks.ops, task))
            }

            event.status_acted != null -> ops(state, TaskOpsLaw.undo(state.tasks.ops))

            event.file_requested != null -> {
                val id = event.file_requested.task_id
                if (TodoPlace.find(state.tasks, id) == null) {
                    Step(state)
                } else {
                    Step(
                        state.copy(
                            screen = screen.copy(sheet = AgendaHomeState.Sheet.SHEET_FILE, filing_task_id = id),
                        ),
                    )
                }
            }

            event.file_chosen != null -> file(state, event.file_chosen.key)

            event.quick_add_changed != null ->
                Step(
                    state.copy(
                        screen = screen.copy(
                            quick_add = (screen.quick_add ?: TasksQuickAdd()).copy(title = event.quick_add_changed.title),
                        ),
                    ),
                )

            // THE BRIDGE MINTS THE ID: a quick add that reached the machine
            // without one (a spec forwarding the proto event) is nothing.
            event.quick_add_submitted != null -> Step(state)

            // THE PLUS OPENS THE BAR on the keyboard (R-CHROME-1), on To-do only.
            event.quick_add_opened != null ->
                if (screen.destination == TODO) {
                    Step(
                        state.copy(
                            screen = screen.copy(
                                quick_add = (screen.quick_add ?: TasksQuickAdd()).copy(drawn = true, focused = true),
                            ),
                        ),
                    )
                } else {
                    Step(state)
                }

            // THE KEYBOARD LEFT IT: an empty bar goes away; typed words keep
            // it open, so nothing the member wrote is thrown away.
            event.quick_add_closed != null ->
                if (screen.quick_add?.title.isNullOrBlank()) Step(shut(state)) else Step(state)

            event.new_project_name != null ->
                Step(state.copy(screen = screen.copy(new_project_name = event.new_project_name.name)))

            event.new_project_submitted != null -> {
                val name = screen.new_project_name.trim()
                if (name.isEmpty()) {
                    Step(state)
                } else {
                    val out = TaskOpsLaw.created(
                        state.tasks.ops,
                        Act.Tasks.CreateProject(kind = Act.Tasks.CreateProjectKind.Project, title = name),
                        name,
                        TasksCopy.PROJECT_CREATED,
                    )
                    Step(
                        state.copy(
                            tasks = state.tasks.copy(ops = out.ops),
                            screen = screen.copy(sheet = AgendaHomeState.Sheet.SHEET_NONE, new_project_name = ""),
                        ),
                        out.effects,
                    )
                }
            }

            // THE EMPTY TO-DO'S ONE ACTION is the new-project sheet.
            event.todo_empty_acted != null ->
                if (screen.destination == TODO && screen.data_?.todo?.empty?.action_label?.isNotEmpty() == true) {
                    Step(state.copy(screen = screen.copy(sheet = AgendaHomeState.Sheet.SHEET_NEW_PROJECT)))
                } else {
                    Step(state)
                }

            event.write_settled != null -> ops(state, TaskOpsLaw.settled(state.tasks.ops, event.write_settled))

            event.next_page != null ->
                if (state.tasks.limit >= TodoPlace.MAX_WINDOW) {
                    Step(state)
                } else {
                    read(
                        state.copy(
                            tasks = state.tasks.copy(
                                limit = (state.tasks.limit + TodoPlace.PAGE).coerceAtMost(TodoPlace.MAX_WINDOW),
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

            event.seat_changed != null ->
                Step(state.copy(screen = screen.copy(seat = event.seat_changed.seat)))

            // INTENTS: the shell routes them, and nothing here changes.
            event.new_event != null -> Step(state)
            event.event_picked != null -> Step(state)
            event.task_picked != null -> Step(state)
            event.project_picked != null -> Step(state)
            event.group_verb != null -> Step(state)
            event.notice_acted != null -> Step(state)

            else -> Step(state)
        }
    }

    /**
     * A destination, by the band or by the shell. Picking one LEAVES SEARCH —
     * even the lit tab: a destination picked is the member choosing the list
     * over the hits.
     */
    private fun moveTo(state: AgendaHome, destination: AgendaHomeState.Destination): Step<AgendaHome> {
        if (destination == AgendaHomeState.Destination.DESTINATION_UNSPECIFIED) return Step(state)
        val left = closedSearch(shut(state))
        val moved = left.copy(
            screen = left.screen.copy(
                destination = destination,
                sheet = AgendaHomeState.Sheet.SHEET_NONE,
            ),
        )
        return if (holdsWindow(moved)) refold(moved) else newWindow(moved)
    }

    /** A calendar shown or hidden, for the session: a re-fold, never a read. */
    private fun toggleCalendar(state: AgendaHome, id: String): Step<AgendaHome> {
        val hidden = state.screen.hidden_calendar_ids
        return refold(
            state.copy(
                screen = state.screen.copy(
                    hidden_calendar_ids = if (id in hidden) hidden - id else hidden + id,
                ),
            ),
        )
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
    private fun closedSearch(state: AgendaHome): AgendaHome = withoutSearch(
        state.copy(
            screen = state.screen.copy(search_open = false, search_term = "", search_corrected = "", search_ask_row = null),
        ),
    )

    /** The hits dropped, the events' and the tasks'. */
    private fun withoutSearch(state: AgendaHome): AgendaHome = state.copy(
        answers = state.answers?.copy(search = null),
        tasks = state.tasks.copy(search = null),
    )

    private fun closeSearch(state: AgendaHome): Step<AgendaHome> {
        val closed = closedSearch(state)
        return if (holdsWindow(closed)) refold(closed) else newWindow(closed)
    }

    /**
     * DO THE HELD ANSWERS DRAW THIS PLACE? To-do's are its own (the Inbox and
     * the projects, current); Waiting's is the held upcoming list for its
     * window; Day's and Schedule's also need the dated task boards for it.
     */
    private fun holdsWindow(state: AgendaHome): Boolean =
        when (state.screen.destination) {
            TODO -> state.tasks.heldTodo
            // WAITING DRAWS NO TASK, so the events are all it needs; Day and Schedule draw both.
            AgendaHomeState.Destination.DESTINATION_WAITING ->
                state.answers != null && state.heldWindow == windowKey(state.screen)
            else ->
                state.answers != null &&
                    state.heldWindow == windowKey(state.screen) &&
                    state.tasks.heldDated == windowKey(state.screen)
        }

    /** The quick-add bar put away, its words with it: another place, or search. */
    private fun shut(state: AgendaHome): AgendaHome =
        state.copy(screen = state.screen.copy(quick_add = TasksQuickAdd()))

    /** A task write's outcome: the ops held, the rows re-folded without a read. */
    private fun ops(state: AgendaHome, out: TaskOpsLaw.Out): Step<AgendaHome> {
        val folded = refold(state.copy(tasks = state.tasks.copy(ops = out.ops)))
        return Step(folded.state, folded.effects + out.effects)
    }

    /** To-do's quick add: a bare title, the bridge's id, drawn at once in the Inbox. */
    private fun add(state: AgendaHome, taskId: String): Step<AgendaHome> {
        val screen = state.screen
        val title = screen.quick_add?.title?.trim().orEmpty()
        if (title.isEmpty() || screen.denied != null || screen.destination != TODO) return Step(state)
        val out = TaskOpsLaw.added(
            state.tasks.ops,
            taskId = taskId,
            title = title,
            dueDay = "",
            landsIn = TasksCopy.INBOX,
        )
        return Step(
            refold(
                state.copy(
                    tasks = state.tasks.copy(ops = out.ops),
                    screen = screen.copy(quick_add = (screen.quick_add ?: TasksQuickAdd()).copy(title = "")),
                ),
            ).state,
            out.effects,
        )
    }

    /** A filing choice: the write it makes, with the sheet shut. */
    private fun file(state: AgendaHome, key: String): Step<AgendaHome> {
        val screen = state.screen
        val task = TodoPlace.find(state.tasks, screen.filing_task_id)
        val closed = state.copy(
            screen = screen.copy(sheet = AgendaHomeState.Sheet.SHEET_NONE, filing_task_id = ""),
        )
        if (task == null) return Step(closed)
        val out = TodoPlace.filing(state.tasks, task, key) ?: return Step(closed)
        return ops(closed, out)
    }

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
        // TO-DO'S OWN ANSWER: the Inbox and the projects, no event in it.
        if (state.screen.destination == TODO && activeTerm(state.screen) == null) return answeredTodo(state, answer)
        val upcoming = answer.upcoming ?: state.answers?.upcoming
        val context = answer.context ?: state.answers?.context
        val searching = activeTerm(state.screen) != null
        // THE TASK ARMS, merged over the ones held (a search keystroke asks only the hits).
        val incoming = answer.tasks
        val merged = state.tasks.copy(
            inbox = incoming.inbox ?: state.tasks.inbox,
            projects = incoming.projects ?: state.tasks.projects,
            today = incoming.today ?: state.tasks.today,
            upcoming = incoming.upcoming ?: state.tasks.upcoming,
            catchUp = incoming.catchUp ?: state.tasks.catchUp,
            // A SEARCH CLOSED WHILE ITS HITS WERE READING IS NOT REOPENED.
            search = if (searching) incoming.search ?: state.tasks.search else null,
        )
        val needsBoards = !searching && state.screen.destination in DATED
        if (upcoming == null || context == null || (needsBoards && (merged.today == null || merged.upcoming == null))) {
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
        val screen = state.screen.copy(
            anchor_day = state.screen.anchor_day.ifEmpty { today },
            // THE WORDS THE HITS ANSWER: kept only while a term is, and only
            // when this answer is a search's. The events' correction wins; the
            // tasks' stands when only they were corrected.
            search_corrected = if (searching) {
                answer.search?.corrected?.ifEmpty { null } ?: incoming.search?.corrected ?: ""
            } else {
                ""
            },
            // THE ASK ROW (#1097, R-1097-28, #1135): for a search's own answer to the term on screen,
            // matched or not. Agenda keeps flat fields, so this is the law by hand.
            search_ask_row = if (searching && answer.search != null) {
                SearchLaw.offer(state.screen.search_term, "agenda")
            } else {
                null
            },
        )
        val held = AgendaAnswers(
            upcoming = upcoming,
            context = context,
            // A SEARCH CLOSED WHILE ITS HITS WERE READING IS NOT REOPENED.
            search = answer.search.takeIf { activeTerm(screen) != null },
        )
        val key = windowKey(screen)
        val writes = if (incoming.today != null) {
            // WRITES THE VAULT HAS NOW ANSWERED are the vault's to draw (`TaskOpsLaw.answered`), but only
            // by an answer that carries the boards: a search keystroke's does not.
            TaskOpsLaw.answered(merged.ops, TodoPlace.openIn(merged), TodoPlace.todayOf(merged).ifEmpty { today })
        } else {
            merged.ops
        }
        return refold(
            state.copy(
                screen = screen,
                answers = held,
                reading = false,
                heldWindow = if (answer.upcoming != null) key else state.heldWindow,
                tasks = merged.copy(
                    ops = writes,
                    heldDated = if (incoming.today != null) key else state.tasks.heldDated,
                ),
            ),
            force = true,
        )
    }

    /**
     * TO-DO'S ANSWER. A short one — the Inbox without the projects, or the
     * reverse, with nothing held — is not a whole one, and neither is made up.
     * Writes the vault has now answered are the vault's to draw
     * (`TaskOpsLaw.answered`).
     */
    private fun answeredTodo(state: AgendaHome, answer: AgendaInput.Answered): Step<AgendaHome> {
        val inbox = answer.tasks.inbox ?: state.tasks.inbox
        val projects = answer.tasks.projects ?: state.tasks.projects
        if (inbox == null || projects == null) {
            return Step(
                state.copy(
                    reading = false,
                    screen = state.screen.copy(
                        loading = null,
                        data_ = null,
                        denied = null,
                        failure = Reads.refused(TasksCopy.READ_INCOMPLETE),
                    ),
                ),
            )
        }
        val held = state.tasks.copy(inbox = inbox, projects = projects, heldTodo = true)
        val settled = held.copy(ops = TaskOpsLaw.answered(held.ops, TodoPlace.openIn(held), inbox.today))
        return refold(state.copy(tasks = settled, reading = false), force = true)
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
                    search_corrected = "",
                    search_ask_row = null,
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
        if (!force && state.screen.data_ == null) return Step(state)
        val data = dataOf(state) ?: return Step(state)
        return Step(
            state.copy(
                screen = state.screen.copy(
                    loading = null,
                    failure = null,
                    denied = null,
                    data_ = data,
                ),
            ),
        )
    }

    /**
     * THE DATA THE HELD ANSWERS DRAW, or null when they are not for this state.
     * To-do draws the tasks alone; every other place, and any search, the
     * events ([AgendaFold]).
     */
    private fun dataOf(state: AgendaHome): AgendaHomeData? =
        if (state.screen.destination == TODO && activeTerm(state.screen) == null) {
            TodoPlace.fold(state.tasks)
        } else {
            state.answers?.let { AgendaFold.fold(state.screen, it, state.tasks) }
        }

    private fun heldToday(state: AgendaHome): String =
        state.answers?.let { it.context.today.ifEmpty { it.upcoming.today } } ?: ""

    // ---------------------------------------------------------------------
    // What every state carries: the band, the day bar, the fixed words
    // ---------------------------------------------------------------------

    private fun decorate(state: AgendaHome): AgendaHome {
        val screen = state.screen
        val todo = screen.destination == TODO
        val bar = screen.quick_add ?: TasksQuickAdd()
        // KEPT THROUGH A READ: the views draw the bar only while it is also
        // `shown`, so a bar opened over a loading page survives the answer.
        val drawn = bar.drawn
        return state.copy(
            screen = screen.copy(
                band = if (screen.denied != null) emptyList() else band(screen),
                toolbar = toolbar(screen, heldToday(state)),
                chrome = CHROME,
                more_rows = if (screen.denied != null) emptyList() else moreRows(screen),
                status = state.tasks.ops.status,
                quick_add = TasksQuickAdd(
                    title = bar.title,
                    can_submit = bar.title.isNotBlank(),
                    lands_label = "${TasksCopy.LANDS_IN} ${TasksCopy.INBOX}",
                    // Hidden while search is open, term or not: the bar and its Plus
                    // would be a second verb over a field that is looking.
                    shown = todo && screen.denied == null && screen.data_ != null && !screen.search_open,
                    focused = drawn && bar.focused,
                    add_label = TasksCopy.ADD_TASK,
                    drawn = drawn,
                ),
                file_choices = if (screen.sheet == AgendaHomeState.Sheet.SHEET_FILE) {
                    TodoPlace.fileChoices(state.tasks, screen.filing_task_id)
                } else {
                    emptyList()
                },
                new_project_can_submit = screen.new_project_name.isNotBlank(),
                // "Add", not "New event": on Day, Schedule and Waiting the Plus opens the sheet that adds
                // an event or a task (R-1128-Z1).
                add_label = if (todo) TasksCopy.ADD_TASK else AgendaCopy.QUICK_ADD,
                add_opens_quick_add = todo,
            ),
        )
    }

    /**
     * THE MORE SHEET, AS ROWS (R-1046-5): every calendar the answer named, as
     * a show/hide toggle under the Calendars heading, then "What Agenda may
     * read". Never Search, never a sort or a filter (R-CHROME-4).
     */
    private fun moreRows(screen: AgendaHomeState): List<AgendaMoreRow> {
        val calendars = screen.data_?.calendars.orEmpty().mapIndexed { index, calendar ->
            AgendaMoreRow(
                key = MORE_CALENDAR + calendar.calendar_id,
                label = calendar.name,
                meta = calendar.state_label,
                hue_key = calendar.hue_key,
                toggle = true,
                on = !calendar.hidden,
                section = if (index == 0) AgendaCopy.RAIL_CALENDARS else "",
                spoken = "${calendar.name}, ${calendar.state_label}",
            )
        }
        // THE TASKS PLACES (R-1128-6), under their own heading. All and Catch up
        // are not here: All is Day, Schedule and To-do together, and Catch up is
        // the Overdue group's verb.
        val places = listOf(
            taskPlace(MORE_ANYTIME, TasksCopy.VIEW_ANYTIME, TasksCopy.MORE_ANYTIME_META, "Layers"),
            taskPlace(MORE_LOGBOOK, TasksCopy.VIEW_LOGBOOK, TasksCopy.MORE_LOGBOOK_META, "Book"),
            taskPlace(MORE_REMINDERS, TasksCopy.VIEW_REMINDERS, TasksCopy.MORE_REMINDERS_META, "Bell"),
            taskPlace(MORE_TRASH, TasksCopy.TRASH, TasksCopy.MORE_TRASH_META, "Trash"),
        ).mapIndexed { index, row -> if (index == 0) row.copy(section = AgendaCopy.RAIL_TASKS) else row }
        return calendars + places + AgendaMoreRow(
            key = MORE_READS,
            label = AgendaCopy.READS_TITLE,
            spoken = AgendaCopy.READS_TITLE,
        )
    }

    private fun taskPlace(key: String, label: String, meta: String, icon: String): AgendaMoreRow =
        AgendaMoreRow(key = key, label = label, meta = meta, icon_key = icon, spoken = "$label, $meta")

    private fun band(screen: AgendaHomeState): List<AgendaBandTab> {
        val sheetUp = screen.sheet == AgendaHomeState.Sheet.SHEET_MORE ||
            screen.sheet == AgendaHomeState.Sheet.SHEET_READS
        // SEARCH IS A MODE OVER THE PLACE, not a place: the destination's tab
        // stays lit while the field is open.
        fun tab(key: String, label: String, icon: String, of: AgendaHomeState.Destination) =
            AgendaBandTab(
                key = key,
                label = label,
                icon_key = icon,
                current = screen.destination == of,
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
            tab(BAND_TODO, AgendaCopy.BAND_TODO, "Todo", TODO),
            AgendaBandTab(
                key = BAND_MORE,
                label = AgendaCopy.BAND_MORE,
                icon_key = "MoreHoriz",
                current = sheetUp,
            ),
        )
    }

    private fun toolbar(screen: AgendaHomeState, today: String): AgendaToolbar {
        val anchor = screen.anchor_day
        val shown = anchor.isNotEmpty() &&
            today.isNotEmpty() &&
            screen.denied == null &&
            screen.destination != TODO &&
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
        tasks = TodoPlace.CHROME,
    )

    /** `AgendaBandTab.key`s — what `BandPicked` carries. */
    public const val BAND_DAY: String = "day"
    public const val BAND_SCHEDULE: String = "schedule"
    public const val BAND_WAITING: String = "waiting"
    public const val BAND_TODO: String = "todo"
    public const val BAND_MORE: String = "more"

    /**
     * `AgendaMoreRow.key`s — what `MoreRowPicked` carries. The Tasks places are
     * intents the shell routes; `reads` opens the facts sheet.
     */
    public const val MORE_READS: String = "reads"
    public const val MORE_CALENDAR: String = "calendar-"
    public const val MORE_ANYTIME: String = "anytime"
    public const val MORE_LOGBOOK: String = "logbook"
    public const val MORE_REMINDERS: String = "reminders"
    public const val MORE_TRASH: String = "trash"

    private val TASK_PLACES: Set<String> = setOf(MORE_ANYTIME, MORE_LOGBOOK, MORE_REMINDERS, MORE_TRASH)

    private val TODO = AgendaHomeState.Destination.DESTINATION_TODO

    /** The places that draw tasks on their days. */
    private val DATED: Set<AgendaHomeState.Destination> = setOf(
        AgendaHomeState.Destination.DESTINATION_DAY,
        AgendaHomeState.Destination.DESTINATION_SCHEDULE,
    )
}
