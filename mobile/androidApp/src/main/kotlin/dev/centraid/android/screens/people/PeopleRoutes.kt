package dev.centraid.android.screens.people

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import centraid.screen.v1.PeopleChannelIntent
import centraid.screen.v1.PeopleChannelRow
import centraid.screen.v1.PeopleHomeState
import dev.centraid.android.screens.AppRoutes
import dev.centraid.android.screens.RouteNav
import dev.centraid.android.kit.TrashListScreen
import dev.centraid.design.copy.PeopleCopy
import dev.centraid.shared.apps.people.PeopleEditorBridge
import dev.centraid.shared.apps.people.PeopleHomeBridge
import dev.centraid.shared.apps.people.PeoplePersonBridge
import dev.centraid.shared.apps.people.PeopleRouting
import dev.centraid.shared.apps.people.PeopleTrashBridge
import dev.centraid.shared.nav.AppIds
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.withPeopleDestination
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope

/**
 * PEOPLE'S ROUTES (#1029 app port): home, one person, the profile editor and
 * the trash, each on its bridge for the activity's life.
 *
 * The machines emit intents and route nothing; `PeopleRouting` decides where
 * each goes (for iOS too) — a person, the editor under an id it mints, the kit
 * trash, the channel row a tap meant — and this file pushes it, hands a
 * channel to the OS (dial, mail, map, clipboard), and pops on a person's `done`.
 */
public class PeopleRoutes : AppRoutes {
    private val home = PeopleHomeBridge()
    private val person = PeoplePersonBridge()
    private val editor = PeopleEditorBridge()
    private val trash = PeopleTrashBridge()

    override fun handles(destination: Destination): Boolean =
        destination is Destination.PeopleHome ||
            destination is Destination.PeoplePerson ||
            destination is Destination.PeopleEditor ||
            destination == Destination.PeopleTrash

    override fun opens(moveId: String): Destination? = if (moveId == AppIds.PEOPLE) Destination.PeopleHome() else null

    override fun attach(session: HomeSession, scope: CoroutineScope) {
        home.attach(session)
        person.attach(session)
        editor.attach(session)
        trash.attach(session)
    }

    @Composable
    override fun Routes(destination: Destination, nav: RouteNav) {
        when (destination) {
            is Destination.PeopleHome -> HomeRoute(destination, nav)
            is Destination.PeoplePerson -> PersonRoute(destination, nav)
            is Destination.PeopleEditor -> EditorRoute(destination, nav)
            else -> TrashRoute(nav)
        }
    }

    @Composable
    private fun HomeRoute(destination: Destination.PeopleHome, nav: RouteNav) {
        var stack by nav
        // Keyed on arriving: a band tap swaps the entry's parameter and must
        // not re-open (the machine's `BandPicked` already read).
        LaunchedEffect(Unit) { home.open(destination.destination) }
        val state by home.host.state.collectAsStateWithLifecycle()
        LaunchedEffect(state.destination) {
            val band = state.destination
            if (band != PeopleHomeState.Destination.DESTINATION_UNSPECIFIED && band != destination.destination) {
                stack = stack.withPeopleDestination(band)
            }
        }
        PeopleHomeScreen(
            state = state,
            onEvent = { event ->
                home.forward(event)
                nav.push(PeopleRouting.home(event))
            },
            onHome = { nav.home() },
        )
    }

    @Composable
    private fun PersonRoute(destination: Destination.PeoplePerson, nav: RouteNav) {
        val context = LocalContext.current
        LaunchedEffect(destination) { person.open(destination.partyId, destination.name, destination.logTouch) }
        val state by person.host.state.collectAsStateWithLifecycle()
        // A PERSON MOVED TO THE TRASH HERE is done: the page goes with them.
        LaunchedEffect(state.done, state.party_id) {
            if (state.done && state.party_id == destination.partyId) nav.pop()
        }
        PeoplePersonScreen(
            state = state,
            onEvent = { event ->
                person.forward(event)
                nav.push(PeopleRouting.person(event, state))
                PeopleRouting.channel(event, state)?.let { reach(context, it) }
            },
            onBack = { nav.pop() },
        )
    }

    @Composable
    private fun EditorRoute(destination: Destination.PeopleEditor, nav: RouteNav) {
        // A NEW person opens under the id `PeopleRouting` minted for the route.
        LaunchedEffect(destination) {
            if (destination.isNew) editor.openNew(destination.partyId) else editor.open(destination.partyId)
        }
        val state by editor.host.state.collectAsStateWithLifecycle()
        PeopleEditorScreen(
            state = state,
            onEvent = { event -> editor.forward(event) },
            onClose = { nav.pop() },
            onDeparted = { editor.departed() },
        )
    }

    @Composable
    private fun TrashRoute(nav: RouteNav) {
        LaunchedEffect(Unit) { trash.open() }
        val state by trash.host.state.collectAsStateWithLifecycle()
        TrashListScreen(
            state = state,
            onEvent = { event -> trash.forward(event) },
            parentTitle = PeopleCopy.APP_TITLE,
            onBack = { nav.pop() },
        )
    }
}

/**
 * A CHANNEL, TO THE OS, by the row's own intent: the dialler, a mail
 * composer, the maps app, or the clipboard. Nothing is sent from here — each
 * hands the member to the app that does it.
 */
private fun reach(context: Context, channel: PeopleChannelRow) {
    val value = channel.value_
    val intent = when (channel.intent) {
        PeopleChannelIntent.PEOPLE_CHANNEL_INTENT_CALL -> Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(value)))
        PeopleChannelIntent.PEOPLE_CHANNEL_INTENT_MAIL -> Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:" + value))
        PeopleChannelIntent.PEOPLE_CHANNEL_INTENT_MAP -> Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=" + Uri.encode(value)))
        PeopleChannelIntent.PEOPLE_CHANNEL_INTENT_COPY -> {
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            clipboard?.setPrimaryClip(ClipData.newPlainText(channel.kind_label, value))
            null
        }
        else -> null
    } ?: return
    try {
        context.startActivity(intent)
    } catch (_: ActivityNotFoundException) {
        // No app on this phone answers the intent; the row stays as it was.
    }
}
