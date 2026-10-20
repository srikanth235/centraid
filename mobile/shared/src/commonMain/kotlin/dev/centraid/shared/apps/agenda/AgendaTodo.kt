package dev.centraid.shared.apps.agenda

import centraid.core.v1.TasksBoard
import centraid.core.v1.TasksCatchUp
import centraid.core.v1.TasksGroup
import centraid.core.v1.TasksGroupKind
import centraid.core.v1.TasksProject
import centraid.core.v1.TasksProjects
import centraid.core.v1.TasksSearch
import centraid.core.v1.TasksSection
import centraid.core.v1.TasksTask
import centraid.screen.v1.AgendaHomeData
import centraid.screen.v1.AgendaTodo
import centraid.screen.v1.EmptyState
import centraid.screen.v1.ImportSource
import centraid.screen.v1.ListRow
import centraid.screen.v1.TasksChoice
import centraid.screen.v1.TasksChrome
import centraid.screen.v1.TasksProjectGroup
import centraid.screen.v1.TasksRowGroup
import dev.centraid.design.copy.TasksCopy
import dev.centraid.shared.kit.tasks.PendingAdd
import dev.centraid.shared.kit.tasks.TaskOps
import dev.centraid.shared.kit.tasks.TaskOpsLaw
import dev.centraid.shared.kit.tasks.TasksRows

/**
 * THE TASKS HALF OF AGENDA'S HOME (#1128): what is held beside the events.
 *
 * The core's raw `tasks.*` answers, like [AgendaAnswers] for the events, kept
 * here so a task checked off or filed re-folds without a read:
 *
 * - [inbox] and [projects] are To-do's (`tasks.board` INBOX, `tasks.projects`).
 * - [today] and [upcoming] are the dated boards Day and Schedule draw on their
 *   days (`tasks.board` TODAY — its Overdue group, then today — and UPCOMING),
 *   [catchUp] is the absence notice's, and [search] is the term's task hits.
 * - [ops] are the writes this phone has out and the rows it hides or draws
 *   until the vault's answer carries them (`TaskOpsLaw`).
 * - [limit] is To-do's window, widened by "Show more".
 * - [heldTodo] and [heldDated] say the answers above are for the vault as it
 *   is now — To-do's, and the dated boards' for the window named — and a change
 *   event clears both, so coming back to a place reads again.
 */
public data class AgendaTasks(
    public val inbox: TasksBoard? = null,
    public val projects: TasksProjects? = null,
    public val today: TasksBoard? = null,
    public val upcoming: TasksBoard? = null,
    public val catchUp: TasksCatchUp? = null,
    public val search: TasksSearch? = null,
    public val ops: TaskOps = TaskOps(),
    public val limit: Int = TodoPlace.PAGE,
    public val heldTodo: Boolean = false,
    public val heldDated: String? = null,
)

/** The `tasks.*` answers to one read, BY ARM; null where the arm was not asked. */
public data class TasksAnswers(
    public val inbox: TasksBoard? = null,
    public val projects: TasksProjects? = null,
    public val today: TasksBoard? = null,
    public val upcoming: TasksBoard? = null,
    public val catchUp: TasksCatchUp? = null,
    public val search: TasksSearch? = null,
)

/**
 * TO-DO (#1128, R-1128-1): the Inbox's tasks, then the projects by area — named
 * areas A→Z, then "Projects" for those in none — in one list.
 *
 * Pure folds over [AgendaTasks]; [AgendaHomeMachine] owns the events. The quick
 * add lands in the Inbox, its row is drawn at once and taken back, with the
 * core's sentence, if the vault refuses it. A row is checked off (hidden at
 * once, "Task done" and Undo on the status line), filed (a sheet of Inbox,
 * projects and sections), or opened.
 */
public object TodoPlace {
    /** The board window, and how far "Show more" may widen it (the manifest's 20…500). */
    public const val PAGE: Int = TasksRows.PAGE
    public const val MAX_WINDOW: Int = TasksRows.MAX_WINDOW

    /** Filing choice keys. */
    public const val FILE_INBOX: String = TasksRows.FILE_INBOX
    public const val FILE_PROJECT: String = TasksRows.FILE_PROJECT
    public const val FILE_SECTION: String = TasksRows.FILE_SECTION

    /**
     * THE TASK WORDS A VIEW DRAWS on To-do (and Day): the quick-add bar's
     * placeholder and verb, the filing sheet, the new-project sheet.
     */
    public val CHROME: TasksChrome = TasksChrome(
        quick_add_placeholder = TasksCopy.TITLE_PLACEHOLDER,
        quick_add_verb = TasksCopy.ADD,
        file_title = TasksCopy.FILE_TITLE,
        new_project_title = TasksCopy.NEW_PROJECT_TITLE,
        new_project_placeholder = TasksCopy.NEW_PROJECT_PLACEHOLDER,
        new_project_verb = TasksCopy.NEW_PROJECT_VERB,
        cancel = TasksCopy.CANCEL,
        show_more = TasksCopy.SHOW_MORE,
        file_verb = TasksCopy.FILE,
    )

    /** Every task the held answers carry, root or child — To-do's, the dated boards' and the hits'. */
    internal fun held(tasks: AgendaTasks): List<TasksTask> =
        listOfNotNull(tasks.inbox, tasks.today, tasks.upcoming).flatMap { it.groups }.flatMap(TasksRows::flatten) +
            tasks.search?.tasks.orEmpty()

    /** A task on screen, root or child, by id. */
    internal fun find(tasks: AgendaTasks, id: String): TasksTask? =
        if (id.isEmpty()) null else held(tasks).firstOrNull { it.task_id == id }

    /** Projects and sections from whichever answer holds them. */
    internal fun projectsOf(tasks: AgendaTasks): Pair<List<TasksProject>, List<TasksSection>> {
        val projects = tasks.projects
        val board = listOfNotNull(tasks.inbox, tasks.today, tasks.upcoming).firstOrNull()
        return when {
            projects != null -> projects.projects to projects.sections
            board != null -> board.projects to board.sections
            else -> emptyList<TasksProject>() to emptyList()
        }
    }

    /** The tasks an answer carries that are still open, for `TaskOpsLaw.answered`. */
    internal fun openIn(tasks: AgendaTasks): List<TasksTask> = held(tasks).filter(TasksRows::isOpen)

    /** The day the core named, from whichever held board has one. */
    internal fun todayOf(tasks: AgendaTasks): String =
        listOfNotNull(tasks.inbox?.today, tasks.today?.today, tasks.upcoming?.today, tasks.catchUp?.today)
            .firstOrNull { it.isNotEmpty() }.orEmpty()

    /**
     * TO-DO'S DATA, or null when the held answers are not for this state — the
     * Inbox board and the projects must both be in hand.
     */
    internal fun fold(tasks: AgendaTasks): AgendaHomeData? {
        val board = tasks.inbox ?: return null
        val answer = tasks.projects ?: return null
        val ops = tasks.ops
        val today = board.today
        val (projects, sections) = projectsOf(tasks)
        val ctx = TasksRows.Context(
            today = today,
            projects = projects.associateBy { it.project_id },
            sections = sections.associateBy { it.section_id },
            pending = ops.pendingIds,
            hidden = ops.hiddenIds,
        )
        // A TASK FILED INTO A PROJECT LEAVES THE INBOX AT ONCE, before the answer says so.
        val inboxFiled = ops.filed.filterValues { it.first != null }.keys
        val source = board.groups.map { g -> g.copy(tasks = g.tasks.filter { it.task_id !in inboxFiled }) }
        val groups = withAdds(TasksRows.groups(source, ctx), ops)
        val projectGroups = projectGroups(answer)
        val open = board.counts?.open_ ?: -1
        val dayOne = (board.counts?.let { it.open_ == 0 && it.closed == 0 } ?: false) &&
            board.projects.isEmpty() && answer.projects.isEmpty() && ops.adds.isEmpty()
        // NOTHING OPEN — day one, or the starters finished — is when the
        // phone's reminders are offered: a first vault's starter tasks mean
        // day one is never seen, and "all done" is the point of use.
        val reminders = if (open == 0 && ops.adds.isEmpty()) {
            ImportSource.IMPORT_SOURCE_REMINDERS
        } else {
            ImportSource.IMPORT_SOURCE_UNSPECIFIED
        }
        val empty = when {
            groups.isNotEmpty() || projectGroups.isNotEmpty() -> EmptyState()
            // DAY ONE, and only day one, says so; both offer the phone's
            // reminders, where the shell can read them.
            dayOne -> EmptyState(headline = TasksCopy.DAY_ONE, import_source = ImportSource.IMPORT_SOURCE_REMINDERS)
            else -> EmptyState(
                headline = TasksCopy.INBOX_EMPTY,
                import_source = reminders,
                action_label = TasksCopy.NEW_PROJECT_TITLE,
            )
        }
        val rootCount = TasksRows.rootCount(groups)
        val counts = listOfNotNull(
            TasksRows.count(rootCount, TasksCopy.TASK_ONE, TasksCopy.TASK_MANY).takeIf { rootCount > 0 },
            TasksRows.count(answer.projects.size, TasksCopy.PROJECT_ONE, TasksCopy.PROJECT_MANY)
                .takeIf { answer.projects.isNotEmpty() },
        )
        return AgendaHomeData(
            today = today,
            now_local = board.now_local,
            todo = AgendaTodo(
                groups = groups,
                projects = projectGroups,
                empty = empty,
                count_label = counts.joinToString(" · "),
                window_label = if (board.truncated) {
                    "${TasksRows.count(board.window, TasksCopy.TASK_ONE, TasksCopy.TASK_MANY)} · ${TasksCopy.WINDOW}"
                } else {
                    ""
                },
                can_show_more = board.truncated && tasks.limit < MAX_WINDOW,
                new_project_label = TasksCopy.NEW_PROJECT_TITLE,
            ),
        )
    }

    /** A quick add is drawn where it lands: the Inbox, with the rest of the Inbox's rows. */
    private fun withAdds(groups: List<TasksRowGroup>, ops: TaskOps): List<TasksRowGroup> {
        val carried = groups.flatMap { g -> g.rows.map { it.task_id } }.toSet()
        val lands = { add: PendingAdd -> add.dueDay.isEmpty() && add.projectId == null }
        val rows = ops.adds.filter { lands(it) && it.taskId !in carried }.map { TasksRows.pendingRow(it.taskId, it.title) }
        if (rows.isEmpty()) return groups
        val at = groups.indexOfFirst { it.title == TasksCopy.INBOX }
        return if (at >= 0) {
            groups.mapIndexed { i, g ->
                if (i == at) g.copy(rows = g.rows + rows, meta = (g.rows.size + rows.size).toString()) else g
            }
        } else {
            listOf(
                TasksRowGroup(
                    key = "${TasksGroupKind.TASKS_GROUP_KIND_INBOX.value}|inbox",
                    title = TasksCopy.INBOX,
                    meta = rows.size.toString(),
                    rows = rows,
                ),
            ) + groups
        }
    }

    /** Named areas A→Z, then the projects in none. */
    private fun projectGroups(answer: TasksProjects): List<TasksProjectGroup> {
        val byArea = answer.projects
            .sortedWith(compareBy({ it.sort_order }, { it.name }))
            .groupBy { it.area?.takeIf(String::isNotBlank) }
        val named = byArea.keys.filterNotNull().sorted()
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

    /** Inbox, then each project and its sections, the task's own place selected. */
    internal fun fileChoices(tasks: AgendaTasks, taskId: String): List<TasksChoice> {
        val task = find(tasks, taskId) ?: return emptyList()
        val (projects, sections) = projectsOf(tasks)
        val bySection = sections.groupBy { it.project_id }
        return buildList {
            add(
                TasksChoice(
                    key = FILE_INBOX,
                    label = TasksCopy.INBOX,
                    selected = task.project_id == null,
                    enabled = true,
                    icon_key = "Inbox",
                ),
            )
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

    /**
     * A FILING CHOICE, as the write it makes — or null when the key names a
     * place the held answers no longer have (a project gone since the sheet
     * was drawn).
     */
    internal fun filing(tasks: AgendaTasks, task: TasksTask, key: String): TaskOpsLaw.Out? {
        val (projects, sections) = projectsOf(tasks)
        return when {
            key == FILE_INBOX -> TaskOpsLaw.filed(tasks.ops, task, null, null, TasksCopy.INBOX)
            key.startsWith(FILE_PROJECT) -> {
                val id = key.removePrefix(FILE_PROJECT)
                val project = projects.firstOrNull { it.project_id == id } ?: return null
                TaskOpsLaw.filed(tasks.ops, task, id, null, project.name)
            }
            key.startsWith(FILE_SECTION) -> {
                val sectionId = key.removePrefix(FILE_SECTION)
                val section = sections.firstOrNull { it.section_id == sectionId } ?: return null
                val project = projects.firstOrNull { it.project_id == section.project_id } ?: return null
                TaskOpsLaw.filed(tasks.ops, task, project.project_id, sectionId, "${project.name} · ${section.name}")
            }
            else -> null
        }
    }
}
