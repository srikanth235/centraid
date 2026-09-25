package dev.centraid.shared.nav

import centraid.screen.v1.AgendaHomeState
import centraid.screen.v1.DocsDriveState
import centraid.screen.v1.PeopleHomeState
import centraid.screen.v1.PhotoShelf
import centraid.screen.v1.PhotoStateView
import centraid.screen.v1.PhotosGridState
import centraid.screen.v1.PlacesState
import centraid.screen.v1.TallyHomeState
import centraid.screen.v1.TallyListState
import centraid.screen.v1.TasksHomeState
import centraid.screen.v1.TasksListState

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

    /**
     * AGENDA'S HOME (#1046). Day, Schedule or Waiting, as a parameter; Search
     * is a mode over it and More a sheet, so neither is a value here. A shell
     * pushes this and calls `AgendaBridge.open(destination)`.
     */
    public data class AgendaHome(
        val destination: AgendaHomeState.Destination =
            AgendaHomeState.Destination.DESTINATION_DAY,
    ) : Destination

    /**
     * ONE AGENDA OCCURRENCE (#1046 wave 4) — `AgendaHomeEvent.EventPicked`'s
     * fields. A shell pushes this and calls `AgendaEventBridge.open`.
     */
    public data class AgendaEvent(
        val eventId: String,
        val instanceKey: String,
        val originalStartLocal: String? = null,
        val day: String,
    ) : Destination

    /**
     * AGENDA'S EDITOR (#1046 wave 5): a new event on [day] when [eventId] is
     * null (`AgendaEditorBridge.openNew`), else that occurrence
     * (`AgendaEditorBridge.openEdit`). Popped only on
     * `AgendaEditorState.dismissed`.
     */
    public data class AgendaEditor(
        val eventId: String? = null,
        val instanceKey: String = "",
        val originalStartLocal: String? = null,
        val day: String = "",
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

    public data object PhotosPeople : Destination

    public data object PhotoFaceReview : Destination

    public data object PhotosMemories : Destination

    public data object PhotoDuplicates : Destination

    public data class PhotoDuplicateReview(val clusterId: String) : Destination

    /** Names ride along, so the head says "Add to Portugal" before a read. */
    public data class PhotoPicker(
        val collectionId: String,
        val collectionName: String,
    ) : Destination

    public data class NotesEditor(
        val noteId: String,
        /** The title rides along so the app bar has something to say at once. */
        val title: String? = null,
        /**
         * The id was minted on the phone for a note not yet written
         * (`NotesRouting.target`): the editor opens empty and creates it on
         * its first save.
         */
        val isNew: Boolean = false,
    ) : Destination

    public data class DocsFolder(val folderId: String, val folderName: String) : Destination

    // --- Docs (#1046, docs port) ---------------------------------------

    /**
     * DOCS' DRIVE. All, Folders, Starred or Recently added, as a parameter;
     * search is a field and More a sheet, so neither is a value here. A folder
     * inside Folders is [DocsFolder], pushed over it (#1015 D4: content
     * pushes). A shell pushes this and calls `DocsDriveBridge.open(destination)`.
     */
    public data class DocsHome(
        val destination: DocsDriveState.Destination = DocsDriveState.Destination.DESTINATION_ALL,
    ) : Destination

    /** One document. The title rides along so the head has words at once. */
    public data class DocsDocument(val documentId: String, val title: String = "") : Destination

    /** A text document's editor: autosave, close = done, no band. */
    public data class DocsEditor(val documentId: String, val title: String = "") : Destination

    /** Docs' trash: restore and Empty trash; there is no destroy path. */
    public data object DocsTrash : Destination

    // --- Notes (#1029 port) ---

    /**
     * NOTES' LIBRARY: every note, one notebook's, or the unfiled ones. A shell
     * forwards `NotesLibraryEvent.Opened` with the same three.
     */
    public data class NotesLibrary(
        val notebookId: String = "",
        val notebookName: String = "",
        val unfiledOnly: Boolean = false,
    ) : Destination

    public data object NotesNotebooks : Destination

    public data object NotesJournal : Destination

    /** One note's versions; the title rides along for the head. */
    public data class NotesHistory(val noteId: String, val title: String = "") : Destination

    public data object NotesTrash : Destination

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

    // --- Tasks (#1029 port) ---

    /**
     * TASKS' HOME: Today, Upcoming, Inbox or Projects, as a parameter; search
     * is a field and More a sheet. A shell calls `TasksHomeBridge.open(destination)`
     * — or, with [quickAdd] (Notes' "Send to Tasks"), `openQuickAdd(quickAdd)`,
     * which lands on the Inbox with those words in the quick add.
     */
    public data class TasksHome(
        val destination: TasksHomeState.Destination = TasksHomeState.Destination.DESTINATION_TODAY,
        val quickAdd: String = "",
    ) : Destination

    /** Anytime, All, Logbook or Reminders — one screen, the view a parameter. */
    public data class TasksList(val view: TasksListState.View) : Destination

    /** One project; the name rides along for the head. */
    public data class TasksProject(val projectId: String, val name: String = "") : Destination

    /** The task editor: autosave, close = done, no band. */
    public data class TasksDetail(val taskId: String) : Destination

    public data object TasksCatchUp : Destination

    /** Tasks' trash: restore, and delete forever behind a confirm. */
    public data object TasksTrash : Destination
    // --- Tally (#1046 port) ---

    /**
     * TALLY'S HOME: Balances, Activity or Groups, as a parameter; More is a
     * sheet. A shell calls `TallyHomeBridge.open(destination)`. The legacy
     * [TallyHome] stays until the native list moves here.
     */
    public data class TallyApp(
        val destination: TallyHomeState.Destination = TallyHomeState.Destination.DESTINATION_BALANCES,
    ) : Destination

    /** One group's ledger; the name rides along for the head. */
    public data class TallyGroup(val groupId: String, val name: String = "") : Destination

    /** One friend; the name rides along for the head. */
    public data class TallyFriend(val partyId: String, val name: String = "") : Destination

    public data class TallyExpense(val expenseId: String) : Destination

    /**
     * Add (no `expenseId`, preset with a group or a friend) or edit. No band:
     * explicit Save, and leaving with changes asks first.
     */
    public data class TallyEditor(
        val expenseId: String = "",
        val groupId: String = "",
        val partyId: String = "",
    ) : Destination

    /** Empty `groupId` is every group plus the group-less positions. */
    public data class TallySettleUp(val groupId: String = "") : Destination

    public data object TallyRecurring : Destination

    public data object TallySpending : Destination

    public data object TallySearch : Destination

    /** Restore only: the sweep purges, and there is no destroy path. */
    public data object TallyTrash : Destination
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

    /** The same in-place swap for Agenda's band. */
    public fun withAgendaDestination(destination: AgendaHomeState.Destination): NavStack {
        val top = current
        return if (top is Destination.AgendaHome) {
            NavStack(entries.dropLast(1) + top.copy(destination = destination))
        } else {
            push(Destination.AgendaHome(destination))
        }
    }

    /** The same in-place swap for Docs' band. A folder page is left for its tab's top level. */
    public fun withDocsDestination(destination: DocsDriveState.Destination): NavStack {
        val top = current
        return if (top is Destination.DocsHome) {
            NavStack(entries.dropLast(1) + top.copy(destination = destination))
        } else {
            push(Destination.DocsHome(destination))
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

/**
 * NOTES' BAND, IN PLACE (#1029 port): Notes, Notebooks and Journal are three
 * screens under one band, and moving between them is not a push — back does
 * not walk the places a member happened to tap. [key] is `NotesBandTab.key`;
 * an unknown key (or `more`, a sheet) leaves the stack alone.
 */
public fun NavStack.withNotesPlace(key: String): NavStack {
    val place: Destination = when (key) {
        "notes" -> Destination.NotesLibrary()
        "notebooks" -> Destination.NotesNotebooks
        "journal" -> Destination.NotesJournal
        else -> return this
    }
    val top = current
    val onBand = top is Destination.NotesLibrary || top == Destination.NotesNotebooks || top == Destination.NotesJournal
    return if (onBand) NavStack(entries.dropLast(1) + place) else push(place)
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

/** TASKS' BAND, IN PLACE (#1029 port): Today, Upcoming, Inbox and Projects are one screen's parameter. */
public fun NavStack.withTasksDestination(destination: TasksHomeState.Destination): NavStack {
    val top = current
    return if (top is Destination.TasksHome) {
        NavStack(entries.dropLast(1) + top.copy(destination = destination))
    } else {
        push(Destination.TasksHome(destination))
    }
}
