package dev.centraid.android.screens.agenda

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import centraid.screen.v1.AgendaEventEvent
import centraid.screen.v1.AgendaHomeState
import dev.centraid.android.screens.AgendaHomeScreen
import dev.centraid.android.screens.AppRoutes
import dev.centraid.android.screens.RouteNav
import dev.centraid.shared.apps.agenda.AgendaBridge
import dev.centraid.shared.apps.agenda.AgendaEditorBridge
import dev.centraid.shared.apps.agenda.AgendaEventBridge
import dev.centraid.shared.apps.agenda.AgendaMarks
import dev.centraid.shared.apps.agenda.AgendaRouting
import dev.centraid.shared.nav.AppIds
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavStack
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope

/**
 * AGENDA'S ROUTES (#1046). The shell builds the bridges — `shell/` may not
 * import `apps` — and attaches them once, with the other screens. ONE
 * [AgendaMarks] is handed to all three, so a write held by the detail or the
 * editor outlives its screen and the list draws its pending chip.
 */
public class AgendaRoutes : AppRoutes {
    private val marks = AgendaMarks()
    private val agenda = AgendaBridge(marks)
    private val event = AgendaEventBridge(marks)
    private val editor = AgendaEditorBridge(marks)

    override fun handles(destination: Destination): Boolean =
        destination is Destination.AgendaHome || destination is Destination.AgendaEvent || destination is Destination.AgendaEditor

    // `open()` ON THE PUSH, not on every composition: a band move swaps the
    // top entry and must not land on today.
    override fun opens(moveId: String): Destination? = if (moveId == AppIds.AGENDA) {
        agenda.open()
        Destination.AgendaHome()
    } else {
        null
    }

    override fun attach(session: HomeSession, scope: CoroutineScope) {
        agenda.attach(session)
        event.attach(session)
        editor.attach(session)
    }

    @Composable
    override fun Routes(destination: Destination, nav: RouteNav) {
        when (destination) {
            is Destination.AgendaHome -> HomeRoute(agenda, destination, nav)
            is Destination.AgendaEvent -> EventRoute(destination, nav)
            is Destination.AgendaEditor -> EditorRoute(destination, nav)
            else -> Unit
        }
    }

    /**
     * A PUSH `AgendaRouting` CHOSE, with its bridge opened on the PUSH, so a
     * pop back never re-reads over a draft.
     */
    private fun push(nav: RouteNav, to: Destination?) {
        when (to) {
            is Destination.AgendaEvent -> event.open(to.eventId, to.instanceKey, to.originalStartLocal, to.day)
            is Destination.AgendaEditor -> {
                val id = to.eventId
                if (id == null) editor.openNew(to.day) else editor.openEdit(id, to.instanceKey, to.originalStartLocal, to.day)
            }
            else -> Unit
        }
        nav.push(to)
    }

    @Composable
    private fun HomeRoute(agenda: AgendaBridge, destination: Destination.AgendaHome, nav: RouteNav) {
        var stack by nav
        val state by agenda.host.state.collectAsStateWithLifecycle()
        val screen = state.screen
        // THE ROUTE FOLLOWS THE MACHINE: a band tab is a parameter swap on the
        // top entry, never a push.
        LaunchedEffect(screen.destination) {
            val band = screen.destination
            if (band != AgendaHomeState.Destination.DESTINATION_UNSPECIFIED &&
                band != destination.destination
            ) {
                stack = stack.withAgendaDestination(band)
            }
        }
        AgendaHomeScreen(
            state = screen,
            onEvent = { e ->
                agenda.forward(e)
                push(nav, AgendaRouting.home(e, screen))
            },
            onHome = { stack = NavStack() },
        )
    }

    @Composable
    private fun EventRoute(destination: Destination.AgendaEvent, nav: RouteNav) {
        val context = LocalContext.current
        val state by event.host.state.collectAsStateWithLifecycle()
        val screen = state.screen
        // CANCELLED: the occurrence is gone from here, and so is its page.
        LaunchedEffect(screen.dismissed) {
            if (screen.dismissed && nav.stack.current == destination) nav.pop()
        }
        AgendaEventScreen(
            state = screen,
            onEvent = { e: AgendaEventEvent ->
                event.forward(e)
                // EDIT IS AN INTENT: the editor, on the ids the detail holds.
                push(nav, AgendaRouting.event(e, screen))
            },
            onBack = { nav.pop() },
            onCall = { uri -> openCall(context, uri) },
        )
    }

    @Composable
    private fun EditorRoute(destination: Destination.AgendaEditor, nav: RouteNav) {
        val state by editor.host.state.collectAsStateWithLifecycle()
        val screen = state.screen
        // THE EDITOR NEVER POPS ITSELF: back forwards `LeaveRequested`, and
        // the pop follows the machine's `dismissed` (saved, or discarded).
        LaunchedEffect(screen.dismissed) {
            if (screen.dismissed && nav.stack.current == destination) nav.pop()
        }
        AgendaEditorScreen(
            state = screen,
            onEvent = { e -> editor.forward(e) },
            onDeparted = { editor.departed() },
        )
    }
}

/**
 * THE CALL LINK, HANDED OFF: `call_uri` is the event's own link (a meeting URL
 * or `tel:`), opened by whatever app on this phone answers it. Nothing joins
 * from here; with no app to answer, the button stays as it was.
 */
private fun openCall(context: Context, uri: String) {
    try {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri)))
    } catch (_: ActivityNotFoundException) {
        // No app on this phone opens the link.
    }
}
