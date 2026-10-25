package dev.centraid.shared.nav

import centraid.core.v1.HealthConnectRoute
import centraid.core.v1.HealthDestination
import centraid.core.v1.HealthHomeRoute
import centraid.core.v1.HealthMetricRoute
import centraid.core.v1.HealthWorkoutRoute
import centraid.core.v1.Route

/**
 * WHERE THE SHELL ENTERS HEALTH FROM OUTSIDE IT (#1135): Home's tile, a chat
 * card, the rationale Health Connect asks for. Inside Health a row carries the
 * `Route` Rust built; these are the only routes the shell spells, because the
 * caller holds an id and no row.
 *
 * INTERIM: the shell lane (#1135) replaces the KMP stack with Rust's and
 * deletes this file, as it deletes [AgendaEntry]; a front door then asks Rust
 * for the route.
 */
public object HealthEntry {
    private const val HOME: String = "health.home"
    private const val WORKOUT: String = "health.workout"
    private const val CONNECT: String = "health.connect"
    private const val METRIC: String = "health.metric"

    /** Health's home on Today, or the tab named. */
    public fun home(destination: HealthDestination = HealthDestination.HEALTH_DESTINATION_TODAY): Destination.RustScreen =
        Destination.RustScreen(
            Route(screen = HOME, health_home = HealthHomeRoute(destination = destination)),
        )

    /** One workout; [parent] is the pushing page's title, which its back control says. */
    public fun workout(activityId: String, parent: String = ""): Destination.RustScreen =
        Destination.RustScreen(
            Route(screen = WORKOUT, health_workout = HealthWorkoutRoute(activity_id = activityId, parent = parent)),
        )

    /** One metric. */
    public fun metric(metric: String, parent: String = ""): Destination.RustScreen =
        Destination.RustScreen(
            Route(screen = METRIC, health_metric = HealthMetricRoute(metric = metric, parent = parent)),
        )

    /** What Health may read, and Connect. */
    public fun connect(parent: String = ""): Destination.RustScreen =
        Destination.RustScreen(
            Route(screen = CONNECT, health_connect = HealthConnectRoute(parent = parent)),
        )
}
