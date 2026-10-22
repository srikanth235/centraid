package dev.centraid.shared.kit.tasks

import centraid.core.v1.TasksTask
import centraid.screen.v1.StatusLine
import centraid.screen.v1.WriteSettled
import dev.centraid.design.copy.TasksCopy
import dev.centraid.shared.kit.InvokeKeys
import dev.centraid.shared.kit.jsonString
import dev.centraid.shared.kit.time.CivilWords
import dev.centraid.shared.screen.ScreenEffect
import kotlin.uuid.ExperimentalUuidApi
import kotlin.uuid.Uuid

/** One write a Tasks list holds, by the key it was submitted under. */
public data class TaskOp(
    val kind: Kind,
    val taskId: String,
    val title: String = "",
    /** A status write: the status it moves to, and the one it came from. */
    val to: String = "",
    val from: String = "",
    val repeats: Boolean = false,
    val seriesId: String? = null,
    /** An add: where it lands, filed after it commits. */
    val projectId: String? = null,
    val sectionId: String? = null,
    /** What the status line says when it commits. */
    val done: String = "",
) {
    public enum class Kind { STATUS, UNDO, ADD, FILE, PLACE_ADDED, CREATE }
}

/** A task added on this phone, drawn until the vault's answer carries it. */
public data class PendingAdd(
    val taskId: String,
    val title: String,
    /** The due day it was added with; empty undated. */
    val dueDay: String,
    val projectId: String? = null,
    val sectionId: String? = null,
    val committed: Boolean = false,
)

/**
 * WHAT A TASKS LIST HOLDS BESIDE THE ANSWERS: the writes it has out, the rows
 * it hides until the vault moves them, the adds it draws before the vault
 * has them, and the one status line.
 *
 * Many writes can be out at once — a member checks off three rows in a
 * second — so this is a map by invoke key, not the kit's one-in-flight
 * `WriteState`; each settle finds its own write (`ScreenWrites.settled`'s
 * rule). A committed change stays drawn until the NEXT ANSWER, which is read
 * after the commit (the change event re-reads, and a read already out is
 * queued behind it), so it never flickers back.
 */
public data class TaskOps(
    val seq: Long = 0,
    val inFlight: Map<String, TaskOp> = emptyMap(),
    /** task id → committed. Checked off (or reopened in the Logbook) here. */
    val hidden: Map<String, Boolean> = emptyMap(),
    /** task id → where it was filed here (`null` project = Inbox), and committed. */
    val filed: Map<String, Pair<String?, Boolean>> = emptyMap(),
    val adds: List<PendingAdd> = emptyList(),
    val status: StatusLine? = null,
    /** What Undo reverses. */
    val undo: TaskOp? = null,
    /** A repeating task completed here: name where its next one landed. */
    val nextOf: TaskOp? = null,
    /** Completions this session, for Today's earned quiet. */
    val completed: Int = 0,
) {
    val hiddenIds: Set<String> get() = hidden.keys
    val pendingIds: Set<String> get() = inFlight.values.map { it.taskId }.toSet() + adds.map { it.taskId }
}

/**
 * THE LAWS OF A TASKS LIST'S ROW WRITES — check off, undo, add, file — for
 * Home, a list, a project and Catch up alike.
 *
 * A DONE ROW IS DRAWN IN THE LOGBOOK ONLY (owner ruling): checking a row off
 * hides it at once and says "Task done" with Undo on the status line; the
 * Logbook's box reopens, and hides the row there the same way.
 */
public object TaskOpsLaw {
    public const val COMPLETE: String = "task.complete"
    public const val REOPEN: String = "task.reopen"
    public const val CANCEL: String = "task.cancel"
    public const val ADD: String = "task.add"
    public const val ORGANIZE: String = "task.organize"

    /** A project, an area and a section are containers: one shared verb makes them. */
    public const val CREATE_CONTAINER: String = "container.create"

    /** The command that puts a task in [status]: an action says the state it wants (R-1135-3-10). */
    public fun commandFor(status: String): String = when (status) {
        TasksRows.STATUS_DONE -> COMPLETE
        TasksRows.STATUS_CANCELLED -> CANCEL
        else -> REOPEN
    }

    public data class Out(val ops: TaskOps, val effects: List<ScreenEffect> = emptyList())

    /** A fresh task id: a v4 UUID, the shape `add_task` honours. A reducer is pure, so a bridge mints it. */
    @OptIn(ExperimentalUuidApi::class)
    public fun mintId(): String = Uuid.random().toString()

    /** The box. Open work completes; closed work (the Logbook) reopens. */
    public fun checked(ops: TaskOps, task: TasksTask): Out {
        if (task.task_id in ops.hidden) return Out(ops)
        val open = TasksRows.isOpen(task)
        val to = if (open) TasksRows.STATUS_DONE else TasksRows.STATUS_OPEN
        val title = task.title.ifBlank { TasksCopy.UNTITLED }
        val op = TaskOp(
            kind = TaskOp.Kind.STATUS,
            taskId = task.task_id,
            title = title,
            to = to,
            from = task.status,
            repeats = task.repeats,
            seriesId = task.series_id,
        )
        val (seq, key, effect) = status(ops, task.task_id, to)
        // A REPEATING TASK'S COMPLETION IS NOT UNDONE HERE: the engine has
        // already opened its next occurrence, and reopening this one would
        // leave two open copies of one series.
        val undoable = !task.repeats
        return Out(
            ops.copy(
                seq = seq,
                inFlight = ops.inFlight + (key to op),
                hidden = ops.hidden + (task.task_id to false),
                status = StatusLine(
                    sentence = if (open) TasksCopy.TASK_DONE else TasksCopy.TASK_REOPENED,
                    action_label = if (undoable) TasksCopy.UNDO else "",
                ),
                undo = op.takeIf { undoable },
                nextOf = op.takeIf { open && task.repeats },
                completed = if (open) ops.completed + 1 else ops.completed,
            ),
            listOf(effect),
        )
    }

    /** The status line's Undo: the status back, the row back. */
    public fun undo(ops: TaskOps): Out {
        val undo = ops.undo ?: return Out(ops)
        val (seq, key, effect) = status(ops, undo.taskId, undo.from)
        return Out(
            ops.copy(
                seq = seq,
                inFlight = ops.inFlight + (key to undo.copy(kind = TaskOp.Kind.UNDO, to = undo.from, from = undo.to)),
                hidden = ops.hidden - undo.taskId,
                status = null,
                undo = null,
                nextOf = null,
                completed = if (undo.to == TasksRows.STATUS_DONE) (ops.completed - 1).coerceAtLeast(0) else ops.completed,
            ),
            listOf(effect),
        )
    }

    /**
     * A QUICK ADD: a bare title, the id minted by the bridge (a UUID, which
     * `add_task` honours), drawn at once. Filing into a project is a second
     * write after the first commits — `add_task` takes no project.
     */
    public fun added(
        ops: TaskOps,
        taskId: String,
        title: String,
        dueDay: String,
        landsIn: String,
        projectId: String? = null,
        sectionId: String? = null,
    ): Out {
        val input = buildString {
            append("{\"id\":").append(jsonString(taskId))
            append(",\"title\":").append(jsonString(title))
            if (dueDay.isNotEmpty()) append(",\"due\":").append(jsonString(dueDay))
            append('}')
        }
        val key = InvokeKeys.of(ADD, taskId)
        return Out(
            ops.copy(
                inFlight = ops.inFlight + (
                    key to TaskOp(
                        kind = TaskOp.Kind.ADD,
                        taskId = taskId,
                        title = title,
                        projectId = projectId,
                        sectionId = sectionId,
                        done = "${TasksCopy.ADDED_TO} $landsIn",
                    )
                    ),
                adds = ops.adds + PendingAdd(taskId, title, dueDay, projectId, sectionId),
                status = null,
                undo = null,
            ),
            listOf(ScreenEffect.SubmitWrite(ADD, input, key)),
        )
    }

    /** File a task: a project (and section), or the Inbox (`projectId` null). */
    public fun filed(ops: TaskOps, task: TasksTask, projectId: String?, sectionId: String?, label: String): Out {
        val seq = ops.seq + 1
        val key = InvokeKeys.of(ORGANIZE, task.task_id, "project=${projectId ?: ""}", "section=${sectionId ?: ""}", "n=$seq")
        return Out(
            ops.copy(
                seq = seq,
                inFlight = ops.inFlight + (
                    key to TaskOp(
                        kind = TaskOp.Kind.FILE,
                        taskId = task.task_id,
                        title = task.title,
                        projectId = projectId,
                        done = "${TasksCopy.FILED_IN} $label",
                    )
                    ),
                filed = ops.filed + (task.task_id to (projectId to false)),
                status = null,
                undo = null,
            ),
            listOf(ScreenEffect.SubmitWrite(ORGANIZE, organizeInput(task.task_id, projectId, sectionId, task.sort_order), key)),
        )
    }

    /** A create with no row to draw (a project, a section): the status line says it. */
    public fun created(ops: TaskOps, command: String, input: String, subject: String, done: String): Out {
        val seq = ops.seq + 1
        val key = InvokeKeys.of(command, subject, "n=$seq")
        return Out(
            ops.copy(
                seq = seq,
                inFlight = ops.inFlight + (key to TaskOp(kind = TaskOp.Kind.CREATE, taskId = "", done = done)),
                status = null,
                undo = null,
            ),
            listOf(ScreenEffect.SubmitWrite(command, input, key)),
        )
    }

    /**
     * `task.organize`'s input. A project without a section CLEARS the section, because a section
     * of another project would be refused; the Inbox clears both (`null` clears what it names).
     */
    public fun organizeInput(taskId: String, projectId: String?, sectionId: String?, position: Long): String = buildString {
        append("{\"id\":").append(jsonString(taskId))
        append(",\"project_id\":").append(projectId?.let { jsonString(it) } ?: "null")
        append(",\"section_id\":").append(if (projectId == null) "null" else sectionId?.let { jsonString(it) } ?: "null")
        append(",\"position\":").append(position)
        append('}')
    }

    /**
     * A write's answer. Refused: whatever it drew is taken back and the
     * core's sentence is the status line. Committed: it stays drawn until
     * the next answer, and an add that lands in a project is filed now.
     */
    public fun settled(ops: TaskOps, settled: WriteSettled): Out {
        val op = ops.inFlight[settled.invoke_key] ?: return Out(ops)
        val left = ops.copy(inFlight = ops.inFlight - settled.invoke_key)
        if (!settled.committed) {
            val sentence = settled.failure?.sentence?.takeIf { it.isNotBlank() } ?: TasksCopy.WRITE_REFUSED
            return Out(
                left.copy(
                    hidden = if (op.kind == TaskOp.Kind.STATUS) left.hidden - op.taskId else left.hidden,
                    filed = if (op.kind == TaskOp.Kind.FILE) left.filed - op.taskId else left.filed,
                    adds = if (op.kind == TaskOp.Kind.ADD) left.adds.filter { it.taskId != op.taskId } else left.adds,
                    status = StatusLine(sentence = sentence, refused = true),
                    undo = null,
                    nextOf = if (left.nextOf?.taskId == op.taskId) null else left.nextOf,
                ),
            )
        }
        return when (op.kind) {
            TaskOp.Kind.STATUS, TaskOp.Kind.UNDO -> Out(
                left.copy(hidden = if (op.taskId in left.hidden) left.hidden + (op.taskId to true) else left.hidden),
            )
            TaskOp.Kind.FILE -> Out(
                left.copy(
                    filed = left.filed[op.taskId]?.let { left.filed + (op.taskId to (it.first to true)) } ?: left.filed,
                    status = StatusLine(sentence = op.done),
                ),
            )
            TaskOp.Kind.ADD -> {
                val committed = left.copy(
                    adds = left.adds.map { if (it.taskId == op.taskId) it.copy(committed = true) else it },
                    status = StatusLine(sentence = op.done),
                )
                val project = op.projectId ?: return Out(committed)
                val seq = committed.seq + 1
                val key = InvokeKeys.of(ORGANIZE, op.taskId, "project=$project", "section=${op.sectionId ?: ""}", "n=$seq")
                Out(
                    committed.copy(
                        seq = seq,
                        inFlight = committed.inFlight + (key to op.copy(kind = TaskOp.Kind.PLACE_ADDED)),
                    ),
                    listOf(ScreenEffect.SubmitWrite(ORGANIZE, organizeInput(op.taskId, project, op.sectionId, 0), key)),
                )
            }
            TaskOp.Kind.PLACE_ADDED -> Out(left)
            TaskOp.Kind.CREATE -> Out(left.copy(status = StatusLine(sentence = op.done)))
        }
    }

    /**
     * A NEW ANSWER, read after every commit it follows: what was committed is
     * now the vault's to draw. A repeating task completed here names where its
     * next occurrence landed, when the answer carries it.
     */
    public fun answered(ops: TaskOps, open: List<TasksTask>, today: String): TaskOps {
        val next = ops.nextOf?.let { done ->
            open.firstOrNull {
                it.due_day.isNotEmpty() &&
                    (it.task_id == done.taskId || (done.seriesId != null && it.series_id == done.seriesId))
            }
        }
        val status = if (next != null && ops.status?.sentence == TasksCopy.TASK_DONE) {
            StatusLine(
                sentence = "${TasksCopy.TASK_DONE} · ${TasksCopy.NEXT_ONE_IS} ${CivilWords.relativeDay(next.due_day, today)}",
            )
        } else {
            ops.status
        }
        val stillHidden = ops.hidden.filterValues { !it }
        return ops.copy(
            hidden = stillHidden,
            // A row completed here and read back open (the next occurrence
            // under the same id) is drawn again.
            filed = ops.filed.filterValues { !it.second },
            adds = ops.adds.filter { !it.committed },
            status = status,
            nextOf = if (next != null) null else ops.nextOf,
        )
    }

    /** One status write, under a key no earlier gesture used. */
    private fun status(ops: TaskOps, taskId: String, to: String): Triple<Long, String, ScreenEffect> {
        val seq = ops.seq + 1
        val command = commandFor(to)
        val key = InvokeKeys.of(command, taskId, "to=$to", "n=$seq")
        val input = "{\"id\":${jsonString(taskId)}}"
        return Triple(seq, key, ScreenEffect.SubmitWrite(command, input, key))
    }
}
