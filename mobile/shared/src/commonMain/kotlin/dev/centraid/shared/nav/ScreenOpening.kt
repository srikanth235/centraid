package dev.centraid.shared.nav

import centraid.screen.v1.HealthConnectEvent
import centraid.screen.v1.HealthHomeEvent
import centraid.screen.v1.HealthMetricEvent
import centraid.screen.v1.HealthWorkoutEvent
import centraid.screen.v1.LockerAccessEvent
import centraid.screen.v1.LockerEditorEvent
import centraid.screen.v1.LockerEditorState
import centraid.screen.v1.LockerExportEvent
import centraid.screen.v1.LockerHomeEvent
import centraid.screen.v1.LockerImportEvent
import centraid.screen.v1.LockerItemEvent
import centraid.screen.v1.MoneyAccountsEvent
import centraid.screen.v1.MoneyCategoriesEvent
import centraid.screen.v1.MoneyHomeEvent
import centraid.screen.v1.MoneyImportEvent
import centraid.screen.v1.MoneyRecurringEvent
import centraid.screen.v1.MoneyRulesEvent
import centraid.screen.v1.MoneySearchEvent
import centraid.screen.v1.MoneyTargetEvent
import centraid.screen.v1.MoneyTransactionEvent
import centraid.screen.v1.PeopleEditorEvent
import centraid.screen.v1.PeopleHomeEvent
import centraid.screen.v1.PeoplePersonEvent
import centraid.screen.v1.TrashListEvent

/**
 * ONE ROUTE, AS A SHELL THAT KEYS ITS SCREENS BY ID OPENS IT.
 *
 * A [Destination] is the stack's value in a shell that pushes Kotlin; a shell
 * whose views are written in another language (SwiftUI) cannot hold one, so it
 * is handed this: the screen's id ([ScreenIds], which its machine's `SCREEN_ID`
 * is) and the screen's own `Opened` event, encoded, which the shell sends as it
 * stands. Nothing
 * here is a second table of where things go: [ScreenOpenings.of] only SPELLS a
 * destination the shared side already chose.
 */
public class ScreenOpening(
    public val screenId: String,
    public val event: ByteArray = ByteArray(0),
)

/** A [Destination], spelled as the screen id and `Opened` event its screen takes. */
public object ScreenOpenings {
    /**
     * The route [destination] opens, or null for a destination no route
     * spells (a shell-owned page, or one the callers have not needed yet).
     */
    public fun of(destination: Destination): ScreenOpening? = when (destination) {
        is Destination.PeopleHome -> screen(
            ScreenIds.PEOPLE_HOME,
            PeopleHomeEvent(opened = PeopleHomeEvent.Opened(destination = destination.destination)).encode(),
        )
        is Destination.PeoplePerson -> screen(
            ScreenIds.PEOPLE_PERSON,
            PeoplePersonEvent(
                opened = PeoplePersonEvent.Opened(
                    party_id = destination.partyId,
                    name = destination.name,
                    log_touch = destination.logTouch,
                ),
            ).encode(),
        )
        is Destination.MoneyHome -> screen(
            ScreenIds.MONEY_HOME,
            MoneyHomeEvent(opened = MoneyHomeEvent.Opened(destination = destination.destination)).encode(),
        )
        is Destination.MoneyTransaction -> screen(
            ScreenIds.MONEY_TRANSACTION,
            MoneyTransactionEvent(
                opened = MoneyTransactionEvent.Opened(txn_id = destination.txnId, parent = destination.parent),
            ).encode(),
        )
        is Destination.MoneyTarget -> screen(
            ScreenIds.MONEY_TARGET,
            MoneyTargetEvent(
                opened = MoneyTargetEvent.Opened(
                    month = destination.month,
                    category_id = destination.categoryId,
                    currency = destination.currency,
                ),
            ).encode(),
        )
        is Destination.MoneyRecurring -> screen(
            ScreenIds.MONEY_RECURRING,
            MoneyRecurringEvent(opened = MoneyRecurringEvent.Opened(parent = destination.parent)).encode(),
        )
        is Destination.MoneyImport -> screen(
            ScreenIds.MONEY_IMPORT,
            MoneyImportEvent(opened = MoneyImportEvent.Opened(parent = destination.parent)).encode(),
        )
        is Destination.MoneyAccounts -> screen(
            ScreenIds.MONEY_ACCOUNTS,
            MoneyAccountsEvent(opened = MoneyAccountsEvent.Opened(parent = destination.parent)).encode(),
        )
        is Destination.MoneyRules -> screen(
            ScreenIds.MONEY_RULES,
            MoneyRulesEvent(opened = MoneyRulesEvent.Opened(parent = destination.parent)).encode(),
        )
        is Destination.MoneyCategories -> screen(
            ScreenIds.MONEY_CATEGORIES,
            MoneyCategoriesEvent(opened = MoneyCategoriesEvent.Opened(parent = destination.parent)).encode(),
        )
        Destination.MoneySearch -> screen(ScreenIds.MONEY_SEARCH, MoneySearchEvent(opened = MoneySearchEvent.Opened()).encode())
        // HEALTH: the phone's facts are stamped on arrival (`HealthRouting.opened`), never spelled here.
        is Destination.HealthHome -> screen(
            ScreenIds.HEALTH_HOME,
            HealthHomeEvent(opened = HealthHomeEvent.Opened(destination = destination.destination)).encode(),
        )
        is Destination.HealthMetric -> screen(
            ScreenIds.HEALTH_METRIC,
            HealthMetricEvent(opened = HealthMetricEvent.Opened(metric = destination.metric, parent = destination.parent)).encode(),
        )
        is Destination.HealthWorkout -> screen(
            ScreenIds.HEALTH_WORKOUT,
            HealthWorkoutEvent(opened = HealthWorkoutEvent.Opened(activity_id = destination.activityId, parent = destination.parent)).encode(),
        )
        is Destination.HealthConnect -> screen(
            ScreenIds.HEALTH_CONNECT,
            HealthConnectEvent(opened = HealthConnectEvent.Opened(parent = destination.parent)).encode(),
        )
        // A NEW PERSON's id rides as the minted one: the editor adds them on its first save.
        is Destination.PeopleEditor -> screen(
            ScreenIds.PEOPLE_EDITOR,
            PeopleEditorEvent(
                opened = if (destination.isNew) {
                    PeopleEditorEvent.Opened(minted_party_id = destination.partyId)
                } else {
                    PeopleEditorEvent.Opened(party_id = destination.partyId)
                },
            ).encode(),
        )
        Destination.PeopleTrash -> screen(ScreenIds.PEOPLE_TRASH, TrashListEvent(opened = TrashListEvent.Opened()).encode())
        // LOCKER: every page's bridge opens itself on arrival, so the event is
        // what names the page. The generator's candidate never rides here
        // (`Destination.LockerEditor`), and neither does `fromGenerator`: that
        // hand-over is bridge to bridge, in the shell that has both.
        is Destination.LockerHome -> screen(
            ScreenIds.LOCKER_HOME,
            LockerHomeEvent(opened = LockerHomeEvent.Opened(destination = destination.destination)).encode(),
        )
        is Destination.LockerItem -> screen(
            ScreenIds.LOCKER_ITEM,
            LockerItemEvent(opened = LockerItemEvent.Opened(item_id = destination.itemId, parent = destination.parent, follow = destination.follow)).encode(),
        )
        is Destination.LockerEditor -> if (destination.fromGenerator) {
            null
        } else {
            screen(
                ScreenIds.LOCKER_EDITOR,
                LockerEditorEvent(
                    opened = LockerEditorEvent.Opened(
                        mode = if (destination.itemId.isEmpty()) LockerEditorState.Mode.MODE_ADD else LockerEditorState.Mode.MODE_EDIT,
                        item_id = destination.itemId,
                        type = destination.type,
                    ),
                ).encode(),
            )
        }
        Destination.LockerTrash -> screen(ScreenIds.LOCKER_TRASH, TrashListEvent(opened = TrashListEvent.Opened()).encode())
        Destination.LockerExport -> screen(ScreenIds.LOCKER_EXPORT, LockerExportEvent(opened = LockerExportEvent.Opened()).encode())
        Destination.LockerImport -> screen(ScreenIds.LOCKER_IMPORT, LockerImportEvent(opened = LockerImportEvent.Opened()).encode())
        Destination.LockerAccess -> screen(ScreenIds.LOCKER_ACCESS, LockerAccessEvent(opened = LockerAccessEvent.Opened()).encode())
        // A SCREEN RUST OWNS: the event is the `Route` Rust built, which the shell pushes as it stands.
        is Destination.RustScreen -> screen(ScreenIds.RUST_SCREEN, destination.route.encode())
        else -> null
    }

    private fun screen(screenId: String, event: ByteArray): ScreenOpening = ScreenOpening(screenId, event)
}
