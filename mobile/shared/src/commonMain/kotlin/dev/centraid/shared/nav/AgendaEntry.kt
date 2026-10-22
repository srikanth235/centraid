package dev.centraid.shared.nav

import centraid.core.v1.AgendaDestination
import centraid.core.v1.AgendaEventRoute
import centraid.core.v1.AgendaHomeRoute
import centraid.core.v1.Route
import centraid.core.v1.TodoDetailRoute
import centraid.core.v1.TodoProjectRoute

/**
 * WHERE THE SHELL ENTERS AGENDA FROM OUTSIDE IT (#1135): Home's tile and search,
 * a chat card, Notes' "Send to Agenda", the reminders import. Inside Agenda a
 * row carries the `Route` Rust built; these are the only routes the shell
 * spells, because the caller holds an id and no row.
 *
 * INTERIM: the shell lane (#1135) replaces the KMP stack with Rust's and
 * deletes this file; a front door then asks Rust for the route.
 */
public object AgendaEntry {
    private const val HOME: String = "agenda.home"
    private const val EVENT: String = "agenda.event"
    private const val TASK: String = "agenda.task"
    private const val PROJECT: String = "agenda.project"

    /** The route to a registered screen, before its arguments ride on it. */
    private fun route(screenId: String): Route = Route(screen = screenId)

    /** Agenda's home at [destination] (Day when unspecified); [quickAdd] is words waiting in To-do's quick add. */
    public fun home(
        destination: AgendaDestination = AgendaDestination.AGENDA_DESTINATION_DAY,
        quickAdd: String = "",
    ): Destination.RustScreen = Destination.RustScreen(
        route(screenId = HOME).copy(agenda_home = AgendaHomeRoute(destination = destination, quick_add_title = quickAdd)),
    )

    /** One task's page. */
    public fun task(id: String): Destination.RustScreen = Destination.RustScreen(
        route(screenId = TASK).copy(todo_detail = TodoDetailRoute(task_id = id)),
    )

    /** One project's page; the name rides along for the head. */
    public fun project(id: String, name: String = ""): Destination.RustScreen = Destination.RustScreen(
        route(screenId = PROJECT).copy(todo_project = TodoProjectRoute(project_id = id, name = name)),
    )

    /** One occurrence of an event; [day] is the civil day it was drawn under, empty when unknown. */
    public fun event(
        eventId: String,
        instanceKey: String = "",
        originalStartLocal: String? = null,
        day: String = "",
    ): Destination.RustScreen = Destination.RustScreen(
        route(screenId = EVENT).copy(
            agenda_event = AgendaEventRoute(
                event_id = eventId,
                instance_key = instanceKey,
                original_start_local = originalStartLocal,
                day = day,
            ),
        ),
    )
}
