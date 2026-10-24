package dev.centraid.shared.nav

import centraid.core.v1.Route
import centraid.screen.v1.PeopleHomeState
import centraid.screen.v1.PhotoShelf
import centraid.screen.v1.PhotoStateView
import centraid.screen.v1.PhotosGridState
import centraid.screen.v1.PlacesState

/**
 * The navigation model (#1020, D-1020-E1, D-1020-E3).
 *
 * **One root stack, no bottom tabs — apps are covers over Home.** That is the
 * sentence the whole model keeps, and it is why [Destination] is a flat sealed
 * hierarchy rather than a tree of tab graphs: a tab bar would make "which app
 * am I in" a second piece of state.
 *
 * Kotlin and not protobuf, deliberately: a destination never crosses the ABI.
 * The core answers reads and commands; where the member is standing is the
 * shell's own business, and a wire type for it would be a contract nobody on
 * the other side reads.
 *
 * ## The four doctrines, as types
 *
 * 1. A **band destination is a parameter**, so [Destination.PhotosHome] carries
 *    one and there is no `PhotosCollections` destination.
 * 2. **Names ride along the route**, so the Docs folder route carries
 *    `folderName` and an app bar need not wait a replica round trip.
 * 3. A **discriminated union, not a bag of optionals**:
 *    [Destination.PhotoStateViewRoute] holds a `PhotoStateView`, whose `view`
 *    is a oneof.
 * 4. **An OS permission is not a route.** There is no `PhotoPermission`
 *    destination and there never will be; the grant is a field on
 *    `PhotosGridState`.
 */
public sealed interface Destination {
    public data object Home : Destination

    public data object Capture : Destination

    /**
     * HOME'S SEARCH (R-CHROME-6): one field over every app, pushed
     * from Home's search bar. A shell forwards `HomeSearchEvent.Opened` at the
     * push, never on re-appearance, so a member coming back from a row finds
     * the results they left.
     */
    public data object HomeSearch : Destination

    public data object Settings : Destination

    /** Activity. The alias v0 keeps for Insights (`navigation.ts:1-3`). */
    public data object Activity : Destination

    /** Vault. v0's `Data` alias. */
    public data object Vault : Destination

    /** Copies. v0's `Devices` alias. */
    public data object Copies : Destination

    /**
     * A SCREEN RUST OWNS (#1135), drawn by the shell from the view state Rust
     * sends: [route] is the registered screen and its arguments, built by Rust
     * (a row's `route`) or, at an app's front door, by [AgendaEntry]. INTERIM
     * HOSTING: this stack still holds the back stack until the shell lane
     * replaces it; pushing an entry sends `NavPush(tab, route)` and popping it
     * sends `NavPopped`.
     */
    public data class RustScreen(val route: Route) : Destination

    public data class PhotosHome(
        /**
         * `more` IS ABSENT FROM THIS TYPE, and cannot be added: it is a
         * `PhotosGridState.Destination`, and `more` is a
         * `PhotosGridState.Sheet` (`navigation.ts:19-24`).
         */
        val destination: PhotosGridState.Destination =
            PhotosGridState.Destination.DESTINATION_LIBRARY,
    ) : Destination

    /**
     * A PHOTO SHELF: the library under a predicate.
     *
     * v0 had four routes here — `PhotoStateView`, `AlbumDetail`, `PlaceDetail`
     * and a memory's members — reading the same table in the same order and
     * drawing the same cells. [PhotoShelf] is the parameter that replaced them
     * (`screen.proto`, *Photos: the rest of the miniapp*), which is doctrine 1
     * read one step further than wave 3 read it.
     */
    public data class PhotoShelfRoute(val shelf: PhotoShelf) : Destination

    /**
     * v0's `PhotoStateView` route, kept as a CONSTRUCTOR and not as a second
     * destination: it makes the four standing shelves reachable by the name the
     * rest of the shell knows them by, and lands on the one screen that draws
     * them.
     */
    public data class PhotoStateViewRoute(val view: PhotoStateView) : Destination {
        public fun asShelf(): PhotoShelfRoute = PhotoShelfRoute(PhotoShelf(state_view = view))
    }

    /** One photograph, full-bleed. `neighbours` is the shelf's order, so a
     *  swipe needs no read; `albumId` is the album it was opened from, empty
     *  from anywhere else, so "Make key photo" knows which cover it sets. */
    public data class PhotoLightbox(
        val assetId: String,
        val neighbours: List<String> = emptyList(),
        val albumId: String = "",
    ) : Destination

    /**
     * THE EDITOR, pushed over the lightbox it was opened from. A route and not
     * v0's in-place mode: it owns a screen machine, and the lightbox under it
     * stays mounted so Cancel lands back on the same photograph. The
     * lightbox's neighbours ride along, so a save can return to a lightbox
     * whose swipe still walks the same shelf.
     */
    public data class PhotoEditor(
        val assetId: String,
        val neighbours: List<String> = emptyList(),
    ) : Destination

    /**
     * PLACES, and CARDS-OR-MAP IS A PARAMETER.
     *
     * v0's `PlacesView` and `PlacesMap` were two routes over one read. The
     * presentation rides the destination for [PhotosHome]'s reason: moving
     * between them is not a push, so back does not walk through the
     * presentations a member happened to tap.
     */
    public data class Places(
        val presentation: PlacesState.Presentation =
            PlacesState.Presentation.PRESENTATION_CARDS,
    ) : Destination

    public data object PhotoDuplicates : Destination

    public data class PhotoDuplicateReview(val clusterId: String) : Destination

    /** Names ride along, so the head says "Add to Portugal" before a read. */
    public data class PhotoPicker(
        val collectionId: String,
        val collectionName: String,
    ) : Destination


    // --- People (#1029 port) ---

    /**
     * PEOPLE'S HOME: People or Touch, as a parameter; search is a field over it
     * and More a sheet. A shell calls `PeopleHomeBridge.open(destination)`.
     */
    public data class PeopleHome(
        val destination: PeopleHomeState.Destination =
            PeopleHomeState.Destination.DESTINATION_PEOPLE,
    ) : Destination

    /** One person; the name rides along for the head. `logTouch` opens the Log a touch sheet. */
    public data class PeoplePerson(
        val partyId: String,
        val name: String = "",
        val logTouch: Boolean = false,
    ) : Destination

    /**
     * The profile editor. `isNew`: `partyId` was minted by
     * `PeopleEditorBridge.openNew` and the first save adds the person.
     */
    public data class PeopleEditor(val partyId: String, val isNew: Boolean = false) : Destination

    public data object PeopleTrash : Destination

    // --- Health (#1129) ---
    // `parent` on a pushed Health page is the pushing page's title: the back
    // control's word. Empty: "Health".

    /**
     * HEALTH'S HOME. Today, Trends or Workouts, as a parameter; More is a
     * sheet. A shell calls `HealthHomeBridge.open(destination)`.
     */
    public data class HealthHome(
        val destination: centraid.screen.v1.HealthHomeState.Destination =
            centraid.screen.v1.HealthHomeState.Destination.DESTINATION_TODAY,
    ) : Destination

    /** One metric (its key, `steps`): `HealthMetricBridge.open(metric, parent)`. */
    public data class HealthMetric(val metric: String, val parent: String = "") : Destination

    /** One workout: `HealthWorkoutBridge.open(activityId, parent)`. */
    public data class HealthWorkout(val activityId: String, val parent: String = "") : Destination

    /** What Health may read, and Connect: `HealthConnectScreenBridge.open(parent)`. */
    public data class HealthConnect(val parent: String = "") : Destination
}

/**
 * The root stack.
 *
 * Immutable, because a navigation state that can be mutated in place is a
 * navigation state two frames can disagree about. [push] and [pop] return a new
 * stack and the shell swaps it.
 */
public data class NavStack(val entries: List<Destination> = listOf(Destination.Home)) {
    init {
        require(entries.isNotEmpty()) {
            "the root stack is never empty; Home is the floor (navigation.ts:1-3)"
        }
    }

    public val current: Destination get() = entries.last()

    public fun push(destination: Destination): NavStack = NavStack(entries + destination)

    /** Pop, unless this is the floor. Popping Home is not a thing. */
    public fun pop(): NavStack =
        if (entries.size == 1) this else NavStack(entries.dropLast(1))

    /**
     * Change a band destination IN PLACE.
     *
     * The whole point of doctrine 1: moving from the library band to the
     * collections band is not a push, so back does not walk through the bands
     * a member happened to tap. A second screen per band would make it one.
     */
    public fun withPhotosDestination(destination: PhotosGridState.Destination): NavStack {
        val top = current
        return if (top is Destination.PhotosHome) {
            NavStack(entries.dropLast(1) + top.copy(destination = destination))
        } else {
            push(Destination.PhotosHome(destination))
        }
    }

    /** The same in-place swap for the Places presentation, and for the same
     *  reason: cards and the map are one screen. */
    public fun withPlacesPresentation(presentation: PlacesState.Presentation): NavStack {
        val top = current
        return if (top is Destination.Places) {
            NavStack(entries.dropLast(1) + top.copy(presentation = presentation))
        } else {
            push(Destination.Places(presentation))
        }
    }
}

/** PEOPLE'S BAND, IN PLACE (#1029 port): People and Touch are one screen's parameter. */
public fun NavStack.withPeopleDestination(destination: PeopleHomeState.Destination): NavStack {
    val top = current
    return if (top is Destination.PeopleHome) {
        NavStack(entries.dropLast(1) + top.copy(destination = destination))
    } else {
        push(Destination.PeopleHome(destination))
    }
}

/** HEALTH'S BAND, IN PLACE (#1129): Today, Trends and Workouts are one screen's parameter. */
public fun NavStack.withHealthDestination(destination: centraid.screen.v1.HealthHomeState.Destination): NavStack {
    val top = current
    return if (top is Destination.HealthHome) {
        NavStack(entries.dropLast(1) + top.copy(destination = destination))
    } else {
        push(Destination.HealthHome(destination))
    }
}
