package dev.centraid.shared.apps.tasks

import centraid.screen.v1.TrashListEvent
import centraid.screen.v1.TrashListState
import dev.centraid.design.copy.TasksCopy
import dev.centraid.shared.kit.ScreenBridge
import dev.centraid.shared.kit.TrashCopy
import dev.centraid.shared.kit.TrashMachine
import dev.centraid.shared.kit.TrashReads
import dev.centraid.shared.kit.TrashSpec

/**
 * TASKS' TRASH — the kit's one trash screen, Tasks as its parameter (law 2).
 *
 * `schedule.delete_task` puts a task and its subtasks in the trash for 30
 * days, `schedule.restore_task` brings back what that gesture trashed, and
 * `schedule.purge_task` destroys a trashed task and the subtasks trashed with
 * it now (#1015 D1: "Delete forever" wherever an app can destroy). There is
 * no command that empties the whole trash, so no "Empty trash": the purge
 * sweep erases the rest at 30 days, and the screen says nothing it cannot do.
 */
public val TasksTrashSpec: TrashSpec = TrashSpec(
    appId = APP_ID,
    table = "schedule_task",
    restoreCommand = "schedule.restore_task",
    purgeCommand = "schedule.purge_task",
    emptyCommand = null,
    idColumn = "task_id",
    titleColumn = "title",
    purgeWindowDays = 30,
    copy = TrashCopy(purgeBody = TasksCopy.TRASH_PURGE_BODY),
    backLabel = TasksCopy.APP_TITLE,
)

public object TasksTrashMachine {
    public val machine: TrashMachine = TrashMachine(TasksTrashSpec)
    public val reads: TrashReads = TrashReads(TasksTrashSpec)
}

/** `tasks.trash`, with the Swift symbol Tasks' own. */
public class TasksTrashBridge : ScreenBridge<TrashListState, TrashListEvent>(
    machine = TasksTrashMachine.machine,
    events = TrashListEvent.ADAPTER,
    wire = { w ->
        w.session.attachScreen(w.host, TasksTrashMachine.reads, TasksTrashMachine.reads, left = w.left)
    },
) {
    public fun open() {
        forward(TrashListEvent(opened = TrashListEvent.Opened()))
    }
}
