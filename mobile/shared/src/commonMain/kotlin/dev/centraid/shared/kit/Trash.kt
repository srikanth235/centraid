package dev.centraid.shared.kit

import centraid.core.v1.CommandStatus
import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.Row
import centraid.screen.v1.Confirm
import centraid.screen.v1.EmptyState
import centraid.screen.v1.Loading
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.SeatState
import centraid.screen.v1.TrashListData
import centraid.screen.v1.TrashListEvent
import centraid.screen.v1.TrashListState
import centraid.screen.v1.TrashRow
import centraid.screen.v1.WriteState
import dev.centraid.design.copy.SharedCopy
import dev.centraid.shared.kit.time.CivilWords
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import dev.centraid.shared.sync.ScreenReads
import dev.centraid.shared.sync.ScreenWrites

/**
 * ONE APP'S TRASH, as the parameter the one trash screen takes (law 2).
 *
 * Each app's instance lives in its own package; the kit never names one.
 * [purgeCommand] null means the app has NO destroy path (Docs today): then the
 * screen offers restore only — no "Delete forever" and no "Empty trash" —
 * and says nothing it cannot do. [emptyCommand] null is the same for emptying.
 */
public data class TrashSpec(
    /** `tasks` — also the screen id's prefix: `tasks.trash`. */
    val appId: String,
    /** The table the deleted rows live on, `deleted_at` set. */
    val table: String,
    val restoreCommand: String,
    val purgeCommand: String?,
    val emptyCommand: String?,
    /** The row's key column, and the command input's key for it. */
    val idColumn: String,
    val titleColumn: String,
    val deletedAtColumn: String = "deleted_at",
    val purgeWindowDays: Int,
    /**
     * The column holding the day a row is erased by the purge sweep, or null
     * for an app whose table carries none. When set, [TrashReads] selects it
     * and each row's meta gains [TrashCopy.purgesOn] with that day.
     */
    val purgeAtColumn: String? = null,
    /** The sentences, where the kit's shared ones would be false for this app. */
    val copy: TrashCopy = TrashCopy(),
    /**
     * The back control's words: the app the trash was pushed from ("Notes").
     * Empty draws the platform's own back.
     */
    val backLabel: String = "",
    /**
     * True when a change on [table] is keyed by something other than a row's
     * id (People: rows are parties, changes are profiles), so the kit's "only
     * if a shown row moved" could never match: any change re-reads the list.
     */
    val reReadOnAnyChange: Boolean = false,
)

/**
 * THE TRASH SCREEN'S WORDS, per app. Every default is the kit's shared copy;
 * an app overrides only the sentence that would be false for it (Docs'
 * "Empty trash" removes nothing, so its confirm cannot say "for good").
 */
public data class TrashCopy(
    val purgeTitle: String = SharedCopy.TRASH_PURGE_TITLE,
    val purgeBody: String = SharedCopy.TRASH_PURGE_BODY,
    val purgeAction: String = SharedCopy.TRASH_PURGE,
    val emptyTitle: String = SharedCopy.TRASH_EMPTY_TITLE,
    val emptyBody: String = SharedCopy.TRASH_EMPTY_BODY,
    val emptyAction: String = SharedCopy.TRASH_EMPTY_ACTION,
    val emptyHeadline: String = SharedCopy.TRASH_EMPTY_HEADLINE,
    val emptyStateBody: String = SharedCopy.TRASH_EMPTY_STATE_BODY,
    val untitled: String = SharedCopy.TRASH_UNTITLED,
    val deleted: String = SharedCopy.TRASH_DELETED,
    val title: String = SharedCopy.TRASH_TITLE,
    val restoreAction: String = SharedCopy.TRASH_RESTORE,
    /** A `{day}` template for [TrashSpec.purgeAtColumn]'s day, or null to say nothing. */
    val purgesOn: String? = null,
) {
    /** [purgesOn] filled with [day] (`2026-10-12`), or null. */
    public fun purgeMeta(day: String): String? =
        purgesOn?.takeIf { day.length >= DAY }?.replace("{day}", CivilWords.dayMonth(day.take(DAY)))

    /** `Deleted Wed 11 March` for an RFC 3339 [deletedAt], or empty. */
    public fun deletedMeta(deletedAt: String): String =
        if (deletedAt.length >= DAY) "$deleted ${CivilWords.dayMonth(deletedAt.take(DAY))}" else ""

    private companion object {
        const val DAY: Int = 10
    }
}

/**
 * THE TRASH SCREEN (#1015 D1: Empty trash everywhere an app can destroy).
 *
 * A paged list of deleted rows ([PagedList]'s laws), restore as a write with
 * no confirm, and purge / empty behind a destructive confirm with full
 * sentences (DESIGN.md). One write in flight at a time ([WriteLaw]); a refused
 * write keeps the list. The vault's own change event re-reads the list after a
 * write commits — the screen never deletes a row locally on a guess.
 */
public class TrashMachine(public val spec: TrashSpec) : ScreenMachine<TrashListState, TrashListEvent> {
    public val screenId: String = "${spec.appId}.trash"

    private val list = TrashLens(screenId)

    override fun initial(): TrashListState = TrashListState(
        app_id = spec.appId,
        loading = Loading(first_load = true),
        write = WriteState(phase = WriteState.Phase.PHASE_IDLE),
        purge_window_days = spec.purgeWindowDays,
        title = spec.copy.title,
        back_label = spec.backLabel,
    )

    override fun reduce(state: TrashListState, event: TrashListEvent): Step<TrashListState> = when {
        event.opened != null -> PagedList.opened(list, state)
        event.refreshed != null -> PagedList.refreshed(list, state)
        event.next_page != null -> PagedList.nextPage(list, state)
        event.data_ != null -> {
            val data = decorate(event.data_.data_ ?: TrashListData())
            val answered = event.data_.answered_cursor
            if (answered == null) {
                PagedList.arrivedUnechoed(list, state, data)
            } else {
                PagedList.arrived(list, state, data, answered)
            }
        }
        event.refused != null -> PagedList.refused(list, state, event.refused.failure ?: Reads.refused(""))
        event.denied != null -> PagedList.denied(list, state, event.denied)
        event.rows_changed != null -> PagedList.rowsChanged(list, state, event.rows_changed.ids)
        event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))

        // RESTORE ASKS NOTHING: it undoes, and undoing is not a decision.
        event.restore != null -> WriteLaw.submit(
            Writes,
            state,
            spec.restoreCommand,
            idInput(event.restore.id),
            InvokeKeys.of(spec.restoreCommand, event.restore.id),
        )

        // DESTROYING IS ASKED FIRST, in full sentences, and only where the app
        // can destroy at all.
        event.purge != null ->
            if (spec.purgeCommand == null) {
                Step(state)
            } else {
                Step(
                    state.copy(
                        confirm = Confirm(
                            title = spec.copy.purgeTitle,
                            body = spec.copy.purgeBody,
                            confirm_label = spec.copy.purgeAction,
                            destructive = true,
                        ),
                        purge_id = event.purge.id,
                        empty_all = null,
                    ),
                )
            }

        event.empty != null ->
            if (spec.emptyCommand == null) {
                Step(state)
            } else {
                Step(
                    state.copy(
                        confirm = Confirm(
                            title = spec.copy.emptyTitle,
                            body = spec.copy.emptyBody,
                            confirm_label = spec.copy.emptyAction,
                            destructive = true,
                        ),
                        purge_id = null,
                        empty_all = true,
                    ),
                )
            }

        event.confirmed != null -> confirmed(state)

        event.dismissed != null -> Step(dismissed(state))

        event.write_settled != null -> WriteLaw.settled(Writes, state, event.write_settled)

        else -> Step(state)
    }

    private fun confirmed(state: TrashListState): Step<TrashListState> {
        val purgeId = state.purge_id
        val purge = spec.purgeCommand
        val empty = spec.emptyCommand
        return when {
            purgeId != null && purge != null ->
                WriteLaw.submit(Writes, dismissed(state), purge, idInput(purgeId), InvokeKeys.of(purge, purgeId))
            state.empty_all == true && empty != null -> {
                // One key per emptying of THIS list: the ids on screen, so a
                // double tap dedups and an emptying after new deletions is new.
                val shown = list.dataOf(state)?.rows?.joinToString(",") { it.id } ?: ""
                WriteLaw.submit(Writes, dismissed(state), empty, "{}", InvokeKeys.of(empty, spec.appId, shown))
            }
            else -> Step(dismissed(state))
        }
    }

    private fun dismissed(state: TrashListState): TrashListState =
        state.copy(confirm = null, purge_id = null, empty_all = null)

    /** What the machine adds to a page: the empty sentence and the verbs the app has. */
    private fun decorate(data: TrashListData): TrashListData = data.copy(
        rows = data.rows.map {
            it.copy(
                purge_label = if (spec.purgeCommand == null) "" else spec.copy.purgeAction,
                restore_label = spec.copy.restoreAction,
            )
        },
        empty = EmptyState(headline = spec.copy.emptyHeadline, body = spec.copy.emptyStateBody),
        empty_label = if (spec.emptyCommand == null || data.rows.isEmpty()) "" else spec.copy.emptyAction,
    )

    private fun idInput(id: String): String = "{${jsonString(spec.idColumn)}:${jsonString(id)}}"

    override fun rowsChanged(table: String, keys: List<String>): TrashListEvent? =
        when {
            table != spec.table -> null
            spec.reReadOnAnyChange -> TrashListEvent(rows_changed = TrashListEvent.RowsChanged())
            else -> TrashListEvent(rows_changed = TrashListEvent.RowsChanged(ids = keys))
        }

    override fun seatChanged(seat: SeatState): TrashListEvent =
        TrashListEvent(seat_changed = TrashListEvent.SeatChanged(seat = seat))

    private object Writes : WriteLens<TrashListState> {
        override fun write(state: TrashListState): WriteState = state.write ?: WriteState()

        override fun with(state: TrashListState, write: WriteState): TrashListState = state.copy(write = write)
    }
}

/** The trash list's parts, for [PagedList]. */
internal class TrashLens(override val screenId: String) : PagedListLens<TrashListState, TrashListData, TrashRow> {
    override fun content(state: TrashListState): ReadContent<TrashListData> = when {
        state.data_ != null -> ReadContent.Data(state.data_)
        state.failure != null -> ReadContent.Failed(state.failure)
        state.denied != null -> ReadContent.Denied(state.denied)
        else -> ReadContent.Loading(state.loading?.first_load ?: true)
    }

    override fun with(state: TrashListState, content: ReadContent<TrashListData>): TrashListState = when (content) {
        is ReadContent.Loading -> state.copy(
            loading = Loading(first_load = content.firstLoad),
            failure = null,
            denied = null,
            data_ = null,
        )
        is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
        is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
        is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
    }

    override fun rows(data: TrashListData): List<TrashRow> = data.rows

    override fun withRows(data: TrashListData, rows: List<TrashRow>): TrashListData = data.copy(rows = rows)

    override fun nextCursor(data: TrashListData): String? = data.next_cursor

    override fun key(row: TrashRow): String = row.id

    override fun firstPagePending(state: TrashListState): Boolean = state.first_page_pending

    override fun withFirstPagePending(state: TrashListState, pending: Boolean): TrashListState =
        state.copy(first_page_pending = pending)
}

/**
 * WHAT A TRASH READS: the app's table, deleted rows only, newest deletion
 * first. The page door, so it pages by keyset like every list.
 */
public class TrashReads(public val spec: TrashSpec) :
    ScreenReads<TrashListState, TrashListEvent>,
    ScreenWrites<TrashListState, TrashListEvent> {
    override val screenId: String = "${spec.appId}.trash"

    override val table: String = spec.table

    override val limit: Int = 50

    override val appId: String = spec.appId

    override fun query(state: TrashListState, afterCursor: String?): PageQuery = PageQuery(
        name = "$screenId.rows",
        select = listOfNotNull(spec.idColumn, spec.titleColumn, spec.deletedAtColumn, spec.purgeAtColumn),
        from = spec.table,
        where_ = "${spec.deletedAtColumn} IS NOT NULL",
        order = PageOrder(sort_column = spec.deletedAtColumn, pk_column = spec.idColumn, descending = true),
    )

    override fun arrived(rows: List<Row>, nextCursor: String?): TrashListEvent = page(rows, nextCursor, null)

    override fun arrived(rows: List<Row>, nextCursor: String?, answeredCursor: String?): TrashListEvent =
        page(rows, nextCursor, answeredCursor ?: "")

    private fun page(rows: List<Row>, nextCursor: String?, answered: String?): TrashListEvent = TrashListEvent(
        data_ = TrashListEvent.DataArrived(
            data_ = TrashListData(rows = rows.map(::rowOf), next_cursor = nextCursor),
            answered_cursor = answered,
        ),
    )

    override fun refused(failure: ReadFailure): TrashListEvent =
        TrashListEvent(refused = TrashListEvent.ReadRefused(failure = failure))

    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): TrashListEvent =
        TrashListEvent(write_settled = WriteLaw.settledOf(status, sentence, invokeKey))

    private fun rowOf(row: Row): TrashRow {
        val deletedAt = row.values.getOrNull(2)?.text ?: ""
        return TrashRow(
            id = row.values.getOrNull(0)?.text ?: "",
            title = (row.values.getOrNull(1)?.text ?: "").ifBlank { spec.copy.untitled },
            // `Deleted Wed 11 March · Erased Mon 12 October` — the days, in
            // the kit's words. The columns are RFC 3339; the first ten
            // characters are the day.
            meta = listOfNotNull(
                spec.copy.deletedMeta(deletedAt).ifEmpty { null },
                spec.purgeAtColumn?.let { row.values.getOrNull(3)?.text }?.let(spec.copy::purgeMeta),
            ).joinToString(" · "),
        )
    }
}
