package dev.centraid.shared.apps.tasks

import centraid.core.v1.TasksGroup
import centraid.core.v1.TasksGroupKind
import centraid.core.v1.TasksProject
import centraid.core.v1.TasksSection
import centraid.core.v1.TasksTask
import centraid.screen.v1.TasksBandTab
import centraid.screen.v1.TasksCheck
import centraid.screen.v1.TasksChrome
import centraid.screen.v1.TasksFact
import centraid.screen.v1.TasksRow
import centraid.screen.v1.TasksRowGroup
import dev.centraid.design.copy.TasksCopy
import dev.centraid.shared.design.PartyHueWheel
import dev.centraid.shared.kit.time.CivilWords

/**
 * WHAT ONE TASK SAYS AS A ROW — one way, for every Tasks screen (#1029 port).
 *
 * Pure: every date is a civil string the core already placed in the device's
 * zone (`due_day`, `due_time`, `remind_at_local`, `completed_day`), and
 * `today` is the answer's own — never the device clock, which was v0's UTC
 * "today" defect. The words are [CivilWords] and [TasksCopy]; a view formats
 * nothing.
 */
public object TasksRows {
    /** What a row needs besides its task. */
    public data class Context(
        val today: String,
        val projects: Map<String, TasksProject> = emptyMap(),
        val sections: Map<String, TasksSection> = emptyMap(),
        /** The group head already names the day, so the row says the time only. */
        val dayInHead: Boolean = false,
        /** Name the project in the meta line (not inside the project itself). */
        val showProject: Boolean = true,
        /** Rows this phone has written and the vault has not answered. */
        val pending: Set<String> = emptySet(),
        /** Rows hidden here until the vault's answer moves them. */
        val hidden: Set<String> = emptySet(),
    )

    public fun row(task: TasksTask, ctx: Context, subtask: Boolean = false): TasksRow {
        val title = task.title.ifBlank { TasksCopy.UNTITLED }
        val due = dueLabel(task, ctx)
        val meta = meta(task, ctx)
        val priority = priorityLabel(task.priority)
        val check = checkOf(task.status)
        val open = check == TasksCheck.TASKS_CHECK_OPEN || check == TasksCheck.TASKS_CHECK_IN_PROCESS
        val pending = task.task_id in ctx.pending
        val children = if (subtask) {
            emptyList()
        } else {
            task.children.filter { it.task_id !in ctx.hidden }.map { row(it, ctx, subtask = true) }
        }
        return TasksRow(
            task_id = task.task_id,
            title = title,
            due_label = due,
            overdue = task.overdue && open,
            meta = meta,
            priority_label = priority,
            project_hue_key = task.project_id?.let { hueOf(it, ctx.projects[it]) } ?: "",
            check = check,
            check_label = checkLabel(title, open),
            accessibility_label = listOf(title, due, meta, priority)
                .filter { it.isNotEmpty() }
                .joinToString(", "),
            pending = pending,
            subtask = subtask,
            children = children,
            can_file = open && !subtask && !pending,
            can_check = !pending,
        )
    }

    /** A row for a task added here and not yet answered. */
    public fun pendingRow(taskId: String, title: String): TasksRow = TasksRow(
        task_id = taskId,
        title = title,
        meta = TasksCopy.PENDING_ROW,
        check = TasksCheck.TASKS_CHECK_OPEN,
        check_label = checkLabel(title, open = true),
        accessibility_label = "$title, ${TasksCopy.PENDING_ROW}",
        pending = true,
        can_file = false,
        can_check = false,
    )

    public fun checkLabel(title: String, open: Boolean): String =
        if (open) "${TasksCopy.MARK} $title ${TasksCopy.DONE_SUFFIX}" else "${TasksCopy.REOPEN} $title"

    public fun checkOf(status: String): TasksCheck = when (status) {
        STATUS_COMPLETED -> TasksCheck.TASKS_CHECK_DONE
        STATUS_CANCELLED -> TasksCheck.TASKS_CHECK_WONT_DO
        STATUS_IN_PROCESS -> TasksCheck.TASKS_CHECK_IN_PROCESS
        else -> TasksCheck.TASKS_CHECK_OPEN
    }

    public fun isOpen(task: TasksTask): Boolean =
        task.status != STATUS_COMPLETED && task.status != STATUS_CANCELLED

    /**
     * THE DUE, IN WORDS. Overdue says how long ago — a fact, in the attention
     * tone, never a scold. A group head that names the day leaves the time.
     */
    public fun dueLabel(task: TasksTask, ctx: Context): String {
        if (task.due_day.isEmpty()) return ""
        val days = task.days_from_today
        if (task.overdue && days != null && days < 0) {
            return if (days == -1) CivilWords.relativeDay(task.due_day, ctx.today) else "${-days} ${TasksCopy.DAYS_AGO}"
        }
        if (ctx.dayInHead) return task.due_time
        val day = CivilWords.relativeDay(task.due_day, ctx.today)
        return if (task.due_time.isEmpty()) day else if (task.lands_today) task.due_time else "$day ${task.due_time}"
    }

    /**
     * The meta line: project · repeats · missed · reminder · effort · tags ·
     * family · age · logbook day. Each part only when it says something.
     */
    public fun meta(task: TasksTask, ctx: Context): String {
        val parts = mutableListOf<String>()
        if (ctx.showProject) {
            task.project_id?.let { ctx.projects[it] }?.let { project ->
                val section = task.section_id?.let { ctx.sections[it] }
                parts += if (section != null) "${project.name} · ${section.name}" else project.name
            }
        }
        // THE CORE'S SENTENCE, never a dash (v0 drew "—" for every repeat).
        task.recurrence_summary?.takeIf { task.repeats && it.isNotBlank() }?.let { parts += it }
        if (task.missed > 0 && task.due_day.isNotEmpty()) {
            parts += "${TasksCopy.MISSED} ${task.missed} · ${TasksCopy.NEXT_IS} ${CivilWords.relativeDay(task.due_day, ctx.today)}"
        }
        reminderPart(task, ctx.today)?.let { parts += it }
        task.effort_min?.let { parts += effortLabel(it) }
        task.tags.forEach { parts += "#${it.label}" }
        if (task.children.isNotEmpty()) {
            parts += "${task.done_children} ${TasksCopy.OF} ${task.children.size}"
        }
        if (task.due_day.isEmpty() && isOpen(task)) {
            val age = task.age_days
            val month = task.created_at?.let(::monthOf)
            if (age != null && age >= SITTING_DAYS && !month.isNullOrEmpty()) {
                parts += "${TasksCopy.SITTING_SINCE} $month"
            }
        }
        if (!isOpen(task) && task.completed_day.isNotEmpty()) {
            val day = CivilWords.relativeDay(task.completed_day, ctx.today)
            parts += if (task.status == STATUS_CANCELLED) "${TasksCopy.WONT_DO.lowercase()} · $day" else day
        }
        if (task.task_id in ctx.pending) parts += TasksCopy.PENDING_ROW
        return parts.filter { it.isNotEmpty() }.joinToString(META_SEPARATOR)
    }

    /**
     * THE OWNER'S RULING ON A DATE-ONLY REMINDER: it names a moment only when
     * the core supplies one (`remind_at_local`); a date has no moment to count
     * back from, so it says "on the day" and never invents 09:00.
     */
    public fun reminderPart(task: TasksTask, today: String): String? {
        if (task.remind_at_local.isNotEmpty()) {
            val day = CivilWords.relativeDay(task.remind_at_local.take(DAY), today)
            return "${TasksCopy.REMINDER} $day ${CivilWords.clock(task.remind_at_local)}"
        }
        if (task.remind_before_min != null && task.due_day.isNotEmpty()) {
            return "${TasksCopy.REMINDER} ${TasksCopy.REMINDER_ON_THE_DAY.lowercase()}"
        }
        return null
    }

    /** `~25 min`, `~1 hour`. */
    public fun effortLabel(minutes: Long): String =
        if (minutes == HOUR) "${TasksCopy.EFFORT_PREFIX}${TasksCopy.EFFORT_HOUR}" else "${TasksCopy.EFFORT_PREFIX}$minutes ${TasksCopy.MIN}"

    /** Four member-facing levels over the core's scale, higher more urgent. */
    public fun priorityLabel(priority: Long): String = when {
        priority <= 0 -> ""
        priority == 1L -> TasksCopy.PRIORITY_SOON
        priority == 2L -> TasksCopy.PRIORITY_NEXT
        else -> TasksCopy.PRIORITY_NOW
    }

    public fun hueOf(projectId: String, project: TasksProject?): String =
        PartyHueWheel.partyHueKey(projectId, project?.color) ?: PartyHueWheel.identityHueKey(projectId)

    /** `March`, from an instant or a day. */
    public fun monthOf(stamp: String): String =
        stamp.takeIf { it.length >= MONTH_TO }?.substring(MONTH_FROM, MONTH_TO)?.toIntOrNull()?.let(CivilWords::monthName) ?: ""

    /** `April 2026`. */
    public fun monthYear(day: String): String = "${monthOf(day)} ${day.take(YEAR)}"

    /** `3 tasks`, `1 task`. */
    public fun count(n: Int, one: String, many: String): String = "$n ${if (n == 1) one else many}"

    // ---------------------------------------------------------------------
    // Groups
    // ---------------------------------------------------------------------

    /**
     * The core's groups, finished. Hidden rows drop out; a group left empty
     * by that is dropped too, except a project's sections, which are drawn
     * empty (the core's own rule for `TASKS_VIEW_PROJECT`).
     */
    public fun groups(groups: List<TasksGroup>, ctx: Context): List<TasksRowGroup> {
        var lastMonth = ctx.today.take(MONTH_TO)
        return groups.mapNotNull { group ->
            val keepEmpty = group.kind == TasksGroupKind.TASKS_GROUP_KIND_SECTION
            val dayHead = group.kind == TasksGroupKind.TASKS_GROUP_KIND_TODAY ||
                group.kind == TasksGroupKind.TASKS_GROUP_KIND_DAY
            val rowCtx = ctx.copy(
                dayInHead = dayHead,
                showProject = ctx.showProject && group.kind != TasksGroupKind.TASKS_GROUP_KIND_PROJECT,
            )
            val rows = group.tasks.filter { it.task_id !in ctx.hidden }.map { row(it, rowCtx) }
            if (rows.isEmpty() && !keepEmpty) return@mapNotNull null
            val month = if (group.kind == TasksGroupKind.TASKS_GROUP_KIND_DAY && group.day.length >= MONTH_TO) {
                val m = group.day.take(MONTH_TO)
                if (m != lastMonth) {
                    lastMonth = m
                    monthYear(group.day)
                } else {
                    null
                }
            } else {
                null
            }
            val (verbLabel, verbKey) = verbOf(group)
            TasksRowGroup(
                key = group.key.ifEmpty { "${group.kind.value}|${group.day}|${group.project_id}|${group.section_id}" },
                title = titleOf(group, ctx),
                meta = rows.size.toString(),
                month_heading = month,
                verb_label = verbLabel,
                verb_key = verbKey,
                section_id = if (keepEmpty) group.section_id else null,
                rows = rows,
            )
        }
    }

    public fun titleOf(group: TasksGroup, ctx: Context): String = when (group.kind) {
        TasksGroupKind.TASKS_GROUP_KIND_OVERDUE -> TasksCopy.GROUP_OVERDUE
        TasksGroupKind.TASKS_GROUP_KIND_TODAY -> TasksCopy.GROUP_TODAY
        TasksGroupKind.TASKS_GROUP_KIND_DAY -> CivilWords.relativeDay(group.day, ctx.today)
        TasksGroupKind.TASKS_GROUP_KIND_INBOX -> TasksCopy.INBOX
        TasksGroupKind.TASKS_GROUP_KIND_PROJECT ->
            group.project_id?.let { ctx.projects[it]?.name } ?: TasksCopy.INBOX
        TasksGroupKind.TASKS_GROUP_KIND_DATED -> TasksCopy.GROUP_DATED
        TasksGroupKind.TASKS_GROUP_KIND_UNDATED -> TasksCopy.GROUP_UNDATED
        TasksGroupKind.TASKS_GROUP_KIND_DONE -> TasksCopy.DONE
        TasksGroupKind.TASKS_GROUP_KIND_WONT_DO -> TasksCopy.WONT_DO
        TasksGroupKind.TASKS_GROUP_KIND_REMINDERS -> TasksCopy.GROUP_REMINDERS
        TasksGroupKind.TASKS_GROUP_KIND_SECTION ->
            group.section_id?.let { ctx.sections[it]?.name } ?: TasksCopy.GROUP_UNSECTIONED
        TasksGroupKind.TASKS_GROUP_KIND_UNSECTIONED -> TasksCopy.GROUP_UNSECTIONED
        else -> ""
    }

    private fun verbOf(group: TasksGroup): Pair<String, String> = when (group.kind) {
        TasksGroupKind.TASKS_GROUP_KIND_OVERDUE -> TasksCopy.CATCH_UP to VERB_CATCH_UP
        TasksGroupKind.TASKS_GROUP_KIND_SECTION -> TasksCopy.ADD_TASK to "$VERB_ADD${group.section_id ?: ""}"
        TasksGroupKind.TASKS_GROUP_KIND_UNSECTIONED -> TasksCopy.ADD_TASK to VERB_ADD
        else -> "" to ""
    }

    /** Roots on screen, for the count. */
    public fun rootCount(groups: List<TasksRowGroup>): Int = groups.sumOf { it.rows.size }

    // ---------------------------------------------------------------------
    // The fixed words
    // ---------------------------------------------------------------------

    public val CHROME: TasksChrome = TasksChrome(
        title = TasksCopy.APP_TITLE,
        retry = TasksCopy.RETRY,
        loading = TasksCopy.LOADING,
        search_placeholder = TasksCopy.SEARCH_PLACEHOLDER,
        search_label = TasksCopy.SEARCH_LABEL,
        search_close = TasksCopy.CLOSE,
        more_title = TasksCopy.MORE_TITLE,
        reads_title = TasksCopy.READS_TITLE,
        reads_facts = listOf(
            TasksFact(label = TasksCopy.READS_FACT_READS, detail = TasksCopy.READS_FACT_READS_VALUE),
            TasksFact(label = TasksCopy.READS_FACT_WRITES, detail = TasksCopy.READS_FACT_WRITES_VALUE),
            TasksFact(label = TasksCopy.READS_FACT_LEAVES, detail = TasksCopy.READS_FACT_LEAVES_VALUE),
        ),
        quick_add_placeholder = TasksCopy.TITLE_PLACEHOLDER,
        quick_add_verb = TasksCopy.ADD,
        file_title = TasksCopy.FILE_TITLE,
        new_project_title = TasksCopy.NEW_PROJECT_TITLE,
        new_project_placeholder = TasksCopy.NEW_PROJECT_PLACEHOLDER,
        new_project_verb = TasksCopy.NEW_PROJECT_VERB,
        add_section_title = TasksCopy.ADD_SECTION,
        add_section_placeholder = TasksCopy.ADD_SECTION_PLACEHOLDER,
        add_section_verb = TasksCopy.ADD_SECTION,
        cancel = TasksCopy.CANCEL,
        home = TasksCopy.BAND_HOME,
        show_more = TasksCopy.SHOW_MORE,
        back = TasksCopy.APP_TITLE,
        add_subtask_verb = TasksCopy.ADD,
        add_tag_verb = TasksCopy.ADD,
        file_verb = TasksCopy.FILE,
    )

    public fun tab(key: String, label: String, icon: String, current: Boolean): TasksBandTab =
        TasksBandTab(key = key, label = label, icon_key = icon, current = current)

    public const val STATUS_NEEDS_ACTION: String = "needs-action"
    public const val STATUS_IN_PROCESS: String = "in-process"
    public const val STATUS_COMPLETED: String = "completed"
    public const val STATUS_CANCELLED: String = "cancelled"

    /** A group verb's keys: Overdue's way out, and a section's add target. */
    public const val VERB_CATCH_UP: String = "catch_up"
    public const val VERB_ADD: String = "add:"

    /** Undated open work this old says how long it has sat (the handoff's age signal). */
    public const val SITTING_DAYS: Int = 30

    private const val HOUR: Long = 60
    private const val META_SEPARATOR: String = " · "
    private const val YEAR: Int = 4
    private const val MONTH_FROM: Int = 5
    private const val MONTH_TO: Int = 7
    private const val DAY: Int = 10
}
