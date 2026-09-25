package dev.centraid.shared.apps.tally

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.TallyGroupLedger
import centraid.core.v1.TallyGroupRequest
import centraid.screen.v1.EmptyState
import centraid.screen.v1.Loading
import centraid.screen.v1.SeatState
import centraid.screen.v1.TallyDetailChrome
import centraid.screen.v1.TallyGroupData
import centraid.screen.v1.TallyGroupEvent
import centraid.screen.v1.TallyGroupState
import centraid.screen.v1.TallyMemberRow
import centraid.screen.v1.TallySimplify
import centraid.screen.v1.WriteSettled
import centraid.screen.v1.WriteState
import dev.centraid.design.copy.TallyCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.InvokeKeys
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.kit.WriteLens
import dev.centraid.shared.kit.jsonString
import dev.centraid.shared.screen.Step

/**
 * ONE GROUP'S LEDGER (#1046): members with their nets, the expenses, the
 * settlements, and simplification — opt-in per group, a write, and a
 * proposal the core derives.
 *
 * A group that does not exist is a sentence, not an error: a stale link from
 * Activity lands here after a delete.
 */
public object TallyGroupMachine :
    TallyQueryMachine<TallyGroupState, TallyGroupEvent, TallyGroupData>("tally.group", TALLY_LEDGER_TABLES) {
    public const val SCREEN_ID: String = "tally.group"

    public const val SIMPLIFY_COMMAND: String = "tally.set_group_simplification"

    override val lens: ContentLens<TallyGroupState, TallyGroupData> = Lens

    override fun blank(): TallyGroupState = TallyGroupState(write = WriteState(phase = WriteState.Phase.PHASE_IDLE))

    override fun withSeat(screen: TallyGroupState, seat: SeatState): TallyGroupState = screen.copy(seat = seat)

    override fun view(held: TallyHeld<TallyGroupState>, event: TallyGroupEvent): Step<TallyHeld<TallyGroupState>> =
        when {
            event.opened != null -> reload(
                held.copy(
                    screen = held.screen.copy(
                        group_id = event.opened.group_id,
                        title = event.opened.title,
                        write = WriteState(phase = WriteState.Phase.PHASE_IDLE),
                    ),
                ),
            )

            event.refreshed != null -> read(overRows(held))

            event.simplify_toggled != null -> {
                val group = held.answers.group?.group
                if (group == null || lens.content(held.screen) !is ReadContent.Data) {
                    Step(held)
                } else {
                    val on = !group.simplify_opt_in
                    val input = "{\"group_id\":${jsonString(group.group_id)},\"simplify\":$on}"
                    val step = WriteLaw.submit(
                        Writes,
                        held,
                        SIMPLIFY_COMMAND,
                        input,
                        InvokeKeys.of(SIMPLIFY_COMMAND, group.group_id, if (on) "on" else "off"),
                    )
                    // The toggle disables while its write is out.
                    val folded = refold(step.state)
                    Step(folded.state, step.effects)
                }
            }

            // INTENTS the shell routes.
            else -> Step(held)
        }

    override fun settled(held: TallyHeld<TallyGroupState>, settled: WriteSettled): Step<TallyHeld<TallyGroupState>> {
        val step = WriteLaw.settled(Writes, held, settled)
        return Step(refold(step.state).state, step.effects)
    }

    override fun fold(held: TallyHeld<TallyGroupState>): TallyGroupData? {
        val ledger = held.answers.group ?: return null
        return fold(ledger, held.screen.write?.phase == WriteState.Phase.PHASE_IN_FLIGHT)
    }

    internal fun fold(answer: TallyGroupLedger, writing: Boolean): TallyGroupData {
        val group = answer.group
            ?: return TallyGroupData(gone = EmptyState(headline = TallyCopy.GROUP_GONE, body = TallyCopy.GROUP_GONE_BODY))
        val me = answer.members.firstOrNull { it.person?.is_me == true }
        val members = answer.members.map { member ->
            val person = TallyFold.chip(member.person)
            val net = TallyFold.position(member.net, TallyCopy.IS_OWED, TallyCopy.OWES, TallyCopy.LEVEL)
            val meta = if (member.departed) TallyCopy.DEPARTED_META else ""
            TallyMemberRow(
                person = person,
                net = net,
                meta = meta,
                departed = member.departed,
                accessibility_label = listOf(person.name, net.label, meta).filter { it.isNotEmpty() }.joinToString(", "),
            )
        }
        val simplification = answer.simplification
        val optedIn = simplification?.opted_in ?: group.simplify_opt_in
        val transfers = simplification?.transfers.orEmpty()
        val level = answer.members.all { (it.net?.minor ?: 0L) == 0L }
        return TallyGroupData(
            name = group.name,
            icon_key = TallyFold.groupIcon(group.icon),
            glyph = TallyFold.groupGlyph(group.icon),
            hue = group.color,
            archived_meta = if (group.archived_at != null) TallyCopy.ARCHIVED_META else "",
            hero = TallyFold.hero(
                me?.net,
                TallyCopy.GROUP_HERO_OWED,
                TallyCopy.GROUP_HERO_OWE,
                TallyCopy.GROUP_HERO_LEVEL,
                TallyCopy.GROUP_HERO_SUB,
            ),
            members_heading = TallyCopy.MEMBERS_HEADING,
            members = members,
            ledger_heading = TallyCopy.EXPENSES_HEADING,
            ledger = answer.ledger.map { TallyFold.expenseRow(it, today = null, withGroup = false) },
            ledger_empty = if (answer.ledger.isEmpty()) {
                EmptyState(headline = TallyCopy.GROUP_LEDGER_EMPTY, action_label = TallyCopy.ADD_COMMIT)
            } else {
                null
            },
            settlements_heading = if (answer.settlements.isEmpty()) "" else TallyCopy.SETTLEMENTS_HEADING,
            settlements = answer.settlements.map { TallyFold.settlementRow(it, groupName = "", today = null) },
            simplify = TallySimplify(
                heading = TallyCopy.SIMPLIFY_HEAD,
                opted_in = optedIn,
                state_line = when {
                    level -> TallyCopy.SIMPLIFY_NONE
                    optedIn -> TallyCopy.SIMPLIFY_ON
                    else -> TallyCopy.SIMPLIFY_OFF
                },
                toggle_label = if (optedIn) TallyCopy.SIMPLIFY_STOP else TallyCopy.SIMPLIFY_COMMIT,
                toggle_enabled = !writing,
                summary = if (optedIn && simplification != null && !level) {
                    "${TallyFold.count(simplification.debts_before.toInt(), TallyCopy.DEBT_ONE, TallyCopy.DEBT_MANY)} " +
                        "${TallyCopy.BECOME_WORD} " +
                        TallyFold.count(simplification.payments_after.toInt(), TallyCopy.PAYMENT_ONE, TallyCopy.PAYMENT_MANY)
                } else {
                    ""
                },
                explanation = TallyCopy.SIMPLIFY_EXPLAINED,
                transfers = if (optedIn) transfers.map { TallyFold.transferRow(it, mapOf(group.group_id to group.name)) } else emptyList(),
            ),
        )
    }

    override fun decorate(held: TallyHeld<TallyGroupState>): TallyGroupState = held.screen.copy(chrome = CHROME)

    internal val CHROME: TallyDetailChrome = TallyDetailChrome(
        retry = TallyCopy.RETRY,
        loading = TallyCopy.LOADING,
        add_expense = TallyCopy.ADD_COMMIT,
        settle_up = TallyCopy.SETTLE_HEAD,
        back = TallyCopy.APP_TITLE,
        memo_placeholder = TallyCopy.MEMO_PLACEHOLDER,
        memo_done = TallyCopy.DONE,
    )

    private object Writes : WriteLens<TallyHeld<TallyGroupState>> {
        override fun write(state: TallyHeld<TallyGroupState>): WriteState = state.screen.write ?: WriteState()

        override fun with(state: TallyHeld<TallyGroupState>, write: WriteState): TallyHeld<TallyGroupState> =
            state.copy(screen = state.screen.copy(write = write))
    }

    internal object Lens : ContentLens<TallyGroupState, TallyGroupData> {
        override fun content(state: TallyGroupState): ReadContent<TallyGroupData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: TallyGroupState, content: ReadContent<TallyGroupData>): TallyGroupState = when (content) {
            is ReadContent.Loading ->
                state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
            is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
            is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
            is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
        }
    }
}

/** What a group's ledger asks. Nothing until it knows which group. */
public object TallyGroupReads : TallyQueries<TallyGroupState, TallyGroupEvent>(
    screenId = TallyGroupMachine.SCREEN_ID,
    tables = TALLY_LEDGER_TABLES,
    ask = { held, _ ->
        held.screen.group_id.takeIf { it.isNotEmpty() }?.let {
            listOf(AppQueryRequest(tally_group = TallyGroupRequest(group_id = it)))
        }
    },
)
