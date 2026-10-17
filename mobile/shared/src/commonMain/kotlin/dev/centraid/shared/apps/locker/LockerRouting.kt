package dev.centraid.shared.apps.locker

import centraid.screen.v1.LockerGeneratorEvent
import centraid.screen.v1.LockerHomeEvent
import centraid.screen.v1.LockerHomeState
import centraid.screen.v1.LockerItemEvent
import centraid.screen.v1.LockerItemState
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.ScreenMove
import dev.centraid.shared.nav.ScreenMoves

/**
 * WHERE LOCKER'S INTENTS GO, ONCE (#1047, D-5).
 *
 * `AddItem`, `ItemPicked`, a More row, `EditTapped` and the generator's
 * `UseTapped` change nothing in their machines; the shell pushes. WHICH page
 * lives here: Android pushes the [Destination] (opening the editor's bridge on
 * the push), and iOS asks [route] for the same push spelled. More's Lock and
 * Facts are not pages (the gate's `LockTapped`, the machine's sheet).
 *
 * The generator's Use is answered for Android only: its editor takes the
 * candidate bridge to bridge (`LockerEditorBridge.openAddFrom`), which is
 * never a route parameter, so `ScreenOpenings` spells no such opening and
 * iOS pushes its own editor route for it.
 */
public object LockerRouting {
    public fun home(event: LockerHomeEvent, state: LockerHomeState): Destination? {
        val picked = event.item
        return when {
            event.add != null -> Destination.LockerEditor()
            picked != null && picked.item_id.isNotEmpty() -> Destination.LockerItem(picked.item_id, parent = state.chrome?.title.orEmpty())
            else -> when (event.more?.key) {
                LockerHomeMachine.MORE_IMPORT -> Destination.LockerImport
                LockerHomeMachine.MORE_EXPORT -> Destination.LockerExport
                LockerHomeMachine.MORE_ACCESS -> Destination.LockerAccess
                LockerHomeMachine.MORE_TRASH -> Destination.LockerTrash
                else -> null
            }
        }
    }

    /** Edit opens the editor on the item the page holds, once the state names it. */
    public fun item(event: LockerItemEvent, state: LockerItemState): Destination? =
        if (event.edit != null && state.item_id.isNotEmpty()) Destination.LockerEditor(itemId = state.item_id) else null

    /** "Put it on an item": a new login, its password the generator's, handed over by the shell. */
    public fun generator(event: LockerGeneratorEvent): Destination? =
        if (event.use != null) Destination.LockerEditor(type = LOGIN, fromGenerator = true) else null

    /**
     * THE SAME DECISIONS FOR A SHELL THAT SENDS BYTES: [event] is what screen
     * [screenId] just forwarded and [state] is that screen's own state. Null
     * for an event that routes nowhere, a screen that is not Locker's, the
     * generator's Use (see above), or bytes that do not decode.
     */
    public fun route(screenId: String, event: ByteArray, state: ByteArray): ScreenMove? {
        val destination = runCatching {
            when (screenId) {
                LockerHomeMachine.SCREEN_ID -> home(LockerHomeEvent.ADAPTER.decode(event), LockerHomeState.ADAPTER.decode(state))
                LockerItemMachine.SCREEN_ID -> item(LockerItemEvent.ADAPTER.decode(event), LockerItemState.ADAPTER.decode(state))
                else -> null
            }
        }.getOrNull()
        return ScreenMoves.push(destination)
    }

    private const val LOGIN: String = "login"
}
