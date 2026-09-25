package dev.centraid.shared.apps.people

import centraid.screen.v1.EmptyState
import centraid.screen.v1.Loading
import centraid.screen.v1.PeopleBandTab
import centraid.screen.v1.PeopleChipKey
import centraid.screen.v1.PeopleHomeChrome
import centraid.screen.v1.PeopleHomeData
import centraid.screen.v1.PeopleHomeEvent
import centraid.screen.v1.PeopleHomeState
import centraid.screen.v1.PeopleOrder
import centraid.screen.v1.PeopleOrderChoice
import centraid.screen.v1.PeopleRow
import centraid.screen.v1.PeopleStarPending
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.SearchField
import centraid.screen.v1.SeatState
import centraid.screen.v1.WriteState
import dev.centraid.design.copy.PeopleCopy
import dev.centraid.shared.apps.people.PeopleWords.fill
import dev.centraid.shared.kit.InvokeKeys
import dev.centraid.shared.kit.SearchLaw
import dev.centraid.shared.kit.SearchLens
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.kit.WriteLens
import dev.centraid.shared.kit.jsonString
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step

/**
 * PEOPLE'S HOME ON THE PHONE (#1029 app port): People and Touch, with search
 * a field on the current surface and More a sheet.
 *
 * - **People** is the roster: chips (All, Starred, Overdue) and the order
 *   (Recently added, Name) are PARAMETERS of the core's read, so a chip or an
 *   order re-reads and the counts stay the whole window's.
 * - **Touch** is the keep-in-touch dashboard: tiles, Reconnect (most overdue
 *   first, each card with "Log a touch"), Upcoming (nearest first), Recent.
 * - **Search** asks the core's name search; the surface under it is kept, so
 *   closing search re-reads nothing and clears the term.
 *
 * ONE READ IN FLIGHT ([PeopleHomeState.reading]): an answer does not say
 * which request it answers, so a read asked while one is out is queued and the
 * older answer is dropped rather than drawn under the wrong chip or term.
 *
 * THE STAR is a write from the row ([WriteLaw]); the row shows the star it
 * asked for until the vault's next answer, and a refusal puts the vault's
 * star back with the sentence on the status line.
 */
public object PeopleHomeMachine : ScreenMachine<PeopleHomeState, PeopleHomeEvent> {
    public const val SCREEN_ID: String = "people.home"

    public const val STAR_COMMAND: String = "people.star_person"
    public const val UNSTAR_COMMAND: String = "people.unstar_person"

    /**
     * THE TABLES THE ROSTER, TOUCH AND SEARCH ANSWERS ARE FOLDED FROM: the
     * profile and its party, the star and list tags with their vocabulary,
     * important dates, and the touches (`core_activity` linked by
     * `core_link`). `PeopleHomeReads.tables` is this set.
     */
    public val TABLES: Set<String> = setOf(
        "people_profile",
        "core_party",
        "core_tag",
        "core_concept",
        "core_concept_scheme",
        "people_important_date",
        "core_activity",
        "core_link",
    )

    override fun initial(): PeopleHomeState = decorate(
        PeopleHomeState(
            destination = PeopleHomeState.Destination.DESTINATION_PEOPLE,
            chip = PeopleChipKey.PEOPLE_CHIP_KEY_ALL,
            order = PeopleOrder.PEOPLE_ORDER_RECENT,
            search = SearchField(),
            loading = Loading(first_load = true),
            sheet = PeopleHomeState.Sheet.SHEET_NONE,
            write = WriteState(phase = WriteState.Phase.PHASE_IDLE),
        ),
    )

    override fun reduce(state: PeopleHomeState, event: PeopleHomeEvent): Step<PeopleHomeState> {
        val step = step(state, event)
        return Step(decorate(step.state), step.effects)
    }

    override fun rowsChanged(table: String, keys: List<String>): PeopleHomeEvent? =
        if (table in TABLES) PeopleHomeEvent(rows_changed = PeopleHomeEvent.RowsChanged(table = table)) else null

    override fun seatChanged(seat: SeatState): PeopleHomeEvent =
        PeopleHomeEvent(seat_changed = PeopleHomeEvent.SeatChanged(seat = seat))

    /** The term search is answering, or null when search is not reading. */
    public fun activeTerm(state: PeopleHomeState): String? {
        val field = state.search ?: return null
        return field.term.trim().takeIf { field.open_ && it.isNotEmpty() }
    }

    // ---------------------------------------------------------------------

    private fun step(state: PeopleHomeState, event: PeopleHomeEvent): Step<PeopleHomeState> = when {
        event.opened != null -> {
            val to = event.opened.destination
                .takeUnless { it == PeopleHomeState.Destination.DESTINATION_UNSPECIFIED }
                ?: PeopleHomeState.Destination.DESTINATION_PEOPLE
            read(
                loading(
                    state.copy(
                        destination = to,
                        search = SearchField(),
                        search_data = null,
                        sheet = PeopleHomeState.Sheet.SHEET_NONE,
                    ),
                ),
            )
        }
        event.refreshed != null -> read(state)
        event.band != null -> band(state, event.band.key)
        event.chip != null -> chip(state, event.chip.chip)
        event.order != null -> {
            val sheetClosed = state.copy(sheet = PeopleHomeState.Sheet.SHEET_NONE)
            val to = event.order.order
            if (to == state.order || to == PeopleOrder.PEOPLE_ORDER_UNSPECIFIED) {
                Step(sheetClosed)
            } else if (state.destination == PeopleHomeState.Destination.DESTINATION_PEOPLE) {
                read(loading(sheetClosed.copy(order = to)))
            } else {
                // Touch has no order; the roster reads with it next time.
                Step(sheetClosed.copy(order = to))
            }
        }
        event.tile != null -> when (event.tile.key) {
            "all" -> chip(state, PeopleChipKey.PEOPLE_CHIP_KEY_ALL, forceRead = true)
            "reconnect" -> chip(state, PeopleChipKey.PEOPLE_CHIP_KEY_DUE, forceRead = true)
            "starred" -> chip(state, PeopleChipKey.PEOPLE_CHIP_KEY_STARRED, forceRead = true)
            else -> Step(state)
        }
        event.search_opened != null -> SearchLaw.opened(Search, state)
        event.search_term != null -> {
            val next = SearchLaw.term(Search, state, event.search_term.term)
            if (next.effects.isEmpty()) {
                Step(next.state.copy(search_data = null))
            } else {
                read(next.state)
            }
        }
        event.search_closed != null -> Step(SearchLaw.closed(Search, state).state.copy(search_data = null))
        event.sheet_opened != null -> Step(
            state.copy(
                sheet = event.sheet_opened.sheet
                    .takeUnless { it == PeopleHomeState.Sheet.SHEET_UNSPECIFIED }
                    ?: PeopleHomeState.Sheet.SHEET_NONE,
            ),
        )
        event.sheet_closed != null -> Step(state.copy(sheet = PeopleHomeState.Sheet.SHEET_NONE))
        event.star != null -> star(state, event.star.party_id)
        event.data_ != null -> arrived(state, event.data_)
        event.refused != null -> refused(state, event.refused.failure ?: Reads.refused(""))
        event.denied != null -> Step(
            state.copy(
                loading = null,
                failure = null,
                data_ = null,
                denied = event.denied,
                reading = false,
                read_queued = false,
            ),
        )
        event.rows_changed != null -> if (state.denied != null) Step(state) else read(state)
        event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))
        event.write_settled != null -> settled(state, event.write_settled)
        // INTENTS: the shell routes them; the machine keeps its state.
        else -> Step(state)
    }

    private fun band(state: PeopleHomeState, key: String): Step<PeopleHomeState> {
        val to = when (key) {
            "people" -> PeopleHomeState.Destination.DESTINATION_PEOPLE
            "touch" -> PeopleHomeState.Destination.DESTINATION_TOUCH
            "more" -> return Step(state.copy(sheet = PeopleHomeState.Sheet.SHEET_MORE))
            else -> return Step(state)
        }
        // THE SAME TAB IS NOTHING (the kit's band law): no reset, no read.
        if (to == state.destination) return Step(state)
        return read(loading(state.copy(destination = to, sheet = PeopleHomeState.Sheet.SHEET_NONE)))
    }

    private fun chip(state: PeopleHomeState, to: PeopleChipKey, forceRead: Boolean = false): Step<PeopleHomeState> {
        val chip = to.takeUnless { it == PeopleChipKey.PEOPLE_CHIP_KEY_UNSPECIFIED } ?: PeopleChipKey.PEOPLE_CHIP_KEY_ALL
        val onPeople = state.destination == PeopleHomeState.Destination.DESTINATION_PEOPLE
        if (chip == state.chip && onPeople && !forceRead) return Step(state)
        return read(
            loading(
                state.copy(
                    chip = chip,
                    destination = PeopleHomeState.Destination.DESTINATION_PEOPLE,
                    search = SearchField(),
                    search_data = null,
                ),
            ),
        )
    }

    /** Skeletons for a new window: a chip's rows are not drawn under another chip. */
    private fun loading(state: PeopleHomeState): PeopleHomeState =
        state.copy(loading = Loading(first_load = true), failure = null, denied = null, data_ = null)

    /** Ask for a read, or queue one behind the read in flight. */
    private fun read(state: PeopleHomeState): Step<PeopleHomeState> =
        if (state.reading) {
            Step(state.copy(read_queued = true))
        } else {
            Step(state.copy(reading = true), listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)))
        }

    private fun arrived(state: PeopleHomeState, event: PeopleHomeEvent.DataArrived): Step<PeopleHomeState> {
        val settled = state.copy(reading = false)
        // A READ WAS ASKED SINCE: this answer is for an older question.
        if (state.read_queued) return read(settled.copy(read_queued = false))
        val term = activeTerm(state)
        if (event.search != null) {
            if (term == null) return Step(settled)
            val answered = SearchLaw.answered(Search, settled, term)
            return Step(answered.copy(search_data = event.search.copy(term = term)))
        }
        val data = event.data_ ?: return Step(settled)
        // The surface must be the one on screen; anything else is re-asked.
        val fits = when (settled.destination) {
            PeopleHomeState.Destination.DESTINATION_TOUCH -> data.touch != null
            else -> data.roster != null
        }
        if (!fits) return read(settled)
        // A star the vault has now answered for is the vault's again.
        return Step(
            settled.copy(
                loading = null,
                failure = null,
                denied = null,
                data_ = data,
                star_pending = settled.star_pending.filter { it.invoke_key.isNotEmpty() },
            ),
        )
    }

    private fun refused(state: PeopleHomeState, failure: ReadFailure): Step<PeopleHomeState> {
        val settled = state.copy(reading = false)
        if (state.read_queued) return read(settled.copy(read_queued = false))
        // THE READ LAW: a failed read is not an empty list.
        return Step(settled.copy(loading = null, denied = null, data_ = null, failure = failure, search_data = null))
    }

    private fun star(state: PeopleHomeState, partyId: String): Step<PeopleHomeState> {
        val row = rowsOf(state).firstOrNull { it.party_id == partyId } ?: return Step(state)
        val target = !row.starred
        val command = if (target) STAR_COMMAND else UNSTAR_COMMAND
        val key = InvokeKeys.of(command, partyId)
        val step = WriteLaw.submit(Writes, state, command, "{\"party_id\":${jsonString(partyId)}}", key)
        return Step(
            step.state.copy(
                star_pending = state.star_pending.filter { it.party_id != partyId } +
                    PeopleStarPending(party_id = partyId, starred = target, invoke_key = key),
                status = "",
            ),
            step.effects,
        )
    }

    private fun settled(state: PeopleHomeState, settled: centraid.screen.v1.WriteSettled): Step<PeopleHomeState> {
        val pending = state.star_pending.firstOrNull { it.invoke_key == settled.invoke_key }
            ?: return WriteLaw.settled(Writes, state, settled)
        val written = WriteLaw.settled(Writes, state, settled).state
        val name = rowsOf(state).firstOrNull { it.party_id == pending.party_id }?.name ?: ""
        return if (settled.committed) {
            Step(
                written.copy(
                    // KEPT, KEYLESS, until the vault's next answer: drawing the
                    // old star between the commit and the re-read would flicker.
                    star_pending = state.star_pending.map {
                        if (it.invoke_key == settled.invoke_key) it.copy(invoke_key = "") else it
                    },
                    status = fill(
                        if (pending.starred) PeopleCopy.OUTCOME_STARRED else PeopleCopy.OUTCOME_UNSTARRED,
                        "name" to name,
                    ),
                ),
            )
        } else {
            Step(
                written.copy(
                    star_pending = state.star_pending.filter { it.invoke_key != settled.invoke_key },
                    status = settled.failure?.sentence?.takeIf { it.isNotEmpty() } ?: PeopleCopy.WRITE_FAILED,
                ),
            )
        }
    }

    private fun rowsOf(state: PeopleHomeState): List<PeopleRow> =
        (state.search_data?.rows ?: emptyList()) + (state.data_?.roster?.rows ?: emptyList())

    // ---------------------------------------------------------------------
    // Decorate: everything a view draws that depends on the state.
    // ---------------------------------------------------------------------

    private fun decorate(state: PeopleHomeState): PeopleHomeState {
        val denied = state.denied != null
        return state.copy(
            band = if (denied) emptyList() else band(state.destination),
            chrome = CHROME,
            order_choices = listOf(
                PeopleOrderChoice(order = PeopleOrder.PEOPLE_ORDER_RECENT, label = PeopleCopy.SORT_RECENT),
                PeopleOrderChoice(order = PeopleOrder.PEOPLE_ORDER_NAME, label = PeopleCopy.SORT_NAME),
            ).map { it.copy(selected = it.order == state.order) },
            data_ = state.data_?.let { decorateData(it, state) },
            search_data = state.search_data?.let { it.copy(rows = it.rows.map { row -> overlay(row, state) }) },
        )
    }

    private fun decorateData(data: PeopleHomeData, state: PeopleHomeState): PeopleHomeData {
        val roster = data.roster ?: return data
        val rows = roster.rows.map { overlay(it, state) }
        val empty = when {
            rows.isNotEmpty() -> null
            roster.chips.sumOf { if (it.key == PeopleChipKey.PEOPLE_CHIP_KEY_ALL) it.count else 0 } == 0 ->
                PeopleFold.dayOne()
            state.chip == PeopleChipKey.PEOPLE_CHIP_KEY_STARRED -> EmptyState(headline = PeopleCopy.EMPTY_STARRED)
            state.chip == PeopleChipKey.PEOPLE_CHIP_KEY_DUE -> EmptyState(headline = PeopleCopy.EMPTY_DUE)
            else -> PeopleFold.dayOne()
        }
        return data.copy(
            roster = roster.copy(
                chips = roster.chips.map { it.copy(selected = it.key == state.chip) },
                rows = rows,
                empty = empty,
            ),
        )
    }

    /** The star to draw: the one asked for while a write is out, else the vault's. */
    private fun overlay(row: PeopleRow, state: PeopleHomeState): PeopleRow {
        val pending = state.star_pending.firstOrNull { it.party_id == row.party_id }
        val starred = pending?.starred ?: row.vault_starred
        val a11y = when {
            starred && row.due -> PeopleCopy.ROW_A11Y_DUE_STARRED
            starred -> PeopleCopy.ROW_A11Y_STARRED
            row.due -> PeopleCopy.ROW_A11Y_DUE
            else -> PeopleCopy.ROW_A11Y
        }
        return row.copy(
            starred = starred,
            star_pending = pending != null && pending.invoke_key.isNotEmpty(),
            star_label = fill(if (starred) PeopleCopy.UNSTAR else PeopleCopy.STAR, "name" to row.name),
            accessibility_label = fill(a11y, "name" to row.name),
        )
    }

    private fun band(destination: PeopleHomeState.Destination): List<PeopleBandTab> = listOf(
        PeopleBandTab(
            key = "people",
            label = PeopleCopy.BAND_PEOPLE,
            icon_key = "Users",
            current = destination == PeopleHomeState.Destination.DESTINATION_PEOPLE,
        ),
        PeopleBandTab(
            key = "touch",
            label = PeopleCopy.BAND_TOUCH,
            // The catalog's nearest to "keeping in touch": a pulse.
            icon_key = "Activity",
            current = destination == PeopleHomeState.Destination.DESTINATION_TOUCH,
        ),
        PeopleBandTab(key = "more", label = PeopleCopy.BAND_MORE, icon_key = "more", current = false),
    )

    private val CHROME = PeopleHomeChrome(
        title = PeopleCopy.APP_TITLE,
        add_person = PeopleCopy.ADD_PERSON,
        search_label = PeopleCopy.SEARCH_LABEL,
        search_placeholder = PeopleCopy.SEARCH_PLACEHOLDER,
        search_close = PeopleCopy.SEARCH_CLOSE,
        retry = PeopleCopy.RETRY,
        loading = PeopleCopy.LOADING,
        more_title = PeopleCopy.MORE_TITLE,
        sort_heading = PeopleCopy.SORT_HEADING,
        trash_label = PeopleCopy.TRASH_LABEL,
        home = PeopleCopy.BAND_HOME,
    )

    private object Search : SearchLens<PeopleHomeState> {
        override val screenId: String = SCREEN_ID

        override fun field(state: PeopleHomeState): SearchField = state.search ?: SearchField()

        override fun with(state: PeopleHomeState, field: SearchField): PeopleHomeState = state.copy(search = field)
    }

    private object Writes : WriteLens<PeopleHomeState> {
        override fun write(state: PeopleHomeState): WriteState = state.write ?: WriteState()

        override fun with(state: PeopleHomeState, write: WriteState): PeopleHomeState = state.copy(write = write)
    }

}
