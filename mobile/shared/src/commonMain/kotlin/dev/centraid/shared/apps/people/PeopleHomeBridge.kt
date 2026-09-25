package dev.centraid.shared.apps.people

import centraid.screen.v1.PeopleHomeEvent
import centraid.screen.v1.PeopleHomeState
import dev.centraid.shared.kit.ScreenBridge

/**
 * What both shells hold for People's home (#1029 app port). The kit's
 * [ScreenBridge], named so the Swift symbol is People's own.
 *
 * A shell pushes `Destination.PeopleHome` and forwards `Opened` with its band
 * destination. The intents on `PeopleHomeEvent` — `PersonPicked`,
 * `AddPersonRequested` (push the editor with a minted id, see
 * [PeopleEditorBridge.openNew]), `TrashRequested`, `LogTouchRequested` (push
 * the person with `Opened.log_touch`) — change nothing here; the shell routes
 * them off the event it forwards.
 */
public class PeopleHomeBridge : ScreenBridge<PeopleHomeState, PeopleHomeEvent>(
    machine = PeopleHomeMachine,
    events = PeopleHomeEvent.ADAPTER,
    wire = { w -> w.session.attachQueries(w.host, PeopleHomeReads, PeopleHomeReads, left = w.left) },
) {
    /** Land on [destination] with search closed: the one call a shell makes to open People. */
    public fun open(
        destination: PeopleHomeState.Destination = PeopleHomeState.Destination.DESTINATION_PEOPLE,
    ) {
        forward(PeopleHomeEvent(opened = PeopleHomeEvent.Opened(destination = destination)))
    }

    // SWIFT CANNOT OMIT A KOTLIN DEFAULT ARGUMENT: each overload below is the
    // call with the defaults spelled out.
    public fun open() {
        open(PeopleHomeState.Destination.DESTINATION_PEOPLE)
    }
}
