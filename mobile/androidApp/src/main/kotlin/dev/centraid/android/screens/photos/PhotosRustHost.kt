package dev.centraid.android.screens.photos

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import centraid.core.v1.NavEvent
import centraid.core.v1.NavPopToRoot
import centraid.core.v1.NavPopped
import centraid.core.v1.NavPush
import centraid.core.v1.PhotosDestination
import centraid.core.v1.PhotosHomeEvent
import centraid.core.v1.Route
import centraid.core.v1.ScreenEvent
import dev.centraid.android.kit.PerformScreenEffects
import dev.centraid.android.screens.RouteNav
import dev.centraid.core.CentraidCore
import dev.centraid.core.Screens
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavStack
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.shell.PhotosDevice
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.Locale
import java.util.TimeZone

/**
 * PHOTOS' SCREENS THAT RUST OWNS, OVER THE SCREEN RUNTIME (#1135). Photos' home
 * (the library, Collections, Search and More) is `crates/screens/src/photos/home`:
 * a `ViewState` this file draws and `ScreenEvent`s it sends. It decides nothing a
 * person sees and picks no route. The other Photos screens join it here as they
 * move: an arm in [Page]'s `when`, and nothing else.
 *
 * INTERIM HOSTING (the shell lane replaces it), the way `AgendaRoutes` does it.
 * The KMP [NavStack] still holds the back stack, and every Rust Photos page is ONE
 * destination, [Destination.RustScreen], carrying the `Route` Rust built. An entry
 * arriving on the KMP stack is pushed to Rust (`NavPush`, tab `photos`) and the
 * instance it opened is remembered; an entry that leaves it is popped in Rust
 * (`NavPopped`). [reconcile] makes that one comparison, after every move.
 *
 * THE CAMERA ROLL IS THE SHELL'S ([PhotosDevice]): the OS grant and each pass's
 * progress reach the screen as events, and what the screen asks of the roll (the
 * system prompt, a pass, free up space, an original back from the gateway) comes
 * back as effects, performed by `PerformScreenEffects`.
 */
internal class PhotosRustHost(private val device: PhotosDevice) {
    private var session: HomeSession? = null
    private var scope: CoroutineScope? = null

    /** The runtime for the core it was built on, or null before there is one. Read by composition. */
    private var screens: Screens? by mutableStateOf(null)
    private var core: CentraidCore? = null
    private var attached: Job? = null

    /** Rust's Photos stack above its root, one per KMP entry, in order. Read by composition. */
    private val opened = mutableStateListOf<Opened>()
    private val gate = Mutex()

    /** What the camera roll last said, replayed to a screen that opens after it. */
    private var grant: PhotosHomeEvent? = null
    private var progress: PhotosHomeEvent? = null
    private val told = mutableSetOf<Long>()

    private class Opened(val entry: Destination.RustScreen, val instance: Long)

    fun handles(destination: Destination): Boolean =
        destination is Destination.RustScreen && destination.route.screen.startsWith(SCREEN_PREFIX)

    fun attach(session: HomeSession, scope: CoroutineScope) {
        this.session = session
        this.scope = scope
        // THE ROLL'S GRANT AND PROGRESS go to every Photos home that is open.
        device.observe { bytes ->
            val event = PhotosHomeEvent.ADAPTER.decode(bytes)
            if (event.permission != null) grant = event else progress = event
            scope.launch { current()?.let { runtime -> homes(runtime).forEach { tell(runtime, it, event) } } }
        }
        ensureScreens()
    }

    @Composable
    fun Global(nav: RouteNav) {
        val stack = nav.stack
        LaunchedEffect(stack) {
            nav.scope.launch {
                gate.withLock {
                    val runtime = ensureScreens() ?: return@withLock
                    reconcile(runtime, nav.stack)
                }
            }
        }
        screens?.let { PerformScreenEffects(it, null, device, TAB) }
    }

    @Composable
    fun Routes(destination: Destination, nav: RouteNav) {
        val entry = destination as? Destination.RustScreen ?: return
        val runtime = screens ?: return
        val instance = opened.firstOrNull { it.entry === entry }?.instance ?: return
        Page(runtime, instance, nav)
    }

    /**
     * THE BACK GESTURE: Collections and Search are destinations of ONE Rust screen,
     * so back returns the screen to its library rather than popping Photos whole.
     * Null pops.
     */
    fun back(stack: NavStack, scope: CoroutineScope): NavStack? {
        val top = stack.current as? Destination.RustScreen ?: return null
        if (!handles(top)) return null
        val runtime = screens ?: return null
        val instance = opened.firstOrNull { it.entry === top }?.instance ?: return null
        val home = runtime.views.value[instance]?.photos_home ?: return null
        if (home.destination == PhotosDestination.PHOTOS_DESTINATION_LIBRARY ||
            home.destination == PhotosDestination.PHOTOS_DESTINATION_UNSPECIFIED
        ) {
            return null
        }
        scope.launch {
            runtime.send(
                instance,
                ScreenEvent(
                    photos_home = PhotosHomeEvent(destination = PhotosDestination.PHOTOS_DESTINATION_LIBRARY),
                ),
            )
        }
        return stack
    }

    private fun current(): Screens? = screens

    /** The Photos home instances Rust holds: the tab's root and every pushed one. */
    private fun homes(runtime: Screens): List<Long> =
        runtime.views.value.filterValues { it.photos_home != null }.keys.toList()

    private suspend fun tell(runtime: Screens, instance: Long, event: PhotosHomeEvent) {
        runtime.send(instance, ScreenEvent(photos_home = event))
    }

    /** The runtime for the foreground vault's core; a new one when the core changed. */
    private fun ensureScreens(): Screens? {
        val live = session?.shelf?.core() ?: return screens
        if (live === core) return screens
        val home = scope ?: return null
        attached?.cancel()
        opened.clear()
        told.clear()
        val next = Screens(live, home)
        core = live
        screens = next
        attached = next.attach()
        home.launch {
            // THE DEVICE'S LOCALE AND ZONE, then the tabs' roots, then any page a
            // previous run of this process left open above them is closed.
            next.environment(Locale.getDefault().toLanguageTag(), TimeZone.getDefault().id)
            next.start()
            next.navigate(NavEvent(pop_to_root = NavPopToRoot(tab = TAB)))
        }
        // A HOME THAT OPENS LATER IS TOLD WHAT THE ROLL ALREADY SAID.
        home.launch {
            next.views.collect { views ->
                views.filterValues { it.photos_home != null }.keys
                    .filter { told.add(it) }
                    .forEach { instance ->
                        grant?.let { tell(next, instance, it) }
                        progress?.let { tell(next, instance, it) }
                    }
            }
        }
        return next
    }

    /**
     * MAKE RUST'S PHOTOS STACK THE KMP STACK'S: the entries both hold, in order,
     * stay; the first that Rust holds and the stack no longer does is popped (with
     * everything above it); each entry the stack holds and Rust does not is pushed.
     * Entries are compared by identity, so the same route pushed twice is two pages.
     */
    private suspend fun reconcile(runtime: Screens, stack: NavStack) {
        val wanted = stack.entries
            .filterIsInstance<Destination.RustScreen>()
            .filter { it.route.screen.startsWith(SCREEN_PREFIX) }
        var kept = 0
        while (kept < opened.size && kept < wanted.size && opened[kept].entry === wanted[kept]) kept++
        if (opened.size > kept) {
            runtime.navigate(NavEvent(popped = NavPopped(tab = TAB, instance = opened[kept].instance)))
            while (opened.size > kept) opened.removeAt(opened.lastIndex)
        }
        for (entry in wanted.drop(kept)) {
            runtime.navigate(NavEvent(push = NavPush(tab = TAB, route = entry.route)))
            val top = runtime.navigation.value?.tabs?.firstOrNull { it.tab == TAB }?.entries?.lastOrNull() ?: return
            opened.add(Opened(entry, top.instance))
        }
    }

    /**
     * ONE PAGE: the top of the stack's view state, drawn by which `ViewState` arm
     * Rust sent. A row's route is pushed.
     */
    @Composable
    private fun Page(runtime: Screens, instance: Long, nav: RouteNav) {
        val views by runtime.views.collectAsState()
        val view = views[instance] ?: return
        val send: (ScreenEvent) -> Unit = { event -> nav.scope.launch { runtime.send(instance, event) } }
        val open: (Route) -> Unit = { route -> nav.push(Destination.RustScreen(route)) }

        val home = view.photos_home
        // EACH PHOTOS SCREEN THAT MOVES TO RUST ADDS ITS ARM HERE.
        when {
            home != null -> PhotosHomeScreen(
                state = home,
                onEvent = { send(ScreenEvent(photos_home = it)) },
                onOpen = open,
                onHome = { nav.home() },
                onResume = { device.opened() },
            )
        }
    }

    private companion object {
        /** Rust's tab for Photos' pages, and the prefix every one of its screens' names carries. */
        const val TAB = "photos"
        const val SCREEN_PREFIX = "photos."
    }
}
