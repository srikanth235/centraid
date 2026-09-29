package dev.centraid.android.screens.tally

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import centraid.screen.v1.TallyEditorEvent
import centraid.screen.v1.TallyExpenseEvent
import centraid.screen.v1.TallyExportEvent
import centraid.screen.v1.TallyFriendEvent
import centraid.screen.v1.TallyGroupEvent
import centraid.screen.v1.TallyHomeEvent
import centraid.screen.v1.TallyHomeState
import centraid.screen.v1.TallySearchEvent
import centraid.screen.v1.TallySettleUpEvent
import dev.centraid.android.kit.TrashListScreen
import dev.centraid.android.screens.AppRoutes
import dev.centraid.android.screens.RouteNav
import dev.centraid.shared.apps.tally.TallyEditorBridge
import dev.centraid.shared.apps.tally.TallyExpenseBridge
import dev.centraid.shared.apps.tally.TallyExportBridge
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

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
    private val export = TallyExportBridge()

    override fun handles(destination: Destination): Boolean = when (destination) {
        is Destination.TallyApp, is Destination.TallyGroup, is Destination.TallyFriend, is Destination.TallyExpense,
        is Destination.TallyEditor, is Destination.TallySettleUp, Destination.TallyRecurring, Destination.TallySpending,
        Destination.TallySearch, Destination.TallyTrash, is Destination.TallyExport,
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
        export.attach(session)
    }

    // THE BACK CONTROL IS THE MACHINE'S (#1047): every pushed page draws its
    // state's back words, and a push hands the pushed page the PUSHING page's
    // own title — the words it draws in its own app bar — as its `parent`.

    @Composable
    override fun Routes(destination: Destination, nav: RouteNav) {
        when (destination) {
            is Destination.TallyApp -> HomeRoute(destination, nav)
            is Destination.TallyGroup -> {
                LaunchedEffect(destination) { group.open(destination.groupId, destination.name, destination.parent) }
                val held by group.host.state.collectAsStateWithLifecycle()
                val state = held.screen
                TallyGroupScreen(state, onBack = nav::pop, onEvent = { event ->
                    group.forward(event)
                    val here = state.title
                    when {
                        event.add_expense != null -> push(nav, Destination.TallyEditor(groupId = destination.groupId)) {
                            editor.openAdd(groupId = destination.groupId)
                        }
                        event.settle_up != null -> push(nav, Destination.TallySettleUp(destination.groupId, parent = here))
                        event.expense != null -> push(nav, Destination.TallyExpense(event.expense!!.expense_id, parent = here))
                        event.member != null -> {
                            val id = event.member!!.party_id
                            val name = state.data_?.members?.firstOrNull { it.person?.party_id == id }?.person?.name.orEmpty()
                            push(nav, Destination.TallyFriend(id, name, parent = here))
                        }
                    }
                })
            }
            is Destination.TallyFriend -> {
                LaunchedEffect(destination) { friend.open(destination.partyId, destination.name, destination.parent) }
                val held by friend.host.state.collectAsStateWithLifecycle()
                val state = held.screen
                TallyFriendScreen(state, onBack = nav::pop, onEvent = { event ->
                    friend.forward(event)
                    val here = state.title
                    when {
                        event.add_expense != null -> push(nav, Destination.TallyEditor(partyId = destination.partyId)) {
                            editor.openAdd(partyId = destination.partyId)
                        }
                        event.settle_up != null -> push(nav, Destination.TallySettleUp(parent = here))
                        event.expense != null -> push(nav, Destination.TallyExpense(event.expense!!.expense_id, parent = here))
                        event.group != null -> {
                            val id = event.group!!.group_id
                            val name = state.data_?.parts?.firstOrNull { it.group_id == id }?.title.orEmpty()
                            push(nav, Destination.TallyGroup(id, name, parent = here))
                        }
                    }
                })
            }
            is Destination.TallyExpense -> {
                LaunchedEffect(destination) { expense.open(destination.expenseId, destination.parent) }
                val held by expense.host.state.collectAsStateWithLifecycle()
                TallyExpenseScreen(held.screen, onBack = nav::pop, onEvent = { event ->
                    expense.forward(event)
                    if (event.edit != null) {
                        push(nav, Destination.TallyEditor(expenseId = destination.expenseId)) { editor.openEdit(destination.expenseId) }
                    }
                })
            }
            is Destination.TallyEditor -> EditorRoute(destination, nav)
            is Destination.TallySettleUp -> {
                LaunchedEffect(destination) { settle.open(destination.groupId, destination.parent) }
                val held by settle.host.state.collectAsStateWithLifecycle()
                TallySettleUpScreen(held.screen, onBack = nav::pop, onEvent = { event: TallySettleUpEvent -> settle.forward(event) })
            }
            Destination.TallyRecurring -> {
                LaunchedEffect(destination) { recurring.open() }
                val held by recurring.host.state.collectAsStateWithLifecycle()
                TallyRecurringScreen(held.screen, onBack = nav::pop, onEvent = recurring::forward)
            }
            Destination.TallySpending -> {
                LaunchedEffect(destination) { spending.open() }
                val held by spending.host.state.collectAsStateWithLifecycle()
                TallySpendingScreen(held.screen, onBack = nav::pop, onEvent = spending::forward)
            }
            Destination.TallySearch -> {
                LaunchedEffect(destination) { search.open() }
                val held by search.host.state.collectAsStateWithLifecycle()
                val state = held.screen
                TallySearchScreen(state, onBack = nav::pop, onEvent = { event: TallySearchEvent ->
                    search.forward(event)
                    event.expense?.let { push(nav, Destination.TallyExpense(it.expense_id, parent = state.chrome?.title.orEmpty())) }
                })
            }
            Destination.TallyTrash -> {
                LaunchedEffect(destination) { trash.open() }
                val state by trash.host.state.collectAsStateWithLifecycle()
                // `TrashListState.back_label` is the machine's back word.
                TrashListScreen(state = state, onEvent = trash::forward, onBack = nav::pop)
            }
            is Destination.TallyExport -> ExportRoute(destination, nav)
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
            val here = state.chrome?.title.orEmpty()
            when {
                event.add_expense != null -> push(nav, Destination.TallyEditor()) { editor.openAdd() }
                event.settle_up != null -> push(nav, Destination.TallySettleUp(parent = here))
                event.friend != null -> {
                    val id = event.friend!!.party_id
                    val name = state.data_?.friends?.firstOrNull { it.person?.party_id == id }?.person?.name.orEmpty()
                    push(nav, Destination.TallyFriend(id, name, parent = here))
                }
                event.group != null -> {
                    val id = event.group!!.group_id
                    val data = state.data_
                    val name = (data?.groups.orEmpty() + data?.archived_groups.orEmpty()).firstOrNull { it.group_id == id }?.name.orEmpty()
                    push(nav, Destination.TallyGroup(id, name, parent = here))
                }
                event.expense != null -> push(nav, Destination.TallyExpense(event.expense!!.expense_id, parent = here))
                event.more != null -> when (event.more!!.key) {
                    TallyHomeMachine.MORE_SETTLE -> push(nav, Destination.TallySettleUp(parent = here))
                    TallyHomeMachine.MORE_RECURRING -> push(nav, Destination.TallyRecurring)
                    TallyHomeMachine.MORE_SPENDING -> push(nav, Destination.TallySpending)
                    TallyHomeMachine.MORE_SEARCH -> push(nav, Destination.TallySearch)
                    TallyHomeMachine.MORE_TRASH -> push(nav, Destination.TallyTrash)
                    TallyHomeMachine.MORE_EXPORT -> push(nav, Destination.TallyExport(parent = here))
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
    private fun EditorRoute(destination: Destination.TallyEditor, nav: RouteNav) {
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
        TallyEditorScreen(state, onEvent = { event: TallyEditorEvent -> editor.forward(event) })
    }

    /**
     * THE EXPORT: the view's Export asks the bridge, the bridge hands this
     * route the core's CSV and proposed name (`onSave`), and the Storage
     * Access Framework's `CreateDocument("text/csv")` lets the member say
     * where. The text is written as UTF-8, byte for byte — nothing here
     * formats a figure — and the bridge hears exactly one answer.
     */
    @Composable
    private fun ExportRoute(destination: Destination.TallyExport, nav: RouteNav) {
        val context = LocalContext.current
        LaunchedEffect(destination) { export.open(destination.groupId, destination.parent) }
        val held by export.host.state.collectAsStateWithLifecycle()
        // The file between the sheet going up and its answer; never in a state.
        val pending = remember { arrayOfNulls<String>(1) }
        val create = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(CSV)) { uri ->
            val csv = pending[0]
            pending[0] = null
            when {
                uri == null -> export.saveCancelled()
                csv == null -> export.saveRefused("")
                else -> nav.scope.launch {
                    val wrote = withContext(Dispatchers.IO) {
                        runCatching {
                            context.contentResolver.openOutputStream(uri, "wt")?.use { it.write(csv.encodeToByteArray()) } != null
                        }.getOrDefault(false)
                    }
                    // A refusal with no sentence: the machine says it in its own words.
                    if (wrote) export.saved() else export.saveRefused("")
                }
            }
        }
        DisposableEffect(Unit) {
            val save: (String, String) -> Unit = { csv, fileName ->
                pending[0] = csv
                try {
                    create.launch(fileName)
                } catch (why: android.content.ActivityNotFoundException) {
                    pending[0] = null
                    export.saveRefused("")
                }
            }
            export.onSave = save
            onDispose { if (export.onSave === save) export.onSave = null }
        }
        TallyExportScreen(
            held.screen,
            onEvent = { event: TallyExportEvent -> export.forward(event) },
            onSave = export::save,
            onBack = nav::pop,
        )
    }

    /** A push, with the target bridge's open where the push is its reason to read. */
    private fun push(nav: RouteNav, destination: Destination, open: (() -> Unit)? = null) {
        open?.invoke()
        nav.go(nav.stack.push(destination))
    }

    private companion object {
        /** What the Storage Access Framework is asked to create: the core's CSV. */
        const val CSV: String = "text/csv"
    }
}
