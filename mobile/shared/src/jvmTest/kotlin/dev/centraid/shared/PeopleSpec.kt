package dev.centraid.shared

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandStatus
import centraid.core.v1.PeopleCard
import centraid.core.v1.PeopleChannel
import centraid.core.v1.PeopleDate
import centraid.core.v1.PeopleNote
import centraid.core.v1.PeoplePerson
import centraid.core.v1.PeopleRoster
import centraid.core.v1.PeopleRosterFilter
import centraid.core.v1.PeopleRosterRow
import centraid.core.v1.PeopleRosterSort
import centraid.core.v1.PeopleSearch
import centraid.core.v1.PeopleSheet
import centraid.core.v1.PeopleTouch
import centraid.core.v1.PeopleTouchEntry
import centraid.core.v1.PeopleTrash
import centraid.core.v1.PeopleTrashRow
import centraid.core.v1.PeopleUpcoming
import centraid.screen.v1.Autosave
import centraid.screen.v1.PeopleChannelIntent
import centraid.screen.v1.PeopleChipKey
import centraid.screen.v1.PeopleEditorEvent
import centraid.screen.v1.PeopleEditorState
import centraid.screen.v1.PeopleHomeEvent
import centraid.screen.v1.PeopleHomeState
import centraid.screen.v1.PeopleOrder
import centraid.screen.v1.PeoplePersonEvent
import centraid.screen.v1.PeoplePersonState
import centraid.screen.v1.StatusChip
import centraid.screen.v1.TrashListEvent
import centraid.screen.v1.TrashListState
import dev.centraid.design.copy.PeopleCopy
import dev.centraid.design.copy.SharedCopy
import dev.centraid.shared.apps.people.PeopleEditorMachine
import dev.centraid.shared.apps.people.PeopleEditorReads
import dev.centraid.shared.apps.people.PeopleHomeMachine
import dev.centraid.shared.apps.people.PeopleHomeReads
import dev.centraid.shared.apps.people.PeoplePersonMachine
import dev.centraid.shared.apps.people.PeoplePersonReads
import dev.centraid.shared.apps.people.PeopleTrashMachine
import dev.centraid.shared.apps.people.PeopleTrashReads
import dev.centraid.shared.apps.people.PeopleWords
import dev.centraid.shared.kit.AutosaveLaw
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavStack
import dev.centraid.shared.nav.withPeopleDestination
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import java.io.File

/**
 * PEOPLE ON THE PHONE (#1029 app port), from the core's typed answers to what
 * a view draws. Every fixture is a `people.proto` answer as the core gives it
 * — `today`, `in_days` and `days_since_contact` already computed — so what is
 * pinned is the shell's half: which query, what the rows say, which write.
 */
class PeopleSpec : StringSpec({

    val clock = DeviceClock.Reading(zone = "Europe/London", epochMillis = 1_781_516_520_000L)

    fun <S, E> run(machine: ScreenMachine<S, E>, state: S, vararg events: E): Step<S> =
        events.fold(Step(state)) { step, event -> machine.reduce(step.state, event).let { Step(it.state, it.effects) } }

    fun home(vararg events: PeopleHomeEvent): Step<PeopleHomeState> =
        run(PeopleHomeMachine, PeopleHomeMachine.initial(), *events)

    fun opened(dest: PeopleHomeState.Destination = PeopleHomeState.Destination.DESTINATION_PEOPLE) =
        PeopleHomeEvent(opened = PeopleHomeEvent.Opened(destination = dest))

    fun roster(vararg rows: PeopleRosterRow, all: Int = rows.size, due: Int = 0, starred: Int = 0) =
        PeopleHomeReads.arrived(
            listOf(
                AppQueryResponse(
                    people_roster = PeopleRoster(
                        people = rows.toList(),
                        today = TODAY,
                        count_all = all,
                        count_due = due,
                        count_starred = starred,
                        window = 10_000,
                    ),
                ),
            ),
        )

    fun person(id: String, name: String, vararg more: (PeopleRosterRow) -> PeopleRosterRow) =
        more.fold(
            PeopleRosterRow(
                party_id = id,
                name = name,
                created_at = "2026-06-01T09:00:00.000Z",
                days_since_contact = 14,
            ),
        ) { row, f -> f(row) }

    fun settled(key: String, committed: Boolean, sentence: String = "") =
        WriteLaw.settledOf(
            if (committed) CommandStatus.COMMAND_STATUS_EXECUTED else CommandStatus.COMMAND_STATUS_FAILED,
            sentence,
            key,
        )

    // --- Home: roster ----------------------------------------------------

    "opening reads the roster by its chip and order, over the whole window, in the device's zone" {
        val step = home(opened())
        step.effects shouldBe listOf(ScreenEffect.ReadPage("people.home", null))
        step.state.loading.shouldNotBeNull()
        val asked = PeopleHomeReads.requests(step.state, clock).single().people_roster.shouldNotBeNull()
        asked.filter shouldBe PeopleRosterFilter.PEOPLE_ROSTER_FILTER_ALL
        asked.sort shouldBe PeopleRosterSort.PEOPLE_ROSTER_SORT_RECENT
        asked.limit shouldBe 0
        asked.tz shouldBe "Europe/London"
        // The band: People, Touch, More — and the one on screen is current.
        step.state.band.map { it.key } shouldBe listOf("people", "touch", "more")
        step.state.band.single { it.current }.key shouldBe "people"
    }

    "a chip and an order are the READ's, and the counts stay the window's" {
        val landed = home(opened(), roster(person("p1", "Dana Reyes"), person("p2", "Sam"), all = 2, due = 1, starred = 1))
        val data = landed.state.data_.shouldNotBeNull().roster.shouldNotBeNull()
        data.chips.map { it.label to it.count } shouldBe listOf("All" to 2, "Starred" to 1, "Overdue" to 1)
        data.chips.single { it.selected }.key shouldBe PeopleChipKey.PEOPLE_CHIP_KEY_ALL
        data.status_line shouldBe "2 people · 1 to reconnect · 1 starred"

        val starred = PeopleHomeMachine.reduce(landed.state, PeopleHomeEvent(chip = PeopleHomeEvent.ChipPicked(chip = PeopleChipKey.PEOPLE_CHIP_KEY_STARRED)))
        starred.effects shouldBe listOf(ScreenEffect.ReadPage("people.home", null))
        // Skeletons: one chip's rows are never drawn under another's.
        starred.state.data_.shouldBeNull()
        PeopleHomeReads.requests(starred.state, clock).single().people_roster.shouldNotBeNull().filter shouldBe
            PeopleRosterFilter.PEOPLE_ROSTER_FILTER_STARRED
        // The same chip again is nothing.
        PeopleHomeMachine.reduce(starred.state, PeopleHomeEvent(chip = PeopleHomeEvent.ChipPicked(chip = PeopleChipKey.PEOPLE_CHIP_KEY_STARRED)))
            .effects.shouldBeEmpty()

        val byName = PeopleHomeMachine.reduce(landed.state, PeopleHomeEvent(order = PeopleHomeEvent.OrderPicked(order = PeopleOrder.PEOPLE_ORDER_NAME)))
        byName.state.sheet shouldBe PeopleHomeState.Sheet.SHEET_NONE
        byName.state.order_choices.single { it.selected }.label shouldBe "Name"
        PeopleHomeReads.requests(byName.state, clock).single().people_roster.shouldNotBeNull().sort shouldBe
            PeopleRosterSort.PEOPLE_ROSTER_SORT_NAME
    }

    "a roster row says who, when last in touch, overdue and the next reminder — as finished words" {
        val row = home(
            opened(),
            roster(
                person("p1", "Dana Reyes", { it.copy(role = "Designer", due = true, last_contacted_at = "2026-06-01T09:00:00.000Z", days_since_contact = 14, avatar_color = "var(--c-teal)") }, {
                    it.copy(
                        reminders = listOf(
                            PeopleDate(date_id = "d2", label = "Anniversary", month_day = "09-01", reminder_on = true, in_days = 78),
                            PeopleDate(date_id = "d1", label = "Birthday", month_day = "06-18", reminder_on = true, in_days = 3),
                        ),
                    )
                }),
                due = 1,
            ),
        ).state.data_.shouldNotBeNull().roster.shouldNotBeNull().rows.single()
        row.avatar.shouldNotBeNull().initials shouldBe "DR"
        // A HUE KEY, never the stored `var()` (the v0 merge-screen defect).
        row.avatar.shouldNotBeNull().hue_key shouldBe "cTeal"
        row.meta shouldBe "Last touch 14 days ago"
        row.chips.map { it.label to it.tone } shouldBe listOf(
            "Overdue" to StatusChip.Tone.TONE_NET,
            "Birthday · in 3 days" to StatusChip.Tone.TONE_NEUTRAL,
        )
        row.due shouldBe true
        row.star_label shouldBe "Star Dana Reyes"
        row.accessibility_label shouldBe "Dana Reyes, overdue"
    }

    "the star is a write from the row, drawn at once, and a refusal puts the vault's star back" {
        val landed = home(opened(), roster(person("p1", "Dana"))).state
        val asked = PeopleHomeMachine.reduce(landed, PeopleHomeEvent(star = PeopleHomeEvent.StarToggled(party_id = "p1")))
        val write = asked.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "people.star_person"
        write.inputJson shouldBe """{"party_id":"p1"}"""
        write.invokeKey shouldBe "people.star_person:p1"
        val drawn = asked.state.data_.shouldNotBeNull().roster.shouldNotBeNull().rows.single()
        drawn.starred shouldBe true
        drawn.star_pending shouldBe true
        drawn.star_label shouldBe "Remove star from Dana"

        val refused = PeopleHomeMachine.reduce(asked.state, PeopleHomeEvent(write_settled = settled(write.invokeKey, false, "The vault refused that.")))
        refused.state.data_.shouldNotBeNull().roster.shouldNotBeNull().rows.single().starred shouldBe false
        refused.state.status shouldBe "The vault refused that."

        val committed = PeopleHomeMachine.reduce(asked.state, PeopleHomeEvent(write_settled = settled(write.invokeKey, true)))
        committed.state.status shouldBe "Dana starred"
        // Kept until the vault's own answer, so the star does not flicker back.
        committed.state.data_.shouldNotBeNull().roster.shouldNotBeNull().rows.single().starred shouldBe true
    }

    "day one is its own empty with one action; a chip with nobody says so in one sentence" {
        val dayOne = home(opened(), roster(all = 0)).state.data_.shouldNotBeNull().roster.shouldNotBeNull()
        val empty = dayOne.empty.shouldNotBeNull()
        empty.headline shouldBe "Add the people you keep up with"
        empty.action_label shouldBe "Add person"

        val onStarred = home(
            opened(),
            roster(person("p1", "Dana"), all = 1),
            PeopleHomeEvent(chip = PeopleHomeEvent.ChipPicked(chip = PeopleChipKey.PEOPLE_CHIP_KEY_STARRED)),
            roster(all = 1),
        ).state.data_.shouldNotBeNull().roster.shouldNotBeNull()
        onStarred.empty.shouldNotBeNull().headline shouldBe "Nobody is starred."
        onStarred.empty.shouldNotBeNull().action_label shouldBe ""
    }

    "one read in flight: an answer to an older question is dropped and the newer one asked" {
        val first = home(opened())
        val chip = PeopleHomeMachine.reduce(first.state, PeopleHomeEvent(chip = PeopleHomeEvent.ChipPicked(chip = PeopleChipKey.PEOPLE_CHIP_KEY_DUE)))
        chip.effects.shouldBeEmpty()
        chip.state.read_queued shouldBe true
        val stale = PeopleHomeMachine.reduce(chip.state, roster(person("p1", "Dana")))
        stale.effects shouldBe listOf(ScreenEffect.ReadPage("people.home", null))
        stale.state.data_.shouldBeNull()
    }

    "a failed read is not an empty roster, and a denied read is the gate with no band" {
        val refused = home(opened(), PeopleHomeReads.refused(dev.centraid.shared.screen.Reads.refused("Out of reach."))).state
        refused.failure.shouldNotBeNull().sentence shouldBe "Out of reach."
        refused.data_.shouldBeNull()

        val denied = home(opened(), PeopleHomeReads.denied(AppQueryDenial(message = "No grant for people."))).state
        denied.denied.shouldNotBeNull().title shouldBe PeopleCopy.DENIED_TITLE
        denied.denied.shouldNotBeNull().receipt shouldBe "No grant for people."
        denied.band.shouldBeEmpty()
    }

    "a change to a table the answers are folded from re-reads; any other table is not ours" {
        PeopleHomeMachine.TABLES.forEach { table ->
            withClue(table) { PeopleHomeMachine.rowsChanged(table, listOf("k")).shouldNotBeNull() }
        }
        PeopleHomeMachine.rowsChanged("tally_expense", listOf("k")).shouldBeNull()
        val landed = home(opened(), roster(person("p1", "Dana"))).state
        val moved = PeopleHomeMachine.reduce(landed, PeopleHomeMachine.rowsChanged("core_tag", listOf("t"))!!)
        moved.effects shouldBe listOf(ScreenEffect.ReadPage("people.home", null))
        // The rows stay while the re-read is out.
        moved.state.data_.shouldNotBeNull()
    }

    // --- Home: search ----------------------------------------------------

    "search is a field over the surface: names only, the surface kept, and closing clears the term" {
        val landed = home(opened(), roster(person("p1", "Dana"))).state
        val typed = run(
            PeopleHomeMachine,
            landed,
            PeopleHomeEvent(search_opened = PeopleHomeEvent.SearchOpened()),
            PeopleHomeEvent(search_term = PeopleHomeEvent.SearchTermChanged(term = "sa")),
        )
        typed.effects shouldBe listOf(ScreenEffect.ReadPage("people.home", null))
        val asked = PeopleHomeReads.requests(typed.state, clock).single()
        asked.people_search.shouldNotBeNull().term shouldBe "sa"
        asked.people_roster.shouldBeNull()

        val none = PeopleHomeMachine.reduce(
            typed.state,
            PeopleHomeReads.arrived(listOf(AppQueryResponse(people_search = PeopleSearch()))),
        ).state
        none.search_data.shouldNotBeNull().empty.shouldNotBeNull().headline shouldBe "Nothing matches."
        none.search_data.shouldNotBeNull().term shouldBe "sa"
        none.search.shouldNotBeNull().answered_term shouldBe "sa"
        // THE SURFACE UNDER IT STANDS.
        none.data_.shouldNotBeNull().roster.shouldNotBeNull().rows.size shouldBe 1

        val closed = PeopleHomeMachine.reduce(none, PeopleHomeEvent(search_closed = PeopleHomeEvent.SearchClosed()))
        closed.effects.shouldBeEmpty()
        closed.state.search.shouldNotBeNull().term shouldBe ""
        closed.state.search_data.shouldBeNull()
    }

    // --- Home: Touch -----------------------------------------------------

    "Touch: tiles, Reconnect with days over and a Log a touch action, Upcoming nearest first, Recent in words" {
        val answer = PeopleTouch(
            reconnect = listOf(
                PeopleCard(party_id = "p2", name = "Sam", days_over = 9),
                PeopleCard(party_id = "p1", name = "Dana", days_over = 1),
            ),
            upcoming = listOf(
                PeopleUpcoming(
                    person = PeopleCard(party_id = "p1", name = "Dana"),
                    date = PeopleDate(date_id = "d1", label = "Birthday", month_day = "06-15", in_days = 0),
                ),
                PeopleUpcoming(
                    person = PeopleCard(party_id = "p3", name = "Ana"),
                    date = PeopleDate(date_id = "d3", label = "Anniversary", month_day = "06-27", in_days = 12),
                ),
            ),
            recent = listOf(
                PeopleTouchEntry(interaction_id = "i1", party_id = "p1", kind = "visit", name = "Dana", occurred_at = "2026-06-14T18:00:00.000Z", occurred_local_day = "2026-06-14"),
            ),
            count_all = 3,
            count_reconnect = 2,
            count_upcoming = 2,
            count_starred = 0,
            today = TODAY,
        )
        val state = home(
            opened(PeopleHomeState.Destination.DESTINATION_TOUCH),
            PeopleHomeReads.arrived(listOf(AppQueryResponse(people_touch = answer))),
        ).state
        PeopleHomeReads.requests(home(opened(PeopleHomeState.Destination.DESTINATION_TOUCH)).state, clock)
            .single().people_touch.shouldNotBeNull().tz shouldBe "Europe/London"
        val touch = state.data_.shouldNotBeNull().touch.shouldNotBeNull()
        touch.tiles.map { Triple(it.label, it.count, it.tappable) } shouldBe listOf(
            Triple("People", 3, true),
            Triple("Reconnect", 2, true),
            // A FIGURE, NOT A DEAD CONTROL (v0's Upcoming tile did nothing).
            Triple("Upcoming", 2, false),
            Triple("Starred", 0, true),
        )
        touch.tiles.single { it.key == "reconnect" }.net shouldBe true
        touch.reconnect.map { it.name to it.detail } shouldBe listOf("Sam" to "9 days over", "Dana" to "1 day over")
        touch.reconnect.first().action_label shouldBe "Log a touch"
        touch.reconnect_head.shouldNotBeNull().count shouldBe 2
        touch.upcoming.map { Triple(it.label, it.when_label, it.day_label) } shouldBe listOf(
            Triple("Birthday", "Today", "15 June"),
            Triple("Anniversary", "In 12 days", "27 June"),
        )
        // BOTH SPELLINGS OF A KIND are one noun: `visit` is "Met up".
        touch.recent.single().kind_label shouldBe "Met up"
        touch.recent.single().when_label shouldBe "Yesterday"
        touch.recent_empty shouldBe ""
        touch.status_line shouldBe "3 people · 2 overdue"

        // A tile lands on People under its chip.
        val tile = PeopleHomeMachine.reduce(state, PeopleHomeEvent(tile = PeopleHomeEvent.TilePicked(key = "reconnect")))
        tile.state.destination shouldBe PeopleHomeState.Destination.DESTINATION_PEOPLE
        tile.state.chip shouldBe PeopleChipKey.PEOPLE_CHIP_KEY_DUE
        PeopleHomeMachine.reduce(state, PeopleHomeEvent(tile = PeopleHomeEvent.TilePicked(key = "upcoming"))).effects.shouldBeEmpty()

        // The band: the same tab is nothing; More is a sheet, never a destination.
        PeopleHomeMachine.reduce(state, PeopleHomeEvent(band = PeopleHomeEvent.BandPicked(key = "touch"))).effects.shouldBeEmpty()
        val more = PeopleHomeMachine.reduce(state, PeopleHomeEvent(band = PeopleHomeEvent.BandPicked(key = "more"))).state
        more.sheet shouldBe PeopleHomeState.Sheet.SHEET_MORE
        more.destination shouldBe PeopleHomeState.Destination.DESTINATION_TOUCH
    }

    "Touch on an empty vault is day one, and each empty rail says one sentence" {
        val touch = home(
            opened(PeopleHomeState.Destination.DESTINATION_TOUCH),
            PeopleHomeReads.arrived(listOf(AppQueryResponse(people_touch = PeopleTouch(today = TODAY)))),
        ).state.data_.shouldNotBeNull().touch.shouldNotBeNull()
        touch.empty.shouldNotBeNull().action_label shouldBe "Add person"
        touch.reconnect_empty shouldBe "Nobody is overdue."
        touch.upcoming_empty shouldBe "No dates coming up."
        touch.recent_empty shouldBe "Nothing logged yet."
    }

    // --- Person ------------------------------------------------------------

    fun sheet(touchesKnown: Boolean = true) = PeoplePerson(
        today = TODAY,
        sheet = PeopleSheet(
            person = person("p1", "Dana Reyes", { it.copy(role = "Designer", cadence_days = 14, last_contacted_at = "2026-06-12T10:00:00.000Z", days_since_contact = 3) }),
            nickname = "Dee",
            met = "",
            channels = listOf(
                PeopleChannel(channel_id = "c1", kind = "phone", value_ = "+44 20 7946 0000", preferred = true, duplicate_names = listOf("Sam")),
                PeopleChannel(channel_id = "c2", kind = "email", value_ = "dana@example.com"),
            ),
            dates = listOf(PeopleDate(date_id = "d1", label = "Birthday", month_day = "08-14", reminder_on = true, in_days = 60)),
            notes = listOf(PeopleNote(annotation_id = "n1", text = "Loves ceramics", created_at = "2026-06-15T08:00:00.000Z", created_local_day = "2026-06-15")),
            touches_known = touchesKnown,
            touches = listOf(PeopleTouchEntry(interaction_id = "i1", kind = "call", text = "Caught up", occurred_at = "2026-06-12T10:00:00.000Z", occurred_local_day = "2026-06-12")),
        ),
    )

    fun personOpened(logTouch: Boolean = false): Step<PeoplePersonState> = run(
        PeoplePersonMachine,
        PeoplePersonMachine.initial(),
        PeoplePersonEvent(opened = PeoplePersonEvent.Opened(party_id = "p1", name = "Dana Reyes", log_touch = logTouch)),
        PeoplePersonReads.arrived(listOf(AppQueryResponse(people_person = sheet()))),
    )

    "the person sheet folds the answer: header, facts, channels with intents, dates, notes and the touch log" {
        val asked = PeoplePersonReads.requests(
            PeoplePersonMachine.reduce(
                PeoplePersonMachine.initial(),
                PeoplePersonEvent(opened = PeoplePersonEvent.Opened(party_id = "p1")),
            ).state,
            clock,
        ).shouldNotBeNull().single().people_person.shouldNotBeNull()
        asked.party_id shouldBe "p1"
        asked.tz shouldBe "Europe/London"

        val data = personOpened().state.data_.shouldNotBeNull()
        data.cadence_line shouldBe "Every 14 days · last touch 3 days ago"
        data.facts.map { it.label to it.value_ } shouldBe listOf("Nickname" to "Dee")
        data.channels.map { Triple(it.kind_label, it.intent, it.action_label) } shouldBe listOf(
            Triple("Phone", PeopleChannelIntent.PEOPLE_CHANNEL_INTENT_CALL, "Call"),
            Triple("Email", PeopleChannelIntent.PEOPLE_CHANNEL_INTENT_MAIL, "Email"),
        )
        data.channels.first().preferred_label shouldBe "preferred"
        data.channels.first().duplicate_note shouldBe "Also on Sam's card"
        data.channels.first().remove_label shouldBe "Remove this phone"
        data.dates.single().day_label shouldBe "14 August"
        data.dates.single().when_label shouldBe "In 60 days"
        data.dates.single().reminder_label shouldBe "Reminder on"
        data.notes.single().when_label shouldBe "Today"
        // THE LOG v0 NEVER SHOWED.
        data.touches.single().kind_label shouldBe "Call"
        data.touches_head.shouldNotBeNull().count shouldBe 1
    }

    "an unreadable touch log is said, not drawn as nothing; a person who is not there is gone, not an error" {
        val unknown = run(
            PeoplePersonMachine,
            PeoplePersonMachine.initial(),
            PeoplePersonEvent(opened = PeoplePersonEvent.Opened(party_id = "p1")),
            PeoplePersonReads.arrived(listOf(AppQueryResponse(people_person = sheet(touchesKnown = false)))),
        ).state.data_.shouldNotBeNull()
        unknown.touches.shouldBeEmpty()
        unknown.touches_empty shouldBe "The touch log could not be read."
        unknown.touches_head.shouldNotBeNull().count.shouldBeNull()

        val gone = run(
            PeoplePersonMachine,
            PeoplePersonMachine.initial(),
            PeoplePersonEvent(opened = PeoplePersonEvent.Opened(party_id = "p9")),
            PeoplePersonReads.arrived(listOf(AppQueryResponse(people_person = PeoplePerson(today = TODAY)))),
        ).state
        gone.gone.shouldNotBeNull().action_label shouldBe "Back"
        gone.failure.shouldBeNull()
    }

    "log a touch is a write sheet: kind and note, one command, and a refusal keeps the words" {
        // Touch's card opens the person with the sheet already up.
        val opened = personOpened(logTouch = true).state
        val log = opened.sheet.shouldNotBeNull().log_touch.shouldNotBeNull()
        log.kinds.map { it.label } shouldBe listOf("Message", "Call", "Met up", "Note")
        log.hint shouldBe "Logging stamps last contacted."
        log.frame.shouldNotBeNull().submit_enabled shouldBe true

        val sent = run(
            PeoplePersonMachine,
            opened,
            PeoplePersonEvent(kind_picked = PeoplePersonEvent.KindPicked(key = "met up")),
            PeoplePersonEvent(text = PeoplePersonEvent.TextChanged(text = "Coffee in town")),
            PeoplePersonEvent(submitted = PeoplePersonEvent.SheetSubmitted()),
        )
        val write = sent.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "people.log_interaction"
        write.inputJson shouldBe """{"party_id":"p1","kind":"met up","text":"Coffee in town"}"""
        sent.state.sheet.shouldNotBeNull().log_touch.shouldNotBeNull().frame.shouldNotBeNull().sending shouldBe true

        val refused = PeoplePersonMachine.reduce(sent.state, PeoplePersonEvent(write_settled = settled(write.invokeKey, false, "That person is in the trash."))).state
        val kept = refused.sheet.shouldNotBeNull().log_touch.shouldNotBeNull()
        kept.note shouldBe "Coffee in town"
        kept.frame.shouldNotBeNull().failure.shouldNotBeNull().sentence shouldBe "That person is in the trash."
        kept.frame.shouldNotBeNull().sending shouldBe false

        val committed = PeoplePersonMachine.reduce(sent.state, PeoplePersonEvent(write_settled = settled(write.invokeKey, true))).state
        committed.sheet.shouldBeNull()
        committed.status shouldBe "Met up logged · Dana Reyes"
    }

    "a date's month and day are checked before the write: 13-45 is not a day" {
        val typed = run(
            PeoplePersonMachine,
            personOpened().state,
            PeoplePersonEvent(sheet_opened = PeoplePersonEvent.SheetOpened(which = PeoplePersonEvent.SheetOpened.Which.WHICH_DATE)),
            PeoplePersonEvent(text = PeoplePersonEvent.TextChanged(text = "Birthday")),
            PeoplePersonEvent(second_text = PeoplePersonEvent.SecondTextChanged(text = "13-45")),
        ).state
        val date = typed.sheet.shouldNotBeNull().date.shouldNotBeNull()
        date.month_day_invalid shouldBe PeopleCopy.DATE_INVALID
        date.frame.shouldNotBeNull().submit_enabled shouldBe false
        PeoplePersonMachine.reduce(typed, PeoplePersonEvent(submitted = PeoplePersonEvent.SheetSubmitted())).effects.shouldBeEmpty()

        val fixed = PeoplePersonMachine.reduce(typed, PeoplePersonEvent(second_text = PeoplePersonEvent.SecondTextChanged(text = "02-29")))
        fixed.state.sheet.shouldNotBeNull().date.shouldNotBeNull().frame.shouldNotBeNull().submit_enabled shouldBe true
        val write = PeoplePersonMachine.reduce(fixed.state, PeoplePersonEvent(submitted = PeoplePersonEvent.SheetSubmitted())).effects.single() as ScreenEffect.SubmitWrite
        write.inputJson shouldBe """{"party_id":"p1","label":"Birthday","month_day":"02-29","reminder_on":true}"""
    }

    "move to trash and remove a channel are asked first in full sentences; the trash commit pops the screen" {
        val asked = PeoplePersonMachine.reduce(personOpened().state, PeoplePersonEvent(trash_tapped = PeoplePersonEvent.TrashTapped())).state
        val confirm = asked.confirm.shouldNotBeNull()
        confirm.title shouldBe "Move Dana Reyes to trash?"
        confirm.body shouldBe "Restorable for 30 days."
        confirm.destructive shouldBe true
        val sent = PeoplePersonMachine.reduce(asked, PeoplePersonEvent(confirmed = PeoplePersonEvent.Confirmed()))
        val write = sent.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "people.trash_person"
        sent.state.confirm.shouldBeNull()
        val done = PeoplePersonMachine.reduce(sent.state, PeoplePersonEvent(write_settled = settled(write.invokeKey, true))).state
        done.done shouldBe true
        done.status shouldBe "Dana Reyes moved to trash"

        val channel = PeoplePersonMachine.reduce(personOpened().state, PeoplePersonEvent(remove_channel = PeoplePersonEvent.RemoveChannelTapped(channel_id = "c2"))).state
        channel.confirm.shouldNotBeNull().title shouldBe "Remove this email?"
        PeoplePersonMachine.reduce(channel, PeoplePersonEvent(dismissed = PeoplePersonEvent.Dismissed())).state.confirm.shouldBeNull()
    }

    "merge is a choices sheet from the roster, without the person themselves, then a confirm, then core.merge_party" {
        val opened = PeoplePersonMachine.reduce(
            personOpened().state,
            PeoplePersonEvent(sheet_opened = PeoplePersonEvent.SheetOpened(which = PeoplePersonEvent.SheetOpened.Which.WHICH_MERGE)),
        )
        opened.effects shouldBe listOf(ScreenEffect.ReadPage("people.person", null))
        opened.state.sheet.shouldNotBeNull().merge.shouldNotBeNull().loading.shouldNotBeNull()
        val asks = PeoplePersonReads.requests(opened.state, clock).shouldNotBeNull()
        asks.mapNotNull { it.people_roster }.single().sort shouldBe PeopleRosterSort.PEOPLE_ROSTER_SORT_NAME

        val choices = PeoplePersonMachine.reduce(
            opened.state,
            PeoplePersonReads.arrived(
                listOf(
                    AppQueryResponse(people_person = sheet()),
                    AppQueryResponse(
                        people_roster = PeopleRoster(
                            people = listOf(person("p1", "Dana Reyes"), person("p2", "Dana R", { it.copy(avatar_color = "var(--c-rose)") })),
                        ),
                    ),
                ),
            ),
        ).state
        val merge = choices.sheet.shouldNotBeNull().merge.shouldNotBeNull()
        merge.title shouldBe "Merge in"
        merge.choices.shouldNotBeNull().choices.map { it.party_id } shouldBe listOf("p2")
        merge.choices.shouldNotBeNull().choices.single().avatar.shouldNotBeNull().hue_key shouldBe "cRose"

        val confirm = PeoplePersonMachine.reduce(choices, PeoplePersonEvent(merge_picked = PeoplePersonEvent.MergePicked(party_id = "p2"))).state
        confirm.sheet.shouldBeNull()
        confirm.confirm.shouldNotBeNull().title shouldBe "Merge Dana R into Dana Reyes?"
        confirm.confirm.shouldNotBeNull().body shouldBe "Merging cannot be undone."
        val sent = PeoplePersonMachine.reduce(confirm, PeoplePersonEvent(confirmed = PeoplePersonEvent.Confirmed()))
        val write = sent.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "core.merge_party"
        write.inputJson shouldBe """{"survivor_party_id":"p1","merged_party_id":"p2"}"""
        PeoplePersonMachine.reduce(sent.state, PeoplePersonEvent(write_settled = settled(write.invokeKey, true))).state.status shouldBe
            "Dana R merged into Dana Reyes"

        // Nobody else: the sheet says so.
        val alone = PeoplePersonMachine.reduce(
            opened.state,
            PeoplePersonReads.arrived(listOf(AppQueryResponse(people_person = sheet()), AppQueryResponse(people_roster = PeopleRoster(people = listOf(person("p1", "Dana Reyes")))))),
        ).state
        alone.sheet.shouldNotBeNull().merge.shouldNotBeNull().choices.shouldNotBeNull().empty.shouldNotBeNull().headline shouldBe "Nobody to merge in."
    }

    "the person re-reads on its tables, channels and notes included" {
        PeoplePersonMachine.TABLES.forEach { table ->
            withClue(table) { PeoplePersonMachine.rowsChanged(table, emptyList()).shouldNotBeNull() }
        }
        val moved = PeoplePersonMachine.reduce(personOpened().state, PeoplePersonMachine.rowsChanged("knowledge_annotation", listOf("n2"))!!)
        moved.effects shouldBe listOf(ScreenEffect.ReadPage("people.person", null))
    }

    // --- Editor ------------------------------------------------------------

    "the editor autosaves only what changed, under one key per edit, and close = done" {
        val opened = run(
            PeopleEditorMachine,
            PeopleEditorMachine.initial(),
            PeopleEditorEvent(opened = PeopleEditorEvent.Opened(party_id = "p1")),
        )
        opened.effects shouldBe listOf(ScreenEffect.ReadPage("people.editor", null))
        val loaded = PeopleEditorMachine.reduce(
            opened.state,
            PeopleEditorReads.arrived(listOf(AppQueryResponse(people_person = sheet()))),
        ).state
        val draft = loaded.draft.shouldNotBeNull()
        draft.display_name shouldBe "Dana Reyes"
        draft.nickname shouldBe "Dee"
        loaded.chrome.shouldNotBeNull().title shouldBe "Edit person"
        loaded.chrome.shouldNotBeNull().close_label shouldBe "Done"
        loaded.cadences.single { it.selected }.label shouldBe "14 days"

        val typed = PeopleEditorMachine.reduce(loaded, PeopleEditorEvent(met = PeopleEditorEvent.MetChanged(text = "At the studio")))
        val tick = typed.effects.single() as ScreenEffect.Schedule
        tick.delayMs shouldBe AutosaveLaw.DEBOUNCE_MS
        val saved = PeopleEditorMachine.reduce(typed.state, PeopleEditorMachine.ticked(tick.token))
        val write = saved.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "people.edit_person"
        write.inputJson shouldBe """{"party_id":"p1","met":"At the studio"}"""
        write.invokeKey shouldBe "people.edit_person:p1:seq=1"
        saved.state.save_label shouldBe "Saving…"

        // Close before the tick: the words are saved now.
        val left = PeopleEditorMachine.reduce(typed.state, PeopleEditorMachine.left())
        (left.effects.single() as ScreenEffect.SubmitWrite).command shouldBe "people.edit_person"

        // A name cleared to nothing is refused here, and the words stay.
        val blank = run(
            PeopleEditorMachine,
            loaded,
            PeopleEditorEvent(name = PeopleEditorEvent.NameChanged(text = " ")),
            PeopleEditorMachine.left(),
        ).state
        blank.autosave.shouldNotBeNull().phase shouldBe Autosave.Phase.PHASE_REFUSED
        blank.save_label shouldBe "A person needs a name."
        blank.draft.shouldNotBeNull().display_name shouldBe " "
    }

    "the cadence is its own command, on the tap" {
        val loaded = run(
            PeopleEditorMachine,
            PeopleEditorMachine.initial(),
            PeopleEditorEvent(opened = PeopleEditorEvent.Opened(party_id = "p1")),
            PeopleEditorReads.arrived(listOf(AppQueryResponse(people_person = sheet()))),
        ).state
        val step = PeopleEditorMachine.reduce(loaded, PeopleEditorEvent(cadence = PeopleEditorEvent.CadencePicked(days = 30)))
        val write = step.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "people.set_cadence"
        write.inputJson shouldBe """{"party_id":"p1","cadence_days":30}"""
        step.state.cadences.single { it.selected }.days shouldBe 30L
        // It is not an autosaved field: nothing else is owed.
        step.state.autosave.shouldNotBeNull().phase shouldBe Autosave.Phase.PHASE_CLEAN
    }

    "a new person: Cancel before the first keystroke, add_person under the minted id first, edit_person after" {
        val opened = PeopleEditorMachine.reduce(
            PeopleEditorMachine.initial(),
            PeopleEditorEvent(opened = PeopleEditorEvent.Opened(minted_party_id = "new-1")),
        )
        opened.effects.shouldBeEmpty()
        PeopleEditorReads.requests(opened.state, clock).shouldBeNull()
        opened.state.chrome.shouldNotBeNull().title shouldBe "New person"
        opened.state.chrome.shouldNotBeNull().close_label shouldBe "Cancel"
        // Closing an untouched new person writes nothing.
        PeopleEditorMachine.reduce(opened.state, PeopleEditorMachine.left()).effects.shouldBeEmpty()

        val typed = run(
            PeopleEditorMachine,
            opened.state,
            PeopleEditorEvent(name = PeopleEditorEvent.NameChanged(text = "Ana")),
            PeopleEditorEvent(cadence = PeopleEditorEvent.CadencePicked(days = 7)),
            PeopleEditorEvent(met = PeopleEditorEvent.MetChanged(text = "School")),
        )
        typed.state.chrome.shouldNotBeNull().close_label shouldBe "Done"
        val add = PeopleEditorMachine.reduce(typed.state, PeopleEditorMachine.left())
        val write = add.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "people.add_person"
        write.inputJson shouldBe """{"party_id":"new-1","display_name":"Ana","cadence_days":7}"""

        // add_person takes no how-you-met: it is owed, and goes by edit_person.
        val created = PeopleEditorMachine.reduce(add.state, PeopleEditorEvent(write_settled = settled(write.invokeKey, true)))
        created.state.created shouldBe true
        val tick = created.effects.single() as ScreenEffect.Schedule
        val edit = PeopleEditorMachine.reduce(created.state, PeopleEditorMachine.ticked(tick.token)).effects.single() as ScreenEffect.SubmitWrite
        edit.command shouldBe "people.edit_person"
        edit.inputJson shouldBe """{"party_id":"new-1","met":"School"}"""
    }

    // --- Trash -------------------------------------------------------------

    "the trash is the kit's: restore, delete forever behind a confirm, and any profile change re-reads it" {
        val opened = PeopleTrashMachine.reduce(PeopleTrashMachine.initial(), TrashListEvent(opened = TrashListEvent.Opened()))
        opened.effects shouldBe listOf(ScreenEffect.ReadPage("people.trash", null))
        PeopleTrashReads.requests(opened.state, clock).single().people_trash.shouldNotBeNull()
        val landed = PeopleTrashMachine.reduce(
            opened.state,
            PeopleTrashReads.arrived(
                listOf(
                    AppQueryResponse(
                        people_trash = PeopleTrash(
                            people = listOf(PeopleTrashRow(party_id = "p1", name = "Dana", role = "Designer", purge_at = "2026-07-15T09:00:00.000Z")),
                        ),
                    ),
                ),
            ),
        ).state
        val data = landed.data_.shouldNotBeNull()
        data.rows.single().meta shouldBe "Designer · Erased Wed 15 July"
        // DELETE FOREVER is `people.purge_person`; there is no emptying.
        data.rows.single().purge_label shouldBe SharedCopy.TRASH_PURGE
        data.rows.single().restore_label shouldBe SharedCopy.TRASH_RESTORE
        data.empty_label shouldBe ""
        landed.title shouldBe SharedCopy.TRASH_TITLE
        landed.back_label shouldBe PeopleCopy.APP_TITLE
        val asked = PeopleTrashMachine.reduce(landed, TrashListEvent(purge = TrashListEvent.PurgeTapped(id = "p1"))).state
        asked.confirm.shouldNotBeNull().body shouldBe PeopleCopy.TRASH_PURGE_BODY
        val purged = PeopleTrashMachine.reduce(asked, TrashListEvent(confirmed = TrashListEvent.Confirmed()))
        (purged.effects.single() as ScreenEffect.SubmitWrite).let {
            it.command shouldBe "people.purge_person"
            it.inputJson shouldBe """{"party_id":"p1"}"""
        }
        val restore = PeopleTrashMachine.reduce(landed, TrashListEvent(restore = TrashListEvent.RestoreTapped(id = "p1")))
        val write = restore.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "people.restore_person"
        write.inputJson shouldBe """{"party_id":"p1"}"""
        // A profile's key is its profile_id, never a shown party id: re-read anyway.
        PeopleTrashMachine.reduce(landed, PeopleTrashMachine.rowsChanged("people_profile", listOf("prof-9"))!!)
            .effects shouldBe listOf(ScreenEffect.ReadPage("people.trash", null))
        val state: TrashListState = landed
        state.app_id shouldBe "people"
    }

    // --- The whole port ------------------------------------------------------

    "every command People submits exists in the vault's declared surface" {
        val root = File(System.getProperty("centraid.repositoryRoot") ?: error("unset"))
        val name = Regex("\"([a-z_]+\\.[a-z_]+)\"")
        val declared = root.resolve("crates/vault/src/commands").walkTopDown()
            .filter { it.isFile && it.extension == "rs" }
            .flatMap { file -> name.findAll(file.readText()).map { it.groupValues[1] } }
            .toSet()
        (PeoplePersonMachine.COMMANDS + listOf(
            PeopleEditorMachine.ADD_COMMAND,
            PeopleEditorMachine.EDIT_COMMAND,
            PeopleEditorMachine.CADENCE_COMMAND,
            "people.restore_person",
        )).forEach { command -> withClue(command) { declared.contains(command) shouldBe true } }
    }

    "no People word says gateway, vault link or share" {
        val words = PeopleCopy::class.java.declaredFields
            .filter { it.type == String::class.java }
            .map { it.isAccessible = true; it.get(null) as String }
        words.forEach { word ->
            withClue(word) {
                word.lowercase() shouldNotContain "gateway"
                word.lowercase() shouldNotContain "linked"
                word.lowercase() shouldNotContain "share"
            }
        }
        PeopleWords.fill(PeopleCopy.OUTCOME_LOGGED, "kind" to "Call", "name" to "Dana") shouldContain "Call logged"
    }

    "People's band changes in place on the stack" {
        val stack = NavStack().push(Destination.PeopleHome())
        stack.withPeopleDestination(PeopleHomeState.Destination.DESTINATION_TOUCH).entries.size shouldBe 2
        stack.withPeopleDestination(PeopleHomeState.Destination.DESTINATION_TOUCH).current shouldBe
            Destination.PeopleHome(PeopleHomeState.Destination.DESTINATION_TOUCH)
    }
}) {
    private companion object {
        const val TODAY: String = "2026-06-15"
    }
}
