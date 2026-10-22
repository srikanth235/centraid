package dev.centraid.shared.apps.tasks

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandStatus
import centraid.core.v1.TasksTrash
import centraid.core.v1.TasksTrashRequest
import centraid.core.v1.TasksTrashRow
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.TrashListData
import centraid.screen.v1.TrashListEvent
import centraid.screen.v1.TrashListState
import centraid.screen.v1.TrashRow
import dev.centraid.design.copy.TasksCopy
import dev.centraid.shared.kit.ScreenBridge
import dev.centraid.shared.kit.TrashCopy
import dev.centraid.shared.kit.TrashMachine
import dev.centraid.shared.kit.TrashSpec
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.kit.tasks.TasksRows
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.sync.ScreenQueries
import dev.centraid.shared.sync.ScreenWrites

/**
 * TASKS' TRASH: the kit's one trash screen, Tasks as its parameter (law 2).
 *
 * `entity.trash` puts a task and its subtasks in the trash for 30 days,
 * `entity.restore` brings back what that gesture trashed, and `entity.purge`
 * destroys a trashed task and the subtasks trashed with it now (#1015 D1: "Delete
 * forever" wherever an app can destroy). There is no Tasks command that empties the
 * whole trash, so no "Empty trash": the purge sweep erases the rest at 30 days, and
 * the screen says nothing it cannot do.
 */
public val TasksTrashSpec: TrashSpec = TrashSpec(
    appId = APP_ID,
    table = "entity",
    restoreCommand = "entity.restore",
    purgeCommand = "entity.purge",
    emptyCommand = null,
    idColumn = "id",
    titleColumn = "title",
    purgeWindowDays = 30,
    copy = TrashCopy(purgeBody = TasksCopy.TRASH_PURGE_BODY),
    // An `entity` change covers every kind and the shelf lists tasks only.
    reReadOnAnyChange = true,
    backLabel = TasksCopy.APP_TITLE,
)

public object TasksTrashMachine {
    public val machine: TrashMachine = TrashMachine(TasksTrashSpec)
    public val reads: TasksTrashReads = TasksTrashReads
}

/**
 * WHAT TASKS' TRASH READS: `tasks.trash`, because the trash is the entity's and the kit's
 * one-table page read of `TrashReads` cannot say which entities are tasks.
 */
public object TasksTrashReads :
    ScreenQueries<TrashListState, TrashListEvent>,
    ScreenWrites<TrashListState, TrashListEvent> {
    override val screenId: String = "$APP_ID.trash"

    override val tables: Set<String> = setOf(TasksTrashSpec.table)

    override val appId: String = APP_ID

    override fun requests(state: TrashListState, now: DeviceClock.Reading): List<AppQueryRequest> =
        listOf(AppQueryRequest(tasks_trash = TasksTrashRequest(tz = now.zone)))

    /** One window of 500, most recently trashed first; there is no next page. */
    override fun arrived(answers: List<AppQueryResponse>): TrashListEvent {
        val trash = answers.firstNotNullOfOrNull { it.tasks_trash } ?: TasksTrash()
        return TrashListEvent(
            data_ = TrashListEvent.DataArrived(data_ = TrashListData(rows = trash.tasks.map(::rowOf)), answered_cursor = ""),
        )
    }

    override fun refused(failure: ReadFailure): TrashListEvent =
        TrashListEvent(refused = TrashListEvent.ReadRefused(failure = failure))

    override fun denied(denial: AppQueryDenial): TrashListEvent =
        TrashListEvent(denied = TasksRows.deniedOf(denial))

    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): TrashListEvent =
        TrashListEvent(write_settled = WriteLaw.settledOf(status, sentence, invokeKey))

    /** `Pay the deposit`, `Deleted Wed 11 March · Erased Mon 12 October`. */
    private fun rowOf(row: TasksTrashRow): TrashRow = TrashRow(
        id = row.task_id,
        title = row.title.ifBlank { TasksTrashSpec.copy.untitled },
        meta = listOfNotNull(
            TasksTrashSpec.copy.deletedMeta(row.deleted_local_day).ifEmpty { null },
            TasksTrashSpec.copy.purgeMeta(row.purge_local_day),
        ).joinToString(" · "),
        icon_key = "CheckSquare",
    )
}

/** `tasks.trash`, with the Swift symbol Tasks' own. */
public class TasksTrashBridge : ScreenBridge<TrashListState, TrashListEvent>(
    machine = TasksTrashMachine.machine,
    events = TrashListEvent.ADAPTER,
    wire = { w -> w.session.attachQueries(w.host, TasksTrashReads, TasksTrashReads, left = w.left) },
) {
    public fun open() {
        forward(TrashListEvent(opened = TrashListEvent.Opened()))
    }
}
