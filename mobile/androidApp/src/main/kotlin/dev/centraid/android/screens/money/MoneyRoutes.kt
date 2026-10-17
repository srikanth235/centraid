package dev.centraid.android.screens.money

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import centraid.screen.v1.MoneyHomeEvent
import centraid.screen.v1.MoneyHomeState
import centraid.screen.v1.MoneyImportEvent
import centraid.screen.v1.MoneySearchEvent
import dev.centraid.android.screens.AppRoutes
import dev.centraid.android.screens.RouteNav
import dev.centraid.shared.apps.money.MoneyAccountsBridge
import dev.centraid.shared.apps.money.MoneyCategoriesBridge
import dev.centraid.shared.apps.money.MoneyHomeBridge
import dev.centraid.shared.apps.money.MoneyHomeMachine
import dev.centraid.shared.apps.money.MoneyImportBridge
import dev.centraid.shared.apps.money.MoneyRecurringBridge
import dev.centraid.shared.apps.money.MoneyRulesBridge
import dev.centraid.shared.apps.money.MoneySearchBridge
import dev.centraid.shared.apps.money.MoneyTargetBridge
import dev.centraid.shared.apps.money.MoneyTransactionBridge
import dev.centraid.shared.nav.AppIds
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavStack
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * MONEY'S ROUTES (#1099): `money.home` (Spending · Activity · Cash flow, More as
 * a sheet) and every screen pushed from it, one bridge each for the activity's
 * life. The machines emit INTENTS (a pick, the Plus, a More row, the search
 * bar, Choose file) and change nothing on them; this file is where they become
 * pushes, `open(...)` calls and the OS file picker.
 */
public class MoneyRoutes : AppRoutes {

    private val home = MoneyHomeBridge()
    private val transaction = MoneyTransactionBridge()
    private val target = MoneyTargetBridge()
    private val recurring = MoneyRecurringBridge()
    private val importer = MoneyImportBridge()
    private val accounts = MoneyAccountsBridge()
    private val rules = MoneyRulesBridge()
    private val categories = MoneyCategoriesBridge()
    private val search = MoneySearchBridge()

    override fun handles(destination: Destination): Boolean = when (destination) {
        is Destination.MoneyHome, is Destination.MoneyTransaction, is Destination.MoneyTarget,
        is Destination.MoneyRecurring, is Destination.MoneyImport, is Destination.MoneyAccounts,
        is Destination.MoneyRules, is Destination.MoneyCategories, Destination.MoneySearch,
        -> true
        else -> false
    }

    // `open()` ON THE PUSH (Agenda's rule): returning to the home from a pushed
    // page keeps its tab, its month, its filters and its answer.
    override fun opens(moveId: String): Destination? = if (moveId == AppIds.MONEY) {
        home.open()
        Destination.MoneyHome()
    } else {
        null
    }

    override fun attach(session: HomeSession, scope: CoroutineScope) {
        home.attach(session)
        transaction.attach(session)
        target.attach(session)
        recurring.attach(session)
        importer.attach(session)
        accounts.attach(session)
        rules.attach(session)
        categories.attach(session)
        search.attach(session)
    }

    // THE BACK CONTROL IS THE MACHINE'S: every pushed page draws its state's back
    // words, and a push hands the pushed page the PUSHING page's own title as its
    // `parent`.

    @Composable
    override fun Routes(destination: Destination, nav: RouteNav) {
        when (destination) {
            is Destination.MoneyHome -> HomeRoute(nav)
            is Destination.MoneyTransaction -> {
                LaunchedEffect(destination) { transaction.open(destination.txnId, destination.parent) }
                val held by transaction.host.state.collectAsStateWithLifecycle()
                MoneyTransactionScreen(held.screen, onBack = nav::pop, onEvent = transaction::forward)
            }
            is Destination.MoneyTarget -> {
                LaunchedEffect(destination) { target.open(destination.month, destination.categoryId, destination.currency) }
                val held by target.host.state.collectAsStateWithLifecycle()
                MoneyTargetScreen(held.screen, onBack = nav::pop, onEvent = target::forward)
            }
            is Destination.MoneyRecurring -> {
                LaunchedEffect(destination) { recurring.open(destination.parent) }
                val held by recurring.host.state.collectAsStateWithLifecycle()
                MoneyRecurringScreen(held.screen, onBack = nav::pop, onEvent = recurring::forward)
            }
            is Destination.MoneyImport -> ImportRoute(destination, nav)
            is Destination.MoneyAccounts -> {
                LaunchedEffect(destination) { accounts.open(destination.parent) }
                val held by accounts.host.state.collectAsStateWithLifecycle()
                MoneyAccountsScreen(held.screen, onBack = nav::pop, onEvent = accounts::forward)
            }
            is Destination.MoneyRules -> {
                LaunchedEffect(destination) { rules.open(destination.parent) }
                val held by rules.host.state.collectAsStateWithLifecycle()
                MoneyRulesScreen(held.screen, onBack = nav::pop, onEvent = rules::forward)
            }
            is Destination.MoneyCategories -> {
                LaunchedEffect(destination) { categories.open(destination.parent) }
                val held by categories.host.state.collectAsStateWithLifecycle()
                MoneyCategoriesScreen(held.screen, onBack = nav::pop, onEvent = categories::forward)
            }
            Destination.MoneySearch -> {
                LaunchedEffect(destination) { search.open() }
                val held by search.host.state.collectAsStateWithLifecycle()
                val state = held.screen
                MoneySearchScreen(
                    state,
                    onBack = nav::pop,
                    onOpenContainer = { card -> nav.open(card, parent = state.chrome?.title.orEmpty()) },
                    onEvent = { event: MoneySearchEvent ->
                        search.forward(event)
                        event.transaction?.let { push(nav, Destination.MoneyTransaction(it.txn_id, parent = state.chrome?.title.orEmpty())) }
                    },
                )
            }
            else -> Unit
        }
    }

    @Composable
    private fun HomeRoute(nav: RouteNav) {
        val held by home.host.state.collectAsStateWithLifecycle()
        val state = held.screen
        // THE ROUTE FOLLOWS THE MACHINE: a band tab swaps the top entry's parameter, never a push.
        LaunchedEffect(state.destination) {
            val band = state.destination
            val top = nav.stack.current
            if (band != MoneyHomeState.Destination.DESTINATION_UNSPECIFIED && top is Destination.MoneyHome && top.destination != band) {
                nav.go(NavStack(nav.stack.entries.dropLast(1) + top.copy(destination = band)))
            }
        }
        MoneyHomeScreen(state, onHome = nav::home, onEvent = { event: MoneyHomeEvent ->
            home.forward(event)
            val here = state.chrome?.title.orEmpty()
            when {
                // The header's Plus and the day-one action: rows enter by import.
                event.add != null -> push(nav, Destination.MoneyImport(parent = here))
                // THE SEARCH BAR IS A DOOR: Money's search is a page of its own.
                event.search_opened != null -> push(nav, Destination.MoneySearch)
                event.transaction != null -> push(nav, Destination.MoneyTransaction(event.transaction!!.txn_id, parent = here))
                event.category_line != null -> push(
                    nav,
                    Destination.MoneyTarget(
                        month = state.month,
                        categoryId = event.category_line!!.category_id,
                        currency = event.category_line!!.currency,
                    ),
                )
                event.recurring != null -> push(nav, Destination.MoneyRecurring(parent = here))
                event.more != null -> when (event.more!!.key) {
                    MoneyHomeMachine.MORE_ACCOUNTS -> push(nav, Destination.MoneyAccounts(parent = here))
                    MoneyHomeMachine.MORE_RULES -> push(nav, Destination.MoneyRules(parent = here))
                    MoneyHomeMachine.MORE_CATEGORIES -> push(nav, Destination.MoneyCategories(parent = here))
                    MoneyHomeMachine.MORE_IMPORT -> push(nav, Destination.MoneyImport(parent = here))
                    else -> Unit
                }
            }
        })
    }

    /**
     * A STATEMENT, READ AND REVIEWED. Choose opens the Storage Access Framework's
     * `OpenDocument`; the chosen file is read through its own URI, never copied
     * into app storage, and handed to the bridge, which holds its bytes only
     * until the page is left.
     */
    @Composable
    private fun ImportRoute(destination: Destination.MoneyImport, nav: RouteNav) {
        val context = LocalContext.current
        LaunchedEffect(destination) { importer.open(destination.parent) }
        DisposableEffect(Unit) { onDispose { importer.departed() } }
        val held by importer.host.state.collectAsStateWithLifecycle()
        val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            if (uri == null) return@rememberLauncherForActivityResult
            nav.scope.launch {
                val read = withContext(Dispatchers.IO) {
                    runCatching {
                        val resolver = context.contentResolver
                        val name = resolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                            if (cursor.moveToFirst()) cursor.getString(0) else null
                        }.orEmpty()
                        resolver.openInputStream(uri)?.use { it.readBytes() }?.let { name to it }
                    }.getOrNull()
                }
                read?.let { (name, bytes) -> importer.picked(name, bytes) }
            }
        }
        MoneyImportScreen(
            held.screen,
            onBack = nav::pop,
            onEvent = { event: MoneyImportEvent ->
                importer.forward(event)
                when {
                    // The picker is the shell's: banks name their files .csv, .ofx or .qfx and none agree on a type.
                    event.choose != null -> try {
                        pick.launch(arrayOf("*/*"))
                    } catch (_: android.content.ActivityNotFoundException) {
                        // No picker on this phone; nothing was read.
                    }
                    event.add_account != null -> push(nav, Destination.MoneyAccounts(parent = held.screen.chrome?.title.orEmpty()))
                    event.done != null -> nav.pop()
                }
            },
        )
    }

    /** A push. */
    private fun push(nav: RouteNav, destination: Destination) {
        nav.go(nav.stack.push(destination))
    }
}
