package dev.centraid.shared.apps.tally

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.TallyExpense
import centraid.core.v1.TallyExpenseRequest
import centraid.core.v1.TallyRate
import centraid.core.v1.TallyRevision
import centraid.screen.v1.Confirm
import centraid.screen.v1.EmptyState
import centraid.screen.v1.Loading
import centraid.screen.v1.SeatState
import centraid.screen.v1.TallyExpenseData
import centraid.screen.v1.TallyExpenseEvent
import centraid.screen.v1.TallyExpenseState
import centraid.screen.v1.TallyField
import centraid.screen.v1.TallyLineRow
import centraid.screen.v1.TallyRevisionRow
import centraid.screen.v1.TallyShareRow
import centraid.screen.v1.WriteSettled
import centraid.screen.v1.WriteState
import dev.centraid.design.copy.TallyCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.InvokeKeys
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.kit.WriteLens
import dev.centraid.shared.kit.jsonString
import dev.centraid.shared.kit.time.CivilWords
import dev.centraid.shared.screen.Step

/**
 * ONE EXPENSE (#1046): the amount, who paid, how it divided, its revisions
 * with Undo while the vault's window is open, and its life — trash behind a
 * confirm, restore without one (restoring undoes; it is not a decision).
 *
 * THE MEMO is the owner's running note on the expense, written with
 * `tally.set_expense_memo`: a sheet holds what is typed ([TallyExpenseState.memo_draft])
 * and closing it is done (#1015 D3) — words that changed are written then, as
 * one write; an emptied memo clears it.
 */
public object TallyExpenseMachine :
    TallyQueryMachine<TallyExpenseState, TallyExpenseEvent, TallyExpenseData>(
        "tally.expense",
        TALLY_LEDGER_TABLES + setOf("core_entity_revision", "knowledge_annotation"),
    ) {
    public const val SCREEN_ID: String = "tally.expense"

    public const val TRASH_COMMAND: String = "tally.delete_expense"
    public const val RESTORE_COMMAND: String = "tally.restore_expense"
    public const val UNDO_COMMAND: String = "tally.undo_expense"
    public const val MEMO_COMMAND: String = "tally.set_expense_memo"

    override val lens: ContentLens<TallyExpenseState, TallyExpenseData> = Lens

    override fun blank(): TallyExpenseState = TallyExpenseState(write = WriteState(phase = WriteState.Phase.PHASE_IDLE))

    override fun withSeat(screen: TallyExpenseState, seat: SeatState): TallyExpenseState = screen.copy(seat = seat)

    override fun view(held: TallyHeld<TallyExpenseState>, event: TallyExpenseEvent): Step<TallyHeld<TallyExpenseState>> {
        val expense = held.answers.expense?.expense
        return when {
            event.opened != null -> reload(
                held.copy(
                    screen = held.screen.copy(
                        expense_id = event.opened.expense_id,
                        confirm = null,
                        write = WriteState(phase = WriteState.Phase.PHASE_IDLE),
                    ),
                ),
            )

            event.refreshed != null -> read(overRows(held))

            // TRASHING ASKS FIRST, in full sentences.
            event.trash != null ->
                if (expense == null || trashed(held)) {
                    Step(held)
                } else {
                    Step(
                        held.copy(
                            screen = held.screen.copy(
                                confirm = Confirm(
                                    title = TallyCopy.TRASH_TITLE,
                                    body = TallyCopy.TRASH_BODY,
                                    confirm_label = TallyCopy.TRASH_COMMIT,
                                    destructive = true,
                                ),
                            ),
                        ),
                    )
                }

            event.confirmed != null -> {
                val dismissed = held.copy(screen = held.screen.copy(confirm = null))
                if (held.screen.confirm == null || expense == null) {
                    Step(dismissed)
                } else {
                    submit(dismissed, TRASH_COMMAND, idInput(expense.expense_id), generation(held))
                }
            }

            event.dismissed != null -> Step(held.copy(screen = held.screen.copy(confirm = null)))

            event.restore != null ->
                if (expense == null || !trashed(held)) {
                    Step(held)
                } else {
                    submit(held, RESTORE_COMMAND, idInput(expense.expense_id), generation(held))
                }

            event.undo != null -> {
                val revision = held.answers.expense?.revisions?.firstOrNull { it.revision_id == event.undo.revision_id }
                if (expense == null || revision == null || !revision.undoable) {
                    Step(held)
                } else {
                    submit(
                        held,
                        UNDO_COMMAND,
                        "{\"expense_id\":${jsonString(expense.expense_id)},\"revision_id\":${jsonString(revision.revision_id)}}",
                        revision.revision_id,
                    )
                }
            }

            event.memo_opened != null ->
                if (expense == null || trashed(held) || writing(held)) {
                    Step(held)
                } else {
                    Step(held.copy(screen = held.screen.copy(memo_draft = held.answers.expense.memo ?: "")))
                }

            event.memo_changed != null ->
                if (held.screen.memo_draft == null) {
                    Step(held)
                } else {
                    Step(held.copy(screen = held.screen.copy(memo_draft = event.memo_changed.text)))
                }

            // CLOSE = DONE: the words, written only when they changed.
            event.memo_closed != null -> {
                val typed = held.screen.memo_draft
                val closed = held.copy(screen = held.screen.copy(memo_draft = null))
                val note = typed?.trim()
                if (expense == null || note == null || note == (held.answers.expense.memo ?: "").trim()) {
                    Step(closed)
                } else {
                    submit(
                        closed,
                        MEMO_COMMAND,
                        "{\"expense_id\":${jsonString(expense.expense_id)},\"note\":${jsonString(note)}}",
                        "memo=${note.hashCode().toUInt().toString(HEX)}",
                    )
                }
            }

            // INTENT: the shell opens the editor.
            else -> Step(held)
        }
    }

    private fun writing(held: TallyHeld<TallyExpenseState>): Boolean =
        held.screen.write?.phase == WriteState.Phase.PHASE_IN_FLIGHT

    private const val HEX: Int = 16

    /**
     * One write. The key is the expense and its REVISION COUNT (or the
     * revision undone): a double tap is one write, and trashing again after a
     * restore is a new one.
     */
    private fun submit(
        held: TallyHeld<TallyExpenseState>,
        command: String,
        input: String,
        intent: String,
    ): Step<TallyHeld<TallyExpenseState>> {
        val id = held.screen.expense_id
        val step = WriteLaw.submit(Writes, held, command, input, InvokeKeys.of(command, id, intent))
        return Step(refold(step.state).state, step.effects)
    }

    private fun generation(held: TallyHeld<TallyExpenseState>): String =
        (held.answers.expense?.revisions?.size ?: 0).toString()

    private fun trashed(held: TallyHeld<TallyExpenseState>): Boolean = held.answers.expense?.deleted_at != null

    private fun idInput(id: String): String = "{\"expense_id\":${jsonString(id)}}"

    override fun settled(held: TallyHeld<TallyExpenseState>, settled: WriteSettled): Step<TallyHeld<TallyExpenseState>> {
        val step = WriteLaw.settled(Writes, held, settled)
        return Step(refold(step.state).state, step.effects)
    }

    override fun fold(held: TallyHeld<TallyExpenseState>): TallyExpenseData? {
        val answer = held.answers.expense ?: return null
        return fold(answer, held.screen.write?.phase == WriteState.Phase.PHASE_IN_FLIGHT)
    }

    internal fun fold(answer: TallyExpense, writing: Boolean): TallyExpenseData {
        val expense = answer.expense
            ?: return TallyExpenseData(gone = EmptyState(headline = TallyCopy.EXPENSE_GONE, body = TallyCopy.EXPENSE_GONE_BODY))
        val trashed = answer.deleted_at != null
        val title = expense.description.ifEmpty { TallyCopy.UNTITLED_EXPENSE }
        val fields = buildList {
            add(TallyField(key = TallyCopy.FIELD_PAID_BY, value_ = expense.payers.joinToString(", ") { it.person?.name ?: "" }
                .ifEmpty { expense.paid_by?.name ?: "" }))
            add(TallyField(key = TallyCopy.FIELD_DATE, value_ = CivilWords.dayMonth(expense.spent_on)))
            add(TallyField(key = TallyCopy.FIELD_GROUP, value_ = expense.group_name.ifEmpty { TallyCopy.NO_GROUP_LABEL }))
            add(TallyField(key = TallyCopy.FIELD_CATEGORY, value_ = TallyFold.categoryLabel(expense.category)))
            add(TallyField(key = TallyCopy.FIELD_DIVIDED, value_ = TallySplit.methodLabel(expense.split_method)))
            expense.rate?.let { add(rateField(it, expense.amount?.currency ?: "")) }
        }
        return TallyExpenseData(
            title = title,
            amount = TallyFold.money(expense.amount),
            yours = TallyFold.yours(expense.your_role, expense.your_amount),
            icon_key = TallyFold.categoryIcon(expense.category),
            fields = fields,
            payers_heading = TallyCopy.PAYERS_HEADING,
            payers = expense.payers.map(::shareRow),
            splits_heading = TallyCopy.SPLITS_HEADING,
            splits = expense.splits.map(::shareRow),
            lines_heading = if (expense.lines.isEmpty()) "" else TallyCopy.LINES_HEADING,
            lines = expense.lines.map { line ->
                TallyLineRow(
                    line_item_id = line.line_item_id,
                    title = line.description,
                    amount = TallyFold.money(line.amount),
                    meta = line.allocations.joinToString(" · ") { it.person?.name ?: "" },
                )
            },
            memo_heading = if (answer.memo.isNullOrEmpty()) "" else TallyCopy.MEMO_HEADING,
            memo = answer.memo ?: "",
            memo_label = when {
                trashed || writing -> ""
                answer.memo.isNullOrEmpty() -> TallyCopy.MEMO_ADD
                else -> TallyCopy.MEMO_EDIT
            },
            revisions_heading = if (answer.revisions.isEmpty()) "" else TallyCopy.REVISIONS_HEADING,
            revisions = answer.revisions.map { revisionRow(it, writing) },
            trashed = trashed,
            trash_line = if (!trashed) {
                ""
            } else {
                answer.purge_on_local?.takeIf { it.isNotEmpty() }
                    ?.let { "${TallyCopy.IN_TRASH} · ${TallyCopy.PURGES_ON} ${CivilWords.dayMonth(it)}" }
                    ?: "${TallyCopy.IN_TRASH} · ${TallyCopy.PURGE_UNKNOWN}"
            },
            edit_label = if (trashed || writing) "" else TallyCopy.EDIT_VERB,
            trash_label = if (trashed || writing) "" else TallyCopy.TRASH_VERB,
            restore_label = if (trashed && !writing) TallyCopy.RESTORE_VERB else "",
        )
    }

    private fun shareRow(share: centraid.core.v1.TallyShare): TallyShareRow {
        val person = TallyFold.chip(share.person)
        return TallyShareRow(person = person, amount = TallyFold.money(share.amount), accessibility_label = person.name)
    }

    /** "1 GBP = 1.17 EUR", noted with the source and date it was given with. */
    private fun rateField(rate: TallyRate, settlement: String): TallyField {
        val from = rate.original?.currency ?: ""
        return TallyField(
            key = TallyCopy.FIELD_CURRENCY,
            value_ = "1 $from = ${TallySplit.decimal(rate.rate_scaled, rate.rate_scale.toInt())} $settlement",
            note = listOf(rate.rate_source, CivilWords.dayMonth(rate.rate_date)).filter { it.isNotEmpty() }.joinToString(" · "),
        )
    }

    private fun revisionRow(revision: TallyRevision, writing: Boolean): TallyRevisionRow {
        val title = when (revision.operation) {
            "edit" -> TallyCopy.REVISION_EDIT
            "trash" -> TallyCopy.REVISION_TRASH
            "restore" -> TallyCopy.REVISION_RESTORE
            "undo" -> TallyCopy.REVISION_UNDO
            else -> TallyCopy.REVISION_OTHER
        }
        val local = revision.recorded_local
        val at = if (local.length >= DAY) "${CivilWords.dayMonth(local.take(DAY))}, ${CivilWords.clock(local)}" else ""
        val was = revision.before_description?.takeIf { it.isNotEmpty() }?.let { "${TallyCopy.WAS_WORD} “$it”" } ?: ""
        return TallyRevisionRow(
            revision_id = revision.revision_id,
            title = title,
            meta = listOf(at, was).filter { it.isNotEmpty() }.joinToString(" · "),
            before_amount = revision.before_amount?.let(TallyFold::money),
            undo_label = if (revision.undoable && !writing) TallyCopy.UNDO_VERB else "",
            state_label = if (revision.undone_at != null) TallyCopy.UNDO_SPENT else "",
        )
    }

    private const val DAY: Int = 10

    override fun decorate(held: TallyHeld<TallyExpenseState>): TallyExpenseState =
        held.screen.copy(chrome = TallyGroupMachine.CHROME)

    private object Writes : WriteLens<TallyHeld<TallyExpenseState>> {
        override fun write(state: TallyHeld<TallyExpenseState>): WriteState = state.screen.write ?: WriteState()

        override fun with(state: TallyHeld<TallyExpenseState>, write: WriteState): TallyHeld<TallyExpenseState> =
            state.copy(screen = state.screen.copy(write = write))
    }

    internal object Lens : ContentLens<TallyExpenseState, TallyExpenseData> {
        override fun content(state: TallyExpenseState): ReadContent<TallyExpenseData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: TallyExpenseState, content: ReadContent<TallyExpenseData>): TallyExpenseState =
            when (content) {
                is ReadContent.Loading ->
                    state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
                is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
                is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
                is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
            }
    }
}

/** What an expense asks: the expense, live or trashed, in the device's zone. */
public object TallyExpenseReads : TallyQueries<TallyExpenseState, TallyExpenseEvent>(
    screenId = TallyExpenseMachine.SCREEN_ID,
    tables = TallyExpenseMachine.tables,
    ask = { held, now ->
        held.screen.expense_id.takeIf { it.isNotEmpty() }?.let {
            listOf(AppQueryRequest(tally_expense = TallyExpenseRequest(expense_id = it, tz = now.zone)))
        }
    },
)
