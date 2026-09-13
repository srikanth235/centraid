package dev.centraid.shared.nav

import centraid.screen.v1.PhotoStateView
import centraid.screen.v1.PhotosGridState
import centraid.screen.v1.TallyListState

/**
 * The navigation model (#1020, D-1020-E1, D-1020-E3).
 *
 * **One root stack, no bottom tabs — apps are covers over Home**
 * (`apps/mobile/src/navigation.ts:1-3`). That is the sentence the whole model
 * keeps, and it is why [Destination] is a flat sealed hierarchy rather than a
 * tree of tab graphs: a tab bar would make "which app am I in" a second piece
 * of state, and v0 deleted it on purpose.
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
 * 2. **Names ride along the route**, so [Destination.DocsFolder] carries
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

    public data object Settings : Destination

    /** Activity. The alias v0 keeps for Insights (`navigation.ts:1-3`). */
    public data object Activity : Destination

    /** Vault. v0's `Data` alias. */
    public data object Vault : Destination

    /** Copies. v0's `Devices` alias. */
    public data object Copies : Destination

    public data class TallyHome(
        val destination: TallyListState.Destination =
            TallyListState.Destination.DESTINATION_ACTIVITY,
    ) : Destination

    public data class PhotosHome(
        /**
         * `more` IS ABSENT FROM THIS TYPE, and cannot be added: it is a
         * `PhotosGridState.Destination`, and `more` is a
         * `PhotosGridState.Sheet` (`navigation.ts:19-24`).
         */
        val destination: PhotosGridState.Destination =
            PhotosGridState.Destination.DESTINATION_LIBRARY,
    ) : Destination

    public data class PhotoStateViewRoute(val view: PhotoStateView) : Destination

    public data class NotesEditor(
        val noteId: String,
        /** The title rides along so the app bar has something to say at once. */
        val title: String? = null,
    ) : Destination

    public data class DocsFolder(val folderId: String, val folderName: String) : Destination
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

    public fun withTallyDestination(destination: TallyListState.Destination): NavStack {
        val top = current
        return if (top is Destination.TallyHome) {
            NavStack(entries.dropLast(1) + top.copy(destination = destination))
        } else {
            push(Destination.TallyHome(destination))
        }
    }
}
