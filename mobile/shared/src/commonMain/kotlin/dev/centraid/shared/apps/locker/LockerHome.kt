package dev.centraid.shared.apps.locker

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.LockerItemsRequest
import centraid.core.v1.LockerReviewRequest
import centraid.core.v1.LockerSearchRequest
import centraid.screen.v1.EmptyState
import centraid.screen.v1.Loading
import centraid.screen.v1.LockerBandTab
import centraid.screen.v1.LockerChoice
import centraid.screen.v1.LockerFact
import centraid.screen.v1.LockerHomeChrome
import centraid.screen.v1.LockerHomeData
import centraid.screen.v1.LockerHomeEvent
import centraid.screen.v1.LockerHomeState
import centraid.screen.v1.LockerMoreRow
import centraid.screen.v1.LockerReviewSection
import centraid.screen.v1.SearchField
import centraid.screen.v1.SeatState
import centraid.screen.v1.SectionHead
import dev.centraid.design.copy.LockerCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.screen.Step

/**
 * LOCKER'S HOME (#1047): Items · Review · Generate · Search, and More as a
 * sheet (the handoff's phone band). One screen, the surface a parameter
 * (law 2). Generate reads nothing: its slot draws the generator screen.
 */
public object LockerHomeMachine :
    LockerQueryMachine<LockerHomeState, LockerHomeEvent, LockerHomeData>("locker.home", LOCKER_TABLES) {
    public const val SCREEN_ID: String = "locker.home"

    /** The filter keys that are not a type. */
    public const val ALL: String = "all"
    public const val STARRED: String = "starred"
    public const val ARCHIVED: String = "archived"

    override val lens: ContentLens<LockerHomeState, LockerHomeData> = Lens

    override fun blank(): LockerHomeState = LockerHomeState(
        destination = LockerHomeState.Destination.DESTINATION_ITEMS,
        sheet = LockerHomeState.Sheet.SHEET_NONE,
        search = SearchField(),
        filter = ALL,
    )

    // A RELOCK KEEPS WHERE THE MEMBER WAS — the tab and the filter — and
    // nothing of what they saw; search is closed, because a term is content.
    override fun wiped(held: LockerHeld<LockerHomeState>): LockerHomeState =
        lens.with(
            blank().copy(destination = held.screen.destination, filter = held.screen.filter),
            ReadContent.Loading(firstLoad = true),
        )

    override fun seatOf(screen: LockerHomeState): SeatState = screen.seat ?: SeatState()

    override fun withSeat(screen: LockerHomeState, seat: SeatState): LockerHomeState = screen.copy(seat = seat)

    override fun view(held: LockerHeld<LockerHomeState>, event: LockerHomeEvent, entropy: ByteArray): Step<LockerHeld<LockerHomeState>> =
        when {
            event.opened != null -> destination(
                held,
                event.opened.destination.takeIf { it != LockerHomeState.Destination.DESTINATION_UNSPECIFIED }
                    ?: LockerHomeState.Destination.DESTINATION_ITEMS,
                force = true,
            )
            event.refreshed != null -> read(overRows(held))
            event.band != null -> when (event.band.key) {
                "more" -> Step(held.copy(screen = held.screen.copy(sheet = LockerHomeState.Sheet.SHEET_MORE)))
                else -> destinationOf(event.band.key)
                    ?.takeIf { it != held.screen.destination }
                    ?.let { destination(held, it, force = false) }
                    ?: Step(held)
            }
            event.filter != null -> filter(held, event.filter.key)
            event.sheet_opened != null -> Step(held.copy(screen = held.screen.copy(sheet = event.sheet_opened.sheet)))
            event.sheet_closed != null -> Step(held.copy(screen = held.screen.copy(sheet = LockerHomeState.Sheet.SHEET_NONE)))
            event.search_opened != null -> destination(held, LockerHomeState.Destination.DESTINATION_SEARCH, force = false)
            event.search_typed != null -> searched(held, event.search_typed.term)
            // CLOSING CLEARS (R-1046-6): the term and its hits.
            event.search_closed != null -> destination(
                held.copy(answers = held.answers.copy(search = null), screen = held.screen.copy(search = SearchField())),
                LockerHomeState.Destination.DESTINATION_ITEMS,
                force = false,
            )
            // `facts` is the machine's (a sheet); `trash` and `lock` are the shell's.
            event.more?.key == "facts" -> Step(held.copy(screen = held.screen.copy(sheet = LockerHomeState.Sheet.SHEET_FACTS)))
            event.more != null -> Step(held.copy(screen = held.screen.copy(sheet = LockerHomeState.Sheet.SHEET_NONE)))
            // INTENTS: the shell routes them.
            else -> Step(held)
        }

    private fun destinationOf(key: String): LockerHomeState.Destination? = when (key) {
        "items" -> LockerHomeState.Destination.DESTINATION_ITEMS
        "review" -> LockerHomeState.Destination.DESTINATION_REVIEW
        "generate" -> LockerHomeState.Destination.DESTINATION_GENERATE
        "search" -> LockerHomeState.Destination.DESTINATION_SEARCH
        else -> null
    }

    private fun destination(
        held: LockerHeld<LockerHomeState>,
        to: LockerHomeState.Destination,
        force: Boolean,
    ): Step<LockerHeld<LockerHomeState>> {
        val search = if (to == LockerHomeState.Destination.DESTINATION_SEARCH) {
            held.screen.search?.copy(open_ = true) ?: SearchField(open_ = true)
        } else {
            SearchField()
        }
        val moved = held.copy(screen = held.screen.copy(destination = to, search = search, sheet = LockerHomeState.Sheet.SHEET_NONE))
        // WHAT IS HELD IS DRAWN; WHAT IS NOT IS READ. A forced open reads
        // everything again.
        return when {
            force -> reload(moved)
            to == LockerHomeState.Destination.DESTINATION_GENERATE -> Step(drawn(moved))
            fold(moved) != null -> Step(drawn(moved))
            else -> read(moved.copy(screen = lens.with(moved.screen, ReadContent.Loading(firstLoad = true))))
        }
    }

    /** The screen drawing whatever the held answers make, or its skeleton. */
    private fun drawn(held: LockerHeld<LockerHomeState>): LockerHeld<LockerHomeState> {
        val data = fold(held) ?: return held.copy(screen = lens.with(held.screen, ReadContent.Loading(firstLoad = true)))
        return held.copy(screen = lens.with(held.screen, ReadContent.Data(data)))
    }

    private fun filter(held: LockerHeld<LockerHomeState>, key: String): Step<LockerHeld<LockerHomeState>> {
        if (key == held.screen.filter) return Step(held)
        val shelfChanged = (key == ARCHIVED) != (held.screen.filter == ARCHIVED)
        val next = held.copy(screen = held.screen.copy(filter = key))
        // THE ARCHIVED SHELF IS ANOTHER READ ("keep forever, hide from
        // lists" — asked for, never filtered out of the live one); every
        // other filter re-folds the live shelf already held.
        return if (shelfChanged) {
            reload(next.copy(answers = next.answers.copy(items = null)))
        } else {
            refold(next)
        }
    }

    private fun searched(held: LockerHeld<LockerHomeState>, term: String): Step<LockerHeld<LockerHomeState>> {
        val field = (held.screen.search ?: SearchField()).copy(open_ = true, term = term)
        val next = held.copy(
            screen = held.screen.copy(search = field, destination = LockerHomeState.Destination.DESTINATION_SEARCH),
        )
        return if (term.isBlank()) {
            Step(drawn(next.copy(answers = next.answers.copy(search = null))))
        } else {
            read(overRows(next))
        }
    }

    override fun fold(held: LockerHeld<LockerHomeState>): LockerHomeData? {
        val screen = held.screen
        val base = LockerHomeData(status_line = LockerCopy.ITEMS_STATUS)
        return when (screen.destination) {
            LockerHomeState.Destination.DESTINATION_REVIEW -> held.answers.review?.let { review(base, it) }
            LockerHomeState.Destination.DESTINATION_SEARCH -> search(base, held)
            LockerHomeState.Destination.DESTINATION_GENERATE -> base
            else -> held.answers.items?.let { items(base, it, screen.filter) }
        }
    }

    private fun items(base: LockerHomeData, answer: centraid.core.v1.LockerItems, filter: String): LockerHomeData {
        val shown = when (filter) {
            ALL, ARCHIVED -> answer.items
            STARRED -> answer.items.filter { it.starred }
            else -> answer.items.filter { it.type == filter }
        }
        val total = answer.total
        val chips = buildList {
            add(LockerChoice(key = ALL, label = LockerCopy.FILTER_ALL, selected = filter == ALL, detail = total?.toString() ?: ""))
            val starred = answer.items.count { it.starred }
            if (starred > 0 || filter == STARRED) {
                add(LockerChoice(key = STARRED, label = LockerCopy.FILTER_STARRED, selected = filter == STARRED, detail = starred.toString()))
            }
            answer.by_type.forEach {
                add(LockerChoice(key = it.type, label = LockerFold.typePlural(it.type), selected = filter == it.type, detail = it.count.toString()))
            }
            val archived = answer.archived_count
            if ((archived != null && archived > 0) || filter == ARCHIVED) {
                add(LockerChoice(key = ARCHIVED, label = LockerCopy.FILTER_ARCHIVED, selected = filter == ARCHIVED, detail = archived?.toString() ?: ""))
            }
        }
        val dayOne = filter == ALL && total == 0 && (answer.archived_count ?: 0) == 0
        val empty = when {
            shown.isNotEmpty() -> null
            dayOne -> EmptyState(headline = LockerCopy.DAY_ONE, body = LockerCopy.DAY_ONE_BODY, action_label = LockerCopy.DAY_ONE_ACTION)
            filter == ARCHIVED -> EmptyState(headline = LockerCopy.ARCHIVED_EMPTY, body = LockerCopy.ARCHIVED_EMPTY_BODY)
            else -> EmptyState(headline = LockerCopy.FILTER_EMPTY)
        }
        val window = if (answer.truncated && total != null && filter == ALL) {
            LockerFold.fill(LockerCopy.WINDOW, "shown" to answer.items.size.toString(), "total" to total.toString())
        } else if (answer.truncated) {
            LockerCopy.WINDOW_UNKNOWN
        } else {
            ""
        }
        return base.copy(
            filters = chips,
            rows = shown.map(LockerFold::row),
            window = window,
            items_empty = empty,
        )
    }

    private fun review(base: LockerHomeData, answer: centraid.core.v1.LockerReview): LockerHomeData {
        val sections = listOf(
            Triple("compromised", LockerCopy.REVIEW_COMPROMISED, LockerCopy.REVIEW_COMPROMISED_REASON) to answer.compromised,
            Triple("insecure_address", LockerCopy.REVIEW_HTTP, LockerCopy.REVIEW_HTTP_REASON) to answer.insecure_address,
            Triple("expired", LockerCopy.REVIEW_EXPIRED, LockerCopy.REVIEW_EXPIRED_REASON) to answer.expired,
            Triple("expiring", LockerCopy.REVIEW_EXPIRING, LockerCopy.REVIEW_EXPIRING_REASON) to answer.expiring,
        ).filter { it.second.isNotEmpty() }.map { (words, rows) ->
            LockerReviewSection(
                key = words.first,
                head = SectionHead(title = words.second, count = rows.size),
                reason = words.third,
                rows = rows.map(LockerFold::row),
            )
        }
        val clear = if (sections.isEmpty() && answer.reviewed > 0) {
            EmptyState(headline = LockerCopy.REVIEW_CLEAR, body = LockerCopy.REVIEW_CLEAR_BODY)
        } else if (answer.reviewed == 0) {
            EmptyState(headline = LockerCopy.REVIEW_NOTHING)
        } else {
            null
        }
        return base.copy(
            review = sections,
            review_unchecked_title = LockerCopy.REVIEW_UNCHECKED,
            review_unchecked = listOf(
                LockerFact(label = LockerCopy.REVIEW_WEAK, detail = LockerCopy.REVIEW_WEAK_REASON),
                LockerFact(label = LockerCopy.REVIEW_BREACH, detail = LockerCopy.REVIEW_BREACH_REASON),
            ),
            review_clear = clear,
            review_note = LockerFold.fill(
                if (answer.truncated) LockerCopy.REVIEW_NOTE_TRUNCATED else LockerCopy.REVIEW_NOTE,
                "items" to LockerFold.items(answer.reviewed),
            ),
        )
    }

    private fun search(base: LockerHomeData, held: LockerHeld<LockerHomeState>): LockerHomeData {
        val field = held.screen.search ?: SearchField()
        val answer = held.answers.search
        if (field.term.isBlank() || answer == null) return base
        return base.copy(
            hits = answer.items.map(LockerFold::row),
            search_empty = if (answer.items.isEmpty()) {
                EmptyState(headline = LockerFold.fill(LockerCopy.SEARCH_EMPTY, "term" to answer.term), body = LockerCopy.SEARCH_NOTE)
            } else {
                null
            },
        )
    }

    override fun decorate(held: LockerHeld<LockerHomeState>): LockerHomeState {
        val screen = held.screen
        val answered = held.answers.search?.term ?: ""
        val drawing = lens.content(screen) !is ReadContent.Denied
        return screen.copy(
            band = if (held.open && drawing) band(screen.destination) else emptyList(),
            chrome = CHROME,
            search = screen.search?.let { if (it.open_) it.copy(answered_term = answered) else it },
        )
    }

    private fun band(current: LockerHomeState.Destination): List<LockerBandTab> = listOf(
        LockerBandTab(key = "items", label = LockerCopy.BAND_ITEMS, icon_key = "Key", current = current == LockerHomeState.Destination.DESTINATION_ITEMS),
        LockerBandTab(key = "review", label = LockerCopy.BAND_REVIEW, icon_key = "Shield", current = current == LockerHomeState.Destination.DESTINATION_REVIEW),
        LockerBandTab(key = "generate", label = LockerCopy.BAND_GENERATE, icon_key = "Sparkle", current = current == LockerHomeState.Destination.DESTINATION_GENERATE),
        LockerBandTab(key = "search", label = LockerCopy.BAND_SEARCH, icon_key = "Search", current = current == LockerHomeState.Destination.DESTINATION_SEARCH),
        LockerBandTab(key = "more", label = LockerCopy.BAND_MORE, icon_key = "MoreHoriz", current = false),
    )

    private val CHROME: LockerHomeChrome = LockerHomeChrome(
        title = LockerCopy.APP_NAME,
        add_label = LockerCopy.ADD_ITEM,
        retry = LockerCopy.RETRY,
        more_title = LockerCopy.MORE_TITLE,
        more_rows = listOf(
            LockerMoreRow(key = "trash", label = LockerCopy.MORE_TRASH, meta = LockerCopy.MORE_TRASH_META, icon_key = "Trash"),
            LockerMoreRow(key = "facts", label = LockerCopy.MORE_FACTS, meta = LockerCopy.MORE_FACTS_META, icon_key = "Info"),
            LockerMoreRow(key = "lock", label = LockerCopy.LOCK_NOW, meta = LockerCopy.MORE_LOCK_META, icon_key = "Lock"),
        ),
        facts_title = LockerCopy.MORE_FACTS,
        facts = listOf(
            LockerFact(label = LockerCopy.KEEPS_LIST, detail = LockerCopy.KEEPS_LIST_DETAIL),
            LockerFact(label = LockerCopy.KEEPS_SECRET, detail = LockerCopy.KEEPS_SECRET_DETAIL),
            LockerFact(label = LockerCopy.KEEPS_RECEIPTS, detail = LockerCopy.KEEPS_RECEIPTS_DETAIL),
            LockerFact(label = LockerCopy.KEEPS_BACKUP, detail = LockerCopy.KEEPS_BACKUP_DETAIL),
        ),
        search_placeholder = LockerCopy.SEARCH_PLACEHOLDER,
        search_note = LockerCopy.SEARCH_NOTE,
        close_label = LockerCopy.CLOSE,
    )

    internal object Lens : ContentLens<LockerHomeState, LockerHomeData> {
        override fun content(state: LockerHomeState): ReadContent<LockerHomeData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: LockerHomeState, content: ReadContent<LockerHomeData>): LockerHomeState = when (content) {
            is ReadContent.Loading -> state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
            is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
            is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
            is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
        }
    }
}

/**
 * EVERY TABLE LOCKER'S QUERIES READ: the item, its sidecars, the tag plane
 * the star and the tags ride, and the memo's annotation. `AppReadsSpec`
 * holds this to the machine's `rowsChanged`.
 */
public val LOCKER_TABLES: Set<String> = setOf(
    "locker_item",
    "locker_item_field",
    "locker_item_address",
    "locker_item_passkey",
    "locker_item_alias",
    "core_tag",
    "core_concept",
    "core_concept_scheme",
    "knowledge_annotation",
)

/** What home asks: the surface on screen — and nothing while locked (`LockerQueries`). */
public object LockerHomeReads : LockerQueries<LockerHomeState, LockerHomeEvent>(
    screenId = "locker.home",
    tables = LOCKER_TABLES,
    ask = { held, now ->
        val screen = held.screen
        val term = screen.search?.term ?: ""
        listOf(
            when {
                screen.destination == LockerHomeState.Destination.DESTINATION_REVIEW ->
                    AppQueryRequest(locker_review = LockerReviewRequest(tz = now.zone))
                screen.destination == LockerHomeState.Destination.DESTINATION_SEARCH && term.isNotBlank() ->
                    AppQueryRequest(locker_search = LockerSearchRequest(term = term, tz = now.zone))
                // Items — and Generate and an empty search, which read the
                // shelf so a change event on them re-reads something true.
                else -> AppQueryRequest(
                    locker_items = LockerItemsRequest(archived = screen.filter == LockerHomeMachine.ARCHIVED, tz = now.zone),
                )
            },
        )
    },
)
