package dev.centraid.shared.nav

import centraid.core.v1.MoneyDestination
import centraid.core.v1.MoneyHomeRoute
import centraid.core.v1.MoneyTransactionRoute
import centraid.core.v1.Route

/**
 * WHERE THE SHELL ENTERS MONEY FROM OUTSIDE IT (#1135): Home's tile, search and a
 * chat card. Inside Money a row carries the `Route` Rust built; these are the
 * only routes the shell spells, because the caller holds an id and no row.
 *
 * INTERIM: the shell lane (#1135) replaces the KMP stack with Rust's and deletes
 * this file; a front door then asks Rust for the route.
 */
public object MoneyEntry {
    private const val HOME: String = "money.home"
    private const val TRANSACTION: String = "money.transaction"

    /** Money's home at [destination] (Spending when unspecified). */
    public fun home(
        destination: MoneyDestination = MoneyDestination.MONEY_DESTINATION_SPENDING,
    ): Destination.RustScreen = Destination.RustScreen(
        Route(screen = HOME, money_home = MoneyHomeRoute(destination = destination)),
    )

    /** One transaction's page; [parent] is the pushing page's title, the back control's word. */
    public fun transaction(txnId: String, parent: String = ""): Destination.RustScreen = Destination.RustScreen(
        Route(screen = TRANSACTION, money_transaction = MoneyTransactionRoute(txn_id = txnId, parent = parent)),
    )
}
