package dev.centraid.shared.apps.money

import centraid.screen.v1.MoneyAccountsEvent
import centraid.screen.v1.MoneyCategoriesEvent
import centraid.screen.v1.MoneyHomeEvent
import centraid.screen.v1.MoneyHomeState
import centraid.screen.v1.MoneyImportEvent
import centraid.screen.v1.MoneyImportState
import centraid.screen.v1.MoneyRulesEvent
import centraid.screen.v1.MoneySearchEvent
import centraid.screen.v1.MoneySearchState
import centraid.screen.v1.MoneyTargetEvent
import centraid.screen.v1.MoneyTransactionEvent
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavMove
import dev.centraid.shared.nav.ScreenMove
import dev.centraid.shared.nav.ScreenMoves

/**
 * WHERE MONEY'S INTENTS GO, ONCE (#1099).
 *
 * A Money machine that emits the Plus, the search door, a pick, a More row,
 * Add an account or Done changes nothing on them; the shell moves. WHICH move
 * lives here: Android applies the [NavMove] to its stack, and iOS asks [route]
 * for the same move spelled. Every push hands the pushed page the PUSHING
 * page's own title as its `parent`, which its back control says (empty reads
 * "Money").
 */
public object MoneyRouting {
    public fun home(event: MoneyHomeEvent, state: MoneyHomeState): Destination? {
        val here = state.chrome?.title.orEmpty()
        val picked = event.transaction
        val line = event.category_line
        return when {
            // The header's Plus and the day-one action: rows enter by import.
            event.add != null -> Destination.MoneyImport(parent = here)
            // THE SEARCH BAR IS A DOOR: Money's search is a page of its own.
            event.search_opened != null -> Destination.MoneySearch
            picked != null -> transactionOf(picked.txn_id, here)
            line != null -> Destination.MoneyTarget(month = state.month, categoryId = line.category_id, currency = line.currency)
            event.recurring != null -> Destination.MoneyRecurring(parent = here)
            else -> when (event.more?.key) {
                MoneyHomeMachine.MORE_ACCOUNTS -> Destination.MoneyAccounts(parent = here)
                MoneyHomeMachine.MORE_RULES -> Destination.MoneyRules(parent = here)
                MoneyHomeMachine.MORE_CATEGORIES -> Destination.MoneyCategories(parent = here)
                MoneyHomeMachine.MORE_IMPORT -> Destination.MoneyImport(parent = here)
                else -> null
            }
        }
    }

    /** Add an account pushes the accounts page; Done is the pop. Choose file is the shell's OS picker. */
    public fun importer(event: MoneyImportEvent, state: MoneyImportState): NavMove? = when {
        event.add_account != null -> NavMove.push(Destination.MoneyAccounts(parent = state.chrome?.title.orEmpty()))
        event.done != null -> NavMove.Pop
        else -> null
    }

    public fun search(event: MoneySearchEvent, state: MoneySearchState): Destination? =
        event.transaction?.let { transactionOf(it.txn_id, state.chrome?.title.orEmpty()) }

    /**
     * THE SAME DECISIONS FOR A SHELL THAT SENDS BYTES: [event] is what screen
     * [screenId] just forwarded and [state] is that screen's own state. Null
     * for an event that moves nothing, a screen that is not Money's, or bytes
     * that do not decode.
     */
    public fun route(screenId: String, event: ByteArray, state: ByteArray): ScreenMove? {
        val move = runCatching {
            when (screenId) {
                MoneyHomeMachine.SCREEN_ID ->
                    home(MoneyHomeEvent.ADAPTER.decode(event), MoneyHomeState.ADAPTER.decode(state))?.let(NavMove::push)
                MoneyImportMachine.SCREEN_ID -> importer(MoneyImportEvent.ADAPTER.decode(event), MoneyImportState.ADAPTER.decode(state))
                MoneySearchMachine.SCREEN_ID ->
                    search(MoneySearchEvent.ADAPTER.decode(event), MoneySearchState.ADAPTER.decode(state))?.let(NavMove::push)
                else -> null
            }
        }.getOrNull()
        return ScreenMoves.of(move)
    }

    /**
     * A ROUTE'S `Opened`, AS IT IS SENT ON ARRIVAL: [opened] is the event the
     * route carries (`ScreenOpenings`), with a draft token minted now on the
     * pages that hold a draft — what each bridge's `open(...)` mints for
     * Android, so a shell that sends bytes never spells a token. Every other
     * page's event, and bytes that do not decode, come back as they are.
     */
    public fun opened(screenId: String, opened: ByteArray): ByteArray = runCatching {
        val token = MoneyBridge.token()
        when (screenId) {
            MoneyTransactionMachine.SCREEN_ID -> MoneyTransactionEvent.ADAPTER.decode(opened).let { e ->
                e.copy(opened = e.opened?.copy(draft_token = token)).encode()
            }
            MoneyTargetMachine.SCREEN_ID -> MoneyTargetEvent.ADAPTER.decode(opened).let { e ->
                e.copy(opened = e.opened?.copy(draft_token = token)).encode()
            }
            MoneyImportMachine.SCREEN_ID -> MoneyImportEvent.ADAPTER.decode(opened).let { e ->
                e.copy(opened = e.opened?.copy(draft_token = token)).encode()
            }
            MoneyAccountsMachine.SCREEN_ID -> MoneyAccountsEvent.ADAPTER.decode(opened).let { e ->
                e.copy(opened = e.opened?.copy(draft_token = token)).encode()
            }
            MoneyRulesMachine.SCREEN_ID -> MoneyRulesEvent.ADAPTER.decode(opened).let { e ->
                e.copy(opened = e.opened?.copy(draft_token = token)).encode()
            }
            MoneyCategoriesMachine.SCREEN_ID -> MoneyCategoriesEvent.ADAPTER.decode(opened).let { e ->
                e.copy(opened = e.opened?.copy(draft_token = token)).encode()
            }
            else -> opened
        }
    }.getOrDefault(opened)

    /** A transaction with no id names nothing, so it opens nothing. */
    private fun transactionOf(txnId: String, parent: String): Destination? =
        if (txnId.isEmpty()) null else Destination.MoneyTransaction(txnId, parent)
}
