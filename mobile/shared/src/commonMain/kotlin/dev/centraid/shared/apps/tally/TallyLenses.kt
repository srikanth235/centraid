package dev.centraid.shared.apps.tally

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.TallyRecurringRequest
import centraid.core.v1.TallySearchRequest
import centraid.core.v1.TallySpending
import centraid.core.v1.TallySpendingRequest
import centraid.screen.v1.EmptyState
import centraid.screen.v1.Loading
import centraid.screen.v1.Money
import centraid.screen.v1.SearchField
import centraid.screen.v1.SeatState
import centraid.screen.v1.StatusChip
import centraid.screen.v1.TallyCategoryRow
import centraid.screen.v1.TallyCurrencySpend
import centraid.screen.v1.TallyRecurringData
import centraid.screen.v1.TallyRecurringEvent
import centraid.screen.v1.TallyRecurringState
import centraid.screen.v1.TallySearchChrome
import centraid.screen.v1.TallySearchData
import centraid.screen.v1.TallySearchEvent
import centraid.screen.v1.TallySearchState
import centraid.screen.v1.TallySpendFact
import centraid.screen.v1.TallySpendingChrome
import centraid.screen.v1.TallySpendingData
import centraid.screen.v1.TallySpendingEvent
import centraid.screen.v1.TallySpendingState
import centraid.screen.v1.TallyTemplateRow
import dev.centraid.design.copy.TallyCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.SearchLaw
import dev.centraid.shared.kit.SearchLens
import dev.centraid.shared.kit.time.CivilWords
import dev.centraid.shared.screen.Step

// ---------------------------------------------------------------------------
// tally.recurring
// ---------------------------------------------------------------------------

/**
 * THE STANDING ORDERS (#1046), read-only: each template's schedule as the
 * core's one summariser put it — or no preview, said so, when it cannot be a
 * sentence — its payer, group, zone and status. Pausing, skipping and
 * materialising stay off the phone until the vault's recurrence plane serves
 * them (`recurrence_plane_missing`).
 */
public object TallyRecurringMachine :
    TallyQueryMachine<TallyRecurringState, TallyRecurringEvent, TallyRecurringData>(
        "tally.recurring",
        setOf("tally_recurring_expense", "tally_group", "social_circle", "core_party"),
    ) {
    public const val SCREEN_ID: String = "tally.recurring"

    override val lens: ContentLens<TallyRecurringState, TallyRecurringData> = RecurringLens

    override fun blank(): TallyRecurringState = TallyRecurringState(title = TallyCopy.RECURRING_TITLE)

    override fun withSeat(screen: TallyRecurringState, seat: SeatState): TallyRecurringState = screen.copy(seat = seat)

    override fun view(held: TallyHeld<TallyRecurringState>, event: TallyRecurringEvent): Step<TallyHeld<TallyRecurringState>> =
        when {
            event.opened != null -> reload(held)
            event.refreshed != null -> read(overRows(held))
            else -> Step(held)
        }

    override fun fold(held: TallyHeld<TallyRecurringState>): TallyRecurringData? {
        val answer = held.answers.recurring ?: return null
        val rows = answer.templates.map { template ->
            val schedule = template.schedule?.takeIf { it.isNotEmpty() } ?: TallyCopy.NO_PREVIEW
            val meta = listOf(
                "${template.paid_by?.name ?: TallyCopy.SOMEONE} ${TallyCopy.PAYS_WORD}",
                template.group_name.ifEmpty { TallyCopy.NO_GROUP_LABEL },
                template.tz,
            ).filter { it.isNotEmpty() }.joinToString(" · ")
            val status = when (template.status) {
                "active" -> StatusChip(label = TallyCopy.STATUS_ACTIVE, tone = StatusChip.Tone.TONE_NEUTRAL)
                "paused" -> StatusChip(label = TallyCopy.STATUS_PAUSED, tone = StatusChip.Tone.TONE_SEAM)
                "ended" -> StatusChip(label = TallyCopy.STATUS_ENDED, tone = StatusChip.Tone.TONE_NEUTRAL)
                else -> StatusChip(label = template.status, tone = StatusChip.Tone.TONE_NEUTRAL)
            }
            TallyTemplateRow(
                template_id = template.template_id,
                title = template.description.ifEmpty { TallyCopy.UNTITLED_EXPENSE },
                schedule = schedule,
                meta = meta,
                amount = TallyFold.money(template.amount),
                status = status,
                accessibility_label = "${template.description}, $schedule, ${status.label}",
            )
        }
        return TallyRecurringData(
            templates = rows,
            empty = if (rows.isEmpty()) EmptyState(headline = TallyCopy.RECURRING_EMPTY, body = TallyCopy.RECURRING_EMPTY_BODY) else null,
        )
    }

    override fun decorate(held: TallyHeld<TallyRecurringState>): TallyRecurringState =
        held.screen.copy(chrome = TallyGroupMachine.CHROME)

    private object RecurringLens : ContentLens<TallyRecurringState, TallyRecurringData> {
        override fun content(state: TallyRecurringState): ReadContent<TallyRecurringData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: TallyRecurringState, content: ReadContent<TallyRecurringData>): TallyRecurringState =
            when (content) {
                is ReadContent.Loading ->
                    state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
                is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
                is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
                is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
            }
    }
}

public object TallyRecurringReads : TallyQueries<TallyRecurringState, TallyRecurringEvent>(
    screenId = TallyRecurringMachine.SCREEN_ID,
    tables = TallyRecurringMachine.tables,
    ask = { _, _ -> listOf(AppQueryRequest(tally_recurring = TallyRecurringRequest())) },
)

// ---------------------------------------------------------------------------
// tally.spending
// ---------------------------------------------------------------------------

/**
 * WHAT A MONTH WENT ON (#1046): category totals and paid-versus-share, ONE
 * BLOCK PER CURRENCY — a month in EUR and JPY is two blocks, never a total.
 * The month is state; ‹ and › step it, and › stops at the month today is in.
 */
public object TallySpendingMachine :
    TallyQueryMachine<TallySpendingState, TallySpendingEvent, TallySpendingData>("tally.spending", TALLY_LEDGER_TABLES) {
    public const val SCREEN_ID: String = "tally.spending"

    override val lens: ContentLens<TallySpendingState, TallySpendingData> = SpendingLens

    override fun blank(): TallySpendingState = TallySpendingState()

    override fun withSeat(screen: TallySpendingState, seat: SeatState): TallySpendingState = screen.copy(seat = seat)

    override fun view(held: TallyHeld<TallySpendingState>, event: TallySpendingEvent): Step<TallyHeld<TallySpendingState>> =
        when {
            // LANDS ON THIS MONTH: the answer names it.
            event.opened != null -> reload(held.copy(screen = held.screen.copy(month = "")))
            event.refreshed != null -> read(overRows(held))
            event.month_stepped != null -> {
                val moved = stepMonth(held.screen.month, event.month_stepped.months)
                val current = currentMonth(held)
                if (moved == null || event.month_stepped.months == 0 || (current != null && moved > current)) {
                    Step(held)
                } else {
                    // A MONTH IS A WINDOW: skeletons, not the last month's rows
                    // under this month's name.
                    read(
                        held.copy(
                            screen = lens.with(held.screen.copy(month = moved), ReadContent.Loading(firstLoad = true)),
                        ),
                    )
                }
            }
            else -> Step(held)
        }

    /** The first answer names the month; later ones are for the month asked. */
    override fun absorb(held: TallyHeld<TallySpendingState>): TallyHeld<TallySpendingState> {
        val month = held.answers.spending?.month ?: return held
        return if (held.screen.month.isEmpty()) held.copy(screen = held.screen.copy(month = month)) else held
    }

    private fun currentMonth(held: TallyHeld<TallySpendingState>): String? =
        held.answers.spending?.today?.takeIf { it.length >= MONTH }?.take(MONTH)

    /** `2026-03` stepped by [months], or null for a month that does not parse. */
    internal fun stepMonth(month: String, months: Int): String? {
        if (month.length != MONTH || month[4] != '-') return null
        val year = month.take(4).toIntOrNull() ?: return null
        val number = month.substring(5).toIntOrNull()?.takeIf { it in 1..12 } ?: return null
        val index = year * 12 + (number - 1) + months
        val y = index / 12
        val m = index % 12 + 1
        return "${y.toString().padStart(4, '0')}-${m.toString().padStart(2, '0')}"
    }

    override fun fold(held: TallyHeld<TallySpendingState>): TallySpendingData? {
        val answer = held.answers.spending ?: return null
        if (held.screen.month.isNotEmpty() && answer.month != held.screen.month) return null
        return fold(answer)
    }

    internal fun fold(answer: TallySpending): TallySpendingData {
        val currencies = answer.month_total.map { it.currency }
        val blocks = currencies.map { currency ->
            val total = answer.month_total.first { it.currency == currency }
            fun of(list: List<centraid.core.v1.TallyMoney>): Money? = list.firstOrNull { it.currency == currency }?.let(TallyFold::money)
            val categories = answer.categories.filter { it.total?.currency == currency }
            TallyCurrencySpend(
                currency = currency,
                total = TallyFold.money(total),
                categories = categories.map {
                    val minor = it.total?.minor ?: 0L
                    TallyCategoryRow(
                        category = it.category,
                        label = TallyFold.categoryLabel(it.category),
                        icon_key = TallyFold.categoryIcon(it.category),
                        total = TallyFold.money(it.total),
                        share_permille = if (total.minor > 0) ((minor * PERMILLE) / total.minor).toInt().coerceIn(0, PERMILLE.toInt()) else 0,
                    )
                },
                facts = listOfNotNull(
                    of(answer.paid)?.let { TallySpendFact(label = TallyCopy.SPEND_PAID, amount = it) },
                    of(answer.share)?.let { TallySpendFact(label = TallyCopy.SPEND_SHARE, amount = it) },
                    of(answer.difference)?.let {
                        TallySpendFact(label = TallyCopy.SPEND_DIFFERENCE, amount = TallyFold.magnitude(it), note = TallyCopy.SPEND_DIFFERENCE_NOTE)
                    },
                ),
            )
        }
        return TallySpendingData(
            currencies = blocks,
            empty = if (blocks.isEmpty()) EmptyState(headline = TallyCopy.SPENDING_EMPTY) else null,
            note = if (blocks.size > 1) TallyCopy.SPENDING_CURRENCIES_NOTE else "",
        )
    }

    override fun decorate(held: TallyHeld<TallySpendingState>): TallySpendingState {
        val screen = held.screen
        val month = screen.month
        val label = if (month.length == MONTH) {
            "${CivilWords.monthName(month.substring(5).toIntOrNull() ?: 0)} ${month.take(4)}"
        } else {
            ""
        }
        val current = currentMonth(held)
        return screen.copy(
            month_label = label,
            next_enabled = current != null && month.isNotEmpty() && month < current,
            previous_enabled = month.isNotEmpty(),
            chrome = CHROME,
        )
    }

    private val CHROME = TallySpendingChrome(
        title = TallyCopy.SPENDING_TITLE,
        previous = TallyCopy.PREVIOUS_MONTH,
        next = TallyCopy.NEXT_MONTH,
        retry = TallyCopy.RETRY,
        loading = TallyCopy.LOADING,
    )

    private const val MONTH: Int = 7
    private const val PERMILLE: Long = 1000

    private object SpendingLens : ContentLens<TallySpendingState, TallySpendingData> {
        override fun content(state: TallySpendingState): ReadContent<TallySpendingData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: TallySpendingState, content: ReadContent<TallySpendingData>): TallySpendingState =
            when (content) {
                is ReadContent.Loading ->
                    state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
                is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
                is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
                is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
            }
    }
}

public object TallySpendingReads : TallyQueries<TallySpendingState, TallySpendingEvent>(
    screenId = TallySpendingMachine.SCREEN_ID,
    tables = TALLY_LEDGER_TABLES,
    ask = { held, now -> listOf(AppQueryRequest(tally_spending = TallySpendingRequest(tz = now.zone, month = held.screen.month))) },
)

// ---------------------------------------------------------------------------
// tally.search
// ---------------------------------------------------------------------------

/**
 * SEARCH EXPENSE DESCRIPTIONS (#1046). A field, not a destination: nothing
 * typed is the resting sentence and no read; each term reads, one at a time;
 * clearing clears the term and its answer (the kit's search law).
 */
public object TallySearchMachine :
    TallyQueryMachine<TallySearchState, TallySearchEvent, TallySearchData>("tally.search", TALLY_LEDGER_TABLES) {
    public const val SCREEN_ID: String = "tally.search"

    /** Hits per answer; `total_matches` says how many there were. */
    public const val LIMIT: Int = 50

    override val lens: ContentLens<TallySearchState, TallySearchData> = SearchContent

    override fun blank(): TallySearchState = TallySearchState(field_ = SearchField(open_ = true))

    override fun initial(): TallyHeld<TallySearchState> = TallyHeld(screen = decorate(TallyHeld(resting(blank()))))

    override fun withSeat(screen: TallySearchState, seat: SeatState): TallySearchState = screen.copy(seat = seat)

    private fun resting(screen: TallySearchState): TallySearchState = screen.copy(
        resting = EmptyState(headline = TallyCopy.SEARCH_RESTING, body = TallyCopy.SEARCH_NOT_SEARCHED),
        loading = null,
        failure = null,
        denied = null,
        data_ = null,
    )

    /** NO TERM, NO READ — a change event over the resting sentence reads nothing. */
    override fun reduce(
        state: TallyHeld<TallySearchState>,
        event: TallyInput<TallySearchEvent>,
    ): Step<TallyHeld<TallySearchState>> {
        if (event is TallyInput.Changed && term(state).isEmpty()) return Step(state)
        return super.reduce(state, event)
    }

    private fun term(held: TallyHeld<TallySearchState>): String = held.screen.field_?.term?.trim() ?: ""

    override fun view(held: TallyHeld<TallySearchState>, event: TallySearchEvent): Step<TallyHeld<TallySearchState>> =
        when {
            event.opened != null -> Step(held.copy(screen = resting(blank().copy(seat = held.screen.seat)), answers = TallyAnswers()))
            event.term != null -> {
                val typed = SearchLaw.term(Field, held, event.term.term).state
                if (term(typed).isEmpty()) {
                    Step(typed.copy(screen = resting(typed.screen), answers = TallyAnswers()))
                } else {
                    // THE HITS ON SCREEN STAY while the next term reads.
                    read(overRows(typed))
                }
            }
            event.cleared != null -> {
                val closed = SearchLaw.closed(Field, held).state
                Step(closed.copy(screen = resting(closed.screen.copy(field_ = SearchField(open_ = true))), answers = TallyAnswers()))
            }
            event.refreshed != null -> if (term(held).isEmpty()) Step(held) else read(overRows(held))
            else -> Step(held)
        }

    override fun absorb(held: TallyHeld<TallySearchState>): TallyHeld<TallySearchState> =
        SearchLaw.answered(Field, held, held.screen.field_?.term ?: "")

    override fun fold(held: TallyHeld<TallySearchState>): TallySearchData? {
        val answer = held.answers.search ?: return null
        val shownTerm = term(held)
        val rows = answer.results.map { TallyFold.expenseRow(it, today = null, withGroup = true) }
        val total = answer.total_matches.toInt()
        return TallySearchData(
            results = rows,
            count_label = when {
                rows.isEmpty() -> ""
                total > rows.size -> "${rows.size} ${TallyCopy.OF_WORD} ${TallyFold.count(total, TallyCopy.MATCH_ONE, TallyCopy.MATCH_MANY)}"
                else -> TallyFold.count(total, TallyCopy.MATCH_ONE, TallyCopy.MATCH_MANY)
            },
            empty = if (rows.isEmpty()) {
                EmptyState(headline = "${TallyCopy.NOTHING_MATCHES} “$shownTerm”.", body = TallyCopy.SEARCH_NOT_SEARCHED)
            } else {
                null
            },
        )
    }

    override fun decorate(held: TallyHeld<TallySearchState>): TallySearchState = held.screen.copy(chrome = CHROME)

    private val CHROME = TallySearchChrome(
        title = TallyCopy.SEARCH_TITLE,
        placeholder = TallyCopy.SEARCH_PLACEHOLDER,
        close = TallyCopy.CLEAR,
        retry = TallyCopy.RETRY,
        loading = TallyCopy.LOADING,
    )

    private object Field : SearchLens<TallyHeld<TallySearchState>> {
        override val screenId: String = SCREEN_ID

        override fun field(state: TallyHeld<TallySearchState>): SearchField = state.screen.field_ ?: SearchField()

        override fun with(state: TallyHeld<TallySearchState>, field: SearchField): TallyHeld<TallySearchState> =
            state.copy(screen = state.screen.copy(field_ = field))
    }

    /** The content oneof less `resting`, which only this machine sets and clears. */
    private object SearchContent : ContentLens<TallySearchState, TallySearchData> {
        override fun content(state: TallySearchState): ReadContent<TallySearchData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: TallySearchState, content: ReadContent<TallySearchData>): TallySearchState = when (content) {
            is ReadContent.Loading -> state.copy(
                resting = null,
                loading = Loading(first_load = content.firstLoad),
                failure = null,
                denied = null,
                data_ = null,
            )
            is ReadContent.Failed -> state.copy(resting = null, loading = null, failure = content.failure, denied = null, data_ = null)
            is ReadContent.Denied -> state.copy(resting = null, loading = null, failure = null, denied = content.denied, data_ = null)
            is ReadContent.Data -> state.copy(resting = null, loading = null, failure = null, denied = null, data_ = content.data)
        }
    }
}

/** A term reads; no term asks nothing. */
public object TallySearchReads : TallyQueries<TallySearchState, TallySearchEvent>(
    screenId = TallySearchMachine.SCREEN_ID,
    tables = TALLY_LEDGER_TABLES,
    ask = { held, _ ->
        (held.screen.field_?.term?.trim() ?: "").takeIf { it.isNotEmpty() }?.let {
            listOf(AppQueryRequest(tally_search = TallySearchRequest(term = it, limit = TallySearchMachine.LIMIT)))
        }
    },
)
