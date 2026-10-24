package dev.centraid.android.screens.notes

import androidx.compose.runtime.Composable
import centraid.screen.v1.HomeTile
import dev.centraid.android.screens.AppRoutes
import dev.centraid.android.screens.RouteNav
import dev.centraid.shared.nav.AppIds
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NotesEntry
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope

/**
 * NOTES' FRONT DOOR (#1135). Its pages are Rust's (`crates/screens`, module
 * `notes`) and are hosted by `AgendaRoutes`, which draws every Rust-owned
 * destination; this holds only what is Notes' alone — where Home's move lands.
 *
 * THE TILE DECIDES, ONE RULE FOR BOTH SHELLS (`NotesEntry.tile`): the Notes
 * place over its shelf, a new note when there is none, nowhere while it reads.
 *
 * INTERIM: the shell lane replaces the KMP stack and deletes this file.
 */
public class NotesRoutes : AppRoutes {
    /** The session, for the Notes tile Home's move is routed by. */
    private var session: HomeSession? = null

    override fun handles(destination: Destination): Boolean = false

    override fun opens(moveId: String): Destination? {
        if (moveId != AppIds.NOTES) return null
        val tile: HomeTile? = session?.state?.value?.data_?.tiles?.firstOrNull { it.app_id == AppIds.NOTES }
        return NotesEntry.tile(tile)
    }

    override fun attach(session: HomeSession, scope: CoroutineScope) {
        this.session = session
    }

    @Composable
    override fun Routes(destination: Destination, nav: RouteNav) {
        // Nothing of Notes' is drawn here: its destinations are `Destination.RustScreen`s.
    }
}
