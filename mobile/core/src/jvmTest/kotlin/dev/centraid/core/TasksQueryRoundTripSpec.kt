package dev.centraid.core

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.Command
import centraid.core.v1.CommandStatus
import centraid.core.v1.Envelope
import centraid.core.v1.Request
import centraid.core.v1.TasksBoard
import centraid.core.v1.TasksBoardRequest
import centraid.core.v1.TasksCatchUpRequest
import centraid.core.v1.TasksGroupKind
import centraid.core.v1.TasksSearchRequest
import centraid.core.v1.TasksTaskDetail
import centraid.core.v1.TasksTaskRequest
import centraid.core.v1.TasksView
import dev.centraid.core.AbiRoundTripSpec.Companion.openRealCore
import dev.centraid.core.AbiRoundTripSpec.Companion.shouldBeAnsweredWith
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.collections.shouldNotContain
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldStartWith
import io.kotest.matchers.types.shouldBeInstanceOf
import java.time.LocalDate
import java.time.ZoneId
import okio.ByteString.Companion.encodeUtf8

/**
 * TASKS' QUERIES, KOTLIN TO RUST AND BACK (#1046).
 *
 * The phone had no Tasks screen: the board nests families, applies the
 * promotion rule and collapses a repeating task's missed periods, and v0 did
 * the civil arithmetic — "today", "overdue", Upcoming's days — on the phone in
 * the host zone. The `tasks_*` arms of `app_query` run `crates/apps/tasks` in
 * the core and answer every civil reading in the zone the request states, so
 * `commonMain` draws strings.
 *
 * Over JNA, against the real `libcentraid_core_ffi` and the vault
 * `spike-fixture` founded — nothing faked. The writes go through `Command`
 * requests, the command plane a screen uses. The fixture vault is shared by
 * every spec in the run and its clock is the real one, so this asks about the
 * tasks it makes and no others, and dates them relative to today.
 */
class TasksQueryRoundTripSpec : StringSpec({

    "tasks.board groups by the device's day, and the trash is on no place" {
        val core = openRealCore()
        try {
            val zone = ZoneId.of(TZ)
            val today = LocalDate.now(zone)
            val late = core.write(
                "schedule.add_task",
                """{"title":"Tasks spec late","due_at":"${today.minusDays(3)}"}""",
                key = "tasks-round-trip-late",
            )
            val later = core.write(
                "schedule.add_task",
                """{"title":"Tasks spec later","due_at":"${today.plusDays(5)}",""" +
                    """"remind_before_min":15}""",
                key = "tasks-round-trip-later",
            )
            val daily = core.write(
                "schedule.add_task",
                """{"title":"Tasks spec daily","due_at":"${today.minusDays(4)}",""" +
                    """"rrule":"FREQ=DAILY"}""",
                key = "tasks-round-trip-daily",
            )
            val trashed = core.write(
                "schedule.add_task",
                """{"title":"Tasks spec trashed","due_at":"${today.minusDays(1)}"}""",
                key = "tasks-round-trip-trashed",
            )
            core.write(
                "schedule.delete_task",
                """{"task_id":"$trashed"}""",
                key = "tasks-round-trip-delete",
            )

            // --- Today ------------------------------------------------------
            val board = core.board(TasksView.TASKS_VIEW_TODAY)
            // TODAY IS THE DEVICE'S, either side of a midnight the run crossed.
            listOf(today.minusDays(1), today).map { it.toString() } shouldContain board.today
            board.now_local shouldStartWith board.today
            val overdue = board.groups.single {
                it.kind == TasksGroupKind.TASKS_GROUP_KIND_OVERDUE
            }
            val lateRow = overdue.tasks.single { it.task_id == late }
            lateRow.overdue shouldBe true
            lateRow.due_day shouldBe today.minusDays(3).toString()
            // THE REPEATING TASK IS DUE ITS NEXT PERIOD, not four days late —
            // and it carries the sentence, built in Rust, never the rule.
            val dailyRow = board.groups.flatMap { it.tasks }.single { it.task_id == daily }
            dailyRow.overdue shouldBe false
            dailyRow.repeats shouldBe true
            dailyRow.recurrence_summary shouldBe "Daily"
            dailyRow.next_due shouldNotBe null

            // --- Upcoming ---------------------------------------------------
            val upcoming = core.board(TasksView.TASKS_VIEW_UPCOMING)
            val day = upcoming.groups.single { group -> group.tasks.any { it.task_id == later } }
            day.kind shouldBe TasksGroupKind.TASKS_GROUP_KIND_DAY
            day.day shouldBe today.plusDays(5).toString()
            // v0 wrote the lead time and never read it back.
            day.tasks.single { it.task_id == later }.remind_before_min shouldBe 15L

            // --- the trash --------------------------------------------------
            val all = core.board(TasksView.TASKS_VIEW_ALL)
            val ids = all.groups.flatMap { group -> group.tasks.map { it.task_id } }
            ids shouldContain late
            ids shouldNotContain trashed
            core.detail(trashed).task shouldBe null

            // --- one task ---------------------------------------------------
            val detail = core.detail(late)
            detail.task?.title shouldBe "Tasks spec late"
            detail.today shouldBe board.today

            // --- search -----------------------------------------------------
            core.appQuery(
                AppQueryRequest(
                    tasks_search = TasksSearchRequest(term = "trashed", limit = 10, tz = TZ),
                ),
            ).shouldBeAnsweredWith { envelope ->
                val found = envelope.appQuery().tasks_search
                    ?: error("a search answer, got ${envelope.appQuery()}")
                found.tasks.map { it.task_id } shouldNotContain trashed
            }

            // --- catch up ---------------------------------------------------
            core.appQuery(AppQueryRequest(tasks_catch_up = TasksCatchUpRequest(tz = TZ)))
                .shouldBeAnsweredWith { envelope ->
                    val piles = envelope.appQuery().tasks_catch_up
                        ?: error("a catch-up answer, got ${envelope.appQuery()}")
                    piles.dated.map { it.task_id } shouldContain late
                    piles.dated.map { it.task_id } shouldNotContain trashed
                }

            // --- the zone rule ----------------------------------------------
            core.appQuery(
                AppQueryRequest(tasks_board = TasksBoardRequest(tz = "Mars/Olympus_Mons")),
            ).shouldBeInstanceOf<CoreOutcome.Failed>()
        } finally {
            core.close()
        }
    }
}) {
    companion object {
        /** The device's zone, as a shell reads it off the platform and states it. */
        private const val TZ = "America/New_York"

        suspend fun CentraidCore.appQuery(query: AppQueryRequest): CoreOutcome<Envelope> =
            call(Envelope(request_id = 1, request = Request(app_query = query)))

        fun Envelope.appQuery(): AppQueryResponse =
            response?.app_query ?: error("an AppQueryResponse, got $this")

        suspend fun CentraidCore.board(view: TasksView): TasksBoard {
            var answer: TasksBoard? = null
            appQuery(AppQueryRequest(tasks_board = TasksBoardRequest(tz = TZ, view = view)))
                .shouldBeAnsweredWith { envelope ->
                    answer = envelope.appQuery().tasks_board
                        ?: error("a board answer, got ${envelope.appQuery()}")
                }
            return answer!!
        }

        suspend fun CentraidCore.detail(taskId: String): TasksTaskDetail {
            var answer: TasksTaskDetail? = null
            appQuery(AppQueryRequest(tasks_task = TasksTaskRequest(task_id = taskId, tz = TZ)))
                .shouldBeAnsweredWith { envelope ->
                    answer = envelope.appQuery().tasks_task
                        ?: error("a task answer, got ${envelope.appQuery()}")
                }
            return answer!!
        }

        /** One command through the command plane; answers its `task_id`. */
        suspend fun CentraidCore.write(name: String, input: String, key: String): String {
            var taskId = ""
            call(
                Envelope(
                    request_id = 1,
                    request = Request(
                        command = Command(
                            name = name,
                            input = input.encodeUtf8(),
                            invoke_key = key,
                        ),
                    ),
                ),
            ).shouldBeAnsweredWith { envelope ->
                val outcome = envelope.response?.command ?: error("a CommandOutcome")
                outcome.status shouldBe CommandStatus.COMMAND_STATUS_EXECUTED
                taskId = Regex("\"task_id\":\"([^\"]+)\"")
                    .find(outcome.output.utf8())
                    ?.groupValues
                    ?.get(1)
                    ?: error("no task_id in ${outcome.output.utf8()}")
            }
            return taskId
        }
    }
}
