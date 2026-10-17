package dev.centraid.shared.apps.money

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.MoneyAccountsRequest
import centraid.core.v1.MoneyActivityRequest
import centraid.core.v1.MoneyCashflowRequest
import centraid.core.v1.MoneyCategoriesRequest
import centraid.core.v1.MoneyCategoryFilter
import centraid.core.v1.MoneySpendingRequest
import centraid.screen.v1.EmptyState
import centraid.screen.v1.Loading
import centraid.screen.v1.MoneyActivityData
import centraid.screen.v1.MoneyBandTab
import centraid.screen.v1.MoneyCashflowData
import centraid.screen.v1.MoneyCashflowMonth
import centraid.screen.v1.MoneyCashflowSeries
import centraid.screen.v1.MoneyCategoryLine
import centraid.screen.v1.MoneyCategoryTable
import centraid.screen.v1.MoneyChip
import centraid.screen.v1.MoneyChoice
import centraid.screen.v1.MoneyFact
import centraid.screen.v1.MoneyFigure
import centraid.screen.v1.MoneyHero
import centraid.screen.v1.MoneyHomeChrome
import centraid.screen.v1.MoneyHomeData
import centraid.screen.v1.MoneyHomeEvent
import centraid.screen.v1.MoneyHomeState
import centraid.screen.v1.MoneyInOutNet
import centraid.screen.v1.MoneyMoreRow
import centraid.screen.v1.MoneySpendingData
import centraid.screen.v1.SeatState
import centraid.screen.v1.StatusChip
import dev.centraid.design.copy.MoneyCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.nav.ScreenIds
import dev.centraid.shared.screen.Step

/**
 * MONEY'S HOME (#1099, R-1099-13): Spending · Activity · Cash flow, and More as a
 * sheet. One screen, the tab a parameter (law 2).
 *
 * Roots are places only (R-CHROME-5). Search is the bar under the title and
 * pushes `money.search` (R-CHROME-2); the header's one trailing action is the
 * Plus glyph, spoken "Import statement" (R-CHROME-1); Activity's chip row is
 * month, account and category with no sort chip (R-CHROME-3); More's rows are
 * machine data (R-CHROME-4).
 *
 * EACH TAB READS ITS OWN QUERY. Moving to a tab whose answer is already held
 * draws it; stepping the month or changing a filter clears what depended on it
 * and reads again. Activity asks for [PAGE] rows at a time: Show more asks for
 * a bigger window, up to the ceiling the core serves ([MAX_ROWS]).
 */
public object MoneyHomeMachine :
    MoneyQueryMachine<MoneyHomeState, MoneyHomeEvent, MoneyHomeData>(ScreenIds.MONEY_HOME, MONEY_TABLES) {
    public const val SCREEN_ID: String = ScreenIds.MONEY_HOME

    /** Activity rows asked for per page. */
    public const val PAGE: Int = 50

    /** The most Activity rows one window holds (the core's page ceiling). */
    public const val MAX_ROWS: Int = 500

    public const val BAND_SPENDING: String = "spending"
    public const val BAND_ACTIVITY: String = "activity"
    public const val BAND_CASHFLOW: String = "cashflow"
    public const val BAND_MORE: String = "more"

    public const val MORE_ACCOUNTS: String = "accounts"
    public const val MORE_RULES: String = "rules"
    public const val MORE_CATEGORIES: String = "categories"
    public const val MORE_IMPORT: String = "import"

    public const val FILTER_UNCATEGORISED: String = "uncategorised"

    private const val BP: Long = 10_000L
    private const val BP_PERCENT: Long = 100L

    override val lens: ContentLens<MoneyHomeState, MoneyHomeData> = Lens

    override fun blank(): MoneyHomeState = MoneyHomeState(
        destination = MoneyHomeState.Destination.DESTINATION_SPENDING,
        sheet = MoneyHomeState.Sheet.SHEET_NONE,
        activity_shown = PAGE,
    )

    override fun withSeat(screen: MoneyHomeState, seat: SeatState): MoneyHomeState = screen.copy(seat = seat)

    override fun view(held: MoneyHeld<MoneyHomeState>, event: MoneyHomeEvent): Step<MoneyHeld<MoneyHomeState>> {
        val screen = held.screen
        return when {
            event.opened != null -> {
                val destination = event.opened.destination
                    .takeUnless { it == MoneyHomeState.Destination.DESTINATION_UNSPECIFIED }
                    ?: MoneyHomeState.Destination.DESTINATION_SPENDING
                reload(
                    held.copy(
                        screen = screen.copy(
                            destination = destination,
                            sheet = MoneyHomeState.Sheet.SHEET_NONE,
                            month = "",
                            account_id = "",
                            category_filter = "",
                            activity_shown = PAGE,
                        ),
                    ),
                )
            }

            event.refreshed != null -> read(overRows(held))

            event.band != null -> when (event.band.key) {
                BAND_SPENDING -> moveTo(held, MoneyHomeState.Destination.DESTINATION_SPENDING)
                BAND_ACTIVITY -> moveTo(held, MoneyHomeState.Destination.DESTINATION_ACTIVITY)
                BAND_CASHFLOW -> moveTo(held, MoneyHomeState.Destination.DESTINATION_CASHFLOW)
                BAND_MORE -> Step(held.copy(screen = screen.copy(sheet = MoneyHomeState.Sheet.SHEET_MORE)))
                else -> Step(held)
            }

            event.month_stepped != null -> stepMonth(held, event.month_stepped.months)

            event.month_picked != null -> setMonth(held, event.month_picked.month)

            event.chip != null -> Step(
                held.copy(
                    screen = screen.copy(
                        sheet = when (event.chip.key) {
                            "month" -> MoneyHomeState.Sheet.SHEET_MONTH
                            "account" -> MoneyHomeState.Sheet.SHEET_ACCOUNT
                            "category" -> MoneyHomeState.Sheet.SHEET_CATEGORY
                            else -> screen.sheet
                        },
                    ),
                ),
            )

            event.account_picked != null -> refilter(
                held.copy(screen = screen.copy(account_id = event.account_picked.account_id)),
            )

            event.category_picked != null -> refilter(
                held.copy(screen = screen.copy(category_filter = event.category_picked.key)),
            )

            event.sheet_closed != null ->
                Step(held.copy(screen = screen.copy(sheet = MoneyHomeState.Sheet.SHEET_NONE)))

            // A bigger window: the rows on screen stay while the read lands.
            event.show_more != null -> {
                val grown = (screen.activity_shown + PAGE).coerceAtMost(MAX_ROWS)
                if (grown == screen.activity_shown) Step(held) else read(overRows(held.copy(screen = screen.copy(activity_shown = grown))))
            }

            // The More rows are routes the shell takes; the sheet closes behind them.
            event.more != null -> Step(held.copy(screen = screen.copy(sheet = MoneyHomeState.Sheet.SHEET_NONE)))

            // INTENTS the shell routes: nothing changes here.
            else -> Step(held)
        }
    }

    /** A tab. The same tab again is nothing (the kit's band law). */
    private fun moveTo(held: MoneyHeld<MoneyHomeState>, to: MoneyHomeState.Destination): Step<MoneyHeld<MoneyHomeState>> {
        if (to == held.screen.destination) return Step(held)
        val moved = held.copy(
            screen = held.screen.copy(destination = to, sheet = MoneyHomeState.Sheet.SHEET_NONE),
        )
        return if (answerFor(moved) && fold(moved) != null) {
            Step(moved.copy(screen = lens.with(moved.screen, ReadContent.Data(fold(moved)!!))))
        } else {
            read(moved.copy(screen = lens.with(moved.screen, ReadContent.Loading(firstLoad = true))))
        }
    }

    /** Is there a held answer for the tab on screen? */
    private fun answerFor(held: MoneyHeld<MoneyHomeState>): Boolean = when (held.screen.destination) {
        MoneyHomeState.Destination.DESTINATION_ACTIVITY ->
            held.answers.activity != null && held.answers.accounts != null && held.answers.categories != null
        MoneyHomeState.Destination.DESTINATION_CASHFLOW -> held.answers.cashflow != null
        else -> held.answers.spending != null
    }

    private fun stepMonth(held: MoneyHeld<MoneyHomeState>, months: Int): Step<MoneyHeld<MoneyHomeState>> {
        val current = currentMonth(held)
        if (current.isEmpty() || months == 0) return Step(held)
        return setMonth(held, MoneyFold.shiftMonth(current, months))
    }

    private fun setMonth(held: MoneyHeld<MoneyHomeState>, month: String): Step<MoneyHeld<MoneyHomeState>> {
        val today = todayMonth(held)
        // THERE IS NO MONTH AFTER THIS ONE: nothing is dated beyond today's month's reach.
        val bounded = if (today.isNotEmpty() && month > today) today else month
        return reload(
            held.copy(
                screen = held.screen.copy(
                    month = bounded,
                    sheet = MoneyHomeState.Sheet.SHEET_NONE,
                    activity_shown = PAGE,
                ),
            ),
        )
    }

    /** A filter changed: what Activity held no longer answers it. */
    private fun refilter(held: MoneyHeld<MoneyHomeState>): Step<MoneyHeld<MoneyHomeState>> = reload(
        held.copy(
            screen = held.screen.copy(sheet = MoneyHomeState.Sheet.SHEET_NONE, activity_shown = PAGE),
        ),
    )

    /** The month in view: the one asked for, else the one the last answer was for. */
    private fun currentMonth(held: MoneyHeld<MoneyHomeState>): String =
        held.screen.month.ifEmpty { answeredMonth(held) }

    private fun answeredMonth(held: MoneyHeld<MoneyHomeState>): String = when (held.screen.destination) {
        MoneyHomeState.Destination.DESTINATION_ACTIVITY -> held.answers.activity?.month
        MoneyHomeState.Destination.DESTINATION_CASHFLOW -> held.answers.cashflow?.through
        else -> held.answers.spending?.month
    }.orEmpty()

    private fun todayOf(held: MoneyHeld<MoneyHomeState>): String =
        when (held.screen.destination) {
            MoneyHomeState.Destination.DESTINATION_ACTIVITY -> held.answers.activity?.today
            MoneyHomeState.Destination.DESTINATION_CASHFLOW -> held.answers.cashflow?.today
            else -> held.answers.spending?.today
        }.orEmpty()

    private fun todayMonth(held: MoneyHeld<MoneyHomeState>): String = MoneyFold.monthOf(todayOf(held)).takeIf { todayOf(held).isNotEmpty() }.orEmpty()

    override fun absorb(held: MoneyHeld<MoneyHomeState>): MoneyHeld<MoneyHomeState> {
        // THE MONTH THE ANSWER WAS FOR is the month in view from now on, so a
        // step is arithmetic over a month and never over "this month".
        val answered = answeredMonth(held)
        return if (held.screen.month.isEmpty() && answered.isNotEmpty()) {
            held.copy(screen = held.screen.copy(month = answered))
        } else {
            held
        }
    }

    override fun fold(held: MoneyHeld<MoneyHomeState>): MoneyHomeData? {
        val screen = held.screen
        val today = todayOf(held)
        if (today.isEmpty()) return null
        val month = currentMonth(held)
        val base = MoneyHomeData(
            today = today,
            month_label = MoneyFold.monthLabel(month),
            can_step_next = month.isNotEmpty() && month < MoneyFold.monthOf(today),
            // THE STEPPER IS SPENDING'S AND ACTIVITY'S. Cash flow reads twelve months at
            // once, so a month to step through there would move nothing it draws.
            shows_month = screen.destination != MoneyHomeState.Destination.DESTINATION_UNSPECIFIED &&
                screen.destination != MoneyHomeState.Destination.DESTINATION_CASHFLOW,
            month_options = MoneyFold.monthOptions(MoneyFold.monthOf(today), month),
        )
        return when (screen.destination) {
            MoneyHomeState.Destination.DESTINATION_ACTIVITY -> activity(held, base)
            MoneyHomeState.Destination.DESTINATION_CASHFLOW -> cashflow(held, base)
            else -> spending(held, base)
        }
    }

    // --- Spending ----------------------------------------------------------

    private fun spending(held: MoneyHeld<MoneyHomeState>, base: MoneyHomeData): MoneyHomeData? {
        val answer = held.answers.spending ?: return null
        if (answer.empty) {
            return base.copy(
                spending = MoneySpendingData(
                    empty = EmptyState(headline = MoneyCopy.DAY_ONE, action_label = MoneyCopy.IMPORT_ACTION),
                ),
            )
        }
        val currentMonth = answer.month == MoneyFold.monthOf(answer.today)
        val tickBp = if (answer.days_in_month > 0) answer.day_of_month.toLong() * BP / answer.days_in_month else 0L
        val heroes = answer.per_currency.map { line ->
            val planned = line.planned
            val left = line.left
            val over = (left?.minor ?: 0L) < 0L
            MoneyHero(
                spent = MoneyFold.money(line.spent),
                spent_label = MoneyCopy.SPENT,
                figures = buildList {
                    if (planned != null) add(MoneyFold.figure(MoneyCopy.PLANNED, planned))
                    if (left != null) {
                        add(MoneyFold.figure(MoneyCopy.LEFT, left, if (over) StatusChip.Tone.TONE_NET else StatusChip.Tone.TONE_NEUTRAL))
                    }
                    if ((line.refund_credit?.minor ?: 0L) != 0L) add(MoneyFold.figure(MoneyCopy.REFUNDS, line.refund_credit))
                },
                has_bar = planned != null,
                fill_bp = (line.progress_bp ?: 0L).coerceIn(0L, BP).toInt(),
                tick_bp = if (currentMonth) tickBp.toInt() else 0,
                over = over,
                accessibility_label = if (planned == null) {
                    MoneyCopy.SPENT
                } else {
                    MoneyFold.fill(
                        MoneyCopy.BAR_SPOKEN,
                        "percent" to ((line.progress_bp ?: 0L) / BP_PERCENT).toString(),
                        "day" to answer.day_of_month.toString(),
                        "days" to answer.days_in_month.toString(),
                    )
                },
            )
        }
        val inOutNet = answer.in_out_net.map { line ->
            MoneyInOutNet(
                figures = listOf(
                    MoneyFold.figure(MoneyCopy.IN, line.incoming),
                    MoneyFold.figure(MoneyCopy.OUT, line.outgoing),
                    MoneyFold.figure(MoneyCopy.NET, line.net, MoneyFold.signTone(line.net)),
                ),
            )
        }
        val currencies = answer.categories.map { it.currency }.distinct()
        val tables = currencies.map { currency ->
            MoneyCategoryTable(
                heading = if (currencies.size > 1) currency else "",
                currency = currency,
                rows = answer.categories.filter { it.currency == currency }.map { line ->
                    val planned = line.planned
                    val left = line.left
                    MoneyCategoryLine(
                        category_id = line.category_id,
                        label = line.label,
                        has_plan = planned != null,
                        planned = MoneyFold.money(planned),
                        spent = MoneyFold.money(line.spent),
                        left = MoneyFold.money(left),
                        over = line.over,
                        accessibility_label = listOf(line.label, if (line.over) MoneyCopy.OVER_PLAN else "")
                            .filter { it.isNotEmpty() }.joinToString(", "),
                    )
                },
            )
        }
        val needs = answer.uncategorised.sumOf { it.count.toInt() }
        val transfers = answer.transfers_excluded.sumOf { it.count.toInt() }
        val future = answer.future_excluded.sumOf { it.count.toInt() }
        val notes = buildList {
            if (needs > 0) add(MoneyFold.fill(if (needs == 1) MoneyCopy.NOTE_NEEDS_ONE else MoneyCopy.NOTE_NEEDS_MANY, "n" to needs.toString()))
            if (transfers > 0) add(MoneyFold.fill(if (transfers == 1) MoneyCopy.NOTE_TRANSFER_ONE else MoneyCopy.NOTE_TRANSFER_MANY, "n" to transfers.toString()))
            if (future > 0) add(MoneyFold.fill(if (future == 1) MoneyCopy.NOTE_FUTURE_ONE else MoneyCopy.NOTE_FUTURE_MANY, "n" to future.toString()))
            answer.last_import?.let { last ->
                val account = last.account_name.orEmpty()
                add(
                    MoneyFold.fill(
                        if (account.isEmpty()) MoneyCopy.NOTE_IMPORTED else MoneyCopy.NOTE_IMPORTED_INTO,
                        "day" to MoneyFold.dayWords(last.imported_at.take(DAY_LENGTH), answer.today),
                        "source" to if (last.source == "ofx") MoneyCopy.SOURCE_OFX else MoneyCopy.SOURCE_CSV,
                        "account" to account,
                    ),
                )
            }
        }
        return base.copy(
            spending = MoneySpendingData(
                heroes = heroes,
                days_left_label = if (currentMonth && answer.days_left > 0) {
                    MoneyFold.fill(
                        if (answer.days_left == 1) MoneyCopy.DAYS_LEFT_ONE else MoneyCopy.DAYS_LEFT_MANY,
                        "n" to answer.days_left.toString(),
                    )
                } else {
                    ""
                },
                in_out_net = inOutNet,
                tables = tables,
                notes = notes,
                definitions = answer.definitions.mapNotNull(MoneyFold::definition).map { MoneyFact(label = it.first, detail = it.second) },
                recurring_label = MoneyCopy.RECURRING_ROW,
                recurring_meta = MoneyCopy.RECURRING_ROW_META,
                window_note = if (answer.truncated) MoneyCopy.WINDOW_NOTE else "",
            ),
        )
    }

    // --- Activity ----------------------------------------------------------

    private fun activity(held: MoneyHeld<MoneyHomeState>, base: MoneyHomeData): MoneyHomeData? {
        val answer = held.answers.activity ?: return null
        val screen = held.screen
        val accounts = held.answers.accounts
        val categories = held.answers.categories
        val filtered = screen.account_id.isNotEmpty() || screen.category_filter.isNotEmpty()
        val needsCount = answer.needs_category.sumOf { it.count.toInt() }
        val shown = answer.rows.size
        val atCeiling = answer.next != null && shown >= MAX_ROWS
        val empty = if (answer.rows.isEmpty()) {
            if (filtered) {
                EmptyState(headline = MoneyCopy.FILTER_EMPTY)
            } else {
                EmptyState(headline = MoneyCopy.ACTIVITY_EMPTY, action_label = MoneyCopy.IMPORT_ACTION)
            }
        } else {
            null
        }
        return base.copy(
            activity = MoneyActivityData(
                account_options = accountOptions(accounts, screen.account_id),
                category_options = categoryOptions(categories, screen.category_filter),
                needs_label = if (needsCount > 0) {
                    MoneyFold.fill(MoneyCopy.NEEDS_CATEGORY, "n" to needsCount.toString())
                } else {
                    ""
                },
                needs_category = answer.needs_category.filter { it.count > 0 }.map { counted ->
                    MoneyFold.figure(counted.amount?.currency.orEmpty(), counted.amount)
                },
                // THE FILTER THAT LISTS THOSE ROWS is the Needs row's tap.
                needs_key = if (needsCount > 0) FILTER_UNCATEGORISED else "",
                sections = MoneyFold.sections(answer.rows, answer.today),
                window = when {
                    atCeiling -> MoneyFold.fill(MoneyCopy.WINDOW_CEILING, "n" to shown.toString())
                    answer.next != null -> MoneyFold.fill(MoneyCopy.WINDOW_SHOWN, "n" to shown.toString())
                    else -> ""
                },
                more = answer.next != null && !atCeiling,
                empty = empty,
            ),
        )
    }

    private fun accountOptions(
        answer: centraid.core.v1.MoneyAccounts?,
        selected: String,
    ): List<MoneyChoice> {
        val lines = answer?.on_budget.orEmpty() + answer?.off_budget.orEmpty()
        return listOf(MoneyFold.choice("", MoneyCopy.ALL_ACCOUNTS, selected.isEmpty())) +
            lines.map { MoneyFold.choice(it.account_id, it.name, it.account_id == selected, it.mask?.let { mask -> "····$mask" }.orEmpty()) }
    }

    private fun categoryOptions(
        answer: centraid.core.v1.MoneyCategories?,
        selected: String,
    ): List<MoneyChoice> = buildList {
        add(MoneyFold.choice("", MoneyCopy.ALL_CATEGORIES, selected.isEmpty()))
        add(MoneyFold.choice(FILTER_UNCATEGORISED, MoneyCopy.NEEDS_CATEGORY_OPTION, selected == FILTER_UNCATEGORISED))
        answer?.groups.orEmpty().forEach { group ->
            group.categories.filter { !it.archived || it.category_id == selected }.forEach { category ->
                add(MoneyFold.choice(category.category_id, category.label, category.category_id == selected, group.label))
            }
        }
    }

    // --- Cash flow ---------------------------------------------------------

    private fun cashflow(held: MoneyHeld<MoneyHomeState>, base: MoneyHomeData): MoneyHomeData? {
        val answer = held.answers.cashflow ?: return null
        val used = answer.series.filter { series ->
            series.months.any { (it.incoming?.minor ?: 0L) != 0L || (it.outgoing?.minor ?: 0L) != 0L }
        }
        if (used.isEmpty()) {
            return base.copy(
                cashflow = MoneyCashflowData(
                    empty = EmptyState(headline = MoneyCopy.DAY_ONE, action_label = MoneyCopy.IMPORT_ACTION),
                ),
            )
        }
        return base.copy(
            cashflow = MoneyCashflowData(
                series = used.map { series ->
                    // A BAR'S LENGTH IS DRAWING, NOT A FIGURE: this series' largest side is full width.
                    val largest = series.months.maxOf { maxOf(it.incoming?.minor ?: 0L, it.outgoing?.minor ?: 0L) }.coerceAtLeast(1L)
                    MoneyCashflowSeries(
                        currency = series.currency,
                        heading = if (used.size > 1) series.currency else "",
                        months = series.months.map { month ->
                            MoneyCashflowMonth(
                                month = month.month,
                                label = MoneyFold.monthShort(month.month),
                                incoming = MoneyFold.money(month.incoming),
                                outgoing = MoneyFold.money(month.outgoing),
                                net = MoneyFold.money(month.net),
                                net_tone = MoneyFold.signTone(month.net),
                                in_bp = ((month.incoming?.minor ?: 0L) * BP / largest).toInt(),
                                out_bp = ((month.outgoing?.minor ?: 0L) * BP / largest).toInt(),
                                rate_label = month.savings_rate_bp?.takeIf { it >= 0L }?.let {
                                    MoneyFold.fill(MoneyCopy.RATE_KEPT, "percent" to (it / BP_PERCENT).toString())
                                }.orEmpty(),
                                partial = month.partial,
                                accessibility_label = listOf(
                                    MoneyFold.monthLabel(month.month),
                                    if (month.partial) MoneyCopy.PARTIAL_MONTH else "",
                                ).filter { it.isNotEmpty() }.joinToString(", "),
                            )
                        },
                    )
                },
                definitions = answer.definitions.mapNotNull(MoneyFold::definition).map { MoneyFact(label = it.first, detail = it.second) },
                window_note = if (answer.truncated) MoneyCopy.WINDOW_NOTE else "",
            ),
        )
    }

    // --- Chrome ------------------------------------------------------------

    override fun decorate(held: MoneyHeld<MoneyHomeState>): MoneyHomeState {
        val screen = held.screen
        val drawing = lens.content(screen) !is ReadContent.Denied
        return screen.copy(
            band = if (drawing) band(screen.destination) else emptyList(),
            chrome = CHROME,
            chips = if (drawing && screen.destination == MoneyHomeState.Destination.DESTINATION_ACTIVITY) chips(held) else emptyList(),
        )
    }

    private fun chips(held: MoneyHeld<MoneyHomeState>): List<MoneyChip> {
        val screen = held.screen
        val accounts = (held.answers.accounts?.on_budget.orEmpty() + held.answers.accounts?.off_budget.orEmpty())
        val accountName = accounts.firstOrNull { it.account_id == screen.account_id }?.name
        val categoryName = when (screen.category_filter) {
            "" -> null
            FILTER_UNCATEGORISED -> MoneyCopy.NEEDS_CATEGORY_OPTION
            else -> held.answers.categories?.groups.orEmpty().flatMap { it.categories }
                .firstOrNull { it.category_id == screen.category_filter }?.label
        }
        val month = currentMonth(held)
        return listOf(
            MoneyChip(key = "month", label = if (month.isEmpty()) MoneyCopy.THIS_MONTH else MoneyFold.monthLabel(month), active = false),
            MoneyChip(
                key = "account",
                label = accountName ?: MoneyCopy.ALL_ACCOUNTS,
                active = screen.account_id.isNotEmpty(),
            ),
            MoneyChip(
                key = "category",
                label = categoryName ?: MoneyCopy.ALL_CATEGORIES,
                active = screen.category_filter.isNotEmpty(),
            ),
        )
    }

    private fun band(current: MoneyHomeState.Destination): List<MoneyBandTab> = listOf(
        MoneyBandTab(
            key = BAND_SPENDING,
            label = MoneyCopy.BAND_SPENDING,
            icon_key = "Coin",
            current = current == MoneyHomeState.Destination.DESTINATION_SPENDING,
        ),
        MoneyBandTab(
            key = BAND_ACTIVITY,
            label = MoneyCopy.BAND_ACTIVITY,
            icon_key = "List",
            current = current == MoneyHomeState.Destination.DESTINATION_ACTIVITY,
        ),
        MoneyBandTab(
            key = BAND_CASHFLOW,
            label = MoneyCopy.BAND_CASHFLOW,
            icon_key = "BarChart2",
            current = current == MoneyHomeState.Destination.DESTINATION_CASHFLOW,
        ),
        MoneyBandTab(key = BAND_MORE, label = MoneyCopy.BAND_MORE, icon_key = "MoreHoriz", current = false),
    )

    private val CHROME: MoneyHomeChrome = MoneyHomeChrome(
        title = MoneyCopy.APP_TITLE,
        add_label = MoneyCopy.IMPORT_ACTION,
        retry = MoneyCopy.RETRY,
        more_title = MoneyCopy.MORE_TITLE,
        more_rows = listOf(
            MoneyMoreRow(key = MORE_ACCOUNTS, label = MoneyCopy.MORE_ACCOUNTS, meta = MoneyCopy.MORE_ACCOUNTS_META, icon_key = "Table"),
            MoneyMoreRow(key = MORE_RULES, label = MoneyCopy.MORE_RULES, meta = MoneyCopy.MORE_RULES_META, icon_key = "Filter"),
            MoneyMoreRow(key = MORE_CATEGORIES, label = MoneyCopy.MORE_CATEGORIES, meta = MoneyCopy.MORE_CATEGORIES_META, icon_key = "Tag"),
            MoneyMoreRow(key = MORE_IMPORT, label = MoneyCopy.MORE_IMPORT, meta = MoneyCopy.MORE_IMPORT_META, icon_key = "Download"),
        ),
        search_placeholder = MoneyCopy.SEARCH_PLACEHOLDER,
        previous_month_label = MoneyCopy.PREVIOUS_MONTH,
        next_month_label = MoneyCopy.NEXT_MONTH,
        month_sheet_title = MoneyCopy.MONTH_SHEET_TITLE,
        account_sheet_title = MoneyCopy.ACCOUNT_SHEET_TITLE,
        category_sheet_title = MoneyCopy.CATEGORY_SHEET_TITLE,
        close_label = MoneyCopy.CLOSE,
    )

    private const val DAY_LENGTH: Int = 10

    internal object Lens : ContentLens<MoneyHomeState, MoneyHomeData> {
        override fun content(state: MoneyHomeState): ReadContent<MoneyHomeData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: MoneyHomeState, content: ReadContent<MoneyHomeData>): MoneyHomeState = when (content) {
            is ReadContent.Loading -> state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
            is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
            is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
            is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
        }
    }
}

/** What Home asks: the tab on screen, in the month and under the filters in force. */
public object MoneyHomeReads : MoneyQueries<MoneyHomeState, MoneyHomeEvent>(
    screenId = MoneyHomeMachine.SCREEN_ID,
    tables = MONEY_TABLES,
    ask = { held, now ->
        val screen = held.screen
        when (screen.destination) {
            MoneyHomeState.Destination.DESTINATION_ACTIVITY -> listOf(
                AppQueryRequest(
                    money_activity = MoneyActivityRequest(
                        tz = now.zone,
                        month = screen.month,
                        account_id = screen.account_id.ifEmpty { null },
                        category_filter = when (screen.category_filter) {
                            "" -> MoneyCategoryFilter.MONEY_CATEGORY_FILTER_ANY
                            MoneyHomeMachine.FILTER_UNCATEGORISED -> MoneyCategoryFilter.MONEY_CATEGORY_FILTER_UNCATEGORISED
                            else -> MoneyCategoryFilter.MONEY_CATEGORY_FILTER_IS
                        },
                        category_id = screen.category_filter.takeUnless { it.isEmpty() || it == MoneyHomeMachine.FILTER_UNCATEGORISED }.orEmpty(),
                        limit = screen.activity_shown.coerceAtLeast(1),
                    ),
                ),
                AppQueryRequest(money_accounts = MoneyAccountsRequest(tz = now.zone)),
                AppQueryRequest(money_categories = MoneyCategoriesRequest()),
            )
            MoneyHomeState.Destination.DESTINATION_CASHFLOW -> listOf(
                AppQueryRequest(money_cashflow = MoneyCashflowRequest(tz = now.zone, through = screen.month)),
            )
            else -> listOf(
                AppQueryRequest(money_spending = MoneySpendingRequest(tz = now.zone, month = screen.month)),
            )
        }
    },
)
