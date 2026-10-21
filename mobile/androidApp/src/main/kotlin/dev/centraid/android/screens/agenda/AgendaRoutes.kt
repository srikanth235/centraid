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
 * AGENDA'S ROUTES (#1046, #1128). The shell builds the bridges — `shell/` may
 * not import `apps` — and attaches them once, with the other screens. ONE
 * [AgendaMarks] is handed to all three, so a write held by the detail or the
 * editor outlives its screen and the list draws its pending chip.
 *
 * The home is Day · Schedule · Waiting · To-do (#1128): every way into Agenda —
 * Home's tile, a chat card or search row, the reminders import's "Open Agenda",
 * Notes' "Send to Agenda" — is a push of [Destination.AgendaHome], and a task
 * or project picked on it is a push `AgendaRouting` chooses, drawn by
 * `TasksRoutes`.
 */
public class AgendaRoutes : AppRoutes {
    private val marks = AgendaMarks()
    private val agenda = AgendaBridge(marks)
    private val event = AgendaEventBridge(marks)
    private val editor = AgendaEditorBridge(marks)

    /**
     * THE BAND SWAP THE ROUTE JUST WROTE (or the open it just asked for), so the
     * entry it produces is not mistaken for a push from elsewhere. One shot: the
     * next arrival consumes it.
     */
    private var written: AgendaHomeState.Destination? = null

    /** A place the route asked the machine to open and has not yet seen land. */
    private var opening: AgendaHomeState.Destination? = null

    override fun handles(destination: Destination): Boolean =
        destination is Destination.AgendaHome || destination is Destination.AgendaEvent || destination is Destination.AgendaEditor

    // `open()` ON THE PUSH, not on every composition: a band move swaps the
    // top entry and must not land on today.
    override fun opens(moveId: String): Destination? = if (moveId == AppIds.AGENDA) {
        agenda.open()
        written = AgendaHomeState.Destination.DESTINATION_DAY
        opening = AgendaHomeState.Destination.DESTINATION_DAY
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
        // A PUSH FROM ELSEWHERE OPENS THE MACHINE ON IT, ONCE: the destination it
        // names (To-do, from a chat card or the reminders import) and the words
        // Notes' "Send to Agenda" carries, which wait in the focused quick add.
        // The words then leave the entry, so a pop back onto this home never seeds
        // the bar a second time. A band swap the route itself wrote is not an
        // arrival (`written`), and neither is the machine already being there.
        LaunchedEffect(destination) {
            val echo = written
            written = null
            val wanted = destination.destination
            val here = agenda.screen.destination
            val elsewhere = wanted != AgendaHomeState.Destination.DESTINATION_UNSPECIFIED && wanted != here && wanted != echo
            val words = destination.quickAdd
            if (elsewhere || words.isNotEmpty()) {
                if (wanted != here) opening = wanted
                agenda.open(wanted, words)
                if (words.isNotEmpty() && stack.current == destination) {
                    written = wanted
                    stack = NavStack(stack.entries.dropLast(1) + destination.copy(quickAdd = ""))
                }
            }
        }
        // THE ROUTE FOLLOWS THE MACHINE: a band tab is a parameter swap on the
        // top entry, never a push — except while an arrival's open has not landed,
        // when the machine is still where it was.
        LaunchedEffect(screen.destination) {
            val band = screen.destination
            if (band == AgendaHomeState.Destination.DESTINATION_UNSPECIFIED) return@LaunchedEffect
            val pending = opening
            if (pending != null && band != pending) return@LaunchedEffect
            opening = null
            if (band != destination.destination) {
                written = band
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
