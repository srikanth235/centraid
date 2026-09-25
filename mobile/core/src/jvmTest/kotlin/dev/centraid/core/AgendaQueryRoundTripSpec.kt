package dev.centraid.core

import centraid.core.v1.AgendaDayContextRequest
import centraid.core.v1.AgendaPartiesRequest
import centraid.core.v1.AgendaSearchRequest
import centraid.core.v1.AgendaUpcoming
import centraid.core.v1.AgendaUpcomingRequest
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.Command
import centraid.core.v1.CommandStatus
import centraid.core.v1.Envelope
import centraid.core.v1.Request
import dev.centraid.core.AbiRoundTripSpec.Companion.openRealCore
import dev.centraid.core.AbiRoundTripSpec.Companion.shouldBeAnsweredWith
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.collections.shouldNotContain
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.ints.shouldBeGreaterThanOrEqual
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldEndWith
import io.kotest.matchers.string.shouldStartWith
import io.kotest.matchers.types.shouldBeInstanceOf
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import okio.ByteString.Companion.encodeUtf8

/**
 * AGENDA'S QUERIES, KOTLIN TO RUST AND BACK (#1046 wave 1's exit).
 *
 * The phone had no request that ran an app crate's query, so Agenda — whose
 * `upcoming` joins six-plus tables and expands every repeating series — had
 * nothing to draw from but a page read of one table, and a Kotlin expansion
 * would have been a second recurrence engine (D-1020-S1). `app_query` (20) is
 * the arm: the core runs `crates/apps/agenda`'s loader and answers a TYPED
 * message, which Wire decodes like everything else the core says.
 *
 * Over JNA, against the real `libcentraid_core_ffi` and the vault
 * `spike-fixture` founded — nothing faked. The writes go through `Command`
 * requests, the command plane a screen uses, so what is read back is what a
 * member's own writes produce.
 */
class AgendaQueryRoundTripSpec : StringSpec({

    "agenda.upcoming answers a weekly series expanded by the core, beside a one-off" {
        val core = openRealCore()
        try {
            // THE CALENDAR FOUNDING MADE, off the query itself: a proposal has
            // to name one, and `upcoming` lists every calendar in range or not.
            val calendarId = core.upcoming().calendars.first().calendar_id

            core.write(
                "schedule.propose_event",
                """{"summary":"Dentist","dtstart":"2099-06-03T09:00:00.000Z",""" +
                    """"dtend":"2099-06-03T10:00:00.000Z","calendar_id":"$calendarId"}""",
                key = "agenda-round-trip-one-off",
            )
            // Anchored AT the window's start, so every occurrence answered is
            // inside it and the count below is the range's and nothing else's.
            val series = core.write(
                "schedule.propose_event",
                """{"summary":"Morning run","dtstart":"2099-06-01T07:00:00.000Z",""" +
                    """"dtend":"2099-06-01T08:00:00.000Z","calendar_id":"$calendarId",""" +
                    """"rrule":"FREQ=WEEKLY","reminders":[{"minutes_before":10}]}""",
                key = "agenda-round-trip-series",
            )

            // ZONED, in London, at 03:30Z on the 4th: 23:30 on the 3rd in New
            // York, the zone every query here states.
            val lateCall = core.write(
                "schedule.propose_event",
                """{"summary":"Late call","dtstart":"2099-06-04T03:30:00.000Z",""" +
                    """"dtend":"2099-06-04T05:00:00.000Z","start_tz":"Europe/London",""" +
                    """"calendar_id":"$calendarId"}""",
                key = "agenda-round-trip-late-call",
            )

            val upcoming = core.upcoming()
            val runs = upcoming.events.filter { it.summary == "Morning run" }
            // THE EXPANSION IS THE CORE'S: three weeks, three rows, ONE series.
            runs.size shouldBeGreaterThanOrEqual 3
            runs.map { it.instance_key }.toSet() shouldHaveSize runs.size
            val seriesId = runs.first().event_id
            series shouldBe seriesId
            runs.forEach { run ->
                run.event_id shouldBe seriesId
                run.instance_key shouldStartWith "$seriesId:"
                run.original_start_local shouldNotBe null
                // The sentence, never the rule — and the reminders decoded in
                // Rust, because `commonMain` has no JSON to decode them with.
                run.recurrence_summary shouldNotBe null
                run.reminders.map { it.minutes_before } shouldBe listOf(10L)
            }
            val dentist = upcoming.events.single { it.summary == "Dentist" }
            dentist.recurrence_summary shouldBe null
            dentist.dtend shouldBe "2099-06-03T10:00:00.000Z"
            // IN START ORDER, which is what a Day list draws in.
            upcoming.events.map { it.dtstart } shouldBe upcoming.events.map { it.dtstart }.sorted()

            // --- civil time, in the zone the request states -----------------
            // The core places every occurrence: a view groups by `local_days`
            // and prints `local_start`, and does no zone arithmetic of its own.
            val call = upcoming.events.single { it.event_id == lateCall }
            call.local_start shouldBe "2099-06-03T23:30"
            call.local_end shouldBe "2099-06-04T01:00"
            call.local_days shouldBe listOf("2099-06-03", "2099-06-04")
            call.all_day shouldBe false
            // A floating 07:00 is 07:00 in every zone, on one day.
            runs.forEach { run ->
                run.local_start shouldEndWith "T07:00"
                run.local_days shouldHaveSize 1
            }
            // TODAY AND NOW are the vault clock read in New York — checked here
            // against the JVM's own zone database, which a shell's shared layer
            // never has. Either side of a midnight the test straddled.
            val zone = ZoneId.of(TZ)
            val around = listOf(LocalDate.now(zone).minusDays(1), LocalDate.now(zone))
                .map { it.toString() }
            around shouldContain upcoming.today
            upcoming.now_local shouldStartWith upcoming.today
            // NOTHING ANSWERED HAD ENDED BEFORE `from`: the reach-back month of
            // a series is not on the agenda. A floating row is a wall clock —
            // a stored `Z` on one is ignored — read in the request zone, as the
            // core reads it.
            val from = Instant.parse(FROM)
            upcoming.events.forEach { event ->
                val instantOf = { text: String ->
                    if (event.recurrence_semantics == "zoned") {
                        Instant.parse(text)
                    } else {
                        LocalDateTime.parse(text.removeSuffix("Z")).atZone(zone).toInstant()
                    }
                }
                val start = instantOf(event.dtstart)
                val end = event.dtend?.let(instantOf) ?: start
                (end.isAfter(from) || !start.isBefore(from)) shouldBe true
            }

            // --- agenda.parties -------------------------------------------
            core.appQuery(AppQueryRequest(agenda_parties = AgendaPartiesRequest()))
                .shouldBeAnsweredWith { envelope ->
                    val parties = envelope.appQuery().agenda_parties
                        ?: error("a parties answer, got ${envelope.appQuery()}")
                    val owner = parties.parties.single { it.is_you }
                    parties.me shouldBe owner.party_id
                    // The owner FIRST, so the picker leads with them.
                    parties.parties.first() shouldBe owner
                }

            // --- agenda.day-context ---------------------------------------
            core.appQuery(
                AppQueryRequest(
                    agenda_day_context = AgendaDayContextRequest(
                        from = "2099-06-01",
                        to = "2099-06-21",
                        tz = TZ,
                    ),
                ),
            ).shouldBeAnsweredWith { envelope ->
                val context = envelope.appQuery().agenda_day_context
                    ?: error("a day-context answer, got ${envelope.appQuery()}")
                // No holiday source exists: EMPTY BY CONSTRUCTION, and a
                // present field rather than an absent one.
                context.holidays.shouldBeEmpty()
                context.due.shouldBeEmpty()
                context.today shouldBe upcoming.today
            }

            // --- the zone rule ----------------------------------------------
            // A zone this build does not know is refused, never answered in UTC.
            core.appQuery(
                AppQueryRequest(
                    agenda_upcoming = AgendaUpcomingRequest(
                        from = FROM,
                        to = TO,
                        tz = "Mars/Olympus_Mons",
                    ),
                ),
            ).shouldBeInstanceOf<CoreOutcome.Failed>()
        } finally {
            core.close()
        }
    }

    "a cancelled event and a trashed one are not on the agenda — Home's tile draws from this" {
        // HOME'S AGENDA TILE READ `core_event` UNFILTERED until #1046 moved it
        // onto this query, so a cancelled dentist and a deleted lunch both
        // headed the launcher. The exclusion is the core's (the window and
        // anchor statements); this proves it over the real command plane.
        val core = openRealCore()
        try {
            val calendarId = core.upcoming().calendars.first().calendar_id
            val kept = core.write(
                "schedule.propose_event",
                """{"summary":"Kept","dtstart":"2099-06-02T09:00:00.000Z",""" +
                    """"dtend":"2099-06-02T10:00:00.000Z","calendar_id":"$calendarId"}""",
                key = "agenda-round-trip-kept",
            )
            val cancelled = core.write(
                "schedule.propose_event",
                """{"summary":"Cancelled","dtstart":"2099-06-02T11:00:00.000Z",""" +
                    """"dtend":"2099-06-02T12:00:00.000Z","calendar_id":"$calendarId"}""",
                key = "agenda-round-trip-cancelled",
            )
            val trashed = core.write(
                "schedule.propose_event",
                """{"summary":"Trashed","dtstart":"2099-06-02T13:00:00.000Z",""" +
                    """"dtend":"2099-06-02T14:00:00.000Z","calendar_id":"$calendarId",""" +
                    """"rrule":"FREQ=WEEKLY"}""",
                key = "agenda-round-trip-trashed",
            )
            // All three are on it first — the fixture vault is shared by
            // every spec in the run, so this asks about these three and no
            // others.
            val before = core.upcoming().events.map { it.event_id }.toSet()
            listOf(kept, cancelled, trashed).forEach { before shouldContain it }

            core.write(
                "schedule.cancel_event",
                """{"event_id":"$cancelled"}""",
                key = "agenda-round-trip-cancel",
            )
            // A SERIES, TRASHED: the anchor read is the one that would bring
            // it back one week at a time, and it does not.
            core.write(
                "schedule.delete_event",
                """{"event_id":"$trashed"}""",
                key = "agenda-round-trip-delete",
            )
            val after = core.upcoming().events.map { it.event_id }.toSet()
            after shouldContain kept
            after shouldNotContain cancelled
            after shouldNotContain trashed
        } finally {
            core.close()
        }
    }
    "agenda.search finds an event by a word of its summary, at the phone's limit" {
        val core = openRealCore()
        try {
            val calendarId = core.upcoming().calendars.first().calendar_id
            val dinner = core.write(
                "schedule.propose_event",
                """{"summary":"Dinner with Maya","dtstart":"2099-06-05T19:00:00.000Z",""" +
                    """"dtend":"2099-06-05T21:00:00.000Z","calendar_id":"$calendarId"}""",
                key = "agenda-round-trip-search",
            )
            for (term in listOf("Dinner", "dinner", "Din")) {
                var found: List<String> = emptyList()
                core.appQuery(
                    AppQueryRequest(
                        agenda_search = AgendaSearchRequest(term = term, limit = 100, tz = TZ),
                    ),
                ).shouldBeAnsweredWith { envelope ->
                    found = envelope.appQuery().agenda_search?.events.orEmpty().map { it.event_id }
                }
                found shouldContain dinner
            }
        } finally {
            core.close()
        }
    }
}) {
    companion object {
        private const val FROM = "2099-06-01T00:00:00.000Z"
        private const val TO = "2099-06-22T00:00:00.000Z"

        /** The device's zone, as a shell reads it off the platform and states it. */
        private const val TZ = "America/New_York"

        suspend fun CentraidCore.appQuery(query: AppQueryRequest): CoreOutcome<Envelope> =
            call(Envelope(request_id = 1, request = Request(app_query = query)))

        fun Envelope.appQuery(): AppQueryResponse =
            response?.app_query ?: error("an AppQueryResponse, got $this")

        suspend fun CentraidCore.upcoming(): AgendaUpcoming {
            var answer: AgendaUpcoming? = null
            appQuery(
                AppQueryRequest(
                    agenda_upcoming = AgendaUpcomingRequest(from = FROM, to = TO, tz = TZ),
                ),
            ).shouldBeAnsweredWith { envelope ->
                answer = envelope.appQuery().agenda_upcoming
                    ?: error("an upcoming answer, got ${envelope.appQuery()}")
            }
            return answer!!
        }

        /** One command through the command plane; answers its `event_id`. */
        suspend fun CentraidCore.write(name: String, input: String, key: String): String {
            var eventId = ""
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
                eventId = Regex("\"event_id\":\"([^\"]+)\"")
                    .find(outcome.output.utf8())
                    ?.groupValues
                    ?.get(1)
                    ?: error("no event_id in ${outcome.output.utf8()}")
            }
            return eventId
        }
    }
}
