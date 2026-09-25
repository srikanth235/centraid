package dev.centraid.shared.apps.tally

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.TallyDashboardRequest
import centraid.core.v1.TallySettleUpRequest
import centraid.screen.v1.EmptyState
import centraid.screen.v1.Loading
import centraid.screen.v1.SeatState
import centraid.screen.v1.TallyPaymentDraft
import centraid.screen.v1.TallySettleUpData
import centraid.screen.v1.TallySettleUpEvent
import centraid.screen.v1.TallySettleUpState
import centraid.screen.v1.WriteSettled
import centraid.screen.v1.WriteState
import dev.centraid.design.copy.TallyCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.InvokeKeys
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.kit.WriteLens
import dev.centraid.shared.kit.dataOf
import dev.centraid.shared.kit.jsonString
import dev.centraid.shared.screen.Step

/**
 * SETTLE UP (#1046): the payments that would level the ledger, as the core
 * proposes them, and recording one that happened — the whole suggestion or a
 * smaller amount (a partial payment). A settlement records a payment; nothing
 * moves money.
 */
public object TallySettleUpMachine :
    TallyQueryMachine<TallySettleUpState, TallySettleUpEvent, TallySettleUpData>("tally.settle_up", TALLY_LEDGER_TABLES) {
    public const val SCREEN_ID: String = "tally.settle_up"
    public const val COMMAND: String = "tally.settle_up"

    override val lens: ContentLens<TallySettleUpState, TallySettleUpData> = Lens

    override fun blank(): TallySettleUpState = TallySettleUpState(
        write = WriteState(phase = WriteState.Phase.PHASE_IDLE),
        title = TallyCopy.SETTLE_HEAD,
        lede = TallyCopy.SETTLE_LEDE,
    )

    override fun withSeat(screen: TallySettleUpState, seat: SeatState): TallySettleUpState = screen.copy(seat = seat)

    override fun view(held: TallyHeld<TallySettleUpState>, event: TallySettleUpEvent): Step<TallyHeld<TallySettleUpState>> {
        val screen = held.screen
        return when {
            event.opened != null -> reload(
                held.copy(
                    screen = blank().copy(
                        seat = screen.seat,
                        group_id = event.opened.group_id,
                        draft_token = event.opened.draft_token,
                    ),
                ),
            )

            event.refreshed != null -> read(overRows(held))

            event.picked != null -> {
                val row = lens.dataOf(screen)?.suggestions?.firstOrNull { it.key == event.picked.key }
                if (row == null) {
                    Step(held)
                } else {
                    val exponent = row.amount?.exponent ?: 0
                    val draft = TallyPaymentDraft(
                        transfer = row,
                        amount_text = TallySplit.amountText(row.amount?.minor ?: 0L, exponent),
                    )
                    Step(held.copy(screen = screen.copy(draft = check(draft), write = WriteState(phase = WriteState.Phase.PHASE_IDLE))))
                }
            }

            event.amount != null -> {
                val draft = screen.draft ?: return Step(held)
                Step(held.copy(screen = screen.copy(draft = check(draft.copy(amount_text = event.amount.text)))))
            }

            event.dismissed != null -> Step(held.copy(screen = screen.copy(draft = null)))

            event.record != null -> record(held)

            else -> Step(held)
        }
    }

    /** The draft's words and whether it can record: an amount above nothing, and no more than suggested. */
    private fun check(draft: TallyPaymentDraft): TallyPaymentDraft {
        val suggested = draft.transfer?.amount
        val exponent = suggested?.exponent ?: 0
        val typed = TallySplit.parseAmount(draft.amount_text, exponent)
        val issue = when {
            typed == null || typed <= 0 -> TallyCopy.AMOUNT_MISSING
            suggested != null && typed > suggested.minor -> TallyCopy.PAYMENT_OVER
            else -> ""
        }
        return draft.copy(
            amount_key = "${TallyCopy.FIELD_AMOUNT} · ${suggested?.currency ?: ""}",
            record_label = TallyCopy.SETTLE_COMMIT,
            can_record = issue.isEmpty(),
            issue = issue,
            foot = if (draft.transfer?.yours == true) TallyCopy.SETTLE_FOOT_YOURS else TallyCopy.SETTLE_FOOT_THEIRS,
            cancel_label = TallyCopy.CANCEL,
        )
    }

    private fun record(held: TallyHeld<TallySettleUpState>): Step<TallyHeld<TallySettleUpState>> {
        val draft = held.screen.draft ?: return Step(held)
        val checked = check(draft)
        val transfer = checked.transfer ?: return Step(held)
        val amount = transfer.amount ?: return Step(held)
        val minor = TallySplit.parseAmount(checked.amount_text, amount.exponent)
        if (!checked.can_record || minor == null) return Step(held.copy(screen = held.screen.copy(draft = checked)))
        val from = transfer.from?.party_id ?: ""
        val to = transfer.to?.party_id ?: ""
        val input = buildString {
            append("{\"from_party\":").append(jsonString(from))
            append(",\"to_party\":").append(jsonString(to))
            append(",\"amount_minor\":").append(minor)
            append(",\"currency\":").append(jsonString(amount.currency))
            if (transfer.group_id.isNotEmpty()) append(",\"group_id\":").append(jsonString(transfer.group_id))
            append("}")
        }
        // A PAYMENT RECORDED TWICE BY A DOUBLE TAP IS ONE; the same payment in
        // another sitting is another (the sitting's token).
        val key = InvokeKeys.of(COMMAND, transfer.key, minor.toString(), held.screen.draft_token)
        return WriteLaw.submit(Writes, held.copy(screen = held.screen.copy(draft = checked)), COMMAND, input, key)
    }

    override fun settled(held: TallyHeld<TallySettleUpState>, settled: WriteSettled): Step<TallyHeld<TallySettleUpState>> {
        val step = WriteLaw.settled(Writes, held, settled)
        val committed = step.state.screen.write?.phase == WriteState.Phase.PHASE_COMMITTED
        // RECORDED: the draft closes, and the change event re-reads the proposals.
        return if (committed) Step(step.state.copy(screen = step.state.screen.copy(draft = null)), step.effects) else step
    }

    override fun fold(held: TallyHeld<TallySettleUpState>): TallySettleUpData? {
        val answer = held.answers.settleUp ?: return null
        val dashboard = held.answers.dashboard
        val names = (dashboard?.groups.orEmpty() + dashboard?.archived_groups.orEmpty()).associate { it.group_id to it.name }
        val rows = answer.suggestions.map { TallyFold.transferRow(it, names) }
        return TallySettleUpData(
            suggestions = rows,
            empty = if (rows.isEmpty()) EmptyState(headline = TallyCopy.SETTLE_EMPTY, body = TallyCopy.SETTLE_EMPTY_BODY) else null,
        )
    }

    override fun decorate(held: TallyHeld<TallySettleUpState>): TallySettleUpState =
        held.screen.copy(chrome = TallyGroupMachine.CHROME)

    private object Writes : WriteLens<TallyHeld<TallySettleUpState>> {
        override fun write(state: TallyHeld<TallySettleUpState>): WriteState = state.screen.write ?: WriteState()

        override fun with(state: TallyHeld<TallySettleUpState>, write: WriteState): TallyHeld<TallySettleUpState> =
            state.copy(screen = state.screen.copy(write = write))
    }

    internal object Lens : ContentLens<TallySettleUpState, TallySettleUpData> {
        override fun content(state: TallySettleUpState): ReadContent<TallySettleUpData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: TallySettleUpState, content: ReadContent<TallySettleUpData>): TallySettleUpState =
            when (content) {
                is ReadContent.Loading ->
                    state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
                is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
                is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
                is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
            }
    }
}

/** The proposals, and the dashboard for the group names they settle. */
public object TallySettleUpReads : TallyQueries<TallySettleUpState, TallySettleUpEvent>(
    screenId = TallySettleUpMachine.SCREEN_ID,
    tables = TALLY_LEDGER_TABLES,
    ask = { held, now ->
        listOf(
            AppQueryRequest(tally_settle_up = TallySettleUpRequest(group_id = held.screen.group_id)),
            AppQueryRequest(tally_dashboard = TallyDashboardRequest(tz = now.zone)),
        )
    },
)
