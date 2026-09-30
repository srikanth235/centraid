package dev.centraid.shared

import centraid.core.v1.AgendaDayContext
import centraid.core.v1.AgendaDayContextRequest
import centraid.core.v1.AgendaEvent
import centraid.core.v1.AgendaParties
import centraid.core.v1.AgendaPartiesRequest
import centraid.core.v1.AgendaUpcoming
import centraid.core.v1.AgendaUpcomingRequest
import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandOutcome
import centraid.core.v1.CommandStatus
import centraid.core.v1.DocsDocumentRequest
import centraid.core.v1.Envelope
import centraid.core.v1.Error
import centraid.core.v1.ErrorCode
import centraid.core.v1.NotesTrashRequest
import centraid.core.v1.Page
import centraid.core.v1.PeopleTouchRequest
import centraid.core.v1.Response
import centraid.core.v1.TallyDashboardRequest
import centraid.core.v1.TasksBoardRequest
import centraid.core.v1.TasksSearch
import centraid.core.v1.TasksSearchRequest
import centraid.screen.v1.HomeEvent
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.ReadFailureKind
import centraid.screen.v1.SeatState
import centraid.screen.v1.TileStatus
import dev.centraid.core.CentraidCore
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.platform.FakeDeviceClock
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import dev.centraid.shared.shell.HomeMachine
import dev.centraid.shared.shell.HomeRuntime
import dev.centraid.shared.sync.ScreenQueries
import dev.centraid.shared.sync.ScreenQueryRuntime
import dev.centraid.shared.sync.ScreenWrites
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.ints.shouldBeGreaterThan
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotContain
import io.kotest.matchers.types.shouldBeInstanceOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import java.io.File
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * THE APP-QUERY RUNTIME, AGAINST A CORE THAT ANSWERS WHAT A TEST SAYS (#1046).
 *
 * [ScreenQueryRuntime] is the half of an app-query read that is not the
 * screen's: which core, in which order, and what a failure becomes. The core
 * here is `CentraidCore.answering` — a real `CentraidCore` over an ABI whose
 * answer the test writes — so the envelope a screen's request becomes, and
 * the envelope it is answered with, cross the same encode and decode the FFI
 * does. What the REAL core answers is `AgendaQueryRoundTripSpec`'s, over JNA.
 */
class ScreenQueryRuntimeSpec : StringSpec({

    /** A screen that records what reached it, and asks for a read when opened. */
    val probeTables = setOf("core_event", "schedule_attendee")

    val probeMachine = object : ScreenMachine<List<Probe>, Probe> {
        override fun initial(): List<Probe> = emptyList()

        override fun reduce(state: List<Probe>, event: Probe): Step<List<Probe>> = when (event) {
            Probe.Open -> Step(state, listOf(ScreenEffect.ReadPage(SCREEN, null)))
            is Probe.Write -> Step(
                state,
                listOf(ScreenEffect.SubmitWrite("schedule.rsvp", "{}", event.invokeKey)),
            )
            else -> Step(state + event)
        }

        override fun rowsChanged(table: String, keys: List<String>): Probe? =
            if (table in probeTables) Probe.Open else null

        override fun seatChanged(seat: SeatState): Probe? = null
    }

    fun queries(
        make: (DeviceClock.Reading) -> List<AppQueryRequest>?,
    ): ScreenQueries<List<Probe>, Probe> = object : ScreenQueries<List<Probe>, Probe> {
        override val screenId: String = SCREEN
        override val tables: Set<String> = probeTables
        override fun requests(state: List<Probe>, now: DeviceClock.Reading) = make(now)
        override fun arrived(answers: List<AppQueryResponse>): Probe = Probe.Arrived(answers)
        override fun refused(failure: ReadFailure): Probe = Probe.Refused(failure)
    }

    val upcoming = { tz: String ->
        AppQueryRequest(agenda_upcoming = AgendaUpcomingRequest(from = "", to = "", tz = tz))
    }

    fun answered(response: AppQueryResponse): Envelope =
        Envelope(request_id = 0, response = Response(app_query = response))

    /** Open the probe on [core], and wait for the one event its read produces. */
    suspend fun readOnce(
        core: CentraidCore?,
        queries: ScreenQueries<List<Probe>, Probe>,
        clock: DeviceClock = FakeDeviceClock(),
    ): Probe {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val host = ScreenHost(probeMachine)
            ScreenQueryRuntime(
                core = { core },
                host = host,
                queries = queries,
                clock = clock,
                scope = scope,
            ).start()
            host.send(Probe.Open)
            return withTimeout(5_000) { host.state.first { it.isNotEmpty() } }.single()
        } finally {
            scope.cancel()
        }
    }

    "every answer arrives, in request order, as ONE event" {
        val asked = ConcurrentLinkedQueue<AppQueryRequest>()
        val core = CentraidCore.answering(Dispatchers.Default) { envelope ->
            val query = envelope.request.shouldNotBeNull().app_query.shouldNotBeNull()
            asked += query
            answered(
                when {
                    query.agenda_upcoming != null -> AppQueryResponse(
                        agenda_upcoming = AgendaUpcoming(
                            events = listOf(AgendaEvent(event_id = "evt-1", instance_key = "evt-1")),
                            today = "2026-06-15",
                        ),
                    )
                    query.agenda_day_context != null ->
                        AppQueryResponse(agenda_day_context = AgendaDayContext(today = "2026-06-15"))
                    else -> AppQueryResponse(agenda_parties = AgendaParties(me = "pty-me"))
                },
            )
        }
        val probe = readOnce(
            core,
            queries { now ->
                listOf(
                    upcoming(now.zone),
                    AppQueryRequest(agenda_day_context = AgendaDayContextRequest(tz = now.zone)),
                    AppQueryRequest(agenda_parties = AgendaPartiesRequest()),
                )
            },
            clock = FakeDeviceClock(zone = "America/New_York"),
        )
        val answers = probe.shouldBeInstanceOf<Probe.Arrived>().answers
        answers.size shouldBe 3
        answers[0].agenda_upcoming.shouldNotBeNull().events.single().event_id shouldBe "evt-1"
        answers[1].agenda_day_context.shouldNotBeNull().today shouldBe "2026-06-15"
        answers[2].agenda_parties.shouldNotBeNull().me shouldBe "pty-me"
        // ASKED IN ORDER, and every zone is the PLATFORM's, read at the read.
        asked.map { it.agenda_upcoming != null } shouldBe listOf(true, false, false)
        asked.map { it.agenda_parties != null } shouldBe listOf(false, false, true)
        asked.first().agenda_upcoming.shouldNotBeNull().tz shouldBe "America/New_York"
        asked.toList()[1].agenda_day_context.shouldNotBeNull().tz shouldBe "America/New_York"
        core.close()
    }

    "a denied read is the screen's denial, with the vault's sentence, and nothing after it is asked" {
        val asked = ConcurrentLinkedQueue<AppQueryRequest>()
        val core = CentraidCore.answering(Dispatchers.Default) { envelope ->
            asked += envelope.request.shouldNotBeNull().app_query.shouldNotBeNull()
            answered(
                AppQueryResponse(
                    denied = AppQueryDenial(code = "revoked", message = "Agenda's access was turned off."),
                ),
            )
        }
        val probe = readOnce(
            core,
            queries { now -> listOf(upcoming(now.zone), AppQueryRequest(agenda_parties = AgendaPartiesRequest())) },
        )
        // THE DEFAULT `denied` is the refusal with the vault's own words.
        val failure = probe.shouldBeInstanceOf<Probe.Refused>().failure
        failure.kind shouldBe ReadFailureKind.READ_FAILURE_KIND_REFUSED
        failure.sentence shouldBe "Agenda's access was turned off."
        // A HALF-ANSWERED READ IS NOT A READ: the second query never went.
        asked.size shouldBe 1
        core.close()
    }

    "a read past its ceiling is refused in the core's words, and the detail never reaches a member" {
        // `READ_BOUND_REACHED` (#1046): the core stopped rather than answer
        // part of the range as if it were all of it. Its sentence is the
        // core's `sentence_for_code`, carried on `Error.sentence`; `detail`
        // names the statement and is for a log.
        val sentence = "There is more here than one look can gather, so none of it was " +
            "shown rather than part of it. Try a shorter range."
        val core = CentraidCore.answering(Dispatchers.Default) {
            Envelope(
                request_id = 0,
                error = Error(
                    code = ErrorCode.ERROR_CODE_READ_BOUND_REACHED,
                    detail = "expansion hit 4096 occurrences in agenda.upcoming.window",
                    sentence = sentence,
                ),
            )
        }
        val failure = readOnce(core, queries { now -> listOf(upcoming(now.zone)) })
            .shouldBeInstanceOf<Probe.Refused>().failure
        failure.kind shouldBe ReadFailureKind.READ_FAILURE_KIND_REFUSED
        failure.sentence shouldBe sentence
        failure.sentence shouldNotContain "agenda.upcoming.window"
        core.close()
    }

    "a core that failed is a restart, in the words the core wrote" {
        val core = CentraidCore.answering(Dispatchers.Default) { error("never asked") }
        core.close()
        val failure = readOnce(core, queries { now -> listOf(upcoming(now.zone)) })
            .shouldBeInstanceOf<Probe.Refused>().failure
        failure.kind shouldBe ReadFailureKind.READ_FAILURE_KIND_CORE_RESTARTED
    }

    "an answer with neither an app query nor a reason is a sentence, not a hang" {
        val core = CentraidCore.answering(Dispatchers.Default) {
            Envelope(request_id = 0, response = Response(page = Page()))
        }
        readOnce(core, queries { now -> listOf(upcoming(now.zone)) })
            .shouldBeInstanceOf<Probe.Refused>()
        core.close()
    }

    "no vault, no request, and no zone are each a sentence, and the core is not asked" {
        val asked = ConcurrentLinkedQueue<Envelope>()
        val core = CentraidCore.answering(Dispatchers.Default) { envelope ->
            asked += envelope
            answered(AppQueryResponse(agenda_parties = AgendaParties()))
        }
        readOnce(null, queries { now -> listOf(upcoming(now.zone)) })
            .shouldBeInstanceOf<Probe.Refused>().failure.sentence shouldBe
            "No vault is open on this device."
        readOnce(core, queries { null })
            .shouldBeInstanceOf<Probe.Refused>().failure.sentence shouldBe
            "Centraid does not know what to read here."
        readOnce(core, queries { emptyList() })
            .shouldBeInstanceOf<Probe.Refused>()
        // A ZONE THE PLATFORM COULD NOT NAME is refused here, in words a
        // member can read — the core would say `INVALID_REQUEST`.
        readOnce(core, queries { now -> listOf(upcoming(now.zone)) }, clock = FakeDeviceClock(zone = ""))
            .shouldBeInstanceOf<Probe.Refused>().failure.sentence shouldBe
            "This device did not say which time zone it is in."
        asked.toList().shouldBeEmpty()
        core.close()
    }

    "a query screen's write goes down the command plane and settles on the screen" {
        val commands = ConcurrentLinkedQueue<String>()
        val core = CentraidCore.answering(Dispatchers.Default) { envelope ->
            val command = envelope.request.shouldNotBeNull().command.shouldNotBeNull()
            commands += command.name + " " + command.invoke_key
            Envelope(
                request_id = 0,
                response = Response(
                    command = CommandOutcome(status = CommandStatus.COMMAND_STATUS_EXECUTED),
                ),
            )
        }
        val writes = object : ScreenWrites<List<Probe>, Probe> {
            override val appId: String = "agenda"
            override fun settled(status: CommandStatus, sentence: String, invokeKey: String): Probe =
                Probe.Settled(status, invokeKey)
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val host = ScreenHost(probeMachine)
        ScreenQueryRuntime(
            core = { core },
            host = host,
            queries = queries { null },
            clock = FakeDeviceClock(),
            scope = scope,
            writes = writes,
        ).start()
        host.send(Probe.Write("rsvp:evt-1:accepted"))
        val settled = withTimeout(5_000) { host.state.first { it.isNotEmpty() } }.single()
        settled shouldBe Probe.Settled(CommandStatus.COMMAND_STATUS_EXECUTED, "rsvp:evt-1:accepted")
        commands.toList() shouldBe listOf("schedule.rsvp rsvp:evt-1:accepted")
        scope.cancel()
        core.close()
    }

    // --- Home's Agenda tile rides the same arm -------------------------------

    "Home's Agenda tile lands from the arm, and a denied read is UNKNOWN, never EMPTY" {
        val zones = ConcurrentLinkedQueue<String>()
        fun home(answer: (AppQueryRequest) -> Envelope): CentraidCore =
            CentraidCore.answering(Dispatchers.Default) { envelope ->
                val query = envelope.request.shouldNotBeNull().app_query
                if (query == null) {
                    Envelope(request_id = 0, response = Response(page = Page()))
                } else {
                    zones += query.agenda_upcoming.shouldNotBeNull().tz
                    answer(query)
                }
            }

        suspend fun agendaTile(core: CentraidCore) = run {
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
            try {
                val host = ScreenHost(HomeMachine)
                HomeRuntime({ core }, host, scope, FakeDeviceClock(zone = "Asia/Tokyo")).start()
                host.send(HomeEvent(opened = HomeEvent.Opened()))
                withTimeout(5_000) {
                    host.state.first { state ->
                        state.data_?.tiles?.single { it.app_id == "agenda" }?.status
                            .let { it != null && it != TileStatus.TILE_STATUS_LOADING }
                    }
                }.data_.shouldNotBeNull().tiles.single { it.app_id == "agenda" }
            } finally {
                scope.cancel()
            }
        }

        val content = home {
            answered(
                AppQueryResponse(
                    agenda_upcoming = AgendaUpcoming(
                        events = listOf(
                            AgendaEvent(
                                event_id = "evt-1",
                                summary = "Survey walk-through",
                                instance_key = "evt-1",
                                local_start = "2026-06-17T08:15",
                                local_days = listOf("2026-06-17"),
                            ),
                        ),
                        today = "2026-06-15",
                        now_local = "2026-06-15T09:00",
                    ),
                ),
            )
        }
        val tile = agendaTile(content)
        tile.status shouldBe TileStatus.TILE_STATUS_CONTENT
        tile.body.shouldNotBeNull().agenda.shouldNotBeNull().at shouldBe "Wed 17 · 08:15"
        zones.toList().last() shouldBe "Asia/Tokyo"
        content.close()

        val denied = home { answered(AppQueryResponse(denied = AppQueryDenial())) }
        val refused = agendaTile(denied)
        refused.status shouldBe TileStatus.TILE_STATUS_UNKNOWN
        refused.count shouldBe null
        denied.close()
    }

    "a blank zone is refused before the core is asked, for every app's query, not only Agenda's" {
        val asked = ConcurrentLinkedQueue<Envelope>()
        val core = CentraidCore.answering(Dispatchers.Default) { envelope ->
            asked += envelope
            answered(AppQueryResponse())
        }
        val blank = FakeDeviceClock(zone = "")
        listOf<(String) -> AppQueryRequest>(
            { tz -> AppQueryRequest(tasks_board = TasksBoardRequest(tz = tz)) },
            { tz -> AppQueryRequest(docs_document = DocsDocumentRequest(document_id = "doc-1", tz = tz)) },
            { tz -> AppQueryRequest(notes_trash = NotesTrashRequest(tz = tz)) },
            { tz -> AppQueryRequest(people_touch = PeopleTouchRequest(tz = tz)) },
            { tz -> AppQueryRequest(tally_dashboard = TallyDashboardRequest(tz = tz)) },
        ).forEach { make ->
            readOnce(core, queries { now -> listOf(make(now.zone)) }, clock = blank)
                .shouldBeInstanceOf<Probe.Refused>().failure.sentence shouldBe
                "This device did not say which time zone it is in."
        }
        asked.toList().shouldBeEmpty()
        core.close()
    }

    "every query arm whose request carries a tz is in the zone pre-check" {
        // THE LIST IS MECHANICAL, so a new arm cannot be forgotten: every
        // `AppQueryRequest` arm whose message declares `string tz` must be
        // named in `zone()`.
        val root = File(System.getProperty("centraid.repositoryRoot") ?: error("unset"))
        val protos = root.resolve("crates/api-proto/proto/centraid/core/v1")
        val text = protos.listFiles { f -> f.name.endsWith(".proto") }!!.joinToString("\n") { it.readText() }
        val withTz = Regex("""(?m)^message (\w+Request) \{([^}]*)\}""").findAll(text)
            .filter { Regex("""(?m)^\s*string tz = \d+;""").containsMatchIn(it.groupValues[2]) }
            .map { it.groupValues[1] }
            .toSet()
        val arms = Regex("""(?m)^\s*(\w+Request) (\w+) = \d+;""")
            .findAll(Regex("""(?ms)^message AppQueryRequest \{(.*?)^\}""").find(text)!!.groupValues[1])
            .filter { it.groupValues[1] in withTz }
            .map { it.groupValues[2] }
            .toList()
        arms.size shouldBeGreaterThan 20
        val source = root.resolve("mobile/shared/src/commonMain/kotlin/dev/centraid/shared/sync/ScreenQueries.kt").readText()
        val body = source.substringAfter("internal fun AppQueryRequest.zone(): String? =").substringBefore("\n\n")
        arms.filterNot { "$it?.tz" in body } shouldBe emptyList()
    }

    "arrived is handed the requests its answers answer, in order" {
        val core = CentraidCore.answering(Dispatchers.Default) { envelope ->
            val query = envelope.request.shouldNotBeNull().app_query.shouldNotBeNull()
            answered(
                if (query.tasks_search != null) {
                    AppQueryResponse(tasks_search = TasksSearch())
                } else {
                    AppQueryResponse(agenda_parties = AgendaParties())
                },
            )
        }
        val searched = object : ScreenQueries<List<Probe>, Probe> {
            override val screenId: String = SCREEN
            override val tables: Set<String> = emptySet()
            override fun requests(state: List<Probe>, now: DeviceClock.Reading) = listOf(
                AppQueryRequest(tasks_search = TasksSearchRequest(term = "milk", tz = now.zone)),
                AppQueryRequest(agenda_parties = AgendaPartiesRequest()),
            )
            override fun arrived(answers: List<AppQueryResponse>, requests: List<AppQueryRequest>): Probe =
                Probe.ArrivedFor(answers, requests)
            override fun refused(failure: ReadFailure): Probe = Probe.Refused(failure)
        }
        val probe = readOnce(core, searched).shouldBeInstanceOf<Probe.ArrivedFor>()
        probe.answers.size shouldBe 2
        probe.requests.first().tasks_search.shouldNotBeNull().term shouldBe "milk"
        probe.requests[1].agenda_parties.shouldNotBeNull()
        core.close()
    }

    "a screen that implements only the one-argument arrived still receives its answers" {
        val core = CentraidCore.answering(Dispatchers.Default) { answered(AppQueryResponse(agenda_parties = AgendaParties())) }
        readOnce(core, queries { listOf(AppQueryRequest(agenda_parties = AgendaPartiesRequest())) })
            .shouldBeInstanceOf<Probe.Arrived>().answers.size shouldBe 1
        core.close()
    }
}) {
    sealed interface Probe {
        data object Open : Probe
        data class Write(val invokeKey: String) : Probe
        data class Arrived(val answers: List<AppQueryResponse>) : Probe
        data class ArrivedFor(val answers: List<AppQueryResponse>, val requests: List<AppQueryRequest>) : Probe
        data class Refused(val failure: ReadFailure) : Probe
        data class Settled(val status: CommandStatus, val invokeKey: String) : Probe
    }

    companion object {
        const val SCREEN: String = "probe"
    }
}
