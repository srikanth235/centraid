package dev.centraid.shared.apps.people

import centraid.screen.v1.PeoplePersonEvent
import centraid.screen.v1.PeoplePersonState
import dev.centraid.shared.kit.ScreenBridge

/**
 * What both shells hold for one person's sheet (#1029 app port).
 *
 * A shell pushes `Destination.PeoplePerson` and calls [open]. It routes the
 * intents it forwards — `EditRequested` (push `Destination.PeopleEditor`),
 * `ChannelTapped` (call, mail, map or copy by the row's `intent`) — and pops
 * when the state says `done`.
 */
public class PeoplePersonBridge : ScreenBridge<PeoplePersonState, PeoplePersonEvent>(
    machine = PeoplePersonMachine,
    events = PeoplePersonEvent.ADAPTER,
    wire = { w -> w.session.attachQueries(w.host, PeoplePersonReads, PeoplePersonReads, left = w.left) },
) {
    /** Open [partyId]; [logTouch] lands with the Log a touch sheet up (Touch's card). */
    public fun open(partyId: String, name: String = "", logTouch: Boolean = false) {
        forward(
            PeoplePersonEvent(
                opened = PeoplePersonEvent.Opened(party_id = partyId, name = name, log_touch = logTouch),
            ),
        )
    }

    // SWIFT CANNOT OMIT A KOTLIN DEFAULT ARGUMENT: each overload below is the
    // call with the defaults spelled out.
    public fun open(partyId: String) {
        open(partyId, "", false)
    }

    public fun open(partyId: String, name: String) {
        open(partyId, name, false)
    }
}
