package dev.centraid.shared.apps.people

import centraid.screen.v1.PeopleChannelRow
import centraid.screen.v1.PeopleHomeEvent
import centraid.screen.v1.PeoplePersonEvent
import centraid.screen.v1.PeoplePersonState
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.ScreenMove
import dev.centraid.shared.nav.ScreenMoves
import kotlin.uuid.ExperimentalUuidApi
import kotlin.uuid.Uuid

/**
 * WHERE PEOPLE'S INTENTS GO, ONCE (#1029 port).
 *
 * `PersonPicked`, `LogTouchRequested`, `AddPersonRequested`, More's Trash and
 * a person's `EditRequested` change nothing in their machines; the shell
 * pushes. WHICH page lives here: Android pushes the [Destination], and iOS asks
 * [route] for the same push spelled. A channel is not a page: [channel] names
 * the row the tap meant, and the shell hands its value to the OS.
 */
public object PeopleRouting {
    public fun home(event: PeopleHomeEvent): Destination? {
        val person = event.person
        val touch = event.log_touch
        return when {
            person != null -> personOf(person.party_id, person.name, logTouch = false)
            touch != null -> personOf(touch.party_id, touch.name, logTouch = true)
            // A NEW PERSON, under an id minted here (#922 G2): every save of
            // the editor names the same person.
            event.add_person != null -> Destination.PeopleEditor(mintPartyId(), isNew = true)
            event.more_row?.key == PeopleHomeMachine.MORE_TRASH -> Destination.PeopleTrash
            else -> null
        }
    }

    /** Edit opens the editor on the person the page holds, once the state names them. */
    public fun person(event: PeoplePersonEvent, state: PeoplePersonState): Destination? =
        if (event.edit != null && state.party_id.isNotEmpty()) Destination.PeopleEditor(state.party_id) else null

    /** The channel row a `ChannelTapped` meant, from the rows the page holds; null for none. */
    public fun channel(event: PeoplePersonEvent, state: PeoplePersonState): PeopleChannelRow? {
        val tapped = event.channel ?: return null
        return state.data_?.channels?.firstOrNull { it.channel_id == tapped.channel_id }
    }

    /**
     * THE SAME DECISIONS FOR A SHELL THAT SENDS BYTES: [event] is what screen
     * [screenId] just forwarded and [state] is that screen's own state. Null
     * for an event that routes nowhere, a screen that is not People's, or bytes
     * that do not decode.
     */
    public fun route(screenId: String, event: ByteArray, state: ByteArray): ScreenMove? {
        val destination = runCatching {
            when (screenId) {
                PeopleHomeMachine.SCREEN_ID -> home(PeopleHomeEvent.ADAPTER.decode(event))
                PeoplePersonMachine.SCREEN_ID -> person(PeoplePersonEvent.ADAPTER.decode(event), PeoplePersonState.ADAPTER.decode(state))
                else -> null
            }
        }.getOrNull()
        return ScreenMoves.push(destination)
    }

    /** [channel] for a shell that sends bytes: the row, encoded, or null. */
    public fun channelRow(event: ByteArray, state: ByteArray): ByteArray? = runCatching {
        channel(PeoplePersonEvent.ADAPTER.decode(event), PeoplePersonState.ADAPTER.decode(state))?.encode()
    }.getOrNull()

    /** A person id minted on this phone: a lowercase version-4 UUID. */
    @OptIn(ExperimentalUuidApi::class)
    public fun mintPartyId(): String = Uuid.random().toString()

    /** A person with no id names nothing, so it opens nothing. */
    private fun personOf(partyId: String, name: String, logTouch: Boolean): Destination? =
        if (partyId.isEmpty()) null else Destination.PeoplePerson(partyId, name, logTouch)
}
