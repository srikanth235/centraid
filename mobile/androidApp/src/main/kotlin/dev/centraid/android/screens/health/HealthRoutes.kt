package dev.centraid.android.screens.health

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import centraid.screen.v1.HealthConnectEvent
import centraid.screen.v1.HealthHomeEvent
import centraid.screen.v1.HealthHomeState
import dev.centraid.android.kit.AndroidHealth
import dev.centraid.android.screens.AppRoutes
import dev.centraid.android.screens.RouteNav
import dev.centraid.shared.apps.health.HealthConnectBridge
import dev.centraid.shared.apps.health.HealthConnectScreenBridge
import dev.centraid.shared.apps.health.HealthHomeBridge
import dev.centraid.shared.apps.health.HealthMetricBridge
import dev.centraid.shared.apps.health.HealthRouting
import dev.centraid.shared.apps.health.HealthWorkoutBridge
import dev.centraid.shared.nav.AppIds
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.withHealthDestination
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope

/**
 * HEALTH'S ROUTES (#1129): `health.home` (Today · Trends · Workouts, More as a sheet), one metric,
 * one workout, and Connect, one bridge each for the activity's life. The machines emit intents;
 * `HealthRouting` decides where each goes (for iOS too), and this file applies the move and runs
 * the shell's two own acts: Stop (`HealthConnectBridge.stop`) and Connect, which is the only place
 * Health Connect is ever asked for anything ([rememberHealthConnect]).
 */
internal class HealthRoutes(private val health: AndroidHealth) : AppRoutes {

    private val home = HealthHomeBridge()
    private val metric = HealthMetricBridge()
    private val workout = HealthWorkoutBridge()
    private val connectPage = HealthConnectScreenBridge()
    private val store = HealthConnectBridge(health.reader)

    override fun handles(destination: Destination): Boolean = when (destination) {
        is Destination.HealthHome, is Destination.HealthMetric, is Destination.HealthWorkout, is Destination.HealthConnect -> true
        else -> false
    }

    // `open()` ON THE PUSH (Money's rule): coming back from a pushed page keeps the tab and the filters.
    override fun opens(moveId: String): Destination? = if (moveId == AppIds.HEALTH) {
        home.open()
        Destination.HealthHome()
    } else {
        null
    }

    override fun attach(session: HomeSession, scope: CoroutineScope) {
        home.attach(session)
        metric.attach(session)
        workout.attach(session)
        connectPage.attach(session)
        store.attach(session)
    }

    @Composable
    override fun Routes(destination: Destination, nav: RouteNav) {
        when (destination) {
            is Destination.HealthHome -> HomeRoute(nav)
            is Destination.HealthMetric -> {
                LaunchedEffect(destination) { metric.open(destination.metric, destination.parent) }
                val held by metric.host.state.collectAsStateWithLifecycle()
                HealthMetricScreen(held.screen, onBack = nav::pop, onEvent = metric::forward)
            }
            is Destination.HealthWorkout -> {
                LaunchedEffect(destination) { workout.open(destination.activityId, destination.parent) }
                val held by workout.host.state.collectAsStateWithLifecycle()
                HealthWorkoutScreen(held.screen, onBack = nav::pop, onEvent = workout::forward)
            }
            is Destination.HealthConnect -> ConnectRoute(destination, nav)
            else -> Unit
        }
    }

    @Composable
    private fun HomeRoute(nav: RouteNav) {
        val held by home.host.state.collectAsStateWithLifecycle()
        val state = held.screen
        // THE ROUTE FOLLOWS THE MACHINE: a band tab swaps the top entry's parameter, never a push.
        LaunchedEffect(state.destination) {
            val band = state.destination
            val top = nav.stack.current
            if (band != HealthHomeState.Destination.DESTINATION_UNSPECIFIED && top is Destination.HealthHome && top.destination != band) {
                nav.go(nav.stack.withHealthDestination(band))
            }
        }
        HealthHomeScreen(state, onHome = nav::home, onEvent = { event: HealthHomeEvent ->
            home.forward(event)
            // THE SHELL'S OWN ACT: Health stops reading the store; every day and workout stays.
            if (event.stop != null) store.stop { }
            nav.push(HealthRouting.home(event, state))
        })
    }

    @Composable
    private fun ConnectRoute(destination: Destination.HealthConnect, nav: RouteNav) {
        LaunchedEffect(destination) { connectPage.open(destination.parent) }
        val state by connectPage.host.state.collectAsStateWithLifecycle()
        val connect = rememberHealthConnect(health, store, connectPage, nav.scope) {
            // Connected pops back to where Connect was opened from.
            nav.apply(HealthRouting.connect(HealthConnectEvent(connected = HealthConnectEvent.Connected()), connectPage.host.state.value))
        }
        HealthConnectScreen(state, onBack = nav::pop, onEvent = { event: HealthConnectEvent ->
            val asked = state
            connectPage.forward(event)
            if (event.connect != null && asked.can_connect) connect(asked.chosen)
        })
    }
}
