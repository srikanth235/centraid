package dev.centraid.shared

import centraid.core.v1.AgendaEvent
import centraid.core.v1.AgendaUpcoming
import centraid.screen.v1.HomeEvent
import centraid.screen.v1.HomeState
import centraid.screen.v1.TileStatus
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.shell.HomeAgendaTile
import dev.centraid.shared.shell.HomeMachine
import dev.centraid.shared.shell.HomeReads
import dev.centraid.shared.kit.time.dayOfMonthOf
import dev.centraid.shared.kit.time.epochDayOf
import dev.centraid.shared.kit.time.isoWeekdayOf
import dev.centraid.shared.kit.time.plusDays
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.collections.shouldNotContain
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain

/**
 * HOME'S TILE READS: AGENDA ON THE APP-QUERY ARM, AND THE TRASH OFF THE OTHERS
 * (#1046).
 *
 * The Agenda tile used to be a page read of `core_event` that printed raw ISO,
 * showed cancelled and trashed rows and never expanded a series. It is now a
 * fold over `agenda.upcoming`'s answer, and everything it decides — which
 * occurrence is next, how its time is said, what the after-line says, what the
 * count counts — is decided here, on strings the core already placed in the
 * device's zone. So every case is an ANSWER the core could give, built by
 * hand, and the tile it becomes.
 *
 * The answer's clock throughout: Monday 15 June 2026, 09:00 on the device.
 */
class HomeReadsSpec : StringSpec({

    val today = "2026-06-15"
    val now = "2026-06-15T09:00"

    fun timed(id: String, summary: String, start: String, end: String? = null): AgendaEvent =
        AgendaEvent(
            event_id = id,
            summary = summary,
            instance_key = "$id:$start",
            local_start = start,
            local_end = end ?: "",
            local_days = listOf(start.take(10)),
        )

    fun allDay(id: String, summary: String, first: String, last: String = first): AgendaEvent =
        AgendaEvent(
            event_id = id,
            summary = summary,
            instance_key = id,
            recurrence_semantics = "all-day",
            all_day = true,
            local_start = first,
            local_end = last,
            local_days = generateSequence(first) { day ->
                plusDays(day, 1)?.takeIf { it <= last }
            }.toList(),
        )

    fun answer(vararg events: AgendaEvent) =
        AgendaUpcoming(events = events.toList(), today = today, now_local = now)

    fun tile(vararg events: AgendaEvent): HomeEvent.TileArrived =
        HomeAgendaTile.arrived(answer(*events)).tile.shouldNotBeNull()

    // --- the request ------------------------------------------------------

    "the request states the device's zone and a fourteen-day bound, and leaves today to the core" {
        // THE ZONE IS THE PLATFORM'S, and a founded vault names none — so an
        // empty one would be refused (`agenda.proto`'s zone rule).
        val request = HomeAgendaTile.request(
            DeviceClock.Reading(zone = "Asia/Kolkata", epochMillis = 1_781_514_000_000L),
        ).agenda_upcoming.shouldNotBeNull()
        request.tz shouldBe "Asia/Kolkata"
        // EMPTY `from` IS TODAY IN THAT ZONE — the loader's default, not a
        // day this side guessed without a zone database.
        request.from shouldBe ""
        // 2026-06-15T09:00:00Z plus fourteen days of wall clock.
        request.to shouldBe "2026-06-29T09:00:00Z"
    }

    // --- which occurrence, and how its time is said ------------------------

    "the next occurrence today is its clock alone, and what follows it that day is named" {
        val arrived = tile(
            // OVER at 08:00, an hour before now: not next, not counted.
            timed("evt-early", "School run", "2026-06-15T07:30", "2026-06-15T08:00"),
            timed("evt-survey", "Survey walk-through", "2026-06-15T10:00", "2026-06-15T11:00"),
            timed("evt-dentist", "Dentist", "2026-06-15T14:00", "2026-06-15T15:00"),
        )
        arrived.status shouldBe TileStatus.TILE_STATUS_CONTENT
        val body = arrived.body.shouldNotBeNull().agenda.shouldNotBeNull()
        body.title shouldBe "Survey walk-through"
        body.at shouldBe "10:00"
        body.after shouldBe "then Dentist"
        arrived.count.shouldNotBeNull().value_ shouldBe 2
        arrived.count.shouldNotBeNull().capped shouldBe false
        arrived.count_label shouldBe "events in the next 7 days"
    }

    "an occurrence already under way is next — it has not ended" {
        val body = tile(
            timed("evt-call", "Call with Ana", "2026-06-15T08:30", "2026-06-15T09:30"),
            timed("evt-survey", "Survey walk-through", "2026-06-15T10:00"),
        ).body.shouldNotBeNull().agenda.shouldNotBeNull()
        body.title shouldBe "Call with Ana"
        body.at shouldBe "08:30"
    }

    "an end EXACTLY at now has ended, because a timed end is exclusive" {
        val body = tile(
            timed("evt-standup", "Stand-up", "2026-06-15T08:45", "2026-06-15T09:00"),
            timed("evt-survey", "Survey walk-through", "2026-06-15T10:00"),
        ).body.shouldNotBeNull().agenda.shouldNotBeNull()
        body.title shouldBe "Survey walk-through"
    }

    "a later day is weekday and date, and an empty stretch after it names the day it ends" {
        val body = tile(
            timed("evt-survey", "Survey walk-through", "2026-06-17T08:15", "2026-06-17T09:00"),
            timed("evt-lease", "Lease signing", "2026-06-20T11:00"),
        ).body.shouldNotBeNull().agenda.shouldNotBeNull()
        // The handoff's own line: "Wed 11 · 08:15", "then nothing until the 14th".
        body.at shouldBe "Wed 17 · 08:15"
        body.after shouldBe "then nothing until the 20th"
    }

    "an all-day event is a day and never a clock time" {
        // v0 drew "00:00" on a birthday. A day has no midnight to show.
        val todays = tile(
            allDay("evt-holiday", "Bank holiday", today),
        ).body.shouldNotBeNull().agenda.shouldNotBeNull()
        todays.at shouldBe "Today · all day"

        val later = tile(
            allDay("evt-move", "Moving day", "2026-06-18"),
        ).body.shouldNotBeNull().agenda.shouldNotBeNull()
        later.at shouldBe "Thu 18 · all day"
    }

    "an all-day run that began before today and covers it is today's, and one that ended yesterday is gone" {
        val arrived = tile(
            allDay("evt-yesterday", "Conference", "2026-06-12", "2026-06-14"),
            allDay("evt-trip", "Lisbon", "2026-06-13", "2026-06-16"),
        )
        val body = arrived.body.shouldNotBeNull().agenda.shouldNotBeNull()
        body.title shouldBe "Lisbon"
        body.at shouldBe "Today · all day"
        arrived.count.shouldNotBeNull().value_ shouldBe 1
    }

    "a repeating series is ONE thing: its next occurrence heads, and the after-line skips its own repeats" {
        // SEVEN occurrences of one series, expanded BY THE CORE — this side
        // expands nothing (D-1020-S1). Each carries the series' `event_id`.
        val standups = (15..21).map { day ->
            timed("evt-standup", "Stand-up", "2026-06-${day}T10:00", "2026-06-${day}T10:15")
                .copy(recurrence_summary = "Every day")
        }
        val dentist = timed("evt-dentist", "Dentist", "2026-06-16T14:00")
        val arrived = tile(*(standups + dentist).sortedBy { it.local_start }.toTypedArray())
        val body = arrived.body.shouldNotBeNull().agenda.shouldNotBeNull()
        body.title shouldBe "Stand-up"
        body.at shouldBe "10:00"
        // NOT "then Stand-up": tomorrow's stand-up is the same thing again.
        body.after shouldBe "then nothing until the 16th"
        // The COUNT is occurrences — seven stand-ups and a dentist.
        arrived.count.shouldNotBeNull().value_ shouldBe 8
    }

    "the count is today and the six days after it, and the window beyond is not counted" {
        val arrived = tile(
            timed("evt-a", "A", "2026-06-15T10:00"),
            timed("evt-b", "B", "2026-06-21T23:30"),
            // The EIGHTH day: in the read's window, outside the count's.
            timed("evt-c", "C", "2026-06-22T00:00"),
        )
        arrived.count.shouldNotBeNull().value_ shouldBe 2
    }

    "nothing after the next in the window says so, rather than a blank line" {
        tile(timed("evt-survey", "Survey walk-through", "2026-06-15T10:00"))
            .body.shouldNotBeNull().agenda.shouldNotBeNull()
            .after shouldBe "nothing after it"
    }

    "an untitled event is called one, never drawn as a blank" {
        tile(timed("evt-x", "", "2026-06-15T10:00"))
            .body.shouldNotBeNull().agenda.shouldNotBeNull()
            .title shouldBe "Untitled event"
    }

    "nothing upcoming is EMPTY with a zero count, and Home offers the move" {
        val arrived = tile(timed("evt-early", "School run", "2026-06-15T07:30", "2026-06-15T08:00"))
        arrived.status shouldBe TileStatus.TILE_STATUS_EMPTY
        arrived.count.shouldNotBeNull().value_ shouldBe 0
        arrived.body.shouldBeNull()

        // THROUGH THE MACHINE: an empty agenda does not earn the grid, draws
        // its empty copy, and is offered as a first move.
        var state: HomeState =
            HomeMachine.reduce(HomeMachine.initial(), HomeEvent(opened = HomeEvent.Opened())).state
        state = HomeMachine.reduce(state, HomeEvent(tile = arrived)).state
        val agenda = state.data_.shouldNotBeNull().tiles.single { it.app_id == "agenda" }
        agenda.status shouldBe TileStatus.TILE_STATUS_EMPTY
        agenda.earns_grid shouldBe false
        agenda.empty_copy shouldBe "Put something on the calendar"
        state.data_.shouldNotBeNull().first_moves.map { it.id } shouldContain "agenda"
    }

    "a tile with a next occurrence earns the grid through the machine" {
        var state: HomeState =
            HomeMachine.reduce(HomeMachine.initial(), HomeEvent(opened = HomeEvent.Opened())).state
        val arrived = tile(timed("evt-survey", "Survey walk-through", "2026-06-17T08:15"))
        state = HomeMachine.reduce(state, HomeEvent(tile = arrived)).state
        val agenda = state.data_.shouldNotBeNull().tiles.single { it.app_id == "agenda" }
        agenda.status shouldBe TileStatus.TILE_STATUS_CONTENT
        agenda.earns_grid shouldBe true
        agenda.body.shouldNotBeNull().agenda.shouldNotBeNull().at shouldBe "Wed 17 · 08:15"
        state.data_.shouldNotBeNull().first_moves.map { it.id } shouldNotContain "agenda"
    }

    "the ordinal a day of the month is said with" {
        mapOf(
            1 to "1st", 2 to "2nd", 3 to "3rd", 4 to "4th",
            11 to "11th", 12 to "12th", 13 to "13th",
            21 to "21st", 22 to "22nd", 23 to "23rd", 30 to "30th", 31 to "31st",
        ).forEach { (day, said) -> withClue(day) { HomeAgendaTile.ordinal(day) shouldBe said } }
    }

    // --- Home redraws on what Agenda's query reads -------------------------

    "Home re-reads on every table the Agenda tile's query depends on" {
        HomeAgendaTile.TABLES.forEach { table ->
            withClue(table) { HomeMachine.rowsChanged(table, listOf("k")).shouldNotBeNull() }
        }
        HomeReads.READS.map { it.appId } shouldNotContain "agenda"
    }

    // --- the trash, off the other tiles ------------------------------------

    "the docs, notes and tasks tiles leave the trash out, and tasks reads open work only" {
        val byApp = HomeReads.READS.associateBy { it.appId }
        listOf("docs", "notes", "tasks").forEach { app ->
            val query = byApp.getValue(app).query
            withClue(app) {
                query.where_.shouldNotBeNull() shouldContain "deleted_at IS NULL"
                // THE AppReadsSpec RULE, here too: the door reads the cursor
                // off the row by the two ORDER BY columns.
                val order = query.order.shouldNotBeNull()
                query.select shouldContain order.sort_column
                query.select shouldContain order.pk_column
                // A `?` PER BIND, or the door refuses the statement.
                query.where_.shouldNotBeNull().count { it == '?' } shouldBe query.bind.size
            }
        }
        val tasks = byApp.getValue("tasks").query
        tasks.where_.shouldNotBeNull() shouldContain "status IN (?, ?)"
        tasks.bind.map { it.text } shouldBe listOf("needs-action", "in-process")
    }

    // --- civil days: arithmetic, never a zone ------------------------------

    "a civil day's weekday, its date, and the day seven on" {
        isoWeekdayOf("1970-01-01") shouldBe 4 // a Thursday
        isoWeekdayOf("2026-06-15") shouldBe 1 // a Monday
        isoWeekdayOf("2026-06-21") shouldBe 7 // a Sunday
        isoWeekdayOf("1969-12-31") shouldBe 3 // before the epoch, still a weekday
        dayOfMonthOf("2026-06-09") shouldBe 9
        plusDays("2026-06-15", 7) shouldBe "2026-06-22"
        // ACROSS a month, a year, and a leap day.
        plusDays("2026-01-31", 1) shouldBe "2026-02-01"
        plusDays("2026-12-31", 1) shouldBe "2027-01-01"
        plusDays("2028-02-28", 1) shouldBe "2028-02-29"
        plusDays("2027-02-28", 1) shouldBe "2027-03-01"
        plusDays("2026-06-15", -15) shouldBe "2026-05-31"
        epochDayOf("1970-01-01") shouldBe 0L
        epochDayOf("2000-03-01") shouldBe 11_017L
    }

    "a day that is not one real day is null, never the day after" {
        epochDayOf("2026-02-31").shouldBeNull()
        epochDayOf("2027-02-29").shouldBeNull()
        epochDayOf("2026-13-01").shouldBeNull()
        epochDayOf("2026-6-15").shouldBeNull()
        epochDayOf("").shouldBeNull()
        isoWeekdayOf("2026-06-15T10:00").shouldBeNull()
        plusDays("not a day", 1).shouldBeNull()
    }
})
