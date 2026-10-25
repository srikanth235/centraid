package dev.centraid.shared.nav

import centraid.core.v1.LockerDestination
import centraid.core.v1.LockerEditorMode
import centraid.core.v1.LockerEditorRoute
import centraid.core.v1.LockerExportRoute
import centraid.core.v1.LockerHomeRoute
import centraid.core.v1.LockerItemRoute
import centraid.core.v1.LockerLockRoute
import centraid.core.v1.Route
import dev.centraid.shared.custody.OwnKeyFiling
import dev.centraid.shared.custody.VaultSecrets
import dev.centraid.shared.platform.platformServices
import dev.centraid.shared.shell.HomeReads
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

/**
 * WHERE THE SHELL ENTERS LOCKER FROM OUTSIDE IT (#1135): Home's tile, a chat card,
 * search. Inside Locker a row carries the `Route` Rust built; these are the only
 * routes the shell spells, because the caller holds an id and no row.
 *
 * It also keeps the one thing that still reaches Locker from KMP until the shell
 * lane ports Home: Home's tile asks whether the Locker is open
 * ([HomeReads.lockerOpen]). Chat's confirm card asks for the key itself now (the
 * owner check is an effect and the session a core step), so nothing here waits on
 * an unlock. The session is the core's and the wall is Rust's; this only mirrors
 * one fact the shell hears: Rust announced an unlock, a Locker view carried a
 * wall, or the app left the foreground.
 *
 * INTERIM: the shell lane (#1135) deletes this file.
 */
public object LockerEntry {
    private const val HOME: String = "locker.home"
    private const val ITEM: String = "locker.item"
    private const val EDITOR: String = "locker.editor"
    private const val EXPORT: String = "locker.export"
    private const val LOCK: String = "locker.lock"

    private val open = MutableStateFlow(false)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** Set by the shell: push [lock] on its stack. Nothing asks for it since chat unlocks itself (H1 removes it). */
    public var pushLock: (() -> Unit)? = null

    private fun route(screenId: String): Route = Route(screen = screenId)

    /** Locker's home at [destination] (Items when unspecified). */
    public fun home(destination: LockerDestination = LockerDestination.LOCKER_DESTINATION_ITEMS): Destination.RustScreen =
        Destination.RustScreen(route(screenId = HOME).copy(locker_home = LockerHomeRoute(destination = destination)))

    /** One item's page; [follow] is a chat card's member action (`reveal:password`). */
    public fun item(id: String, parent: String = "", follow: String = ""): Destination.RustScreen =
        Destination.RustScreen(route(screenId = ITEM).copy(locker_item = LockerItemRoute(item_id = id, parent = parent, follow = follow)))

    /** The editor of an existing item. */
    public fun editor(id: String): Destination.RustScreen = Destination.RustScreen(
        route(screenId = EDITOR).copy(
            locker_editor = LockerEditorRoute(mode = LockerEditorMode.LOCKER_EDITOR_MODE_EDIT, item_id = id),
        ),
    )

    /** Every secret in a file. */
    public fun export(parent: String = ""): Destination.RustScreen =
        Destination.RustScreen(route(screenId = EXPORT).copy(locker_export = LockerExportRoute(parent = parent)))

    /** The wall as a page: what a caller that needs the key pushes. */
    public fun lock(): Destination.RustScreen =
        Destination.RustScreen(route(screenId = LOCK).copy(locker_lock = LockerLockRoute()))

    /** The shell heard that Locker is [opened] (an unlock announced, a wall drawn, the app backgrounded). */
    public fun setOpen(opened: Boolean) {
        open.value = opened
    }

    /**
     * An UNLOCK IS WHEN A VAULT'S OWN KEY CAN BE FILED (R-ONBOARD-10): the core seals a Locker
     * secret only while the session is open. The shell calls this when Rust announces
     * `locker.unlocked`.
     */
    public fun unlocked(session: HomeSession) {
        open.value = true
        scope.launch {
            val services = platformServices()
            runCatching {
                OwnKeyFiling.filePending(session, VaultSecrets(services.secureStore, services.syncedSecrets)) {
                    services.secureRandom.bytes(16)
                }
            }
        }
    }

    /** Fill Home's tile. Called once at launch. */
    public fun install() {
        HomeReads.lockerOpen = { open.value }
    }
}
