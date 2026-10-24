package dev.centraid.shared.nav

import centraid.core.v1.PeopleDestination
import centraid.core.v1.PeopleEditorRoute
import centraid.core.v1.PeopleHomeRoute
import centraid.core.v1.PeoplePersonRoute
import centraid.core.v1.Route

/**
 * WHERE THE SHELL ENTERS PEOPLE FROM OUTSIDE IT (#1135): Home's tile, search, a
 * chat card. Inside People a row carries the `Route` Rust built; these are the
 * only routes the shell spells, because the caller holds an id and no row.
 *
 * INTERIM: the shell lane (#1135) replaces the KMP stack with Rust's and
 * deletes this file; a front door then asks Rust for the route.
 */
public object PeopleEntry {
    private const val HOME: String = "people.home"
    private const val PERSON: String = "people.person"
    private const val EDITOR: String = "people.editor"

    /** People's home on [destination]: the roster, or Touch. */
    public fun home(
        destination: PeopleDestination = PeopleDestination.PEOPLE_DESTINATION_PEOPLE,
    ): Destination.RustScreen = Destination.RustScreen(
        Route(screen = HOME, people_home = PeopleHomeRoute(destination = destination)),
    )

    /** One person; [name] gives the app bar words before the read lands. */
    public fun person(partyId: String, name: String = ""): Destination.RustScreen = Destination.RustScreen(
        Route(screen = PERSON, people_person = PeoplePersonRoute(party_id = partyId, name = name)),
    )

    /** An empty draft: its first save adds the person. */
    public fun newPerson(): Destination.RustScreen = Destination.RustScreen(
        Route(screen = EDITOR, people_editor = PeopleEditorRoute(is_new = true)),
    )
}
