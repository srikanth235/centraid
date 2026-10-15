package dev.centraid.shared.apps.money

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.MoneyRecurringRequest
import centraid.core.v1.MoneyRecurringStatus
import centraid.core.v1.MoneySearchRequest
import centraid.screen.v1.EmptyState
import centraid.screen.v1.Loading
import centraid.screen.v1.MoneyFact
import centraid.screen.v1.MoneyPageChrome
import centraid.screen.v1.MoneyRecurringData
import centraid.screen.v1.MoneyRecurringEvent
import centraid.screen.v1.MoneyRecurringRow
import centraid.screen.v1.MoneyRecurringState
import centraid.screen.v1.MoneySearchData
import centraid.screen.v1.MoneySearchEvent
import centraid.screen.v1.MoneySearchState
import centraid.screen.v1.SearchField
import centraid.screen.v1.SeatState
import centraid.screen.v1.StatusChip
import dev.centraid.design.copy.MoneyCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.SearchLaw
import dev.centraid.shared.kit.SearchLens
import dev.centraid.shared.screen.Step

/**
 * THE RECURRING CHARGES (#1099, R-1099-14): what the core detected over the last
 * months, with when each is next due and whether this cycle's has posted. The
 * page reads and draws; nothing here is written, and nothing is projected on a
 * calendar (the detector emits a rule and the core places it).
 */
public object MoneyRecurringMachine :
    MoneyQueryMachine<MoneyRecurringState, MoneyRecurringEvent, MoneyRecurringData>("money.recurring", MONEY_TABLES) {
    public const val SCREEN_ID: String = "money.recurring"

    override val lens: ContentLens<MoneyRecurringState, MoneyRecurringData> = Lens

    override fun blank(): MoneyRecurringState = MoneyRecurringState(chrome = chrome(""))

    override fun withSeat(screen: MoneyRecurringState, seat: SeatState): MoneyRecurringState = screen.copy(seat = seat)

    override fun view(held: MoneyHeld<MoneyRecurringState>, event: MoneyRecurringEvent): Step<MoneyHeld<MoneyRecurringState>> =
        when {
            event.opened != null -> reload(
                held.copy(screen = blank().copy(seat = held.screen.seat, chrome = chrome(event.opened.parent))),
            )
            event.refreshed != null -> read(overRows(held))
            else -> Step(held)
        }

    override fun fold(held: MoneyHeld<MoneyRecurringState>): MoneyRecurringData? {
        val answer = held.answers.recurring ?: return null
        val rows = answer.series.mapIndexed { index, line ->
            val detail = listOfNotNull(
                line.next_due?.let { MoneyFold.fill(MoneyCopy.NEXT_DUE, "day" to MoneyFold.dayWords(it, answer.today)) },
                MoneyFold.fill(MoneyCopy.SEEN_TIMES_SHORT, "n" to line.seen_times.toString()),
            ).joinToString(" · ")
            MoneyRecurringRow(
                key = "$index:${line.merchant}",
                merchant = line.merchant,
                meta = "${line.cadence_words.ifEmpty { MoneyFold.cadenceWords(line.cadence) }} · ${line.account_label}",
                amount = MoneyFold.money(line.amount),
                detail = detail,
                chips = when (line.status) {
                    MoneyRecurringStatus.MONEY_RECURRING_STATUS_LATE ->
                        listOf(StatusChip(label = MoneyCopy.CHIP_LATE, tone = StatusChip.Tone.TONE_WARNING))
                    MoneyRecurringStatus.MONEY_RECURRING_STATUS_PAID ->
                        listOf(StatusChip(label = MoneyCopy.CHIP_PAID, tone = StatusChip.Tone.TONE_SEAM))
                    MoneyRecurringStatus.MONEY_RECURRING_STATUS_DUE ->
                        listOf(StatusChip(label = MoneyCopy.CHIP_DUE, tone = StatusChip.Tone.TONE_NEUTRAL))
                    else -> emptyList()
                },
                accessibility_label = listOf(line.merchant, line.cadence_words, detail).filter { it.isNotEmpty() }.joinToString(", "),
            )
        }
        return MoneyRecurringData(
            rows = rows,
            empty = if (rows.isEmpty()) EmptyState(headline = MoneyCopy.RECURRING_EMPTY) else null,
            definitions = answer.definitions.mapNotNull(MoneyFold::definition).map { MoneyFact(label = it.first, detail = it.second) },
            window_note = if (answer.truncated) MoneyCopy.WINDOW_NOTE else "",
        )
    }

    private fun chrome(parent: String): MoneyPageChrome = MoneyPageChrome(
        title = MoneyCopy.RECURRING_TITLE,
        back_label = parent.ifEmpty { MoneyCopy.APP_TITLE },
        retry = MoneyCopy.RETRY,
    )

    override fun decorate(held: MoneyHeld<MoneyRecurringState>): MoneyRecurringState = held.screen

    internal object Lens : ContentLens<MoneyRecurringState, MoneyRecurringData> {
        override fun content(state: MoneyRecurringState): ReadContent<MoneyRecurringData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: MoneyRecurringState, content: ReadContent<MoneyRecurringData>): MoneyRecurringState = when (content) {
            is ReadContent.Loading -> state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
            is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
            is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
            is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
        }
    }
}

public object MoneyRecurringReads : MoneyQueries<MoneyRecurringState, MoneyRecurringEvent>(
    screenId = MoneyRecurringMachine.SCREEN_ID,
    tables = MONEY_TABLES,
    ask = { _, now -> listOf(AppQueryRequest(money_recurring = MoneyRecurringRequest(tz = now.zone))) },
)

/**
 * MONEY'S SEARCH (#1099, R-1099-44), a page of its own the search bar pushes
 * (R-CHROME-2). The core walks month windows back from the current month over a
 * line's words, its name, its category and its memo; this page draws rows and a
 * count, and an empty term reads nothing.
 */
public object MoneySearchMachine :
    MoneyQueryMachine<MoneySearchState, MoneySearchEvent, MoneySearchData>("money.search", MONEY_TABLES) {
    public const val SCREEN_ID: String = "money.search"

    /** Rows asked for. */
    public const val LIMIT: Int = 50

    override val lens: ContentLens<MoneySearchState, MoneySearchData> = SearchContent

    override fun blank(): MoneySearchState = resting(MoneySearchState())

    private fun resting(state: MoneySearchState): MoneySearchState = state.copy(
        resting = EmptyState(headline = MoneyCopy.SEARCH_RESTING),
        loading = null,
        failure = null,
        denied = null,
        data_ = null,
    )

    override fun withSeat(screen: MoneySearchState, seat: SeatState): MoneySearchState = screen.copy(seat = seat)

    private fun term(held: MoneyHeld<MoneySearchState>): String = held.screen.field_?.term?.trim().orEmpty()

    override val refoldsOnView: Boolean get() = false

    // NO TERM, NOTHING TO READ: a change in the vault asks the core nothing.
    override fun idle(held: MoneyHeld<MoneySearchState>): Boolean = term(held).isEmpty()

    override fun view(held: MoneyHeld<MoneySearchState>, event: MoneySearchEvent): Step<MoneyHeld<MoneySearchState>> =
        when {
            event.opened != null ->
                Step(held.copy(screen = resting(blank().copy(seat = held.screen.seat, field_ = SearchField(open_ = true))), answers = MoneyAnswers()))
            event.term != null -> {
                val typed = SearchLaw.term(Field, held, event.term.term).state
                if (term(typed).isEmpty()) {
                    Step(typed.copy(screen = resting(typed.screen), answers = MoneyAnswers()))
                } else {
                    // THE HITS ON SCREEN STAY while the next term reads.
                    read(overRows(typed))
                }
            }
            event.cleared != null -> {
                val closed = SearchLaw.closed(Field, held).state
                Step(closed.copy(screen = resting(closed.screen.copy(field_ = SearchField(open_ = true))), answers = MoneyAnswers()))
            }
            event.refreshed != null -> if (term(held).isEmpty()) Step(held) else read(overRows(held))
            else -> Step(held)
        }

    override fun absorb(held: MoneyHeld<MoneySearchState>): MoneyHeld<MoneySearchState> =
        SearchLaw.answered(
            Field,
            held,
            held.answers.search?.term ?: "",
            held.answers.search?.corrected.orEmpty(),
            rows = held.answers.search?.rows?.size,
        )

    override fun unanswered(held: MoneyHeld<MoneySearchState>): MoneyHeld<MoneySearchState> =
        SearchLaw.unasked(Field, held)

    override fun fold(held: MoneyHeld<MoneySearchState>): MoneySearchData? {
        val answer = held.answers.search ?: return null
        val shown = term(held)
        val rows = answer.rows.map { MoneyFold.row(it, today = "", withAccount = true, withDay = true) }
        val total = answer.total_matches
        return MoneySearchData(
            rows = rows,
            count_label = when {
                rows.isEmpty() -> ""
                total > rows.size -> MoneyFold.fill(MoneyCopy.MATCHES_OF, "n" to rows.size.toString(), "total" to total.toString())
                else -> MoneyFold.count(total, MoneyCopy.MATCH_ONE, MoneyCopy.MATCH_MANY)
            },
            empty = if (rows.isEmpty()) {
                SearchLaw.asking(
                    EmptyState(headline = MoneyFold.fill(MoneyCopy.NOTHING_MATCHES, "term" to shown), body = MoneyCopy.SEARCH_NOT_SEARCHED),
                    held.screen.field_ ?: SearchField(),
                )
            } else {
                null
            },
        )
    }

    override fun decorate(held: MoneyHeld<MoneySearchState>): MoneySearchState = held.screen.copy(
        chrome = MoneyPageChrome(title = MoneyCopy.SEARCH_TITLE, back_label = MoneyCopy.APP_TITLE, retry = MoneyCopy.RETRY),
        placeholder = MoneyCopy.SEARCH_PLACEHOLDER,
        clear_label = MoneyCopy.CLEAR,
    )

    private object Field : SearchLens<MoneyHeld<MoneySearchState>> {
        override val screenId: String = SCREEN_ID
        override val asks: Boolean = true

        override fun field(state: MoneyHeld<MoneySearchState>): SearchField = state.screen.field_ ?: SearchField()

        override fun with(state: MoneyHeld<MoneySearchState>, field: SearchField): MoneyHeld<MoneySearchState> =
            state.copy(screen = state.screen.copy(field_ = field))
    }

    /** The content oneof less `resting`, which only this machine sets and clears. */
    private object SearchContent : ContentLens<MoneySearchState, MoneySearchData> {
        override fun content(state: MoneySearchState): ReadContent<MoneySearchData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: MoneySearchState, content: ReadContent<MoneySearchData>): MoneySearchState = when (content) {
            is ReadContent.Loading -> state.copy(resting = null, loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
            is ReadContent.Failed -> state.copy(resting = null, loading = null, failure = content.failure, denied = null, data_ = null)
            is ReadContent.Denied -> state.copy(resting = null, loading = null, failure = null, denied = content.denied, data_ = null)
            is ReadContent.Data -> state.copy(resting = null, loading = null, failure = null, denied = null, data_ = content.data)
        }
    }
}

/** A term reads; no term asks nothing. */
public object MoneySearchReads : MoneyQueries<MoneySearchState, MoneySearchEvent>(
    screenId = MoneySearchMachine.SCREEN_ID,
    tables = MONEY_TABLES,
    ask = { held, now ->
        (held.screen.field_?.term?.trim() ?: "").takeIf { it.isNotEmpty() }?.let {
            listOf(
                AppQueryRequest(
                    money_search = MoneySearchRequest(tz = now.zone, month = "", term = it, limit = MoneySearchMachine.LIMIT),
                ),
            )
        }
    },
)
