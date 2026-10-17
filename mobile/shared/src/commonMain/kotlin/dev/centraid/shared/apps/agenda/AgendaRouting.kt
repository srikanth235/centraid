package dev.centraid.shared.apps.agenda

import centraid.screen.v1.AgendaEventEvent
import centraid.screen.v1.AgendaEventState
import centraid.screen.v1.AgendaHomeEvent
import centraid.screen.v1.AgendaHomeState
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.ScreenMove
import dev.centraid.shared.nav.ScreenMoves

/**
 * WHERE AGENDA'S INTENTS GO, ONCE (#1046).
 *
 * `EventPicked`, `NewEventRequested` and the detail's `ActionPicked{edit}`
 * change nothing in their machines; the shell pushes. WHICH page lives here:
 * Android pushes the [Destination] (opening the bridge on the push), and iOS
 * asks [route] for the same push spelled. A new event lands on the home's
 * anchor day (empty is the core's today); an edit on the occurrence the
 * detail holds.
 */
public object AgendaRouting {
    public fun home(event: AgendaHomeEvent, state: AgendaHomeState): Destination? {
        val picked = event.event_picked
        return when {
            picked != null && picked.event_id.isNotEmpty() ->
                Destination.AgendaEvent(picked.event_id, picked.instance_key, picked.original_start_local, picked.day)
            event.new_event != null -> Destination.AgendaEditor(day = state.anchor_day)
            else -> null
        }
    }

    public fun event(event: AgendaEventEvent, state: AgendaEventState): Destination? =
        if (event.action?.key == AgendaEventMachine.ACTION_EDIT && state.event_id.isNotEmpty()) {
            Destination.AgendaEditor(state.event_id, state.instance_key, state.original_start_local, state.day)
        } else {
            null
        }

    /**
     * THE SAME DECISIONS FOR A SHELL THAT SENDS BYTES: [event] is what screen
     * [screenId] just forwarded and [state] is that screen's own state. Null
     * for an event that routes nowhere, a screen that is not Agenda's, or bytes
     * that do not decode.
     */
    public fun route(screenId: String, event: ByteArray, state: ByteArray): ScreenMove? {
        val destination = runCatching {
            when (screenId) {
                AgendaHomeMachine.SCREEN_ID -> home(AgendaHomeEvent.ADAPTER.decode(event), AgendaHomeState.ADAPTER.decode(state))
                AgendaEventMachine.SCREEN_ID -> event(AgendaEventEvent.ADAPTER.decode(event), AgendaEventState.ADAPTER.decode(state))
                else -> null
            }
        }.getOrNull()
        return ScreenMoves.push(destination)
    }
}
