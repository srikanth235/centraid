package dev.centraid.android.screens.tally

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import centraid.screen.v1.TallyEditorEvent
import centraid.screen.v1.TallyExpenseEvent
import centraid.screen.v1.TallyFriendEvent
import centraid.screen.v1.TallyGroupEvent
import centraid.screen.v1.TallyHomeEvent
import centraid.screen.v1.TallyHomeState
import centraid.screen.v1.TallySearchEvent
import centraid.screen.v1.TallySettleUpEvent
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.TrashListScreen
import dev.centraid.android.screens.AppRoutes
import dev.centraid.android.screens.RouteNav
import dev.centraid.shared.apps.tally.TallyEditorBridge
import dev.centraid.shared.apps.tally.TallyExpenseBridge
import dev.centraid.shared.apps.tally.TallyFriendBridge
import dev.centraid.shared.apps.tally.TallyGroupBridge
import dev.centraid.shared.apps.tally.TallyHomeBridge
import dev.centraid.shared.apps.tally.TallyHomeMachine
import dev.centraid.shared.apps.tally.TallyRecurringBridge
import dev.centraid.shared.apps.tally.TallySearchBridge
import dev.centraid.shared.apps.tally.TallySettleUpBridge
import dev.centraid.shared.apps.tally.TallySpendingBridge
import dev.centraid.shared.apps.tally.TallyTrashBridge
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavStack
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope

/**
 * TALLY'S ROUTES (#1046): `tally.home` (Balances · Activity · Groups, More as
 * a sheet) and every screen pushed from it, one bridge each for the
 * activity's life. The machines emit INTENTS (a pick, Add expense, Settle
 * up, a More row, Edit) and change nothing on them; this file is where they
 * become pushes and `open(…)` calls.
 */
public class TallyRoutes : AppRoutes {
    private val home = TallyHomeBridge()
    private val group = TallyGroupBridge()
    private val friend = TallyFriendBridge()
    private val expense = TallyExpenseBridge()
    private val editor = TallyEditorBridge()
    private val settle = TallySettleUpBridge()
    private val recurring = TallyRecurringBridge()
    private val spending = TallySpendingBridge()
    private val search = TallySearchBridge()
    private val trash = TallyTrashBridge()

    override fun handles(destination: Destination): Boolean = when (destination) {
        is Destination.TallyApp, is Destination.TallyGroup, is Destination.TallyFriend, is Destination.TallyExpense,
        is Destination.TallyEditor, is Destination.TallySettleUp, Destination.TallyRecurring, Destination.TallySpending,
        Destination.TallySearch, Destination.TallyTrash,
        -> true
        else -> false
    }

    // `open()` ON THE PUSH (Agenda's rule): returning to the home from a
    // pushed page keeps its tab, its window and its answer.
    override fun opens(moveId: String): Destination? = if (moveId == "tally") {
        home.open()
        Destination.TallyApp()
    } else {
        null
    }

    override fun attach(session: HomeSession, scope: CoroutineScope) {
        home.attach(session)
        group.attach(session)
        friend.attach(session)
        expense.attach(session)
        editor.attach(session)
        settle.attach(session)
        recurring.attach(session)
        spending.attach(session)
        search.attach(session)
        trash.attach(session)
    }

    /** What the back key names: the page under the top, in the state's own words. */
    private fun parentTitle(stack: NavStack): String {
        val under = stack.entries.dropLast(1).lastOrNull()
        return when (under) {
            is Destination.TallyApp -> home.screen.chrome?.title
            is Destination.TallyGroup -> under.name.ifEmpty { group.screen.data_?.name ?: group.screen.title }
            is Destination.TallyFriend -> under.name.ifEmpty { friend.screen.data_?.person?.name ?: friend.screen.title }
            is Destination.TallyExpense -> expense.screen.data_?.title
            Destination.TallyRecurring -> recurring.screen.title
            Destination.TallySpending -> spending.screen.chrome?.title
            Destination.TallySearch -> search.screen.chrome?.title
            is Destination.TallySettleUp -> settle.screen.title
            else -> null
        }?.ifEmpty { null } ?: KitWords.BACK
    }

    @Composable
    override fun Routes(destination: Destination, nav: RouteNav) {
        val parent = parentTitle(nav.stack)
        when (destination) {
            is Destination.TallyApp -> HomeRoute(destination, nav)
            is Destination.TallyGroup -> {
                LaunchedEffect(destination) { group.open(destination.groupId, destination.name) }
                val held by group.host.state.collectAsStateWithLifecycle()
                val state = held.screen
                TallyGroupScreen(state, parent, onBack = nav::pop, onEvent = { event ->
                    group.forward(event)
                    when {
                        event.add_expense != null -> push(nav, Destination.TallyEditor(groupId = destination.groupId)) {
                            editor.openAdd(groupId = destination.groupId)
                        }
                        event.settle_up != null -> push(nav, Destination.TallySettleUp(destination.groupId))
                        event.expense != null -> push(nav, Destination.TallyExpense(event.expense!!.expense_id))
                        event.member != null -> {
                            val id = event.member!!.party_id
                            val name = state.data_?.members?.firstOrNull { it.person?.party_id == id }?.person?.name.orEmpty()
                            push(nav, Destination.TallyFriend(id, name))
                        }
                    }
                })
            }
            is Destination.TallyFriend -> {
                LaunchedEffect(destination) { friend.open(destination.partyId, destination.name) }
                val held by friend.host.state.collectAsStateWithLifecycle()
                val state = held.screen
                TallyFriendScreen(state, parent, onBack = nav::pop, onEvent = { event ->
                    friend.forward(event)
                    when {
                        event.add_expense != null -> push(nav, Destination.TallyEditor(partyId = destination.partyId)) {
                            editor.openAdd(partyId = destination.partyId)
                        }
                        event.settle_up != null -> push(nav, Destination.TallySettleUp())
                        event.expense != null -> push(nav, Destination.TallyExpense(event.expense!!.expense_id))
                        event.group != null -> {
                            val id = event.group!!.group_id
                            val name = state.data_?.parts?.firstOrNull { it.group_id == id }?.title.orEmpty()
                            push(nav, Destination.TallyGroup(id, name))
                        }
                    }
                })
            }
            is Destination.TallyExpense -> {
                LaunchedEffect(destination) { expense.open(destination.expenseId) }
                val held by expense.host.state.collectAsStateWithLifecycle()
                TallyExpenseScreen(held.screen, parent, onBack = nav::pop, onEvent = { event ->
                    expense.forward(event)
                    if (event.edit != null) {
                        push(nav, Destination.TallyEditor(expenseId = destination.expenseId)) { editor.openEdit(destination.expenseId) }
                    }
                })
            }
            is Destination.TallyEditor -> EditorRoute(destination, parent, nav)
            is Destination.TallySettleUp -> {
                LaunchedEffect(destination) { settle.open(destination.groupId) }
                val held by settle.host.state.collectAsStateWithLifecycle()
                TallySettleUpScreen(held.screen, parent, onBack = nav::pop, onEvent = { event: TallySettleUpEvent -> settle.forward(event) })
            }
            Destination.TallyRecurring -> {
                LaunchedEffect(destination) { recurring.open() }
                val held by recurring.host.state.collectAsStateWithLifecycle()
                TallyRecurringScreen(held.screen, parent, onBack = nav::pop, onEvent = recurring::forward)
            }
            Destination.TallySpending -> {
                LaunchedEffect(destination) { spending.open() }
                val held by spending.host.state.collectAsStateWithLifecycle()
                TallySpendingScreen(held.screen, parent, onBack = nav::pop, onEvent = spending::forward)
            }
            Destination.TallySearch -> {
                LaunchedEffect(destination) { search.open() }
                val held by search.host.state.collectAsStateWithLifecycle()
                TallySearchScreen(held.screen, parent, onBack = nav::pop, onEvent = { event: TallySearchEvent ->
                    search.forward(event)
                    event.expense?.let { push(nav, Destination.TallyExpense(it.expense_id)) }
                })
            }
            Destination.TallyTrash -> {
                LaunchedEffect(destination) { trash.open() }
                val state by trash.host.state.collectAsStateWithLifecycle()
                TrashListScreen(state = state, onEvent = trash::forward, parentTitle = parent, onBack = nav::pop)
            }
            else -> Unit
        }
    }

    @Composable
    private fun HomeRoute(destination: Destination.TallyApp, nav: RouteNav) {
        val held by home.host.state.collectAsStateWithLifecycle()
        val state = held.screen
        // THE ROUTE FOLLOWS THE MACHINE: a band tab swaps the top entry's parameter, never a push.
        LaunchedEffect(state.destination) {
            val band = state.destination
            val top = nav.stack.current
            if (band != TallyHomeState.Destination.DESTINATION_UNSPECIFIED && top is Destination.TallyApp && top.destination != band) {
                nav.go(NavStack(nav.stack.entries.dropLast(1) + top.copy(destination = band)))
            }
        }
        TallyHomeScreen(state, onHome = nav::home, onEvent = { event: TallyHomeEvent ->
            home.forward(event)
            when {
                event.add_expense != null -> push(nav, Destination.TallyEditor()) { editor.openAdd() }
                event.settle_up != null -> push(nav, Destination.TallySettleUp())
                event.friend != null -> {
                    val id = event.friend!!.party_id
                    val name = state.data_?.friends?.firstOrNull { it.person?.party_id == id }?.person?.name.orEmpty()
                    push(nav, Destination.TallyFriend(id, name))
                }
                event.group != null -> {
                    val id = event.group!!.group_id
                    val data = state.data_
                    val name = (data?.groups.orEmpty() + data?.archived_groups.orEmpty()).firstOrNull { it.group_id == id }?.name.orEmpty()
                    push(nav, Destination.TallyGroup(id, name))
                }
                event.expense != null -> push(nav, Destination.TallyExpense(event.expense!!.expense_id))
                event.more != null -> when (event.more!!.key) {
                    TallyHomeMachine.MORE_SETTLE -> push(nav, Destination.TallySettleUp())
                    TallyHomeMachine.MORE_RECURRING -> push(nav, Destination.TallyRecurring)
                    TallyHomeMachine.MORE_SPENDING -> push(nav, Destination.TallySpending)
                    TallyHomeMachine.MORE_SEARCH -> push(nav, Destination.TallySearch)
                    TallyHomeMachine.MORE_TRASH -> push(nav, Destination.TallyTrash)
                    // TODO(intent): Export. The state carries no export rows (no
                    // `tally.export` screen exists), so there is nothing to put in
                    // an ACTION_SEND CSV yet; the sheet closes and nothing leaves.
                    TallyHomeMachine.MORE_EXPORT -> Unit
                    else -> Unit
                }
            }
        })
    }

    /**
     * THE EDITOR: explicit Save, never autosave. The machine says when it is
     * done (a committed save, a clean close, a confirmed discard) and the
     * route pops then — only on a change to done SEEN in this sitting, so a
     * previous sitting's `done` cannot pop the page the moment it opens.
     */
    @Composable
    private fun EditorRoute(destination: Destination.TallyEditor, parent: String, nav: RouteNav) {
        val held by editor.host.state.collectAsStateWithLifecycle()
        val state = held.screen
        val seenOpen = remember(destination) { booleanArrayOf(false) }
        if (!state.done) seenOpen[0] = true
        LaunchedEffect(state.done) {
            if (state.done && seenOpen[0]) {
                seenOpen[0] = false
                if (nav.stack.current == destination) nav.pop()
            }
        }
        DisposableEffect(Unit) { onDispose { editor.departed() } }
        TallyEditorScreen(state, parent, onEvent = { event: TallyEditorEvent -> editor.forward(event) })
    }

    /** A push, with the target bridge's open where the push is its reason to read. */
    private fun push(nav: RouteNav, destination: Destination, open: (() -> Unit)? = null) {
        open?.invoke()
        nav.go(nav.stack.push(destination))
    }
}
