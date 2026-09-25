package dev.centraid.shared.apps.people

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandStatus
import centraid.core.v1.PeopleRoster
import centraid.core.v1.PeopleRosterFilter
import centraid.core.v1.PeopleRosterRequest
import centraid.core.v1.PeopleRosterRow
import centraid.core.v1.PeopleRosterSort
import centraid.core.v1.PeopleSearch
import centraid.core.v1.PeopleSearchRequest
import centraid.core.v1.PeopleTouch
import centraid.core.v1.PeopleTouchRequest
import centraid.screen.v1.Denied
import centraid.screen.v1.EmptyState
import centraid.screen.v1.PeopleCardRow
import centraid.screen.v1.PeopleChip
import centraid.screen.v1.PeopleChipKey
import centraid.screen.v1.PeopleHomeData
import centraid.screen.v1.PeopleHomeEvent
import centraid.screen.v1.PeopleHomeState
import centraid.screen.v1.PeopleOrder
import centraid.screen.v1.PeopleRecentRow
import centraid.screen.v1.PeopleRosterData
import centraid.screen.v1.PeopleRow
import centraid.screen.v1.PeopleSearchData
import centraid.screen.v1.PeopleTile
import centraid.screen.v1.PeopleTouchData
import centraid.screen.v1.PeopleUpcomingRow
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
 * WHAT PEOPLE'S HOME ASKS THE CORE (#1029 app port), and what the answers
 * become.
 *
 * One query per read: `people.roster` on People (the chip and the order are
 * the request's), `people.touch` on Touch, and `people.search` alone while a
 * term is typed — the surface under it stays as it was, so closing search
 * re-reads nothing.
 *
 * THE FOLD IS HERE because `screen.proto` cannot carry the core's messages
 * (the People section's header): [arrived] turns each typed answer into the
 * screen's `*Data`, and [PeopleHomeMachine] decorates what depends on the
 * state — the selected chip, a star in flight, the chip's empty sentence.
 */
public object PeopleHomeReads :
    ScreenQueries<PeopleHomeState, PeopleHomeEvent>,
    ScreenWrites<PeopleHomeState, PeopleHomeEvent> {
    override val screenId: String = PeopleHomeMachine.SCREEN_ID

    override val tables: Set<String> = PeopleHomeMachine.TABLES

    override val appId: String = "people"

    /** At most what `people.search` asks of the index. */
    public const val SEARCH_LIMIT: Int = 50

    override fun requests(state: PeopleHomeState, now: DeviceClock.Reading): List<AppQueryRequest> {
        val term = PeopleHomeMachine.activeTerm(state)
        if (term != null) {
            return listOf(AppQueryRequest(people_search = PeopleSearchRequest(term = term, limit = SEARCH_LIMIT)))
        }
        return when (state.destination) {
            PeopleHomeState.Destination.DESTINATION_TOUCH ->
                listOf(AppQueryRequest(people_touch = PeopleTouchRequest(tz = now.zone)))
            else -> listOf(
                AppQueryRequest(
                    people_roster = PeopleRosterRequest(
                        // 0 IS THE DECLARED MAXIMUM: the chips count the whole window.
                        limit = 0,
                        filter = filterOf(state.chip),
                        sort = sortOf(state.order),
                        tz = now.zone,
                    ),
                ),
            )
        }
    }

    override fun arrived(answers: List<AppQueryResponse>): PeopleHomeEvent {
        val search = answers.firstNotNullOfOrNull { it.people_search }
        val roster = answers.firstNotNullOfOrNull { it.people_roster }
        val touch = answers.firstNotNullOfOrNull { it.people_touch }
        return PeopleHomeEvent(
            data_ = PeopleHomeEvent.DataArrived(
                data_ = roster?.let(PeopleFold::roster) ?: touch?.let(PeopleFold::touch),
                search = search?.let(PeopleFold::search),
            ),
        )
    }

    override fun refused(failure: ReadFailure): PeopleHomeEvent =
        PeopleHomeEvent(refused = PeopleHomeEvent.ReadRefused(failure = failure))

    /** The kit's denied arm, with People's words and the vault's receipt. */
    override fun denied(denial: AppQueryDenial): PeopleHomeEvent =
        PeopleHomeEvent(denied = PeopleFold.denied(denial))

    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): PeopleHomeEvent =
        PeopleHomeEvent(write_settled = WriteLaw.settledOf(status, sentence, invokeKey))

    internal fun filterOf(chip: PeopleChipKey): PeopleRosterFilter = when (chip) {
        PeopleChipKey.PEOPLE_CHIP_KEY_STARRED -> PeopleRosterFilter.PEOPLE_ROSTER_FILTER_STARRED
        PeopleChipKey.PEOPLE_CHIP_KEY_DUE -> PeopleRosterFilter.PEOPLE_ROSTER_FILTER_DUE
        else -> PeopleRosterFilter.PEOPLE_ROSTER_FILTER_ALL
    }

    internal fun sortOf(order: PeopleOrder): PeopleRosterSort = when (order) {
        PeopleOrder.PEOPLE_ORDER_NAME -> PeopleRosterSort.PEOPLE_ROSTER_SORT_NAME
        else -> PeopleRosterSort.PEOPLE_ROSTER_SORT_RECENT
    }
}

/**
 * THE CORE'S PEOPLE ANSWERS, AS THE SCREENS DRAW THEM. Pure; every day and
 * count is the core's.
 */
public object PeopleFold {
    /** A reminder is a roster chip when it is at most this many days away. */
    public const val REMINDER_CHIP_DAYS: Long = 30

    public fun denied(denial: AppQueryDenial): Denied = Denied(
        title = PeopleCopy.DENIED_TITLE,
        body = PeopleCopy.DENIED_BODY,
        receipt = denial.message ?: "",
    )

    public fun roster(answer: PeopleRoster): PeopleHomeData = PeopleHomeData(
        today = answer.today,
        roster = PeopleRosterData(
            chips = listOf(
                chip(PeopleChipKey.PEOPLE_CHIP_KEY_ALL, PeopleCopy.CHIP_ALL, answer.count_all),
                chip(PeopleChipKey.PEOPLE_CHIP_KEY_STARRED, PeopleCopy.CHIP_STARRED, answer.count_starred),
                chip(PeopleChipKey.PEOPLE_CHIP_KEY_DUE, PeopleCopy.CHIP_DUE, answer.count_due),
            ),
            rows = answer.people.map(::row),
            // DAY ONE is the fold's to say; a chip's own empty is the machine's.
            empty = if (answer.count_all == 0) dayOne() else null,
            status_line = fill(
                if (answer.truncated) PeopleCopy.STATUS_ROSTER_SHOWN else PeopleCopy.STATUS_ROSTER,
                "people" to answer.count_all,
                "due" to answer.count_due,
                "starred" to answer.count_starred,
            ),
            truncated = answer.truncated,
        ),
    )

    public fun dayOne(): EmptyState = EmptyState(
        headline = PeopleCopy.EMPTY_ROSTER_TITLE,
        body = PeopleCopy.EMPTY_ROSTER_BODY,
        action_label = PeopleCopy.ADD_PERSON,
    )

    private fun chip(key: PeopleChipKey, label: String, count: Int): PeopleChip = PeopleChip(
        key = key,
        label = label,
        count = count,
        accessibility_label = fill(PeopleCopy.CHIP_A11Y, "label" to label, "count" to count),
    )

    /** One roster or search row; the star words are the machine's overlay. */
    public fun row(person: PeopleRosterRow): PeopleRow {
        val chips = buildList {
            if (person.due) add(StatusChip(label = PeopleCopy.CHIP_OVERDUE, tone = StatusChip.Tone.TONE_NET))
            person.reminders
                .filter { (it.in_days ?: Long.MAX_VALUE) <= REMINDER_CHIP_DAYS }
                .minByOrNull { it.in_days ?: Long.MAX_VALUE }
                ?.let { date ->
                    add(
                        StatusChip(
                            label = fill(
                                PeopleCopy.CHIP_REMINDER,
                                "label" to date.label,
                                "when" to PeopleWords.inDays(date.in_days ?: 0).lowercase(),
                            ),
                            tone = StatusChip.Tone.TONE_NEUTRAL,
                        ),
                    )
                }
        }
        return PeopleRow(
            party_id = person.party_id,
            name = person.name,
            avatar = PeopleWords.avatar(person.party_id, person.name, person.avatar_color),
            role = person.role,
            meta = PeopleWords.lastTouch(person.last_contacted_at != null, person.days_since_contact),
            chips = chips,
            due = person.due,
            starred = person.starred,
            vault_starred = person.starred,
        )
    }

    public fun search(answer: PeopleSearch): PeopleSearchData = PeopleSearchData(
        rows = answer.people.map(::row),
        empty = if (answer.people.isEmpty()) {
            EmptyState(headline = PeopleCopy.EMPTY_NO_MATCH, body = PeopleCopy.EMPTY_NO_MATCH_BODY)
        } else {
            null
        },
    )

    public fun touch(answer: PeopleTouch): PeopleHomeData = PeopleHomeData(
        today = answer.today,
        touch = PeopleTouchData(
            tiles = listOf(
                tile("all", PeopleCopy.TILE_ALL, answer.count_all, net = false, tappable = true),
                tile("reconnect", PeopleCopy.TILE_RECONNECT, answer.count_reconnect, net = true, tappable = true),
                // UPCOMING IS A FIGURE, NOT A CONTROL: its rows are right below
                // it, and v0's tile was a button that did nothing (audit).
                tile("upcoming", PeopleCopy.TILE_UPCOMING, answer.count_upcoming, net = false, tappable = false),
                tile("starred", PeopleCopy.TILE_STARRED, answer.count_starred, net = false, tappable = true),
            ),
            reconnect_head = SectionHead(title = PeopleCopy.SECTION_RECONNECT, count = answer.reconnect.size),
            reconnect = answer.reconnect.map { card ->
                val detail = PeopleWords.daysOver(card.days_over ?: 0)
                PeopleCardRow(
                    party_id = card.party_id,
                    name = card.name,
                    avatar = PeopleWords.avatar(card.party_id, card.name, card.avatar_color),
                    role = card.role,
                    detail = detail,
                    action_label = PeopleCopy.LOG_TOUCH,
                    accessibility_label = "${card.name}, $detail",
                )
            },
            reconnect_empty = if (answer.reconnect.isEmpty()) PeopleCopy.EMPTY_RECONNECT else "",
            upcoming_head = SectionHead(title = PeopleCopy.SECTION_UPCOMING, count = answer.upcoming.size),
            upcoming = answer.upcoming.mapNotNull { up ->
                val person = up.person ?: return@mapNotNull null
                val date = up.date ?: return@mapNotNull null
                val whenLabel = date.in_days?.let(PeopleWords::inDays) ?: ""
                PeopleUpcomingRow(
                    party_id = person.party_id,
                    date_id = date.date_id,
                    name = person.name,
                    avatar = PeopleWords.avatar(person.party_id, person.name, person.avatar_color),
                    label = date.label,
                    when_label = whenLabel,
                    day_label = PeopleWords.monthDay(date.month_day),
                    accessibility_label = fill(
                        PeopleCopy.UPCOMING_A11Y,
                        "name" to person.name,
                        "label" to date.label,
                        "when" to whenLabel.ifEmpty { PeopleWords.monthDay(date.month_day) },
                    ),
                )
            },
            upcoming_empty = if (answer.upcoming.isEmpty()) PeopleCopy.EMPTY_UPCOMING else "",
            recent_head = SectionHead(title = PeopleCopy.SECTION_RECENT),
            recent = answer.recent.map { entry ->
                val kind = PeopleWords.touchKind(entry.kind)
                val whenLabel = PeopleWords.whenLogged(entry.occurred_local_day, answer.today)
                PeopleRecentRow(
                    interaction_id = entry.interaction_id,
                    party_id = entry.party_id,
                    name = entry.name,
                    avatar = PeopleWords.avatar(entry.party_id, entry.name, entry.avatar_color),
                    kind_label = kind,
                    text = entry.text,
                    when_label = whenLabel,
                    accessibility_label = fill(
                        PeopleCopy.RECENT_A11Y,
                        "kind" to kind,
                        "name" to entry.name,
                        "when" to whenLabel,
                    ),
                )
            },
            recent_empty = if (answer.recent.isEmpty()) PeopleCopy.EMPTY_RECENT else "",
            status_line = fill(PeopleCopy.STATUS_TOUCH, "people" to answer.count_all, "due" to answer.count_reconnect),
            empty = if (answer.count_all == 0) dayOne() else null,
        ),
    )

    private fun tile(key: String, label: String, count: Int, net: Boolean, tappable: Boolean): PeopleTile =
        PeopleTile(
            key = key,
            label = label,
            count = count,
            net = net,
            tappable = tappable,
            accessibility_label = fill(PeopleCopy.CHIP_A11Y, "label" to label, "count" to count),
        )
}
