package dev.centraid.shared.apps.locker

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.LockerAccess
import centraid.core.v1.LockerAccessEntry
import centraid.core.v1.LockerAccessKind
import centraid.core.v1.LockerAccessRequest
import centraid.screen.v1.Loading
import centraid.screen.v1.LockerAccessChrome
import centraid.screen.v1.LockerAccessData
import centraid.screen.v1.LockerAccessEvent
import centraid.screen.v1.LockerAccessState
import centraid.screen.v1.LockerFieldRow
import centraid.screen.v1.LockerSection
import centraid.screen.v1.SeatState
import dev.centraid.design.copy.LockerCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.time.CivilWords
import dev.centraid.shared.screen.Step

/**
 * THE WHOLE LOCKER'S ACCESS HISTORY (#1047, Q-1047-21; the handoff's
 * `locker/access`): every unlock, reveal, copy, one-time code and export,
 * newest first, from the More sheet's Access history.
 *
 * A page with nothing to do but be read: no verb, no sheet, no write. It asks
 * the one `locker.access` query the item page asks, with NO item, so the core
 * answers every receipt — an unlock and an export among them, which no item
 * page shows — with each item and custom field named by what it is called now.
 * **Behind the same gate as the item page**: it is a [LockerQueryMachine] over
 * [LockerQueries], so nothing is asked while the Locker is locked and a relock
 * wipes what was drawn.
 *
 * **Metadata only.** A receipt names the act, the item and the minute, never a
 * value, so nothing here can show a secret; the rows are the item page's own
 * ([LockerAccessRows]), here also naming the item each is about.
 */
public object LockerAccessMachine :
    LockerQueryMachine<LockerAccessState, LockerAccessEvent, LockerAccessData>(LOCKER_ACCESS, LOCKER_ACCESS_TABLES) {
    public const val SCREEN_ID: String = LOCKER_ACCESS

    override val lens: ContentLens<LockerAccessState, LockerAccessData> = AccessLens

    override fun blank(): LockerAccessState = LockerAccessState()

    override fun seatOf(screen: LockerAccessState): SeatState = screen.seat ?: SeatState()

    override fun withSeat(screen: LockerAccessState, seat: SeatState): LockerAccessState = screen.copy(seat = seat)

    override fun view(held: LockerHeld<LockerAccessState>, event: LockerAccessEvent, entropy: ByteArray): Step<LockerHeld<LockerAccessState>> =
        when {
            // EVERY OPEN READS AGAIN: a history is as old as the last look.
            event.opened != null -> reload(
                LockerHeld(
                    screen = blank().copy(seat = held.screen.seat),
                    open = held.open,
                    tokens = held.tokens,
                ),
            )
            event.refreshed != null -> read(overRows(held))
            else -> Step(held)
        }

    override fun fold(held: LockerHeld<LockerAccessState>): LockerAccessData? {
        val access = held.answers.access ?: return null
        return LockerAccessData(
            lede = LockerCopy.ACCESS_ALL_LEDE,
            history = LockerAccessRows.section(access, title = "", none = LockerCopy.ACCESS_ALL_NONE) { entry ->
                LockerAccessRows.row(entry, LockerAccessRows.subject(entry, entry.field_label), item = itemName(entry))
            },
        )
    }

    /**
     * WHICH ITEM A ROW IS ABOUT: its title now, or "A removed item" when the
     * vault no longer holds it (a purge takes the row and leaves the receipt).
     * An unlock and an export name no item.
     */
    private fun itemName(entry: LockerAccessEntry): String = when {
        entry.item_id.isEmpty() -> ""
        else -> entry.item_title.ifEmpty { LockerCopy.ACCESS_ITEM_GONE }
    }

    override fun decorate(held: LockerHeld<LockerAccessState>): LockerAccessState =
        held.screen.copy(
            chrome = LockerAccessChrome(title = LockerCopy.ACCESS_HEAD, back_label = LockerCopy.APP_NAME, retry = LockerCopy.RETRY),
        )

    private object AccessLens : ContentLens<LockerAccessState, LockerAccessData> {
        override fun content(state: LockerAccessState): ReadContent<LockerAccessData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: LockerAccessState, content: ReadContent<LockerAccessData>): LockerAccessState = when (content) {
            is ReadContent.Loading -> state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
            is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
            is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
            is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
        }
    }
}

/**
 * THE HISTORY'S ROWS, ONE RECIPE FOR TWO PAGES: the item page's own history
 * and the whole Locker's. A row is the act as its label, the day and minute as
 * its value, and a refusal as its note; on the whole-Locker page the act also
 * names the item. A receipt never carried a value, so neither does a row.
 */
internal object LockerAccessRows {
    /** What a reveal or a copy names: a custom field by its label, else the cell by its own name. */
    fun subject(entry: LockerAccessEntry, fieldLabel: String?): String =
        if (entry.field_id.isNotEmpty()) {
            fieldLabel?.takeIf { it.isNotEmpty() } ?: LockerCopy.ACCESS_FIELD_GONE
        } else {
            LockerItemMachine.labelOf(entry.columns.firstOrNull().orEmpty())
        }

    /** One receipt as a row. [item] is the item's name on the whole-Locker page and empty on an item's own. */
    fun row(entry: LockerAccessEntry, subject: String, item: String = ""): LockerFieldRow {
        val act = when {
            entry.kind == LockerAccessKind.LOCKER_ACCESS_KIND_UNLOCK -> LockerCopy.ACCESS_UNLOCKED
            entry.kind == LockerAccessKind.LOCKER_ACCESS_KIND_EXPORT -> LockerCopy.ACCESS_EXPORTED
            entry.kind == LockerAccessKind.LOCKER_ACCESS_KIND_CODE && entry.copied -> LockerCopy.ACCESS_CODE_COPIED
            entry.kind == LockerAccessKind.LOCKER_ACCESS_KIND_CODE -> LockerCopy.ACCESS_CODE_SHOWN
            entry.copied -> LockerFold.fill(LockerCopy.ACCESS_COPIED, "field" to subject)
            else -> LockerFold.fill(LockerCopy.ACCESS_REVEALED, "field" to subject)
        }
        val label = if (item.isEmpty()) act else LockerFold.fill(LockerCopy.ACCESS_OF_ITEM, "act" to act, "item" to item)
        val day = entry.local_day.takeIf { it.length >= 10 }?.let { CivilWords.dayMonth(it) }.orEmpty()
        val `when` = listOf(day, entry.local_time).filter { it.isNotEmpty() }.joinToString(" · ")
        val refused = if (entry.allowed) "" else LockerCopy.ACCESS_REFUSED
        return LockerFieldRow(
            key = "access:${entry.receipt_id}",
            label = label,
            value_ = `when`,
            note = refused,
            accessibility_label = listOf(label, `when`, refused).filter { it.isNotEmpty() }.joinToString(", "),
        )
    }

    /**
     * The section: one row per receipt, newest first, and when there are none a
     * single row saying so — an audit surface never invents a row. [rowOf]
     * draws one receipt; the note says the value is never logged and where a
     * full window ends.
     */
    fun section(access: LockerAccess, title: String, none: String, rowOf: (LockerAccessEntry) -> LockerFieldRow): LockerSection {
        val rows = access.entries.map(rowOf).ifEmpty {
            listOf(LockerFieldRow(key = "access:none", label = none, accessibility_label = none))
        }
        val window = if (access.truncated) " ${LockerFold.fill(LockerCopy.ACCESS_WINDOW, "n" to access.window.toString())}" else ""
        return LockerSection(title = title, rows = rows, note = LockerCopy.ACCESS_NOTE + window)
    }
}

internal const val LOCKER_ACCESS: String = "locker.access"

/**
 * EVERY TABLE THE WHOLE-LOCKER HISTORY READS, which is every table its machine
 * re-reads on (`AppReadsSpec`): the receipts, and the two tables a receipt's
 * item and custom field are named from. A rename or a removal re-reads it.
 */
public val LOCKER_ACCESS_TABLES: Set<String> = setOf("access_receipt", "locker_item", "locker_item_field")

/** The most receipts the whole-Locker page draws. */
public const val ACCESS_ALL_WINDOW: Int = 200

/** What the whole-Locker history asks: every receipt, no item. Nothing while locked. */
public object LockerAccessReads : LockerQueries<LockerAccessState, LockerAccessEvent>(
    screenId = LOCKER_ACCESS,
    tables = LOCKER_ACCESS_TABLES,
    ask = { _, now ->
        listOf(AppQueryRequest(locker_access = LockerAccessRequest(item_id = "", limit = ACCESS_ALL_WINDOW, tz = now.zone)))
    },
)
