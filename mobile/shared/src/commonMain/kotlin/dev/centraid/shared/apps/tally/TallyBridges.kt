package dev.centraid.shared.apps.tally

import centraid.screen.v1.TallyEditorEvent
import centraid.screen.v1.TallyEditorState
import centraid.screen.v1.TallyExpenseEvent
import centraid.screen.v1.TallyExpenseState
import centraid.screen.v1.TallyFriendEvent
import centraid.screen.v1.TallyFriendState
import centraid.screen.v1.TallyGroupEvent
import centraid.screen.v1.TallyGroupState
import centraid.screen.v1.TallyHomeEvent
import centraid.screen.v1.TallyHomeState
import centraid.screen.v1.TallyRecurringEvent
import centraid.screen.v1.TallyRecurringState
import centraid.screen.v1.TallySearchEvent
import centraid.screen.v1.TallySearchState
import centraid.screen.v1.TallySettleUpEvent
import centraid.screen.v1.TallySettleUpState
import centraid.screen.v1.TallySpendingEvent
import centraid.screen.v1.TallySpendingState
import centraid.screen.v1.TrashListEvent
import centraid.screen.v1.TrashListState
import dev.centraid.design.copy.TallyCopy
import dev.centraid.shared.kit.ScreenBridge
import dev.centraid.shared.kit.TrashMachine
import dev.centraid.shared.kit.TrashReads
import dev.centraid.shared.kit.TrashSpec
import kotlin.random.Random

/**
 * ONE BRIDGE PER TALLY SCREEN (#1046), each a [TallyScreenBridge] with a
 * stable Swift name and one call to open it. A shell pushes the matching
 * `Destination.Tally*` and calls `open…`; a view forwards the screen's events
 * with `send`/`forward`, and routes the INTENTS it reads off them (the
 * machines change nothing on an intent).
 */
public class TallyHomeBridge : TallyScreenBridge<TallyHomeState, TallyHomeEvent>(
    TallyHomeMachine,
    TallyHomeEvent.ADAPTER,
    TallyHomeReads,
) {
    /** Land on [destination] — Balances unless the shell says otherwise. */
    public fun open(destination: TallyHomeState.Destination = TallyHomeState.Destination.DESTINATION_BALANCES) {
        forward(TallyHomeEvent(opened = TallyHomeEvent.Opened(destination = destination)))
    }

    // SWIFT CANNOT OMIT A KOTLIN DEFAULT ARGUMENT: each overload below is the
    // call with the defaults spelled out.
    public fun open() {
        open(TallyHomeState.Destination.DESTINATION_BALANCES)
    }
}

public class TallyGroupBridge : TallyScreenBridge<TallyGroupState, TallyGroupEvent>(
    TallyGroupMachine,
    TallyGroupEvent.ADAPTER,
    TallyGroupReads,
) {
    /** [title] is the group's name where the shell has it, for the app bar before the read. */
    public fun open(groupId: String, title: String = "") {
        forward(TallyGroupEvent(opened = TallyGroupEvent.Opened(group_id = groupId, title = title)))
    }

    /** Swift cannot omit `title`'s default: this is the call without it. */
    public fun open(groupId: String) {
        open(groupId, "")
    }
}

public class TallyFriendBridge : TallyScreenBridge<TallyFriendState, TallyFriendEvent>(
    TallyFriendMachine,
    TallyFriendEvent.ADAPTER,
    TallyFriendReads,
) {
    public fun open(partyId: String, title: String = "") {
        forward(TallyFriendEvent(opened = TallyFriendEvent.Opened(party_id = partyId, title = title)))
    }

    /** Swift cannot omit `title`'s default: this is the call without it. */
    public fun open(partyId: String) {
        open(partyId, "")
    }
}

public class TallyExpenseBridge : TallyScreenBridge<TallyExpenseState, TallyExpenseEvent>(
    TallyExpenseMachine,
    TallyExpenseEvent.ADAPTER,
    TallyExpenseReads,
) {
    public fun open(expenseId: String) {
        forward(TallyExpenseEvent(opened = TallyExpenseEvent.Opened(expense_id = expenseId)))
    }
}

/**
 * The editor. Each open mints the SITTING'S TOKEN, which keys the save: a
 * double tap is one expense, and the same expense added again later is not
 * deduplicated into the first.
 */
public class TallyEditorBridge : TallyScreenBridge<TallyEditorState, TallyEditorEvent>(
    TallyEditorMachine,
    TallyEditorEvent.ADAPTER,
    TallyEditorReads,
) {
    /** Add an expense, preset with the group or the friend it was opened from. */
    public fun openAdd(groupId: String = "", partyId: String = "") {
        forward(
            TallyEditorEvent(
                opened = TallyEditorEvent.Opened(
                    mode = TallyEditorState.Mode.MODE_ADD,
                    group_id = groupId,
                    party_id = partyId,
                    draft_token = token(),
                ),
            ),
        )
    }

    /** [openAdd] with no preset — the call Swift can make (default arguments do not cross). */
    public fun openAdd() {
        openAdd("", "")
    }

    public fun openEdit(expenseId: String) {
        forward(
            TallyEditorEvent(
                opened = TallyEditorEvent.Opened(
                    mode = TallyEditorState.Mode.MODE_EDIT,
                    expense_id = expenseId,
                    draft_token = token(),
                ),
            ),
        )
    }
}

public class TallySettleUpBridge : TallyScreenBridge<TallySettleUpState, TallySettleUpEvent>(
    TallySettleUpMachine,
    TallySettleUpEvent.ADAPTER,
    TallySettleUpReads,
) {
    /** Empty [groupId] is every group plus the group-less positions. */
    public fun open(groupId: String = "") {
        forward(TallySettleUpEvent(opened = TallySettleUpEvent.Opened(group_id = groupId, draft_token = token())))
    }

    /** Every group: the call Swift can make (default arguments do not cross). */
    public fun open() {
        open("")
    }
}

public class TallyRecurringBridge : TallyScreenBridge<TallyRecurringState, TallyRecurringEvent>(
    TallyRecurringMachine,
    TallyRecurringEvent.ADAPTER,
    TallyRecurringReads,
) {
    public fun open() {
        forward(TallyRecurringEvent(opened = TallyRecurringEvent.Opened()))
    }
}

public class TallySpendingBridge : TallyScreenBridge<TallySpendingState, TallySpendingEvent>(
    TallySpendingMachine,
    TallySpendingEvent.ADAPTER,
    TallySpendingReads,
) {
    public fun open() {
        forward(TallySpendingEvent(opened = TallySpendingEvent.Opened()))
    }
}

public class TallySearchBridge : TallyScreenBridge<TallySearchState, TallySearchEvent>(
    TallySearchMachine,
    TallySearchEvent.ADAPTER,
    TallySearchReads,
) {
    public fun open() {
        forward(TallySearchEvent(opened = TallySearchEvent.Opened()))
    }
}

/**
 * TALLY'S TRASH, the kit's one trash screen (#1015 D1) with Tally as its
 * parameter. RESTORE ONLY: Tally has no purge command — the sweep purges a
 * trashed expense 30 days on (`PURGE_WINDOW_DAYS`) — so there is no "Delete
 * forever" and no "Empty trash", and the screen says nothing it cannot do.
 */
public val TALLY_TRASH: TrashSpec = TrashSpec(
    appId = "tally",
    table = "tally_expense",
    restoreCommand = "tally.restore_expense",
    purgeCommand = null,
    emptyCommand = null,
    idColumn = "expense_id",
    titleColumn = "description",
    purgeWindowDays = 30,
    backLabel = TallyCopy.APP_TITLE,
)

/** The trash's machine and reads, one each. */
public val TallyTrashMachine: TrashMachine = TrashMachine(TALLY_TRASH)
public val TallyTrashReads: TrashReads = TrashReads(TALLY_TRASH)

public class TallyTrashBridge : ScreenBridge<TrashListState, TrashListEvent>(
    machine = TallyTrashMachine,
    events = TrashListEvent.ADAPTER,
    wire = { w -> w.session.attachScreen(w.host, TallyTrashReads, TallyTrashReads, left = w.left) },
) {
    public fun open() {
        forward(TrashListEvent(opened = TrashListEvent.Opened()))
    }
}

/** A sitting's token: unique enough to tell two sittings apart, and nothing else. */
private fun token(): String = Random.nextLong().toULong().toString(TOKEN_RADIX)

private const val TOKEN_RADIX: Int = 36
