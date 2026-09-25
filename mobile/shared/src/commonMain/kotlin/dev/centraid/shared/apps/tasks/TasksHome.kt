package dev.centraid.shared.apps.tasks

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandStatus
import centraid.core.v1.TasksBoard
import centraid.core.v1.TasksBoardRequest
import centraid.core.v1.TasksCatchUp
import centraid.core.v1.TasksCatchUpRequest
import centraid.core.v1.TasksGroup
import centraid.core.v1.TasksGroupKind
import centraid.core.v1.TasksProjects
import centraid.core.v1.TasksProjectsRequest
import centraid.core.v1.TasksSearch
import centraid.core.v1.TasksSearchRequest
import centraid.core.v1.TasksTask
import centraid.core.v1.TasksView
import centraid.screen.v1.Denied
import centraid.screen.v1.EmptyState
import centraid.screen.v1.ListRow
import centraid.screen.v1.Loading
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.SearchField
import centraid.screen.v1.SeatState
import centraid.screen.v1.TasksChoice
import centraid.screen.v1.TasksHomeData
import centraid.screen.v1.TasksHomeEvent
import centraid.screen.v1.TasksHomeState
import centraid.screen.v1.TasksNotice
import centraid.screen.v1.TasksProjectGroup
import centraid.screen.v1.TasksQuickAdd
import centraid.screen.v1.TasksRowGroup
import dev.centraid.design.copy.TasksCopy
import dev.centraid.shared.kit.BandLaw
import dev.centraid.shared.kit.BandLens
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.SearchLaw
import dev.centraid.shared.kit.SearchLens
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.kit.jsonString
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import dev.centraid.shared.sync.ScreenQueries
import dev.centraid.shared.sync.ScreenWrites

/**
 * WHAT TASKS' HOME HOLDS: the state a view draws, and the core's raw answers
 * beside it (`AgendaHome`'s shape and reason). A band move, search closing, a
 * row checked off or filed re-folds these without a read.
 */
public data class TasksHome(
    val screen: TasksHomeState,
    val board: TasksBoard? = null,
    val projects: TasksProjects? = null,
    val catchUp: TasksCatchUp? = null,
    val search: TasksSearch? = null,
    val ops: TaskOps = TaskOps(),
    /** One read out at a time; one asked meanwhile is queued, and the older answer dropped. */
    val reading: Boolean = false,
    val readQueued: Boolean = false,
    /** The board window asked for; "Show more" widens it. */
    val limit: Int = TasksHomeMachine.PAGE,
)

public sealed interface TasksHomeInput {
    public data class View(val event: TasksHomeEvent) : TasksHomeInput

    /** The quick add, with the id the bridge minted. */
    public data class Add(val taskId: String) : TasksHomeInput

    /** One read's answers, by arm; null where not asked. */
    public data class Answered(
        val board: TasksBoard? = null,
        val projects: TasksProjects? = null,
        val catchUp: TasksCatchUp? = null,
        val search: TasksSearch? = null,
    ) : TasksHomeInput

    public data class Denied(val denial: AppQueryDenial) : TasksHomeInput
}

/**
 * TASKS' HOME (#1029 port): Today · Upcoming · Inbox · Projects, More a
 * sheet, search a field — the handoff's band (only a PLACE is in it).
 *
 * - **Today** groups overdue (with Catch up) then today, in the core's today
 *   and never UTC's; an absence the core names is a notice over it.
 * - **Upcoming** is one group per civil day, with a month heading where the
 *   month turns ([CivilWords][dev.centraid.shared.kit.time.CivilWords]).
 * - **Inbox** is unfiled open work; **Projects** is the projects by area.
 * - A row is checked off (hidden at once, "Task done" and Undo on the status
 *   line), filed (a sheet of Inbox, projects and sections), or opened.
 * - The quick add takes a bare title: Today dates it today, everywhere else
 *   it lands in the Inbox. Its row is drawn at once and taken back, with the
 *   core's sentence, if the vault refuses it.
 */
public object TasksHomeMachine : ScreenMachine<TasksHome, TasksHomeInput> {
    public const val SCREEN_ID: String = "tasks.home"

    /** The board window, and how far "Show more" may widen it (the manifest's 20…500). */
    public const val PAGE: Int = 100
    public const val MAX_WINDOW: Int = 500

    /**
     * THE TABLES THIS SCREEN'S QUERIES READ AND DRAW: tasks, their projects
     * and sections, and the tags on a row's meta line.
     */
    public val TABLES: Set<String> = setOf(
        "schedule_task",
        "schedule_project",
        "schedule_section",
        "core_tag",
        "core_concept",
    )

    public const val BAND_TODAY: String = "today"
    public const val BAND_UPCOMING: String = "upcoming"
    public const val BAND_INBOX: String = "inbox"
    public const val BAND_PROJECTS: String = "projects"
    public const val BAND_MORE: String = "more"

    /** More rows: all but `search` and `reads` are intents the shell routes. */
    public const val MORE_ANYTIME: String = "anytime"
    public const val MORE_ALL: String = "all"
    public const val MORE_LOGBOOK: String = "logbook"
    public const val MORE_REMINDERS: String = "reminders"
    public const val MORE_CATCH_UP: String = "catch_up"
    public const val MORE_SEARCH: String = "search"
    public const val MORE_TRASH: String = "trash"
    public const val MORE_READS: String = "reads"

    /** Filing choice keys. */
    public const val FILE_INBOX: String = "inbox"
    public const val FILE_PROJECT: String = "project:"
    public const val FILE_SECTION: String = "section:"

    private val TODAY = TasksHomeState.Destination.DESTINATION_TODAY
    private val UPCOMING = TasksHomeState.Destination.DESTINATION_UPCOMING
    private val INBOX = TasksHomeState.Destination.DESTINATION_INBOX
    private val PROJECTS = TasksHomeState.Destination.DESTINATION_PROJECTS
    private val NONE = TasksHomeState.Sheet.SHEET_NONE

    override fun initial(): TasksHome = decorate(
        TasksHome(
            screen = TasksHomeState(
                destination = TODAY,
                search = SearchField(),
                sheet = NONE,
                loading = Loading(first_load = true),
            ),
        ),
    )

    override fun reduce(state: TasksHome, event: TasksHomeInput): Step<TasksHome> {
        val step = when (event) {
            is TasksHomeInput.View -> view(state, event.event)
            is TasksHomeInput.Add -> add(state, event.taskId)
            is TasksHomeInput.Answered -> answered(state, event)
            is TasksHomeInput.Denied -> denied(state, event.denial)
        }
        return Step(decorate(step.state), step.effects)
    }

    override fun rowsChanged(table: String, keys: List<String>): TasksHomeInput? =
        if (table in TABLES) {
            TasksHomeInput.View(TasksHomeEvent(rows_changed = TasksHomeEvent.RowsChanged(table = table)))
        } else {
            null
        }

    override fun seatChanged(seat: SeatState): TasksHomeInput =
        TasksHomeInput.View(TasksHomeEvent(seat_changed = TasksHomeEvent.SeatChanged(seat = seat)))

    /** The term search is answering, or null. */
    public fun activeTerm(screen: TasksHomeState): String? {
        val field = screen.search ?: return null
        return field.term.trim().takeIf { field.open_ && it.isNotEmpty() }
    }

    /** The core's view for a destination; Projects reads `tasks.projects` instead. */
    public fun viewOf(destination: TasksHomeState.Destination): TasksView? = when (destination) {
        TODAY -> TasksView.TASKS_VIEW_TODAY
        UPCOMING -> TasksView.TASKS_VIEW_UPCOMING
        INBOX -> TasksView.TASKS_VIEW_INBOX
        else -> null
    }

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    private fun view(state: TasksHome, event: TasksHomeEvent): Step<TasksHome> {
        val screen = state.screen
        return when {
            event.opened != null -> {
                val to = event.opened.destination
                    .takeUnless { it == TasksHomeState.Destination.DESTINATION_UNSPECIFIED } ?: TODAY
                // SEEDED WORDS (Notes' "Send to Tasks") wait in the bar, focused.
                val seed = event.opened.quick_add_title.trim()
                read(
                    state.copy(
                        screen = screen.copy(
                            destination = to,
                            search = SearchField(),
                            sheet = NONE,
                            filing_task_id = "",
                            quick_add = TasksQuickAdd(title = seed, focused = seed.isNotEmpty()),
                            loading = Loading(first_load = true),
                            failure = null,
                            denied = null,
                            data_ = null,
                        ),
                        search = null,
                        limit = PAGE,
                    ),
                )
            }

            event.refreshed != null -> read(state.copy(screen = overRows(screen)))

            event.band != null -> when (event.band.key) {
                BAND_TODAY -> moveTo(state, TODAY)
                BAND_UPCOMING -> moveTo(state, UPCOMING)
                BAND_INBOX -> moveTo(state, INBOX)
                BAND_PROJECTS -> moveTo(state, PROJECTS)
                BAND_MORE -> Step(state.copy(screen = screen.copy(sheet = TasksHomeState.Sheet.SHEET_MORE)))
                else -> Step(state)
            }

            event.sheet_opened != null -> {
                val sheet = event.sheet_opened.sheet
                if (sheet == TasksHomeState.Sheet.SHEET_UNSPECIFIED) {
                    Step(state)
                } else {
                    Step(state.copy(screen = screen.copy(sheet = sheet)))
                }
            }

            event.sheet_closed != null ->
                Step(state.copy(screen = screen.copy(sheet = NONE, filing_task_id = "", new_project_name = "")))

            event.more_row != null -> when (event.more_row.key) {
                MORE_SEARCH -> opened(state.copy(screen = screen.copy(sheet = NONE)))
                MORE_READS -> Step(state.copy(screen = screen.copy(sheet = TasksHomeState.Sheet.SHEET_READS)))
                // INTENTS: the sheet closes, and the shell routes the key.
                else -> Step(state.copy(screen = screen.copy(sheet = NONE)))
            }

            event.search_opened != null -> opened(state)

            event.search_term != null -> {
                val typed = SearchLaw.term(Search, state, event.search_term.term).state
                if (activeTerm(typed.screen) == null) {
                    refold(typed.copy(search = null))
                } else {
                    // THE ROWS STAY while the hits read.
                    read(typed)
                }
            }

            event.search_closed != null -> {
                val closed = SearchLaw.closed(Search, state).state.copy(search = null)
                if (holds(closed)) refold(closed) else read(closed.copy(screen = skeleton(closed.screen)))
            }

            event.row_checked != null -> {
                val task = find(state, event.row_checked.task_id) ?: return Step(state)
                ops(state, TaskOpsLaw.checked(state.ops, task))
            }

            event.file_requested != null -> {
                val id = event.file_requested.task_id
                if (find(state, id) == null) {
                    Step(state)
                } else {
                    Step(state.copy(screen = screen.copy(sheet = TasksHomeState.Sheet.SHEET_FILE, filing_task_id = id)))
                }
            }

            event.file_chosen != null -> file(state, event.file_chosen.key)

            event.status_acted != null -> ops(state, TaskOpsLaw.undo(state.ops))

            event.quick_add_changed != null ->
                Step(state.copy(screen = screen.copy(quick_add = (screen.quick_add ?: TasksQuickAdd()).copy(title = event.quick_add_changed.title))))

            // THE BRIDGE MINTS THE ID: a quick add that reached the machine
            // without one (a spec forwarding the proto event) is nothing.
            event.quick_add_submitted != null -> Step(state)

            event.new_project_name != null ->
                Step(state.copy(screen = screen.copy(new_project_name = event.new_project_name.name)))

            event.new_project_submitted != null -> {
                val name = screen.new_project_name.trim()
                if (name.isEmpty()) {
                    Step(state)
                } else {
                    val out = TaskOpsLaw.created(
                        state.ops,
                        TaskOpsLaw.SAVE_PROJECT,
                        "{\"name\":${jsonString(name)}}",
                        name,
                        TasksCopy.PROJECT_CREATED,
                    )
                    Step(
                        state.copy(ops = out.ops, screen = screen.copy(sheet = NONE, new_project_name = "")),
                        out.effects,
                    )
                }
            }

            event.empty_acted != null ->
                if (screen.destination == PROJECTS) {
                    Step(state.copy(screen = screen.copy(sheet = TasksHomeState.Sheet.SHEET_NEW_PROJECT)))
                } else {
                    Step(state)
                }

            // A FAILED READ IS NOT AN EMPTY LIST.
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
                                failure = event.refused.failure ?: Reads.refused(TasksCopy.READ_INCOMPLETE),
                            ),
                        ),
                    )
                }

            event.rows_changed != null -> read(state.copy(screen = overRows(screen)))

            event.seat_changed != null -> Step(state.copy(screen = screen.copy(seat = event.seat_changed.seat)))

            event.write_settled != null -> ops(state, TaskOpsLaw.settled(state.ops, event.write_settled))

            event.next_page != null ->
                if (state.limit >= MAX_WINDOW) {
                    Step(state)
                } else {
                    read(state.copy(limit = (state.limit + PAGE).coerceAtMost(MAX_WINDOW)))
                }

            // INTENTS: the shell routes them.
            else -> Step(state)
        }
    }

    private fun opened(state: TasksHome): Step<TasksHome> = refold(SearchLaw.opened(Search, state).state)

    /**
     * A band destination. The tab you are on is NOTHING (the kit's band law);
     * another leaves search and reads, skeletons first.
     */
    private fun moveTo(state: TasksHome, to: TasksHomeState.Destination): Step<TasksHome> {
        val searching = state.screen.search?.open_ == true
        if (!searching && state.screen.destination == to) {
            return Step(state.copy(screen = state.screen.copy(sheet = NONE)))
        }
        val left = state.copy(screen = state.screen.copy(search = SearchField(), sheet = NONE), search = null)
        val moved = if (left.screen.destination == to) {
            Step(left.copy(screen = skeleton(left.screen)))
        } else {
            BandLaw.changed(Band, Content, SCREEN_ID, left, to)
        }
        // The band law asks its own read; this screen's reads are queued.
        return read(moved.state)
    }

    private fun add(state: TasksHome, taskId: String): Step<TasksHome> {
        val screen = state.screen
        val title = screen.quick_add?.title?.trim().orEmpty()
        if (title.isEmpty() || screen.denied != null) return Step(state)
        val today = todayOf(state)
        val dated = screen.destination == TODAY && today.isNotEmpty()
        val out = TaskOpsLaw.added(
            state.ops,
            taskId = taskId,
            title = title,
            dueDay = if (dated) today else "",
            landsIn = if (dated) TasksCopy.GROUP_TODAY else TasksCopy.INBOX,
        )
        return Step(
            refoldState(
                state.copy(ops = out.ops, screen = screen.copy(quick_add = (screen.quick_add ?: TasksQuickAdd()).copy(title = ""))),
            ),
            out.effects,
        )
    }

    private fun file(state: TasksHome, key: String): Step<TasksHome> {
        val screen = state.screen
        val task = find(state, screen.filing_task_id) ?: return Step(state.copy(screen = screen.copy(sheet = NONE)))
        val closed = state.copy(screen = screen.copy(sheet = NONE, filing_task_id = ""))
        val projects = projectsOf(state)
        val out = when {
            key == FILE_INBOX -> TaskOpsLaw.filed(state.ops, task, null, null, TasksCopy.INBOX)
            key.startsWith(FILE_PROJECT) -> {
                val id = key.removePrefix(FILE_PROJECT)
                val project = projects.first.firstOrNull { it.project_id == id } ?: return Step(closed)
                TaskOpsLaw.filed(state.ops, task, id, null, project.name)
            }
            key.startsWith(FILE_SECTION) -> {
                val sectionId = key.removePrefix(FILE_SECTION)
                val section = projects.second.firstOrNull { it.section_id == sectionId } ?: return Step(closed)
                val project = projects.first.firstOrNull { it.project_id == section.project_id } ?: return Step(closed)
                TaskOpsLaw.filed(state.ops, task, project.project_id, sectionId, "${project.name} · ${section.name}")
            }
            else -> return Step(closed)
        }
        return ops(closed, out)
    }

    private fun ops(state: TasksHome, out: TaskOpsLaw.Out): Step<TasksHome> =
        Step(refoldState(state.copy(ops = out.ops)), out.effects)

    // ---------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------

    private fun read(state: TasksHome): Step<TasksHome> =
        if (state.reading) {
            Step(state.copy(readQueued = true))
        } else {
            reissue(state)
        }

    private fun reissue(state: TasksHome): Step<TasksHome> = Step(
        state.copy(reading = true, readQueued = false),
        listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)),
    )

    private fun answered(state: TasksHome, answer: TasksHomeInput.Answered): Step<TasksHome> {
        // THE ANSWER IN HAND IS FOR A STATE SINCE LEFT: ask again, draw nothing.
        if (state.readQueued) return reissue(state)
        val term = activeTerm(state.screen)
        val held = state.copy(
            reading = false,
            board = answer.board ?: state.board,
            projects = answer.projects ?: state.projects,
            catchUp = answer.catchUp ?: state.catchUp,
            // A SEARCH CLOSED WHILE ITS HITS WERE READING IS NOT REOPENED.
            search = if (term == null) null else answer.search ?: state.search,
            screen = if (term != null && answer.search != null) {
                SearchLaw.answered(Search, state, state.screen.search?.term ?: "").screen
            } else {
                state.screen
            },
        )
        val open = listOfNotNull(held.board).flatMap { it.groups }.flatMap(::flatten) +
            (held.search?.tasks ?: emptyList())
        val settled = held.copy(ops = TaskOpsLaw.answered(held.ops, open.filter(TasksRows::isOpen), todayOf(held)))
        val folded = refoldState(settled, force = true)
        if (folded.screen.data_ == null) {
            // A SHORT ANSWER IS NOT A WHOLE ONE: nothing the destination
            // needs came back.
            return Step(
                folded.copy(
                    screen = folded.screen.copy(
                        loading = null,
                        denied = null,
                        failure = Reads.refused(TasksCopy.READ_INCOMPLETE),
                    ),
                ),
            )
        }
        return Step(folded)
    }

    private fun denied(state: TasksHome, denial: AppQueryDenial): Step<TasksHome> {
        if (state.readQueued) return reissue(state)
        return Step(
            state.copy(
                reading = false,
                screen = state.screen.copy(
                    loading = null,
                    failure = null,
                    data_ = null,
                    denied = deniedOf(denial),
                    search = SearchField(),
                    sheet = NONE,
                ),
            ),
        )
    }

    /** The gate's words, and the receipt the vault named. */
    public fun deniedOf(denial: AppQueryDenial): Denied = Denied(
        title = TasksCopy.DENIED_TITLE,
        body = TasksCopy.DENIED_BODY,
        receipt = denial.code ?: "",
    )

    // ---------------------------------------------------------------------
    // The fold
    // ---------------------------------------------------------------------

    private fun refold(state: TasksHome): Step<TasksHome> = Step(refoldState(state))

    /**
     * FOLD THE HELD ANSWERS AGAIN — only over a screen already drawing data,
     * unless [force]: a local change during a skeleton or a failure must not
     * conjure rows out of another destination's answer.
     */
    private fun refoldState(state: TasksHome, force: Boolean = false): TasksHome {
        if (!force && state.screen.data_ == null) return state
        val data = fold(state) ?: return state
        return state.copy(screen = state.screen.copy(loading = null, failure = null, denied = null, data_ = data))
    }

    /** Can the held answers draw this destination without a read? */
    private fun holds(state: TasksHome): Boolean = fold(state) != null

    /** The data a view draws, or null when the held answers are not for this state. */
    public fun fold(state: TasksHome): TasksHomeData? {
        val screen = state.screen
        val ops = state.ops
        val term = activeTerm(screen)
        val (projects, sections) = projectsOf(state)
        val today = todayOf(state)
        val ctx = TasksRows.Context(
            today = today,
            projects = projects.associateBy { it.project_id },
            sections = sections.associateBy { it.section_id },
            pending = ops.pendingIds,
            hidden = ops.hiddenIds,
        )
        if (term != null) {
            val hits = state.search ?: return null
            val rows = hits.tasks.filter { it.task_id !in ctx.hidden }.map { TasksRows.row(it, ctx) }
            return TasksHomeData(
                today = hits.today,
                groups = if (rows.isEmpty()) emptyList() else listOf(TasksRowGroup(key = "results", title = TasksCopy.GROUP_RESULTS, meta = rows.size.toString(), rows = rows)),
                empty = if (rows.isEmpty()) EmptyState(headline = TasksCopy.SEARCH_EMPTY) else EmptyState(),
                count_label = TasksRows.count(rows.size, TasksCopy.HIT_ONE, TasksCopy.HIT_MANY),
                searching = true,
            )
        }
        if (screen.destination == PROJECTS) {
            val answer = state.projects ?: return null
            val groups = projectGroups(answer)
            return TasksHomeData(
                today = today,
                projects = groups,
                empty = if (answer.projects.isEmpty()) {
                    EmptyState(headline = TasksCopy.PROJECTS_EMPTY, action_label = TasksCopy.NEW_PROJECT_TITLE)
                } else {
                    EmptyState()
                },
                count_label = TasksRows.count(answer.projects.size, TasksCopy.PROJECT_ONE, TasksCopy.PROJECT_MANY),
            )
        }
        val board = state.board?.takeIf { it.view == viewOf(screen.destination) } ?: return null
        val inboxFiled = ops.filed.filterValues { it.first != null }.keys
        val source = if (screen.destination == INBOX) {
            board.groups.map { g -> g.copy(tasks = g.tasks.filter { it.task_id !in inboxFiled }) }
        } else {
            board.groups
        }
        val groups = withAdds(TasksRows.groups(source, ctx), ops, screen.destination, board.today)
        val dayOne = (board.counts?.let { it.open_ == 0 && it.closed == 0 } ?: false) &&
            board.projects.isEmpty() && ops.adds.isEmpty()
        val empty = when {
            groups.isNotEmpty() -> EmptyState()
            dayOne -> EmptyState(headline = TasksCopy.DAY_ONE)
            screen.destination == TODAY ->
                EmptyState(headline = if (ops.completed > 0) TasksCopy.TODAY_DONE else TasksCopy.TODAY_EMPTY)
            screen.destination == UPCOMING -> EmptyState(headline = TasksCopy.UPCOMING_EMPTY)
            else -> EmptyState(headline = TasksCopy.INBOX_EMPTY)
        }
        val shown = TasksRows.rootCount(groups)
        val catchUp = state.catchUp
        return TasksHomeData(
            today = board.today,
            groups = groups,
            empty = empty,
            notice = if (screen.destination == TODAY && catchUp != null && catchUp.absent) {
                TasksNotice(
                    sentence = "${TasksCopy.AWAY} ${catchUp.away_days} ${TasksCopy.DAYS} · ${catchUp.overdue} " +
                        if (catchUp.overdue == 1) TasksCopy.CAME_DUE_ONE else TasksCopy.CAME_DUE_MANY,
                    verb_label = TasksCopy.CATCH_UP,
                    verb_key = TasksRows.VERB_CATCH_UP,
                )
            } else {
                null
            },
            count_label = TasksRows.count(shown, TasksCopy.TASK_ONE, TasksCopy.TASK_MANY),
            window_label = if (board.truncated) {
                "${TasksRows.count(board.window, TasksCopy.TASK_ONE, TasksCopy.TASK_MANY)} · ${TasksCopy.WINDOW}"
            } else {
                ""
            },
            can_show_more = board.truncated && state.limit < MAX_WINDOW,
        )
    }

    /** A quick add is drawn where it lands: Today (dated today) or the Inbox. */
    private fun withAdds(
        groups: List<TasksRowGroup>,
        ops: TaskOps,
        destination: TasksHomeState.Destination,
        today: String,
    ): List<TasksRowGroup> {
        val carried = groups.flatMap { g -> g.rows.map { it.task_id } }.toSet()
        val (key, title, lands) = when (destination) {
            TODAY -> Triple("today", TasksCopy.GROUP_TODAY) { a: PendingAdd -> a.dueDay == today && a.projectId == null }
            INBOX -> Triple("inbox", TasksCopy.INBOX) { a: PendingAdd -> a.dueDay.isEmpty() && a.projectId == null }
            else -> return groups
        }
        val rows = ops.adds.filter { lands(it) && it.taskId !in carried }.map { TasksRows.pendingRow(it.taskId, it.title) }
        if (rows.isEmpty()) return groups
        val kind = if (destination == TODAY) TasksGroupKind.TASKS_GROUP_KIND_TODAY else TasksGroupKind.TASKS_GROUP_KIND_INBOX
        val at = groups.indexOfFirst { it.title == title }
        return if (at >= 0) {
            groups.mapIndexed { i, g -> if (i == at) g.copy(rows = g.rows + rows, meta = (g.rows.size + rows.size).toString()) else g }
        } else {
            groups + TasksRowGroup(key = "${kind.value}|$key", title = title, meta = rows.size.toString(), rows = rows)
        }
    }

    private fun projectGroups(answer: TasksProjects): List<TasksProjectGroup> {
        val byArea = answer.projects.sortedWith(compareBy({ it.sort_order }, { it.name })).groupBy { it.area?.takeIf(String::isNotBlank) }
        val named = byArea.keys.filterNotNull().sorted()
        // Named areas A→Z, then the projects in none.
        val order: List<String?> = named + if (byArea.containsKey(null)) listOf(null) else emptyList()
        return order.map { area ->
                TasksProjectGroup(
                    key = "area|${area ?: ""}",
                    title = area ?: TasksCopy.PROJECTS_NO_AREA,
                    rows = byArea[area].orEmpty().map { project ->
                        val count = TasksRows.count(project.open_count, TasksCopy.TASK_ONE, TasksCopy.TASK_MANY)
                        ListRow(
                            id = project.project_id,
                            title = project.name,
                            meta = count,
                            hue_key = TasksRows.hueOf(project.project_id, project),
                            accessibility_label = "${project.name}, $count",
                        )
                    },
                )
            }
    }

    // ---------------------------------------------------------------------
    // What every state carries
    // ---------------------------------------------------------------------

    private fun decorate(state: TasksHome): TasksHome {
        val screen = state.screen
        val denied = screen.denied != null
        val title = screen.quick_add?.title.orEmpty()
        val today = todayOf(state)
        val lands = if (screen.destination == TODAY && today.isNotEmpty()) TasksCopy.GROUP_TODAY else TasksCopy.INBOX
        return state.copy(
            screen = screen.copy(
                band = if (denied) emptyList() else band(screen),
                chrome = TasksRows.CHROME,
                status = state.ops.status,
                quick_add = TasksQuickAdd(
                    title = title,
                    can_submit = title.isNotBlank(),
                    lands_label = "${TasksCopy.LANDS_IN} $lands",
                    shown = !denied && screen.data_ != null && screen.destination != PROJECTS && activeTerm(screen) == null,
                    focused = screen.quick_add?.focused == true && title.isNotEmpty(),
                ),
                file_choices = if (screen.sheet == TasksHomeState.Sheet.SHEET_FILE) fileChoices(state) else emptyList(),
                more_rows = MORE_ROWS,
                new_project_can_submit = screen.new_project_name.isNotBlank(),
            ),
        )
    }

    private fun band(screen: TasksHomeState): List<centraid.screen.v1.TasksBandTab> {
        val searching = screen.search?.open_ == true
        val sheetUp = screen.sheet == TasksHomeState.Sheet.SHEET_MORE || screen.sheet == TasksHomeState.Sheet.SHEET_READS
        fun on(d: TasksHomeState.Destination) = screen.destination == d && !searching && !sheetUp
        return listOf(
            TasksRows.tab(BAND_TODAY, TasksCopy.BAND_TODAY, "Sun", on(TODAY)),
            TasksRows.tab(BAND_UPCOMING, TasksCopy.BAND_UPCOMING, "Calendar", on(UPCOMING)),
            TasksRows.tab(BAND_INBOX, TasksCopy.BAND_INBOX, "Inbox", on(INBOX)),
            TasksRows.tab(BAND_PROJECTS, TasksCopy.BAND_PROJECTS, "Folder", on(PROJECTS)),
            TasksRows.tab(BAND_MORE, TasksCopy.BAND_MORE, "more", sheetUp),
        )
    }

    private val MORE_ROWS: List<TasksChoice> = listOf(
        TasksChoice(key = MORE_ANYTIME, label = TasksCopy.VIEW_ANYTIME, meta = TasksCopy.MORE_ANYTIME_META, enabled = true, icon_key = "Layers"),
        TasksChoice(key = MORE_ALL, label = TasksCopy.VIEW_ALL, meta = TasksCopy.MORE_ALL_META, enabled = true, icon_key = "List"),
        TasksChoice(key = MORE_LOGBOOK, label = TasksCopy.VIEW_LOGBOOK, meta = TasksCopy.MORE_LOGBOOK_META, enabled = true, icon_key = "Book"),
        TasksChoice(key = MORE_REMINDERS, label = TasksCopy.VIEW_REMINDERS, meta = TasksCopy.MORE_REMINDERS_META, enabled = true, icon_key = "Bell"),
        TasksChoice(key = MORE_CATCH_UP, label = TasksCopy.CATCH_UP, meta = TasksCopy.MORE_CATCH_UP_META, enabled = true, icon_key = "History"),
        TasksChoice(key = MORE_SEARCH, label = TasksCopy.SEARCH, enabled = true, icon_key = "Search"),
        TasksChoice(key = MORE_TRASH, label = TasksCopy.TRASH, meta = TasksCopy.MORE_TRASH_META, enabled = true, icon_key = "Trash"),
        TasksChoice(key = MORE_READS, label = TasksCopy.READS_TITLE, enabled = true, icon_key = "Info"),
    )

    /** Inbox, then each project and its sections, the task's own place selected. */
    private fun fileChoices(state: TasksHome): List<TasksChoice> {
        val task = find(state, state.screen.filing_task_id) ?: return emptyList()
        val (projects, sections) = projectsOf(state)
        val bySection = sections.groupBy { it.project_id }
        return buildList {
            add(TasksChoice(key = FILE_INBOX, label = TasksCopy.INBOX, selected = task.project_id == null, enabled = true, icon_key = "Inbox"))
            projects.sortedWith(compareBy({ it.sort_order }, { it.name })).forEach { project ->
                add(
                    TasksChoice(
                        key = FILE_PROJECT + project.project_id,
                        label = project.name,
                        selected = task.project_id == project.project_id && task.section_id == null,
                        enabled = true,
                        icon_key = "Folder",
                    ),
                )
                bySection[project.project_id].orEmpty().sortedBy { it.sort_order }.forEach { section ->
                    add(
                        TasksChoice(
                            key = FILE_SECTION + section.section_id,
                            label = section.name,
                            selected = task.section_id == section.section_id,
                            enabled = true,
                            indented = true,
                        ),
                    )
                }
            }
        }
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    private fun todayOf(state: TasksHome): String =
        state.board?.today?.ifEmpty { null } ?: state.catchUp?.today?.ifEmpty { null } ?: state.search?.today ?: ""

    /** Projects and sections from whichever answer holds them. */
    private fun projectsOf(state: TasksHome): Pair<List<centraid.core.v1.TasksProject>, List<centraid.core.v1.TasksSection>> {
        val projects = state.projects
        val board = state.board
        return when {
            projects != null -> projects.projects to projects.sections
            board != null -> board.projects to board.sections
            else -> emptyList<centraid.core.v1.TasksProject>() to emptyList()
        }
    }

    /** A task on screen, root or child, by id. */
    public fun find(state: TasksHome, id: String): TasksTask? {
        if (id.isEmpty()) return null
        val all = listOfNotNull(state.board).flatMap { it.groups }.flatMap(::flatten) + (state.search?.tasks ?: emptyList())
        return all.firstOrNull { it.task_id == id }
    }

    /** A group's roots and their children. */
    public fun flatten(group: TasksGroup): List<TasksTask> = group.tasks.flatMap { listOf(it) + it.children }

    private fun overRows(screen: TasksHomeState): TasksHomeState =
        if (screen.data_ != null) screen else skeleton(screen)

    private fun skeleton(screen: TasksHomeState): TasksHomeState =
        screen.copy(loading = Loading(first_load = true), failure = null, denied = null, data_ = null)

    // ---------------------------------------------------------------------
    // Lenses the kit's laws take
    // ---------------------------------------------------------------------

    private object Search : SearchLens<TasksHome> {
        override val screenId: String = SCREEN_ID

        override fun field(state: TasksHome): SearchField = state.screen.search ?: SearchField()

        override fun with(state: TasksHome, field: SearchField): TasksHome =
            state.copy(screen = state.screen.copy(search = field))
    }

    private object Band : BandLens<TasksHome, TasksHomeState.Destination> {
        override fun destination(state: TasksHome): TasksHomeState.Destination = state.screen.destination

        override fun with(state: TasksHome, destination: TasksHomeState.Destination): TasksHome =
            state.copy(screen = state.screen.copy(destination = destination))
    }

    private object Content : ContentLens<TasksHome, TasksHomeData> {
        override fun content(state: TasksHome): ReadContent<TasksHomeData> {
            val s = state.screen
            return when {
                s.data_ != null -> ReadContent.Data(s.data_)
                s.failure != null -> ReadContent.Failed(s.failure)
                s.denied != null -> ReadContent.Denied(s.denied)
                else -> ReadContent.Loading(s.loading?.first_load ?: true)
            }
        }

        override fun with(state: TasksHome, content: ReadContent<TasksHomeData>): TasksHome {
            val s = state.screen
            val next = when (content) {
                is ReadContent.Loading -> s.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
                is ReadContent.Failed -> s.copy(loading = null, failure = content.failure, denied = null, data_ = null)
                is ReadContent.Denied -> s.copy(loading = null, failure = null, denied = content.denied, data_ = null)
                is ReadContent.Data -> s.copy(loading = null, failure = null, denied = null, data_ = content.data)
            }
            return state.copy(screen = next)
        }
    }
}

/**
 * WHAT TASKS' HOME ASKS THE CORE (#1029 port), per destination (law 2):
 *
 * - Today: `tasks.board` for Today, and `tasks.catch-up` for the absence notice.
 * - Upcoming, Inbox: `tasks.board` for that view.
 * - Projects: `tasks.projects`.
 * - A search term: `tasks.search` alone — the hits replace the list.
 *
 * Every request states the device's zone; the core answers civil days in it.
 */
public object TasksHomeReads : ScreenQueries<TasksHome, TasksHomeInput>, ScreenWrites<TasksHome, TasksHomeInput> {
    override val screenId: String = TasksHomeMachine.SCREEN_ID
    override val tables: Set<String> = TasksHomeMachine.TABLES
    override val appId: String = APP_ID

    public const val SEARCH_LIMIT: Int = 50

    override fun requests(state: TasksHome, now: DeviceClock.Reading): List<AppQueryRequest>? {
        val screen = state.screen
        val zone = now.zone
        TasksHomeMachine.activeTerm(screen)?.let { term ->
            return listOf(AppQueryRequest(tasks_search = TasksSearchRequest(term = term, limit = SEARCH_LIMIT, tz = zone)))
        }
        if (screen.destination == TasksHomeState.Destination.DESTINATION_PROJECTS) {
            return listOf(AppQueryRequest(tasks_projects = TasksProjectsRequest(tz = zone)))
        }
        val view = TasksHomeMachine.viewOf(screen.destination) ?: return null
        val board = AppQueryRequest(tasks_board = TasksBoardRequest(tz = zone, limit = state.limit, view = view))
        return if (view == TasksView.TASKS_VIEW_TODAY) {
            listOf(board, AppQueryRequest(tasks_catch_up = TasksCatchUpRequest(tz = zone)))
        } else {
            listOf(board)
        }
    }

    override fun arrived(answers: List<AppQueryResponse>): TasksHomeInput = TasksHomeInput.Answered(
        board = answers.firstNotNullOfOrNull { it.tasks_board },
        projects = answers.firstNotNullOfOrNull { it.tasks_projects },
        catchUp = answers.firstNotNullOfOrNull { it.tasks_catch_up },
        search = answers.firstNotNullOfOrNull { it.tasks_search },
    )

    override fun refused(failure: ReadFailure): TasksHomeInput =
        TasksHomeInput.View(TasksHomeEvent(refused = TasksHomeEvent.ReadRefused(failure = failure)))

    override fun denied(denial: AppQueryDenial): TasksHomeInput = TasksHomeInput.Denied(denial)

    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): TasksHomeInput =
        TasksHomeInput.View(TasksHomeEvent(write_settled = WriteLaw.settledOf(status, sentence, invokeKey)))
}

/** Every Tasks write's app. */
public const val APP_ID: String = "tasks"
