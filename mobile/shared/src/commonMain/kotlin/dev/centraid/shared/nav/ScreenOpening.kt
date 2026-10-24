package dev.centraid.shared.nav

import centraid.screen.v1.HealthConnectEvent
import centraid.screen.v1.HealthHomeEvent
import centraid.screen.v1.HealthMetricEvent
import centraid.screen.v1.HealthWorkoutEvent
import centraid.screen.v1.PeopleEditorEvent
import centraid.screen.v1.PeopleHomeEvent
import centraid.screen.v1.PeoplePersonEvent
import centraid.screen.v1.TrashListEvent

/**
 * ONE ROUTE, AS A SHELL THAT KEYS ITS SCREENS BY ID OPENS IT.
 *
 * A [Destination] is the stack's value in a shell that pushes Kotlin; a shell
 * whose views are written in another language (SwiftUI) cannot hold one, so it
 * is handed this: the screen's id ([ScreenIds], which its machine's `SCREEN_ID`
 * is) and the screen's own `Opened` event, encoded, which the shell sends as it
 * stands. Nothing
 * here is a second table of where things go: [ScreenOpenings.of] only SPELLS a
 * destination the shared side already chose.
 *
 * The photographs are not registry screens, so they ride the same value:
 * [screenId] names the machine, [event] is a shelf's `PhotoShelf`, and
 * [assetId] and [neighbours] are the lightbox's photograph and swipe order.
 */
public class ScreenOpening(
    public val screenId: String,
    public val event: ByteArray = ByteArray(0),
    public val assetId: String = "",
    public val neighbours: List<String> = emptyList(),
)

/** A [Destination], spelled as the screen id and `Opened` event its screen takes. */
public object ScreenOpenings {
    /**
     * The route [destination] opens, or null for a destination no route
     * spells (a shell-owned page, or one the callers have not needed yet).
     */
    public fun of(destination: Destination): ScreenOpening? = when (destination) {
        is Destination.PeopleHome -> screen(
            ScreenIds.PEOPLE_HOME,
            PeopleHomeEvent(opened = PeopleHomeEvent.Opened(destination = destination.destination)).encode(),
        )
        is Destination.PeoplePerson -> screen(
            ScreenIds.PEOPLE_PERSON,
            PeoplePersonEvent(
                opened = PeoplePersonEvent.Opened(
                    party_id = destination.partyId,
                    name = destination.name,
                    log_touch = destination.logTouch,
                ),
            ).encode(),
        )
        // HEALTH: the phone's facts are stamped on arrival (`HealthRouting.opened`), never spelled here.
        is Destination.HealthHome -> screen(
            ScreenIds.HEALTH_HOME,
            HealthHomeEvent(opened = HealthHomeEvent.Opened(destination = destination.destination)).encode(),
        )
        is Destination.HealthMetric -> screen(
            ScreenIds.HEALTH_METRIC,
            HealthMetricEvent(opened = HealthMetricEvent.Opened(metric = destination.metric, parent = destination.parent)).encode(),
        )
        is Destination.HealthWorkout -> screen(
            ScreenIds.HEALTH_WORKOUT,
            HealthWorkoutEvent(opened = HealthWorkoutEvent.Opened(activity_id = destination.activityId, parent = destination.parent)).encode(),
        )
        is Destination.HealthConnect -> screen(
            ScreenIds.HEALTH_CONNECT,
            HealthConnectEvent(opened = HealthConnectEvent.Opened(parent = destination.parent)).encode(),
        )
        // A NEW PERSON's id rides as the minted one: the editor adds them on its first save.
        is Destination.PeopleEditor -> screen(
            ScreenIds.PEOPLE_EDITOR,
            PeopleEditorEvent(
                opened = if (destination.isNew) {
                    PeopleEditorEvent.Opened(minted_party_id = destination.partyId)
                } else {
                    PeopleEditorEvent.Opened(party_id = destination.partyId)
                },
            ).encode(),
        )
        Destination.PeopleTrash -> screen(ScreenIds.PEOPLE_TRASH, TrashListEvent(opened = TrashListEvent.Opened()).encode())
        // THE PHOTOGRAPHS: a shelf is its `PhotoShelf`, a lightbox its photograph and swipe.
        is Destination.PhotoShelfRoute -> screen(ScreenIds.PHOTOS_SHELF, destination.shelf.encode())
        is Destination.PhotoLightbox -> ScreenOpening(
            ScreenIds.PHOTOS_LIGHTBOX,
            assetId = destination.assetId,
            neighbours = destination.neighbours,
        )
        is Destination.PhotosHome -> ScreenOpening(ScreenIds.PHOTOS_GRID)
        // A SCREEN RUST OWNS: the event is the `Route` Rust built, which the shell pushes as it stands.
        is Destination.RustScreen -> screen(ScreenIds.RUST_SCREEN, destination.route.encode())
        else -> null
    }

    private fun screen(screenId: String, event: ByteArray): ScreenOpening = ScreenOpening(screenId, event)
}
