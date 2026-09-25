package dev.centraid.shared.apps.people

import centraid.screen.v1.PeopleEditorEvent
import centraid.screen.v1.PeopleEditorState
import dev.centraid.shared.kit.ScreenBridge
import kotlin.uuid.ExperimentalUuidApi
import kotlin.uuid.Uuid

/**
 * What both shells hold for the profile editor (#1029 app port). Close =
 * done: a shell calls `leave()` (or `departed()` for a bridge it keeps) when
 * the editor goes, and the words typed are saved on the session's scope.
 */
public class PeopleEditorBridge : ScreenBridge<PeopleEditorState, PeopleEditorEvent>(
    machine = PeopleEditorMachine,
    events = PeopleEditorEvent.ADAPTER,
    wire = { w -> w.session.attachQueries(w.host, PeopleEditorReads, PeopleEditorReads, left = w.left) },
) {
    /** Edit [partyId]. */
    public fun open(partyId: String) {
        forward(PeopleEditorEvent(opened = PeopleEditorEvent.Opened(party_id = partyId)))
    }

    /**
     * A NEW PERSON, under an id minted here (#922 G2: a seat-minted id is
     * honoured by `people.add_person`), so every save of this editor names
     * the same person. Returns the id, for the shell's route.
     */
    @OptIn(ExperimentalUuidApi::class)
    public fun openNew(): String {
        val id = Uuid.random().toString()
        forward(PeopleEditorEvent(opened = PeopleEditorEvent.Opened(minted_party_id = id)))
        return id
    }
}
