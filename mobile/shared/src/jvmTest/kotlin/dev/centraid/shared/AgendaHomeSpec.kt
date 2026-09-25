package dev.centraid.shared

import centraid.core.v1.AgendaAttendee
import centraid.core.v1.AgendaBirthday
import centraid.core.v1.AgendaCalendar
import centraid.core.v1.AgendaDayContext
import centraid.core.v1.AgendaDueDay
import centraid.core.v1.AgendaDueTask
import centraid.core.v1.AgendaEvent
import centraid.core.v1.AgendaSearch
import centraid.core.v1.AgendaUpcoming
import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.Envelope
import centraid.core.v1.Response
import centraid.screen.v1.AgendaEmpty
import centraid.screen.v1.AgendaEventRow
import centraid.screen.v1.AgendaHomeEvent
import centraid.screen.v1.AgendaHomeState
import centraid.screen.v1.AgendaRowStatus
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.ReadFailureKind
import dev.centraid.core.CentraidCore
import dev.centraid.shared.apps.agenda.AgendaHome
import dev.centraid.shared.apps.agenda.AgendaHomeMachine
import dev.centraid.shared.apps.agenda.AgendaInput
import dev.centraid.shared.apps.agenda.AgendaReads
import dev.centraid.shared.design.PartyHueWheel
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavStack
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.platform.FakeDeviceClock
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.sync.ScreenQueryRuntime
import dev.centraid.shared.kit.time.plusDays
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * AGENDA'S HOME, FROM TYPED ANSWERS TO THE LIST A VIEW DRAWS (#1046).
 *
 * Every fixture is an `AgendaUpcoming` / `AgendaDayContext` the way the core
 * answers them — civil strings already placed in the device's zone — so what
 * is pinned here is the machine's half: which queries, what the rows say, and
 * what a local change does WITHOUT a read. Monday 15 June 2026, 09:42.
 */
class AgendaHomeSpec : StringSpec({

    val day = AgendaHomeState.Destination.DESTINATION_DAY
    val schedule = AgendaHomeState.Destination.DESTINATION_SCHEDULE
    val waiting = AgendaHomeState.Destination.DESTINATION_WAITING
    val clock = DeviceClock.Reading(zone = "Europe/London", epochMillis = 1_781_516_520_000L)

    "opening reads, and lands on Day at the TODAY THE ANSWER NAMES" {
        val opened = AgendaHomeMachine.reduce(AgendaHomeMachine.initial(), view(opened()))
        opened.effects shouldBe listOf(ScreenEffect.ReadPage(AgendaHomeMachine.SCREEN_ID, null))
        opened.state.screen.loading.shouldNotBeNull().first_load shouldBe true
        // NOT A DEVICE-CLOCK GUESS: nothing names a day until the core does.
        opened.state.screen.anchor_day shouldBe ""
        opened.state.screen.toolbar.shouldNotBeNull().shown shouldBe false

        val landed = answer(opened.state, upcoming(timed("a", "Stand-up", "2026-06-15T10:00")), context())
        landed.screen.destination shouldBe day
        landed.screen.anchor_day shouldBe TODAY
        val toolbar = landed.screen.toolbar.shouldNotBeNull()
        toolbar.shown shouldBe true
        toolbar.range_label shouldBe "Today"
        toolbar.month_label shouldBe "June 2026"
        toolbar.at_today shouldBe true
        // THE BAND, computed: five tabs in v0's order, Day current.
        landed.screen.band.map { it.key } shouldBe listOf("day", "schedule", "waiting", "search", "more")
        landed.screen.band.map { it.icon_key } shouldBe listOf("Clock", "List", "Inbox", "Search", "more")
        landed.screen.band.filter { it.current }.map { it.key } shouldBe listOf("day")
        landed.screen.chrome.shouldNotBeNull().new_event shouldBe "New event"
    }

    "a destination opened from the shell lands there" {
        val opened = AgendaHomeMachine.reduce(AgendaHomeMachine.initial(), view(opened(schedule)))
        opened.state.screen.destination shouldBe schedule
        NavStack().withAgendaDestination(schedule).current shouldBe Destination.AgendaHome(schedule)
        NavStack().push(Destination.AgendaHome()).withAgendaDestination(waiting).entries.size shouldBe 2
    }

    "before the first answer the core names today; after it, the window is padded UTC midnights" {
        val first = AgendaReads.requests(AgendaHomeMachine.initial(), clock).shouldNotBeNull()
        first.size shouldBe 2
        val firstUpcoming = first[0].agenda_upcoming.shouldNotBeNull()
        firstUpcoming.from shouldBe ""
        firstUpcoming.to shouldBe "2026-06-17T09:42:00Z"
        firstUpcoming.tz shouldBe "Europe/London"
        first[1].agenda_day_context.shouldNotBeNull().let {
            it.from shouldBe ""
            it.to shouldBe "2026-06-17"
            it.tz shouldBe "Europe/London"
        }

        val onDay = landed(day)
        val dayReads = AgendaReads.requests(onDay, clock).shouldNotBeNull()
        dayReads[0].agenda_upcoming.shouldNotBeNull().let {
            it.from shouldBe "2026-06-14T00:00:00Z"
            it.to shouldBe "2026-06-17T00:00:00Z"
        }
        dayReads[1].agenda_day_context.shouldNotBeNull().let {
            it.from shouldBe TODAY
            it.to shouldBe TODAY
        }

        val onSchedule = landed(schedule)
        val listReads = AgendaReads.requests(onSchedule, clock).shouldNotBeNull()
        listReads[0].agenda_upcoming.shouldNotBeNull().to shouldBe "2026-10-14T00:00:00Z"
        listReads[1].agenda_day_context.shouldNotBeNull().to shouldBe "2026-10-12"
        // WAITING IS SCHEDULE'S WINDOW: the same two queries.
        AgendaReads.requests(
            onSchedule.copy(screen = onSchedule.screen.copy(destination = waiting)),
            clock,
        ) shouldBe listReads
    }

    "a search term replaces the upcoming list, and asks for it again only when it is not held" {
        val typed = drive(landed(schedule), searchOpened(), term("dentist"))
        val reads = AgendaReads.requests(typed.state, clock).shouldNotBeNull()
        reads.map { it.kind() } shouldBe listOf("context", "search")
        reads[1].agenda_search.shouldNotBeNull().let {
            it.term shouldBe "dentist"
            it.limit shouldBe 100
            it.tz shouldBe "Europe/London"
        }
        // A ROW MOVED: the held list is stale, so it is read again too.
        val stale = drive(typed.state, AgendaHomeMachine.rowsChanged("core_event", emptyList())!!)
        AgendaReads.requests(stale.state, clock).shouldNotBeNull().map { it.kind() } shouldBe
            listOf("upcoming", "context", "search")
    }

    "the sections, in day order, with the month named where the list reaches a new one" {
        val home = landed(
            schedule,
            upcoming(
                timed("a", "Stand-up", "2026-06-15T10:00", "2026-06-15T10:15"),
                timed("b", "Dentist", "2026-06-16T14:00", "2026-06-16T15:00"),
                timed("c", "Survey", "2026-07-02T08:15", "2026-07-02T09:45"),
                // THE PAD: a day before the window is in the answer and not drawn.
                timed("z", "Yesterday's", "2026-06-14T12:00", "2026-06-14T13:00"),
            ),
        )
        val data = home.screen.data_.shouldNotBeNull()
        data.days.map { it.day } shouldBe listOf("2026-06-15", "2026-06-16", "2026-07-02")
        data.days.map { it.heading } shouldBe listOf("Today", "Tue 16 June", "Thu 2 July")
        data.days.map { it.month_heading } shouldBe listOf(null, null, "July 2026")
        data.days[1].day_number shouldBe "16"
        data.days[1].weekday_short shouldBe "Tue"
        data.days[0].is_today shouldBe true
        data.event_count shouldBe 3
        data.event_count_label shouldBe "3 events"
        data.empty shouldBe AgendaEmpty.AGENDA_EMPTY_NONE
        home.screen.toolbar.shouldNotBeNull().range_label shouldBe "From today"
    }

    "today's rows: all-day first, the now line before the first that has not started, ended rows dimmed" {
        val home = landed(
            day,
            upcoming(
                timed("early", "Run", "2026-06-15T07:00", "2026-06-15T08:00"),
                allDay("bank", "Bank holiday", TODAY),
                timed("late", "Survey walk-through", "2026-06-15T10:00", "2026-06-15T11:30"),
                timed("now", "Call", "2026-06-15T09:30", "2026-06-15T10:00"),
            ),
        )
        val section = home.screen.data_.shouldNotBeNull().days.single()
        section.items.map { it.event?.title ?: "NOW" } shouldBe
            listOf("Bank holiday", "Run", "Call", "NOW", "Survey walk-through")
        section.items.first { it.now_line != null }.now_line.shouldNotBeNull().let {
            it.label shouldBe "09:42"
            it.accessibility_label shouldBe "Now, 09:42"
        }
        rows(section).associate { it.title to it.is_past } shouldBe mapOf(
            "Bank holiday" to false,
            "Run" to true,
            "Call" to false,
            "Survey walk-through" to false,
        )
        // OPENING LANDS AT NOW.
        home.screen.data_.shouldNotBeNull().landing.shouldNotBeNull().let {
            it.day shouldBe TODAY
            it.now_line shouldBe true
        }
    }

    "a time is a range, a start, All day, Until, From or Continues — never a clock on a day" {
        val home = landed(
            schedule,
            upcoming(
                timed("range", "Range", "2026-06-16T08:15", "2026-06-16T09:45"),
                timed("instant", "Instant", "2026-06-16T08:15"),
                allDay("all", "Offsite", "2026-06-16"),
                timed("in", "Red-eye", "2026-06-14T22:00", "2026-06-15T10:00"),
                timed("out", "Night shift", "2026-06-16T22:00", "2026-06-17T02:00"),
                timed("run", "Conference", "2026-06-18T09:00", "2026-06-20T17:00"),
                timed("midnight", "Late", "2026-06-19T23:00", "2026-06-20T00:00"),
            ),
        )
        val byDay = home.screen.data_.shouldNotBeNull().days.associate { section ->
            section.day to rows(section).associate { it.event_id to it.time_label }
        }
        byDay.getValue("2026-06-15")["in"] shouldBe "Until 10:00"
        byDay.getValue("2026-06-16") shouldBe mapOf(
            "all" to "All day",
            "instant" to "08:15",
            "range" to "08:15 – 09:45",
            "out" to "From 22:00",
        )
        byDay.getValue("2026-06-17")["out"] shouldBe "Until 02:00"
        byDay.getValue("2026-06-18")["run"] shouldBe "From 09:00"
        byDay.getValue("2026-06-19")["run"] shouldBe "Continues"
        byDay.getValue("2026-06-20")["run"] shouldBe "Until 17:00"
        // AN END AT THE NEXT MIDNIGHT IS EXCLUSIVE: it ends on its own day.
        byDay.getValue("2026-06-19")["midnight"] shouldBe "23:00 – 00:00"
        // A run over three days is a row on each, keyed apart.
        home.screen.data_.shouldNotBeNull().days.flatMap { rows(it) }
            .filter { it.event_id == "run" }.map { it.row_key } shouldBe
            listOf("2026-06-18|run", "2026-06-19|run", "2026-06-20|run")
    }

    "every occurrence of a series says repeats, and the label speaks the rest" {
        val anchor = timed("series", "Survey walk-through", "2026-06-16T08:15", "2026-06-16T09:45").copy(
            instance_key = "series:2026-06-16T08:15",
            recurrence_summary = "Every Tuesday",
            is_recurrence_instance = false,
            conferencing_uri = "https://meet.example/abc",
            attendees = listOf(
                you("needs-action"),
                AgendaAttendee(party_id = "pty-dana", name = "Dana", partstat = "accepted"),
                AgendaAttendee(party_id = "pty-sam", name = "Sam", partstat = "tentative"),
            ),
        )
        val row = rows(landed(schedule, upcoming(anchor)).screen.data_.shouldNotBeNull().days.single()).single()
        row.meta shouldBe "repeats · 2 guests · call"
        row.status shouldBe AgendaRowStatus.AGENDA_ROW_STATUS_NEEDS_REPLY
        row.status_label shouldBe "needs a reply"
        row.accessibility_label shouldBe
            "Survey walk-through, 08:15 to 09:45, repeats, 2 guests, call, needs a reply"
        row.instance_key shouldBe "series:2026-06-16T08:15"
    }

    "the status chip: needs a reply from your own unanswered invitation, then the write overlay" {
        val events = upcoming(
            timed("empty", "Asked, no reply", "2026-06-16T08:00").copy(attendees = listOf(you(""))),
            timed("action", "Asked, needs-action", "2026-06-16T09:00").copy(attendees = listOf(you("needs-action"))),
            timed("said", "Accepted", "2026-06-16T10:00").copy(attendees = listOf(you("accepted"))),
            timed("theirs", "Theirs", "2026-06-16T11:00").copy(
                attendees = listOf(AgendaAttendee(party_id = "pty-dana", name = "Dana", partstat = "")),
            ),
            timed("held", "Held", "2026-06-16T12:00"),
            timed("cancel", "Cancel", "2026-06-16T13:00").copy(attendees = listOf(you(""))),
        )
        // THE OVERLAY IS STATE: nothing writes it until the event writes land
        // (waves 4 and 5), and the chip it drives is already computed here.
        val opened = drive(AgendaHomeMachine.initial(), view(opened(schedule))).state
        val overlaid = answer(
            opened.copy(
                screen = opened.screen.copy(
                    pending_event_ids = listOf("held"),
                    cancel_asked_event_ids = listOf("cancel"),
                ),
            ),
            events,
            context(),
        )
        val status = rows(overlaid.screen.data_.shouldNotBeNull().days.single())
            .associate { it.event_id to it.status_label }
        status shouldBe mapOf(
            "empty" to "needs a reply",
            "action" to "needs a reply",
            "said" to "",
            "theirs" to "",
            "held" to "pending",
            // THE OVERLAY OUTRANKS THE INVITATION: the member already acted.
            "cancel" to "cancellation asked",
        )
    }

    "a birthday is a ribbon on the day — one name, or a count — and never a row" {
        val home = landed(
            schedule,
            upcoming(timed("a", "Stand-up", "2026-06-15T10:00")),
            context(
                birthdays = listOf(
                    AgendaBirthday(party_id = "p1", name = "Dana", month = 6, day = 16),
                    AgendaBirthday(party_id = "p2", name = "Ada", month = 6, day = 18),
                    AgendaBirthday(party_id = "p3", name = "Bo", month = 6, day = 18),
                    AgendaBirthday(party_id = "p4", name = "Cy", month = 6, day = 18),
                ),
            ),
        )
        val days = home.screen.data_.shouldNotBeNull().days.associateBy { it.day }
        days.getValue("2026-06-16").ribbon shouldBe "Dana"
        days.getValue("2026-06-18").ribbon shouldBe "3 birthdays"
        days.getValue("2026-06-18").ribbon_names shouldBe listOf("Ada", "Bo", "Cy")
        days.getValue("2026-06-18").items.shouldBeEmpty()
        days.getValue("2026-06-15").ribbon.shouldBeNull()
    }

    "the due shelf counts, and opening it re-folds without a read" {
        val home = landed(
            schedule,
            upcoming(),
            context(
                due = listOf(
                    AgendaDueDay(
                        day = "2026-06-17",
                        count = 9,
                        tasks = listOf(AgendaDueTask(task_id = "t1", title = "File taxes")),
                    ),
                ),
            ),
        )
        val shelf = home.screen.data_.shouldNotBeNull().days.single()
        shelf.due_count shouldBe 9
        shelf.due_label shouldBe "9 due"
        shelf.due.map { it.title } shouldBe listOf("File taxes")
        val opened = drive(home, view(AgendaHomeEvent(due_toggled = AgendaHomeEvent.DueShelfToggled(day = "2026-06-17"))))
        opened.effects.shouldBeEmpty()
        opened.state.screen.data_.shouldNotBeNull().days.single().let {
            it.due_open shouldBe true
            it.due_label shouldBe "Hide"
        }
        home.screen.chrome.shouldNotBeNull().shelf_label shouldBe "Tasks due on this day"
    }

    "Waiting is Schedule's window filtered to your unanswered invitations — and moving re-reads nothing" {
        val home = landed(
            schedule,
            upcoming(
                timed("ask", "Offsite", "2026-06-16T09:00").copy(attendees = listOf(you("needs-action"))),
                timed("mine", "Gym", "2026-06-16T18:00"),
                timed("gone", "Cancelled ask", "2026-06-17T09:00")
                    .copy(status = "cancelled", attendees = listOf(you(""))),
            ),
            context(birthdays = listOf(AgendaBirthday(party_id = "p1", name = "Dana", month = 6, day = 20))),
        )
        home.screen.data_.shouldNotBeNull().waiting_count shouldBe 1
        val moved = drive(home, band("waiting"))
        moved.effects.shouldBeEmpty()
        moved.state.screen.destination shouldBe waiting
        val data = moved.state.screen.data_.shouldNotBeNull()
        // A BIRTHDAY DOES NOT MAKE A WAITING DAY.
        data.days.map { it.day } shouldBe listOf("2026-06-16")
        rows(data.days.single()).map { it.event_id } shouldBe listOf("ask")
        moved.state.screen.band.single { it.current }.key shouldBe "waiting"
    }

    "a hidden calendar re-folds without a read, and says so in the sheet" {
        val home = landed(
            schedule,
            upcoming(
                timed("a", "Personal thing", "2026-06-16T09:00", calendar = "cal-1"),
                timed("b", "Work thing", "2026-06-16T10:00", calendar = "cal-2"),
            ),
        )
        val hidden = drive(home, view(AgendaHomeEvent(calendar_toggled = AgendaHomeEvent.CalendarToggled(calendar_id = "cal-2"))))
        hidden.effects.shouldBeEmpty()
        hidden.state.screen.hidden_calendar_ids shouldBe listOf("cal-2")
        val data = hidden.state.screen.data_.shouldNotBeNull()
        rows(data.days.single()).map { it.event_id } shouldBe listOf("a")
        data.calendars.map { Triple(it.name, it.hidden, it.state_label) } shouldBe listOf(
            Triple("Personal", false, "Shown"),
            Triple("Work", true, "Hidden"),
        )
        // THE HUE: a stored `var(--c-teal)` is teal; `steelblue` is no hue the
        // wheel names, so the calendar's own id picks one.
        data.calendars.map { it.hue_key } shouldBe listOf("teal", PartyHueWheel.identityHueKey("cal-2"))
        rows(data.days.single()).single().calendar_hue_key shouldBe "teal"
        // Toggled back, and the session remembers across a re-open.
        drive(hidden.state, view(opened())).state.screen.hidden_calendar_ids shouldBe listOf("cal-2")
    }

    "search: opening reads nothing, a term reads over the rows, closing CLEARS it and re-reads nothing" {
        val home = landed(schedule, upcoming(timed("a", "Stand-up", "2026-06-16T09:00")))
        val opened = drive(home, band("search"))
        opened.effects.shouldBeEmpty()
        opened.state.screen.search_open shouldBe true
        opened.state.screen.band.single { it.current }.key shouldBe "search"

        val typed = drive(opened.state, term("dentist"))
        typed.effects shouldBe listOf(ScreenEffect.ReadPage(AgendaHomeMachine.SCREEN_ID, null))
        // THE ROWS STAY while the hits read.
        typed.state.screen.data_.shouldNotBeNull().days.size shouldBe 1

        val hits = drive(
            typed.state,
            AgendaInput.Answered(
                upcoming = null,
                context = context(),
                search = AgendaSearch(
                    events = listOf(timed("d", "Dentist", "2026-05-02T14:00").copy(calendar_id = "cal-1")),
                ),
            ),
        ).state
        val found = hits.screen.data_.shouldNotBeNull()
        // A HIT LAST MONTH IS STILL THE ANSWER, dimmed as past.
        found.days.map { it.day } shouldBe listOf("2026-05-02")
        found.days.single().month_heading shouldBe "May 2026"
        found.days.single().is_past shouldBe true
        hits.screen.toolbar.shouldNotBeNull().shown shouldBe false

        val none = drive(typed.state, AgendaInput.Answered(null, context(), AgendaSearch())).state
        none.screen.data_.shouldNotBeNull().let {
            it.empty shouldBe AgendaEmpty.AGENDA_EMPTY_NO_MATCH
            it.empty_title shouldBe "Nothing matches that."
            it.empty_body shouldBe "Try fewer words, or a different day."
        }

        val closed = drive(hits, view(AgendaHomeEvent(search_closed = AgendaHomeEvent.SearchClosed())))
        closed.effects.shouldBeEmpty()
        closed.state.screen.search_open shouldBe false
        closed.state.screen.search_term shouldBe ""
        closed.state.screen.data_.shouldNotBeNull().days.map { it.day } shouldBe listOf("2026-06-16")
    }

    "the empties are four different screens" {
        // DAY ONE: Schedule's whole window empty, nothing hidden, no search.
        landed(schedule, upcoming()).screen.data_.shouldNotBeNull().let {
            it.empty shouldBe AgendaEmpty.AGENDA_EMPTY_DAY_ONE
            it.empty_title shouldBe "Nothing in your calendar yet."
            it.empty_body shouldBe "The first event is one field and a time."
            it.empty_action shouldBe "New event"
        }
        landed(day, upcoming()).screen.data_.shouldNotBeNull().let {
            it.empty shouldBe AgendaEmpty.AGENDA_EMPTY_NOTHING_ON_DAY
            it.empty_title shouldBe "Nothing on this day."
            it.empty_action shouldBe ""
        }
        landed(waiting, upcoming(timed("a", "Gym", "2026-06-16T18:00"))).screen.data_.shouldNotBeNull().let {
            it.empty shouldBe AgendaEmpty.AGENDA_EMPTY_NOTHING_WAITING
            it.empty_title shouldBe "Nothing is waiting on you."
        }
        // EVERYTHING HIDDEN IS NOT DAY ONE: the calendar is not empty.
        val hiddenAll = drive(
            landed(schedule, upcoming(timed("a", "Gym", "2026-06-16T18:00", calendar = "cal-1"))),
            view(AgendaHomeEvent(calendar_toggled = AgendaHomeEvent.CalendarToggled(calendar_id = "cal-1"))),
        ).state
        hiddenAll.screen.data_.shouldNotBeNull().let {
            it.empty shouldBe AgendaEmpty.AGENDA_EMPTY_NOTHING_ON_DAY
            it.empty_title shouldBe "Nothing on these days."
        }
    }

    "denied is the gate, with no band and no day bar" {
        val denied = drive(
            drive(AgendaHomeMachine.initial(), view(opened())).state,
            AgendaInput.Denied(AppQueryDenial(code = "revoked")),
        ).state
        denied.screen.denied.shouldNotBeNull().let {
            it.title shouldBe "Agenda cannot read your calendar"
            it.body shouldBe "The owner has not granted it core.event. Nothing was read, and nothing was written."
            // The kit's gate: the refusal's code is the receipt.
            it.receipt shouldBe "revoked"
        }
        denied.screen.data_.shouldBeNull()
        denied.screen.band.shouldBeEmpty()
        denied.screen.toolbar.shouldNotBeNull().shown shouldBe false
        // THE READS OBJECT MAKES A DENIAL THE GATE, not the default refusal.
        AgendaReads.denied(AppQueryDenial()) shouldBe AgendaInput.Denied(AppQueryDenial())
    }

    "a refused read is a failure, not an empty agenda, and Refreshed is its retry" {
        val failure = ReadFailure(kind = ReadFailureKind.READ_FAILURE_KIND_REFUSED, sentence = "No.")
        val refused = drive(
            drive(AgendaHomeMachine.initial(), view(opened())).state,
            AgendaReads.refused(failure),
        )
        refused.effects.shouldBeEmpty()
        refused.state.screen.failure shouldBe failure
        refused.state.screen.data_.shouldBeNull()
        refused.state.screen.chrome.shouldNotBeNull().retry shouldBe "Retry"
        val retried = drive(refused.state, view(AgendaHomeEvent(refreshed = AgendaHomeEvent.Refreshed())))
        retried.effects shouldBe listOf(ScreenEffect.ReadPage(AgendaHomeMachine.SCREEN_ID, null))
        retried.state.screen.loading.shouldNotBeNull().first_load shouldBe true
    }

    "a row moved re-reads over the rows on screen, and only for the tables the queries read" {
        val home = landed(schedule, upcoming(timed("a", "Stand-up", "2026-06-16T09:00")))
        val moved = drive(home, AgendaHomeMachine.rowsChanged("schedule_attendee", listOf("att-1"))!!)
        moved.effects shouldBe listOf(ScreenEffect.ReadPage(AgendaHomeMachine.SCREEN_ID, null))
        moved.state.screen.data_.shouldNotBeNull()
        AgendaHomeMachine.rowsChanged("tally_expense", listOf("x")).shouldBeNull()
        AgendaReads.tables shouldBe AgendaHomeMachine.TABLES
    }

    "a day step re-reads a new window under skeletons, with the day bar standing" {
        val home = landed(day, upcoming(timed("a", "Stand-up", "2026-06-15T09:00")))
        val next = drive(home, step(1))
        next.effects shouldBe listOf(ScreenEffect.ReadPage(AgendaHomeMachine.SCREEN_ID, null))
        next.state.screen.anchor_day shouldBe "2026-06-16"
        next.state.screen.loading.shouldNotBeNull().first_load shouldBe true
        next.state.screen.toolbar.shouldNotBeNull().let {
            it.shown shouldBe true
            it.range_label shouldBe "Tomorrow"
            it.at_today shouldBe false
        }
        drive(home, step(-1)).state.screen.toolbar.shouldNotBeNull().range_label shouldBe "Yesterday"
        drive(home, step(2)).state.screen.toolbar.shouldNotBeNull().range_label shouldBe "Wednesday 17 June"
        drive(home, step(17)).state.screen.toolbar.shouldNotBeNull().month_label shouldBe "July 2026"
        val listed = drive(landed(schedule), step(2)).state.screen.toolbar.shouldNotBeNull()
        listed.range_label shouldBe "From Wednesday 17 June"

        // TODAY GOES BACK, and at today it is nothing.
        val back = drive(answer(next.state, upcoming(), context(today = TODAY)), today())
        back.state.screen.anchor_day shouldBe TODAY
        back.effects.size shouldBe 1
        drive(home, today()).effects.shouldBeEmpty()
    }

    "a read asked while one is out waits, and the older answer is never drawn" {
        val home = landed(day)
        val first = drive(home, step(1))
        val second = drive(first.state, step(1))
        second.effects.shouldBeEmpty()
        second.state.screen.anchor_day shouldBe "2026-06-17"
        // The answer to the FIRST step lands: dropped, and the queued read asked.
        val stale = drive(second.state, AgendaInput.Answered(upcoming(timed("x", "Stale", "2026-06-16T09:00")), context(), null))
        stale.effects shouldBe listOf(ScreenEffect.ReadPage(AgendaHomeMachine.SCREEN_ID, null))
        stale.state.screen.loading.shouldNotBeNull()
        val fresh = answer(stale.state, upcoming(timed("y", "Fresh", "2026-06-17T09:00")), context())
        rows(fresh.screen.data_.shouldNotBeNull().days.single()).map { it.title } shouldBe listOf("Fresh")
    }

    "the runtime serves the screen through AgendaReads, end to end" {
        val asked = ConcurrentLinkedQueue<AppQueryRequest>()
        val core = CentraidCore.answering(Dispatchers.Default) { envelope ->
            val query = envelope.request.shouldNotBeNull().app_query.shouldNotBeNull()
            asked += query
            Envelope(
                request_id = 0,
                response = Response(
                    app_query = when {
                        query.agenda_upcoming != null -> AppQueryResponse(
                            agenda_upcoming = upcoming(timed("a", "Stand-up", "2026-06-15T10:00")),
                        )
                        else -> AppQueryResponse(agenda_day_context = context())
                    },
                ),
            )
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val host = ScreenHost(AgendaHomeMachine)
            ScreenQueryRuntime(
                core = { core },
                host = host,
                queries = AgendaReads,
                clock = FakeDeviceClock(zone = "America/New_York"),
                scope = scope,
            ).start()
            host.send(view(opened()))
            val landed = withTimeout(5_000) { host.state.first { it.screen.data_ != null } }
            landed.screen.anchor_day shouldBe TODAY
            rows(landed.screen.data_.shouldNotBeNull().days.single()).single().title shouldBe "Stand-up"
            asked.map { it.kind() } shouldBe listOf("upcoming", "context")
            asked.first().agenda_upcoming.shouldNotBeNull().tz shouldBe "America/New_York"
        } finally {
            scope.cancel()
            core.close()
        }
    }
}) {
    companion object {
        const val TODAY: String = "2026-06-15"
        const val NOW: String = "2026-06-15T09:42"

        fun view(event: AgendaHomeEvent): AgendaInput = AgendaInput.View(event)

        fun opened(
            destination: AgendaHomeState.Destination = AgendaHomeState.Destination.DESTINATION_UNSPECIFIED,
        ): AgendaHomeEvent = AgendaHomeEvent(opened = AgendaHomeEvent.Opened(destination = destination))

        fun band(key: String): AgendaInput = view(AgendaHomeEvent(band = AgendaHomeEvent.BandPicked(key = key)))

        fun searchOpened(): AgendaInput = view(AgendaHomeEvent(search_opened = AgendaHomeEvent.SearchOpened()))

        fun term(text: String): AgendaInput =
            view(AgendaHomeEvent(search_term = AgendaHomeEvent.SearchTermChanged(term = text)))

        fun step(days: Int): AgendaInput =
            view(AgendaHomeEvent(day_stepped = AgendaHomeEvent.DayStepped(days = days)))

        fun today(): AgendaInput = view(AgendaHomeEvent(today = AgendaHomeEvent.TodayRequested()))

        data class Driven(val state: AgendaHome, val effects: List<ScreenEffect>)

        fun drive(state: AgendaHome, vararg inputs: AgendaInput): Driven {
            var current = state
            var effects = emptyList<ScreenEffect>()
            inputs.forEach { input ->
                val step = AgendaHomeMachine.reduce(current, input)
                current = step.state
                effects = step.effects
            }
            return Driven(current, effects)
        }

        fun answer(state: AgendaHome, upcoming: AgendaUpcoming, context: AgendaDayContext): AgendaHome =
            drive(state, AgendaInput.Answered(upcoming, context, null)).state

        /** Opened on [destination] and answered with [upcoming] and [context]. */
        fun landed(
            destination: AgendaHomeState.Destination,
            upcoming: AgendaUpcoming = upcoming(),
            context: AgendaDayContext = context(),
        ): AgendaHome = answer(
            drive(AgendaHomeMachine.initial(), view(opened(destination))).state,
            upcoming,
            context,
        )

        fun upcoming(vararg events: AgendaEvent): AgendaUpcoming = AgendaUpcoming(
            events = events.toList(),
            calendars = listOf(
                AgendaCalendar(calendar_id = "cal-1", name = "Personal", color = "var(--c-teal)"),
                AgendaCalendar(calendar_id = "cal-2", name = "Work", color = "steelblue"),
            ),
            today = TODAY,
            now_local = NOW,
        )

        fun context(
            birthdays: List<AgendaBirthday> = emptyList(),
            due: List<AgendaDueDay> = emptyList(),
            today: String = TODAY,
        ): AgendaDayContext = AgendaDayContext(birthdays = birthdays, due = due, today = today, now_local = NOW)

        /** A timed occurrence as the core places it: its local days, end exclusive. */
        fun timed(
            id: String,
            summary: String,
            start: String,
            end: String? = null,
            calendar: String = "cal-1",
        ): AgendaEvent {
            val first = start.take(10)
            val last = when {
                end == null -> first
                end.drop(11) == "00:00" -> plusDays(end.take(10), -1)!!
                else -> end.take(10)
            }
            return AgendaEvent(
                event_id = id,
                instance_key = id,
                summary = summary,
                calendar_id = calendar,
                local_start = start,
                local_end = end ?: "",
                local_days = generateSequence(first) { plusDays(it, 1)?.takeIf { next -> next <= last } }.toList(),
            )
        }

        fun allDay(id: String, summary: String, first: String, last: String = first): AgendaEvent = AgendaEvent(
            event_id = id,
            instance_key = id,
            summary = summary,
            calendar_id = "cal-1",
            recurrence_semantics = "all-day",
            all_day = true,
            local_start = first,
            local_end = last,
            local_days = generateSequence(first) { plusDays(it, 1)?.takeIf { next -> next <= last } }.toList(),
        )

        fun you(partstat: String): AgendaAttendee =
            AgendaAttendee(party_id = "pty-me", name = "You", partstat = partstat, is_you = true)

        fun rows(section: centraid.screen.v1.AgendaDaySection): List<AgendaEventRow> =
            section.items.mapNotNull { it.event }

        fun AppQueryRequest.kind(): String = when {
            agenda_upcoming != null -> "upcoming"
            agenda_day_context != null -> "context"
            agenda_search != null -> "search"
            else -> "other"
        }
    }
}
