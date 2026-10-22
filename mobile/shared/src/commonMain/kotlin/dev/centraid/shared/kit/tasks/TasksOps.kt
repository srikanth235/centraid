package dev.centraid.shared.kit.tasks

import centraid.core.v1.ActInverse
import centraid.core.v1.ActRequest
import centraid.core.v1.TasksTask
import centraid.screen.v1.StatusLine
import centraid.screen.v1.WriteSettled
import dev.centraid.design.copy.TasksCopy
import dev.centraid.shared.catalog.Act
import dev.centraid.shared.catalog.Field
import dev.centraid.shared.catalog.keyed
import dev.centraid.shared.kit.time.CivilWords
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.sync.request
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
    /** What the status line says when it commits. */
    val done: String = "",
) {
    public enum class Kind { STATUS, UNDO, ADD, FILE, CREATE }
}

/** What the status line's Undo sends: the core's inverse of [op], the write it takes back. */
public data class TaskUndo(val request: ActRequest, val op: TaskOp)

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
    /** The key of the write the status line speaks for, so only ITS answer can arm Undo. */
    val statusKey: String? = null,
    /** What Undo sends: the core's inverse, set when the answer to [statusKey] carries one. */
    val undo: TaskUndo? = null,
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
 * hides it at once and says "Task done"; the Logbook's box reopens, and hides
 * the row there the same way.
 *
 * **UNDO IS THE CORE'S, NOT A TABLE HERE (#1135).** A status write's answer
 * carries `ActResponse.inverse` — the action and input that take it back — and
 * the status line offers Undo only once that answer is in. What the core says
 * has no inverse offers none. The one local rule is a repeating task's
 * completion, which is never offered Undo: the engine has already opened its
 * next occurrence, and reopening this one would leave two open copies of one
 * series.
 */
public object TaskOpsLaw {
    public data class Out(val ops: TaskOps, val effects: List<ScreenEffect> = emptyList())

    /** A fresh task id: a v4 UUID, the shape `add` honours. A reducer is pure, so a bridge mints it. */
    @OptIn(ExperimentalUuidApi::class)
    public fun mintId(): String = Uuid.random().toString()

    /** The action that puts a task in [status]: an action says the state it wants (R-1135-3-10). */
    public fun statusAct(taskId: String, status: String): ActRequest = when (status) {
        TasksRows.STATUS_DONE -> Act.Tasks.Complete(taskId)
        TasksRows.STATUS_CANCELLED -> Act.Tasks.Cancel(taskId)
        else -> Act.Tasks.Reopen(taskId)
    }

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
        val (seq, request) = status(ops, task.task_id, to)
        return Out(
            ops.copy(
                seq = seq,
                inFlight = ops.inFlight + (request.invoke_key to op),
                hidden = ops.hidden + (task.task_id to false),
                status = StatusLine(sentence = if (open) TasksCopy.TASK_DONE else TasksCopy.TASK_REOPENED),
                statusKey = request.invoke_key,
                undo = null,
                nextOf = op.takeIf { open && task.repeats },
                completed = if (open) ops.completed + 1 else ops.completed,
            ),
            listOf(ScreenEffect.Act(request)),
        )
    }

    /** The status line's Undo: the core's inverse sent, the row back. */
    public fun undo(ops: TaskOps): Out {
        val undo = ops.undo ?: return Out(ops)
        val seq = ops.seq + 1
        val request = undo.request.keyed(undo.op.taskId, "undo", "n=$seq")
        return Out(
            ops.copy(
                seq = seq,
                inFlight = ops.inFlight + (request.invoke_key to undo.op.copy(kind = TaskOp.Kind.UNDO, to = undo.op.from, from = undo.op.to)),
                hidden = ops.hidden - undo.op.taskId,
                status = null,
                statusKey = null,
                undo = null,
                nextOf = null,
                completed = if (undo.op.to == TasksRows.STATUS_DONE) (ops.completed - 1).coerceAtLeast(0) else ops.completed,
            ),
            listOf(ScreenEffect.Act(request)),
        )
    }

    /**
     * A QUICK ADD: a bare title, the id minted by the bridge (a UUID, which
     * `add` honours), drawn at once. A project and a section ride the same
     * write, so the task lands where the member pointed.
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
        val request = Act.Tasks.Add(
            title = title,
            id = taskId,
            due = if (dueDay.isEmpty()) Field.Keep else Field.Is(dueDay),
            projectId = projectId?.let { Field.Is(it) } ?: Field.Keep,
            sectionId = sectionId?.let { Field.Is(it) } ?: Field.Keep,
        ).keyed(taskId)
        return Out(
            ops.copy(
                inFlight = ops.inFlight + (
                    request.invoke_key to TaskOp(
                        kind = TaskOp.Kind.ADD,
                        taskId = taskId,
                        title = title,
                        done = "${TasksCopy.ADDED_TO} $landsIn",
                    )
                    ),
                adds = ops.adds + PendingAdd(taskId, title, dueDay, projectId, sectionId),
                status = null,
                statusKey = null,
                undo = null,
            ),
            listOf(ScreenEffect.Act(request)),
        )
    }

    /** File a task: a project (and section), or the Inbox (`projectId` null). */
    public fun filed(ops: TaskOps, task: TasksTask, projectId: String?, sectionId: String?, label: String): Out {
        val seq = ops.seq + 1
        val request = organize(task.task_id, projectId, sectionId, task.sort_order)
            .keyed(task.task_id, "project=${projectId ?: ""}", "section=${sectionId ?: ""}", "n=$seq")
        return Out(
            ops.copy(
                seq = seq,
                inFlight = ops.inFlight + (
                    request.invoke_key to TaskOp(
                        kind = TaskOp.Kind.FILE,
                        taskId = task.task_id,
                        title = task.title,
                        done = "${TasksCopy.FILED_IN} $label",
                    )
                    ),
                filed = ops.filed + (task.task_id to (projectId to false)),
                status = null,
                statusKey = null,
                undo = null,
            ),
            listOf(ScreenEffect.Act(request)),
        )
    }

    /** A create with no row to draw (a project, a section): the status line says it. */
    public fun created(ops: TaskOps, create: ActRequest, subject: String, done: String): Out {
        val seq = ops.seq + 1
        val request = create.keyed(subject, "n=$seq")
        return Out(
            ops.copy(
                seq = seq,
                inFlight = ops.inFlight + (request.invoke_key to TaskOp(kind = TaskOp.Kind.CREATE, taskId = "", done = done)),
                status = null,
                statusKey = null,
                undo = null,
            ),
            listOf(ScreenEffect.Act(request)),
        )
    }

    /**
     * `organize`'s request. A project without a section CLEARS the section, because a section
     * of another project would be refused; the Inbox clears both (`Clear` names what it empties).
     */
    public fun organize(taskId: String, projectId: String?, sectionId: String?, position: Long): ActRequest =
        Act.Tasks.OrganizeTask(
            taskId = taskId,
            projectId = projectId?.let { Field.Is(it) } ?: Field.Clear,
            sectionId = if (projectId == null) Field.Clear else sectionId?.let { Field.Is(it) } ?: Field.Clear,
            position = position.toDouble(),
        )

    /**
     * A write's answer. Refused: whatever it drew is taken back and the
     * core's sentence is the status line. Committed: it stays drawn until
     * the next answer, and a status write that carries an [inverse] arms Undo.
     */
    public fun settled(ops: TaskOps, settled: WriteSettled, inverse: ActInverse? = null): Out {
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
                    statusKey = null,
                    undo = null,
                    nextOf = if (left.nextOf?.taskId == op.taskId) null else left.nextOf,
                ),
            )
        }
        return when (op.kind) {
            TaskOp.Kind.STATUS -> {
                val hidden = if (op.taskId in left.hidden) left.hidden + (op.taskId to true) else left.hidden
                val armed = inverse?.takeIf { !op.repeats && left.statusKey == settled.invoke_key }
                Out(
                    left.copy(
                        hidden = hidden,
                        status = if (armed != null) left.status?.copy(action_label = TasksCopy.UNDO) else left.status,
                        undo = armed?.let { TaskUndo(it.request(Act.Tasks.APP), op) } ?: left.undo,
                    ),
                )
            }
            TaskOp.Kind.UNDO -> Out(
                left.copy(hidden = if (op.taskId in left.hidden) left.hidden + (op.taskId to true) else left.hidden),
            )
            TaskOp.Kind.FILE -> Out(
                left.copy(
                    filed = left.filed[op.taskId]?.let { left.filed + (op.taskId to (it.first to true)) } ?: left.filed,
                    status = StatusLine(sentence = op.done),
                ),
            )
            TaskOp.Kind.ADD -> Out(
                left.copy(
                    adds = left.adds.map { if (it.taskId == op.taskId) it.copy(committed = true) else it },
                    status = StatusLine(sentence = op.done),
                ),
            )
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
    private fun status(ops: TaskOps, taskId: String, to: String): Pair<Long, ActRequest> {
        val seq = ops.seq + 1
        return seq to statusAct(taskId, to).keyed(taskId, "to=$to", "n=$seq")
    }
}
