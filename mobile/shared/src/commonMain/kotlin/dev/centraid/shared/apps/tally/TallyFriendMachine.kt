package dev.centraid.shared.apps.tally

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.TallyFriendLedger
import centraid.core.v1.TallyFriendRequest
import centraid.screen.v1.EmptyState
import centraid.screen.v1.Loading
import centraid.screen.v1.SeatState
import centraid.screen.v1.TallyFriendData
import centraid.screen.v1.TallyFriendEvent
import centraid.screen.v1.TallyFriendState
import centraid.screen.v1.TallyHero
import centraid.screen.v1.TallyPartRow
import centraid.screen.v1.TallyTone
import dev.centraid.design.copy.TallyCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.screen.Step

/**
 * ONE FRIEND (#1046): their position per currency, where it came from — one
 * part per group and one outside any group — and the expenses you share.
 */
public object TallyFriendMachine :
    TallyQueryMachine<TallyFriendState, TallyFriendEvent, TallyFriendData>("tally.friend", TALLY_LEDGER_TABLES) {
    public const val SCREEN_ID: String = "tally.friend"

    override val lens: ContentLens<TallyFriendState, TallyFriendData> = Lens

    override fun blank(): TallyFriendState = TallyFriendState()

    override fun withSeat(screen: TallyFriendState, seat: SeatState): TallyFriendState = screen.copy(seat = seat)

    override fun view(held: TallyHeld<TallyFriendState>, event: TallyFriendEvent): Step<TallyHeld<TallyFriendState>> =
        when {
            event.opened != null -> reload(
                held.copy(screen = held.screen.copy(party_id = event.opened.party_id, title = event.opened.title)),
            )
            event.refreshed != null -> read(overRows(held))
            else -> Step(held)
        }

    override fun fold(held: TallyHeld<TallyFriendState>): TallyFriendData? = held.answers.friend?.let(::fold)

    internal fun fold(answer: TallyFriendLedger): TallyFriendData {
        val friend = answer.friend
            ?: return TallyFriendData(gone = EmptyState(headline = TallyCopy.FRIEND_GONE, body = TallyCopy.FRIEND_GONE_BODY))
        val lines = answer.balances
            .filter { it.minor != 0L }
            .map { TallyFold.position(it, TallyCopy.OWES_YOU, TallyCopy.YOU_OWE, TallyCopy.LEVEL) }
        val tone = when {
            lines.isEmpty() -> TallyTone.TALLY_TONE_LEVEL
            lines.all { it.tone == TallyTone.TALLY_TONE_OWE } -> TallyTone.TALLY_TONE_OWE
            else -> TallyTone.TALLY_TONE_OWED
        }
        return TallyFriendData(
            person = TallyFold.chip(friend),
            hero = TallyHero(
                lines = lines,
                label = if (lines.isEmpty()) TallyCopy.FRIEND_HERO_LEVEL else "",
                sub = TallyCopy.FRIEND_HERO_SUB,
                tone = tone,
            ),
            parts_heading = if (answer.parts.isEmpty()) "" else TallyCopy.PARTS_HEADING,
            parts = answer.parts.map { part ->
                val title = if (part.group_id == null) TallyCopy.OUTSIDE_ANY_GROUP else part.group_name
                val net = TallyFold.position(part.net, TallyCopy.OWES_YOU, TallyCopy.YOU_OWE, TallyCopy.LEVEL)
                TallyPartRow(
                    group_id = part.group_id ?: "",
                    title = title,
                    net = net,
                    accessibility_label = "$title, ${net.label}",
                )
            },
            parts_note = if (answer.parts.isEmpty()) "" else TallyCopy.FRIEND_PARTS_NOTE,
            ledger_heading = TallyCopy.SHARED_HEADING,
            ledger = answer.ledger.map { TallyFold.expenseRow(it, today = null, withGroup = true) },
            ledger_empty = if (answer.ledger.isEmpty()) {
                EmptyState(headline = TallyCopy.FRIEND_LEDGER_EMPTY, action_label = TallyCopy.ADD_COMMIT)
            } else {
                null
            },
        )
    }

    override fun decorate(held: TallyHeld<TallyFriendState>): TallyFriendState =
        held.screen.copy(chrome = TallyGroupMachine.CHROME)

    internal object Lens : ContentLens<TallyFriendState, TallyFriendData> {
        override fun content(state: TallyFriendState): ReadContent<TallyFriendData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: TallyFriendState, content: ReadContent<TallyFriendData>): TallyFriendState = when (content) {
            is ReadContent.Loading ->
                state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
            is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
            is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
            is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
        }
    }
}

/** What a friend's ledger asks. Nothing until it knows which friend. */
public object TallyFriendReads : TallyQueries<TallyFriendState, TallyFriendEvent>(
    screenId = TallyFriendMachine.SCREEN_ID,
    tables = TALLY_LEDGER_TABLES,
    ask = { held, _ ->
        held.screen.party_id.takeIf { it.isNotEmpty() }?.let {
            listOf(AppQueryRequest(tally_friend = TallyFriendRequest(party_id = it)))
        }
    },
)
