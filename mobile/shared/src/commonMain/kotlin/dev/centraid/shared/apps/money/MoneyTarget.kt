package dev.centraid.shared.apps.money

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.MoneyTargetSheetRequest
import centraid.screen.v1.Loading
import centraid.screen.v1.MoneyPageChrome
import centraid.screen.v1.MoneyTargetData
import centraid.screen.v1.MoneyTargetEvent
import centraid.screen.v1.MoneyTargetState
import centraid.screen.v1.SeatState
import centraid.screen.v1.WriteSettled
import centraid.screen.v1.WriteState
import dev.centraid.design.copy.MoneyCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.InvokeKeys
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.kit.WriteLens
import dev.centraid.shared.screen.Step

/**
 * A CATEGORY'S PLAN FOR ONE MONTH (#1099, R-1099-5), a sheet over Spending. The
 * stored facts are four: month, category, amount, carry. The sheet shows what
 * the last six months averaged and previews the NEXT month's effect before the
 * member commits, so the core is asked again as they type (`typing_*`).
 */
public object MoneyTargetMachine :
    MoneyQueryMachine<MoneyTargetState, MoneyTargetEvent, MoneyTargetData>("money.target", MONEY_TABLES) {
    public const val SCREEN_ID: String = "money.target"
    public const val CMD_SET: String = "money.set_target"

    override val lens: ContentLens<MoneyTargetState, MoneyTargetData> = Lens

    override fun blank(): MoneyTargetState = MoneyTargetState(
        write = WriteState(phase = WriteState.Phase.PHASE_IDLE),
        chrome = chrome(),
    )

    override fun withSeat(screen: MoneyTargetState, seat: SeatState): MoneyTargetState = screen.copy(seat = seat)

    override fun view(held: MoneyHeld<MoneyTargetState>, event: MoneyTargetEvent): Step<MoneyHeld<MoneyTargetState>> {
        val screen = held.screen
        return when {
            event.opened != null -> reload(
                held.copy(
                    screen = blank().copy(
                        seat = screen.seat,
                        month = event.opened.month,
                        category_id = event.opened.category_id,
                        currency = event.opened.currency,
                        draft_token = event.opened.draft_token,
                    ),
                ),
            )

            event.refreshed != null -> read(overRows(held))

            // TYPING ASKS THE CORE FOR THE PREVIEW: the sheet's figures are the core's.
            event.amount != null -> read(overRows(held.copy(screen = screen.copy(amount_text = event.amount.text))))

            event.carry != null -> read(overRows(held.copy(screen = screen.copy(carry = !screen.carry))))

            event.use_average != null -> {
                val average = held.answers.target?.six_month_average ?: return Step(held)
                val text = MoneyFold.amountText(average.minor, average.exponent)
                read(overRows(held.copy(screen = screen.copy(amount_text = text))))
            }

            event.save != null -> save(held, remove = false)

            event.remove != null -> save(held, remove = true)

            else -> Step(held)
        }
    }

    private fun exponentOf(held: MoneyHeld<MoneyTargetState>): Int = held.answers.target?.spent?.exponent ?: 0

    private fun typed(held: MoneyHeld<MoneyTargetState>): Long? =
        MoneyFold.parseAmount(held.screen.amount_text, exponentOf(held))

    private fun save(held: MoneyHeld<MoneyTargetState>, remove: Boolean): Step<MoneyHeld<MoneyTargetState>> {
        val screen = held.screen
        val minor = if (remove) null else typed(held) ?: return Step(held)
        val input = MoneyFold.json(
            "month" to MoneyFold.str(screen.month),
            "category_concept_id" to MoneyFold.str(screen.category_id),
            "amount_minor" to (minor?.toString() ?: "null"),
            "currency" to MoneyFold.str(screen.currency),
            "carry" to if (remove) null else screen.carry.toString(),
        )
        // The same plan again in one sitting is the same write; another amount is another.
        val key = InvokeKeys.of(CMD_SET, "${screen.month}:${screen.category_id}", minor?.toString() ?: "none", screen.carry.toString())
        return WriteLaw.submit(Writes, held, CMD_SET, input, key)
    }

    override fun settled(held: MoneyHeld<MoneyTargetState>, settled: WriteSettled): Step<MoneyHeld<MoneyTargetState>> =
        WriteLaw.settled(Writes, held, settled)

    /** The first answer seeds the form from the stored plan; later answers never overwrite typing. */
    override fun absorb(held: MoneyHeld<MoneyTargetState>): MoneyHeld<MoneyTargetState> {
        val answer = held.answers.target ?: return held
        if (held.screen.seeded) return held
        val amount = answer.amount
        return held.copy(
            screen = held.screen.copy(
                seeded = true,
                amount_text = amount?.let { MoneyFold.amountText(it.minor, it.exponent) }.orEmpty(),
                carry = answer.carry,
            ),
        )
    }

    override fun fold(held: MoneyHeld<MoneyTargetState>): MoneyTargetData? {
        val answer = held.answers.target ?: return null
        val screen = held.screen
        val exponent = exponentOf(held)
        val minor = typed(held)
        val stored = answer.amount != null && screen.seeded
        val issue = when {
            screen.amount_text.isBlank() -> ""
            minor == null -> MoneyCopy.AMOUNT_INVALID
            else -> ""
        }
        return MoneyTargetData(
            title = MoneyFold.fill(MoneyCopy.TARGET_TITLE, "category" to answer.category_label),
            month_label = MoneyFold.monthLabel(answer.month),
            amount_label = MoneyCopy.TARGET_AMOUNT_LABEL,
            currency_label = answer.currency,
            figures = listOf(
                MoneyFold.figure(MoneyCopy.TARGET_AVERAGE, answer.six_month_average),
                MoneyFold.figure(MoneyCopy.TARGET_SPENT, answer.spent),
                MoneyFold.figure(MoneyCopy.TARGET_CARRIED_IN, answer.carry_in),
            ),
            use_average_label = MoneyCopy.TARGET_USE_AVERAGE,
            carry_label = MoneyCopy.TARGET_CARRY,
            carry_note = MoneyCopy.TARGET_CARRY_NOTE,
            preview_label = MoneyFold.fill(MoneyCopy.TARGET_PREVIEW, "month" to MoneyFold.monthLabel(MoneyFold.shiftMonth(answer.month, 1))),
            preview = MoneyFold.money(answer.next_month_preview),
            preview_note = if (screen.carry) MoneyCopy.TARGET_PREVIEW_CARRIES else MoneyCopy.TARGET_PREVIEW_NOTHING,
            save_label = MoneyCopy.TARGET_SAVE,
            remove_label = if (stored && answer.amount != null) MoneyCopy.TARGET_REMOVE else "",
            can_save = minor != null && issue.isEmpty(),
            issue = issue,
            exponent_hint = if (exponent == 0) MoneyCopy.WHOLE_UNITS else "",
            exponent = exponent,
        )
    }

    private fun chrome(): MoneyPageChrome =
        MoneyPageChrome(title = MoneyCopy.TARGET_SHEET_TITLE, back_label = MoneyCopy.APP_TITLE, retry = MoneyCopy.RETRY)

    internal object Lens : ContentLens<MoneyTargetState, MoneyTargetData> {
        override fun content(state: MoneyTargetState): ReadContent<MoneyTargetData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: MoneyTargetState, content: ReadContent<MoneyTargetData>): MoneyTargetState = when (content) {
            is ReadContent.Loading -> state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
            is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
            is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
            is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
        }
    }

    private object Writes : WriteLens<MoneyHeld<MoneyTargetState>> {
        override fun write(state: MoneyHeld<MoneyTargetState>): WriteState = state.screen.write ?: WriteState()

        override fun with(state: MoneyHeld<MoneyTargetState>, write: WriteState): MoneyHeld<MoneyTargetState> =
            state.copy(screen = state.screen.copy(write = write))
    }
}

/** The sheet's read, asked again with what the member is typing. */
public object MoneyTargetReads : MoneyQueries<MoneyTargetState, MoneyTargetEvent>(
    screenId = MoneyTargetMachine.SCREEN_ID,
    tables = MONEY_TABLES,
    ask = { held, now ->
        val screen = held.screen
        screen.category_id.takeIf { it.isNotEmpty() }?.let { category ->
            val exponent = held.answers.target?.spent?.exponent ?: 0
            val typing = if (screen.seeded) MoneyFold.parseAmount(screen.amount_text, exponent) else null
            listOf(
                AppQueryRequest(
                    money_target_sheet = MoneyTargetSheetRequest(
                        tz = now.zone,
                        month = screen.month,
                        category_id = category,
                        currency = screen.currency,
                        typing_amount_minor = typing,
                        typing_carry = screen.seeded && screen.carry,
                    ),
                ),
            )
        }
    },
)
