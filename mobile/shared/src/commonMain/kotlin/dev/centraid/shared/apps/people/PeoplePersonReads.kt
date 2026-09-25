package dev.centraid.shared.apps.people

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandStatus
import centraid.core.v1.PeoplePersonRequest
import centraid.core.v1.PeopleRoster
import centraid.core.v1.PeopleRosterFilter
import centraid.core.v1.PeopleRosterRequest
import centraid.core.v1.PeopleRosterSort
import centraid.core.v1.PeopleSheet
import centraid.screen.v1.EmptyState
import centraid.screen.v1.PeopleChannelRow
import centraid.screen.v1.PeopleDateRow
import centraid.screen.v1.PeopleFact
import centraid.screen.v1.PeopleMergeChoice
import centraid.screen.v1.PeopleMergeChoices
import centraid.screen.v1.PeopleNoteRow
import centraid.screen.v1.PeoplePersonData
import centraid.screen.v1.PeoplePersonEvent
import centraid.screen.v1.PeoplePersonState
import centraid.screen.v1.PeopleTouchRow
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.SectionHead
import centraid.screen.v1.StatusChip
import dev.centraid.design.copy.PeopleCopy
import dev.centraid.shared.apps.people.PeopleWords.fill
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.sync.ScreenQueries
import dev.centraid.shared.sync.ScreenWrites

/**
 * WHAT ONE PERSON'S SHEET ASKS THE CORE (#1029 app port): `people.person`,
 * and — only while the merge sheet is waiting for its choices —
 * `people.roster` by name, the people who can be folded in.
 */
public object PeoplePersonReads :
    ScreenQueries<PeoplePersonState, PeoplePersonEvent>,
    ScreenWrites<PeoplePersonState, PeoplePersonEvent> {
    override val screenId: String = PeoplePersonMachine.SCREEN_ID

    override val tables: Set<String> = PeoplePersonMachine.TABLES

    override val appId: String = "people"

    override fun requests(state: PeoplePersonState, now: DeviceClock.Reading): List<AppQueryRequest>? {
        if (state.party_id.isEmpty()) return null
        return buildList {
            add(AppQueryRequest(people_person = PeoplePersonRequest(party_id = state.party_id, tz = now.zone)))
            if (state.merge_reading) {
                add(
                    AppQueryRequest(
                        people_roster = PeopleRosterRequest(
                            limit = 0,
                            filter = PeopleRosterFilter.PEOPLE_ROSTER_FILTER_ALL,
                            sort = PeopleRosterSort.PEOPLE_ROSTER_SORT_NAME,
                            tz = now.zone,
                        ),
                    ),
                )
            }
        }
    }

    override fun arrived(answers: List<AppQueryResponse>): PeoplePersonEvent {
        val person = answers.firstNotNullOfOrNull { it.people_person }
        val roster = answers.firstNotNullOfOrNull { it.people_roster }
        val sheet = person?.sheet
        return PeoplePersonEvent(
            data_ = PeoplePersonEvent.DataArrived(
                person = sheet?.let { PeopleSheetFold.person(it, person.today) },
                absent = person != null && sheet == null,
                merge = roster?.let(PeopleSheetFold::mergeChoices),
            ),
        )
    }

    override fun refused(failure: ReadFailure): PeoplePersonEvent =
        PeoplePersonEvent(refused = PeoplePersonEvent.ReadRefused(failure = failure))

    override fun denied(denial: AppQueryDenial): PeoplePersonEvent =
        PeoplePersonEvent(denied = PeopleFold.denied(denial))

    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): PeoplePersonEvent =
        PeoplePersonEvent(write_settled = WriteLaw.settledOf(status, sentence, invokeKey))
}

/** `people.person`'s answer as the sheet draws it. Pure; days are the core's. */
public object PeopleSheetFold {
    public fun person(sheet: PeopleSheet, today: String): PeoplePersonData {
        val person = sheet.person ?: centraid.core.v1.PeopleRosterRow()
        val lastTouch = PeopleWords.lastTouch(person.last_contacted_at != null, person.days_since_contact)
        return PeoplePersonData(
            party_id = person.party_id,
            name = person.name,
            avatar = PeopleWords.avatar(person.party_id, person.name, person.avatar_color),
            role = person.role,
            cadence_line = "${PeopleWords.cadence(person.cadence_days)} · ${lastTouch.replaceFirstChar { it.lowercase() }}",
            due_chip = if (person.due) StatusChip(label = PeopleCopy.CHIP_OVERDUE, tone = StatusChip.Tone.TONE_NET) else null,
            starred = person.starred,
            vault_starred = person.starred,
            star_label = if (person.starred) PeopleCopy.UNSTAR_VERB else PeopleCopy.STAR_VERB,
            facts = buildList {
                if (sheet.nickname.isNotBlank()) add(PeopleFact(label = PeopleCopy.FACT_NICKNAME, value_ = sheet.nickname))
                if (sheet.met.isNotBlank()) add(PeopleFact(label = PeopleCopy.FACT_MET, value_ = sheet.met))
            },
            channels_head = SectionHead(
                title = PeopleCopy.SECTION_CHANNELS,
                count = sheet.channels.size,
                verb_label = PeopleCopy.ADD_CHANNEL,
            ),
            channels = sheet.channels.map { channel ->
                val kind = PeopleWords.channelKind(channel.kind)
                val intent = PeopleWords.channelIntent(channel.kind)
                PeopleChannelRow(
                    channel_id = channel.channel_id,
                    kind_label = kind,
                    value_ = channel.value_,
                    label = channel.label ?: "",
                    preferred_label = if (channel.preferred) PeopleCopy.PREFERRED else "",
                    duplicate_note = if (channel.duplicate_names.isEmpty()) {
                        ""
                    } else {
                        fill(PeopleCopy.ALSO_ON, "names" to channel.duplicate_names.joinToString(", "))
                    },
                    intent = intent,
                    action_label = PeopleWords.channelAction(intent),
                    remove_label = fill(PeopleCopy.REMOVE_CHANNEL, "kind" to kind.lowercase()),
                    accessibility_label = fill(PeopleCopy.CHANNEL_A11Y, "kind" to kind, "value" to channel.value_),
                )
            },
            channels_empty = if (sheet.channels.isEmpty()) PeopleCopy.EMPTY_CHANNELS else "",
            dates_head = SectionHead(
                title = PeopleCopy.SECTION_DATES,
                count = sheet.dates.size,
                verb_label = PeopleCopy.ADD_DATE,
            ),
            dates = sheet.dates.map { date ->
                val day = PeopleWords.monthDay(date.month_day)
                PeopleDateRow(
                    date_id = date.date_id,
                    label = date.label,
                    day_label = day,
                    when_label = date.in_days?.let(PeopleWords::inDays) ?: "",
                    reminder_on = date.reminder_on,
                    reminder_label = if (date.reminder_on) PeopleCopy.REMINDER_ON else PeopleCopy.REMINDER_OFF,
                    toggle_label = fill(
                        if (date.reminder_on) PeopleCopy.REMINDER_TURN_OFF else PeopleCopy.REMINDER_TURN_ON,
                        "label" to date.label,
                    ),
                    accessibility_label = fill(PeopleCopy.DATE_A11Y, "label" to date.label, "day" to day),
                )
            },
            dates_empty = if (sheet.dates.isEmpty()) PeopleCopy.EMPTY_DATES else "",
            notes_head = SectionHead(
                title = PeopleCopy.SECTION_NOTES,
                count = sheet.notes.size,
                verb_label = PeopleCopy.ADD_NOTE,
            ),
            notes = sheet.notes.map { note ->
                PeopleNoteRow(
                    annotation_id = note.annotation_id,
                    text = note.text,
                    when_label = PeopleWords.whenLogged(note.created_local_day, today),
                )
            },
            notes_empty = if (sheet.notes.isEmpty()) PeopleCopy.EMPTY_NOTES else "",
            touches_head = SectionHead(
                title = PeopleCopy.SECTION_TOUCHES,
                count = if (sheet.touches_known) sheet.touches.size else null,
                verb_label = PeopleCopy.LOG_TOUCH,
            ),
            // v0 NEVER SHOWED THE LOG it wrote (audit): here it is, and an
            // unreadable log says so rather than drawing "nothing logged".
            touches = if (!sheet.touches_known) {
                emptyList()
            } else {
                sheet.touches.map { touch ->
                    val kind = PeopleWords.touchKind(touch.kind)
                    val whenLabel = PeopleWords.whenLogged(touch.occurred_local_day, today)
                    PeopleTouchRow(
                        interaction_id = touch.interaction_id,
                        kind_label = kind,
                        text = touch.text,
                        when_label = whenLabel,
                        accessibility_label = fill(PeopleCopy.TOUCH_A11Y, "kind" to kind, "when" to whenLabel),
                    )
                }
            },
            touches_empty = when {
                !sheet.touches_known -> PeopleCopy.TOUCHES_UNKNOWN
                sheet.touches.isEmpty() -> PeopleCopy.EMPTY_TOUCHES
                else -> ""
            },
            today = today,
        )
    }

    /** Everyone who could be folded in; the machine drops the person themselves. */
    public fun mergeChoices(roster: PeopleRoster): PeopleMergeChoices = PeopleMergeChoices(
        choices = roster.people.map { row ->
            PeopleMergeChoice(
                party_id = row.party_id,
                name = row.name,
                avatar = PeopleWords.avatar(row.party_id, row.name, row.avatar_color),
                role = row.role,
            )
        },
    )

    public fun gone(): EmptyState = EmptyState(
        headline = PeopleCopy.GONE_TITLE,
        body = PeopleCopy.GONE_BODY,
        action_label = PeopleCopy.BACK,
    )
}
