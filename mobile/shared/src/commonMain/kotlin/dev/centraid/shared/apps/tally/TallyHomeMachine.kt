package dev.centraid.shared.apps.tally

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.TallyDashboard
import centraid.core.v1.TallyDashboardRequest
import centraid.core.v1.TallyGroupCard
import centraid.screen.v1.EmptyState
import centraid.screen.v1.Loading
import centraid.screen.v1.SeatState
import centraid.screen.v1.TallyBandTab
import centraid.screen.v1.TallyDaySection
import centraid.screen.v1.TallyFact
import centraid.screen.v1.TallyFriendRow
import centraid.screen.v1.TallyGroupRow
import centraid.screen.v1.TallyHero
import centraid.screen.v1.TallyHomeChrome
import centraid.screen.v1.TallyHomeData
import centraid.screen.v1.TallyHomeEvent
import centraid.screen.v1.TallyHomeState
import centraid.screen.v1.TallyLedgerRow
import centraid.screen.v1.TallyMoreRow
import centraid.screen.v1.TallyTone
import dev.centraid.design.copy.TallyCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.screen.Step

/**
 * TALLY'S HOME (#1046): Balances · Activity · Groups, and More as a sheet.
 *
 * ONE READ SERVES ALL THREE TABS. `tally.dashboard` answers the hero, every
 * friend's position, the group cards and the activity feed from one fold of
 * the ledger, so moving between tabs re-reads nothing — the tab is a parameter
 * (law 2), and the same tab again is nothing at all. Opening lands on
 * BALANCES, the handoff's first tab (v1's list landed on Activity; the handoff
 * rules).
 *
 * The band is the handoff's less Waiting: Balances · Activity · Groups · More.
 * Waiting was the sharing plane's, which is gone (#1029 amendment).
 *
 * WINDOW END: Activity draws [PAGE] rows and says "60 of 194"; Show more adds
 * a page and reads nothing — the dashboard already folded the feed.
 */
public object TallyHomeMachine :
    TallyQueryMachine<TallyHomeState, TallyHomeEvent, TallyHomeData>("tally.home", TALLY_LEDGER_TABLES) {
    public const val SCREEN_ID: String = "tally.home"

    /** Activity rows drawn per Show more. */
    public const val PAGE: Int = 60

    public const val BAND_BALANCES: String = "balances"
    public const val BAND_ACTIVITY: String = "activity"
    public const val BAND_GROUPS: String = "groups"
    public const val BAND_MORE: String = "more"

    public const val MORE_SETTLE: String = "settle"
    public const val MORE_RECURRING: String = "recurring"
    public const val MORE_SPENDING: String = "spending"
    public const val MORE_SEARCH: String = "search"
    public const val MORE_EXPORT: String = "export"
    public const val MORE_TRASH: String = "trash"
    public const val MORE_READS: String = "reads"

    override val lens: ContentLens<TallyHomeState, TallyHomeData> = Lens

    override fun blank(): TallyHomeState = TallyHomeState(
        destination = TallyHomeState.Destination.DESTINATION_BALANCES,
        sheet = TallyHomeState.Sheet.SHEET_NONE,
        activity_shown = PAGE,
    )

    override fun withSeat(screen: TallyHomeState, seat: SeatState): TallyHomeState = screen.copy(seat = seat)

    override fun view(held: TallyHeld<TallyHomeState>, event: TallyHomeEvent): Step<TallyHeld<TallyHomeState>> {
        val screen = held.screen
        return when {
            event.opened != null -> {
                val destination = event.opened.destination
                    .takeUnless { it == TallyHomeState.Destination.DESTINATION_UNSPECIFIED }
                    ?: TallyHomeState.Destination.DESTINATION_BALANCES
                reload(
                    held.copy(
                        screen = screen.copy(
                            destination = destination,
                            sheet = TallyHomeState.Sheet.SHEET_NONE,
                            activity_shown = PAGE,
                        ),
                    ),
                )
            }

            event.refreshed != null -> read(overRows(held))

            event.band != null -> when (event.band.key) {
                BAND_BALANCES -> moveTo(held, TallyHomeState.Destination.DESTINATION_BALANCES)
                BAND_ACTIVITY -> moveTo(held, TallyHomeState.Destination.DESTINATION_ACTIVITY)
                BAND_GROUPS -> moveTo(held, TallyHomeState.Destination.DESTINATION_GROUPS)
                BAND_MORE -> Step(held.copy(screen = screen.copy(sheet = TallyHomeState.Sheet.SHEET_MORE)))
                else -> Step(held)
            }

            event.destination != null -> moveTo(held, event.destination.destination)

            event.sheet_opened != null ->
                if (event.sheet_opened.sheet == TallyHomeState.Sheet.SHEET_UNSPECIFIED) {
                    Step(held)
                } else {
                    Step(held.copy(screen = screen.copy(sheet = event.sheet_opened.sheet)))
                }

            event.sheet_closed != null ->
                Step(held.copy(screen = screen.copy(sheet = TallyHomeState.Sheet.SHEET_NONE)))

            event.show_more != null -> refold(held.copy(screen = screen.copy(activity_shown = screen.activity_shown + PAGE)))

            // The one More row that is this screen's: the facts sheet. The
            // rest are routes the shell takes, and the sheet closes behind them.
            event.more != null -> Step(
                held.copy(
                    screen = screen.copy(
                        sheet = if (event.more.key == MORE_READS) {
                            TallyHomeState.Sheet.SHEET_READS
                        } else {
                            TallyHomeState.Sheet.SHEET_NONE
                        },
                    ),
                ),
            )

            // INTENTS the shell routes: nothing changes here.
            else -> Step(held)
        }
    }

    /** A tab. The same tab again is nothing (the kit's band law), and no tab reads. */
    private fun moveTo(
        held: TallyHeld<TallyHomeState>,
        destination: TallyHomeState.Destination,
    ): Step<TallyHeld<TallyHomeState>> {
        if (destination == TallyHomeState.Destination.DESTINATION_UNSPECIFIED) return Step(held)
        val screen = held.screen
        if (destination == screen.destination && screen.sheet == TallyHomeState.Sheet.SHEET_NONE) return Step(held)
        return Step(held.copy(screen = screen.copy(destination = destination, sheet = TallyHomeState.Sheet.SHEET_NONE)))
    }

    override fun fold(held: TallyHeld<TallyHomeState>): TallyHomeData? {
        val dashboard = held.answers.dashboard ?: return null
        return fold(dashboard, held.screen.activity_shown.toInt())
    }

    /** The three tabs out of one answer. */
    internal fun fold(dashboard: TallyDashboard, shown: Int): TallyHomeData {
        val today = dashboard.today
        val dayOne = dashboard.expense_count == 0 &&
            dashboard.settlement_count == 0 &&
            dashboard.groups.isEmpty() &&
            dashboard.archived_groups.isEmpty() &&
            dashboard.activity.isEmpty()
        val friends = dashboard.friends.map { friend ->
            val balances = friend.balances
                .filter { it.minor != 0L }
                .map { TallyFold.position(it, TallyCopy.OWES_YOU, TallyCopy.YOU_OWE, TallyCopy.LEVEL) }
            val person = TallyFold.chip(friend.person)
            val meta = if (balances.isEmpty()) TallyCopy.LEVEL else ""
            TallyFriendRow(
                person = person,
                balances = balances,
                meta = meta,
                accessibility_label = listOf(person.name, meta.ifEmpty { balances.joinToString(", ") { it.label } })
                    .joinToString(", "),
            )
        }
        val allLevel = friends.isNotEmpty() && friends.all { it.balances.isEmpty() }
        val rows = dashboard.activity.mapNotNull { row ->
            row.expense?.let { TallyFold.activityRow(it, today) }
                ?: row.settlement?.let { settlement ->
                    TallyFold.settlementRow(settlement, groupName(dashboard, settlement.group_id), today)
                }
        }
        val days = dashboard.activity.mapNotNull { it.expense?.date ?: it.settlement?.paid_on }
        val drawn = rows.take(shown)
        return TallyHomeData(
            today = today,
            day_one = dayOne,
            day_one_empty = EmptyState(
                headline = TallyCopy.DAY_ONE,
                body = TallyCopy.DAY_ONE_SUB,
                action_label = TallyCopy.DAY_ONE_ACT,
            ),
            status_line = if (dashboard.ledger_window_filled) TallyCopy.WINDOW_FILLED else TallyCopy.BALANCES_STATUS,
            hero = hero(dashboard, dayOne),
            friends = friends,
            friends_heading = TallyCopy.FRIENDS_HEADING,
            all_settled = if (allLevel) EmptyState(headline = TallyCopy.ALL_SETTLED) else null,
            groups = dashboard.groups.map { groupRow(it, archived = false) },
            groups_heading = TallyCopy.GROUPS_HEADING,
            archived_groups = dashboard.archived_groups.map { groupRow(it, archived = true) },
            archived_heading = if (dashboard.archived_groups.isEmpty()) "" else TallyCopy.ARCHIVED_HEADING,
            groups_empty = if (dashboard.groups.isEmpty() && dashboard.archived_groups.isEmpty() && !dayOne) {
                EmptyState(headline = TallyCopy.GROUPS_EMPTY, body = TallyCopy.GROUPS_EMPTY_BODY)
            } else {
                null
            },
            activity = sections(drawn, days.take(shown), today),
            activity_window = if (rows.size > shown) "$shown ${TallyCopy.OF_WORD} ${rows.size}" else "",
            more_activity = rows.size > shown,
            activity_empty = if (rows.isEmpty() && !dayOne) EmptyState(headline = TallyCopy.ACTIVITY_EMPTY) else null,
        )
    }

    private fun groupName(dashboard: TallyDashboard, groupId: String?): String =
        if (groupId.isNullOrEmpty()) {
            ""
        } else {
            (dashboard.groups + dashboard.archived_groups).firstOrNull { it.group_id == groupId }?.name ?: ""
        }

    /**
     * THE HERO: what you are owed and what you owe, each as the core valued
     * it — one figure when it could make one, one line per currency when it
     * could not. The two are never netted into a third figure here.
     */
    private fun hero(dashboard: TallyDashboard, dayOne: Boolean): TallyHero {
        val owed = TallyFold.figures(dashboard.owed, TallyCopy.HERO_OWED, TallyCopy.HERO_OWE, TallyCopy.HERO_LEVEL)
        val owe = TallyFold.figures(dashboard.owe, TallyCopy.HERO_OWE, TallyCopy.HERO_OWED, TallyCopy.HERO_LEVEL)
            // THE CORE STATES `owe` AS A POSITIVE WHAT-YOU-OWE; its tone is owe.
            .map { it.copy(tone = TallyTone.TALLY_TONE_OWE, label = TallyCopy.HERO_OWE) }
        val lines = owed + owe
        val tone = when {
            lines.isEmpty() -> TallyTone.TALLY_TONE_LEVEL
            owed.isNotEmpty() -> TallyTone.TALLY_TONE_OWED
            else -> TallyTone.TALLY_TONE_OWE
        }
        val label = when (tone) {
            TallyTone.TALLY_TONE_OWED -> TallyCopy.HERO_OWED
            TallyTone.TALLY_TONE_OWE -> TallyCopy.HERO_OWE
            else -> TallyCopy.HERO_LEVEL
        }
        val sub = when {
            dayOne -> ""
            lines.isEmpty() -> TallyCopy.HERO_SETTLED_SUB
            else -> derivedFrom(dashboard.expense_count.toInt(), dashboard.settlement_count.toInt())
        }
        return TallyHero(lines = lines, label = label, sub = sub, tone = tone)
    }

    /** "Derived from 194 expenses and 22 settlements — no balance is stored, and none is ever sent." */
    private fun derivedFrom(expenses: Int, settlements: Int): String =
        "${TallyCopy.DERIVED_FROM} ${TallyFold.count(expenses, TallyCopy.EXPENSE_ONE, TallyCopy.EXPENSE_MANY)} " +
            "${TallyCopy.AND_WORD} ${TallyFold.count(settlements, TallyCopy.SETTLEMENT_ONE, TallyCopy.SETTLEMENT_MANY)}" +
            TallyCopy.DERIVED_TAIL

    private fun groupRow(card: TallyGroupCard, archived: Boolean): TallyGroupRow {
        val net = TallyFold.position(card.your_net, TallyCopy.OWED_TO_YOU, TallyCopy.YOU_OWE, TallyCopy.LEVEL)
        val meta = if (archived) {
            TallyCopy.ARCHIVED_META
        } else {
            TallyFold.count(card.member_count, TallyCopy.MEMBER_ONE, TallyCopy.MEMBER_MANY)
        }
        return TallyGroupRow(
            group_id = card.group_id,
            name = card.name,
            icon_key = TallyFold.groupIcon(card.icon),
            glyph = TallyFold.groupGlyph(card.icon),
            hue = card.color,
            meta = meta,
            your_net = net,
            accessibility_label = "${card.name}, $meta, ${net.label}",
        )
    }

    /** Day sections, newest first, in the order the core gave the feed. */
    private fun sections(rows: List<TallyLedgerRow>, days: List<String>, today: String): List<TallyDaySection> {
        val out = mutableListOf<TallyDaySection>()
        rows.forEachIndexed { index, row ->
            val day = days.getOrElse(index) { "" }
            val last = out.lastOrNull()
            if (last != null && last.day == day) {
                out[out.lastIndex] = last.copy(rows = last.rows + row)
            } else {
                out += TallyDaySection(day = day, heading = TallyFold.day(day, today), rows = listOf(row))
            }
        }
        return out
    }

    override fun decorate(held: TallyHeld<TallyHomeState>): TallyHomeState {
        val screen = held.screen
        val denied = screen.denied != null
        return screen.copy(band = if (denied) emptyList() else band(screen), chrome = CHROME)
    }

    private fun band(screen: TallyHomeState): List<TallyBandTab> {
        val sheetUp = screen.sheet == TallyHomeState.Sheet.SHEET_MORE || screen.sheet == TallyHomeState.Sheet.SHEET_READS
        fun tab(key: String, label: String, icon: String, of: TallyHomeState.Destination) =
            TallyBandTab(key = key, label = label, icon_key = icon, current = !sheetUp && screen.destination == of)
        return listOf(
            tab(BAND_BALANCES, TallyCopy.BAND_BALANCES, "Coin", TallyHomeState.Destination.DESTINATION_BALANCES),
            tab(BAND_ACTIVITY, TallyCopy.BAND_ACTIVITY, "List", TallyHomeState.Destination.DESTINATION_ACTIVITY),
            tab(BAND_GROUPS, TallyCopy.BAND_GROUPS, TallyFold.GROUP_ICON, TallyHomeState.Destination.DESTINATION_GROUPS),
            TallyBandTab(key = BAND_MORE, label = TallyCopy.BAND_MORE, icon_key = "more", current = sheetUp),
        )
    }

    private val CHROME: TallyHomeChrome = TallyHomeChrome(
        title = TallyCopy.APP_TITLE,
        add_expense = TallyCopy.ADD_COMMIT,
        settle_up = TallyCopy.SETTLE_HEAD,
        retry = TallyCopy.RETRY,
        loading = TallyCopy.LOADING,
        more_title = TallyCopy.MORE_TITLE,
        more_rows = listOf(
            TallyMoreRow(key = MORE_SETTLE, label = TallyCopy.SETTLE_HEAD, meta = TallyCopy.MORE_SETTLE_META, icon_key = "Coin"),
            TallyMoreRow(key = MORE_RECURRING, label = TallyCopy.RECURRING_TITLE, meta = TallyCopy.MORE_RECURRING_META, icon_key = "Repeat"),
            TallyMoreRow(key = MORE_SPENDING, label = TallyCopy.SPENDING_TITLE, meta = TallyCopy.MORE_SPENDING_META, icon_key = "BarChart2"),
            TallyMoreRow(key = MORE_SEARCH, label = TallyCopy.SEARCH_TITLE, meta = TallyCopy.SEARCH_SCOPE, icon_key = "Search"),
            TallyMoreRow(key = MORE_EXPORT, label = TallyCopy.EXPORT_HEAD, meta = TallyCopy.EXPORT_FOOT, icon_key = "Share"),
            TallyMoreRow(key = MORE_TRASH, label = TallyCopy.TRASH_HEAD, meta = TallyCopy.MORE_TRASH_META, icon_key = "Trash"),
            TallyMoreRow(key = MORE_READS, label = TallyCopy.READS_TITLE, meta = "", icon_key = "Info"),
        ),
        reads_title = TallyCopy.READS_TITLE,
        reads_facts = listOf(
            TallyFact(label = TallyCopy.READS_FACT_READS, detail = TallyCopy.READS_FACT_READS_VALUE),
            TallyFact(label = TallyCopy.READS_FACT_WRITES, detail = TallyCopy.READS_FACT_WRITES_VALUE),
            TallyFact(label = TallyCopy.READS_FACT_STORED, detail = TallyCopy.READS_FACT_STORED_VALUE),
        ),
        home = TallyCopy.BAND_HOME,
        show_more = TallyCopy.SHOW_MORE,
    )

    internal object Lens : ContentLens<TallyHomeState, TallyHomeData> {
        override fun content(state: TallyHomeState): ReadContent<TallyHomeData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: TallyHomeState, content: ReadContent<TallyHomeData>): TallyHomeState = when (content) {
            is ReadContent.Loading ->
                state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
            is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
            // THE GATE HAS NO SHEET and no band.
            is ReadContent.Denied -> state.copy(
                loading = null,
                failure = null,
                denied = content.denied,
                data_ = null,
                sheet = TallyHomeState.Sheet.SHEET_NONE,
            )
            is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
        }
    }
}

/** What Tally's home asks: the dashboard, in the device's zone. */
public object TallyHomeReads : TallyQueries<TallyHomeState, TallyHomeEvent>(
    screenId = TallyHomeMachine.SCREEN_ID,
    tables = TALLY_LEDGER_TABLES,
    ask = { _, now -> listOf(AppQueryRequest(tally_dashboard = TallyDashboardRequest(tz = now.zone))) },
)

