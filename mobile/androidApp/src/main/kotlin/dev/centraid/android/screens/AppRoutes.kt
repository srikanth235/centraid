package dev.centraid.android.screens

import androidx.compose.runtime.Composable
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavStack
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope
import kotlin.reflect.KProperty

/**
 * ONE APP'S ROUTES, AS THE SHELL SEES THEM (K5, shared-constructs §5).
 *
 * `MainActivity` names no app screen. Each app has `screens/<app>/<App>Routes.kt`
 * holding its bridges for the activity's life and drawing its destinations;
 * the activity keeps one list of these and delegates with one line per app —
 * Home's move, the session attach, the back gesture and the destination
 * switch all go through the list. Adding an app is a new file and one list
 * entry, not four edit sites in a 1200-line `when`.
 */
public interface AppRoutes {
    /** Whether [destination] is one of this app's. */
    public fun handles(destination: Destination): Boolean

    /**
     * Where Home's move [moveId] lands, or null when it is not this app's.
     * Side effects that belong to the push (Agenda's "open on today") run here.
     */
    public fun opens(moveId: String): Destination? = null

    /**
     * Put this app's screens on the session's core. Called once, when the
     * session opens: attaching routes a host onto the change stream, and a
     * second route re-reads twice on every commit.
     */
    public fun attach(session: HomeSession, scope: CoroutineScope)

    /**
     * The back gesture over [stack] when this app has its own meaning for it
     * (a band parameter back to its root), or null to pop.
     */
    public fun back(stack: NavStack, scope: CoroutineScope): NavStack? = null

    /** Draw [destination], which [handles] said is this app's. */
    @Composable
    public fun Routes(destination: Destination, nav: RouteNav)
}

/**
 * THE STACK, AS A ROUTE HOLDS IT. Reads are current at call time (a callback
 * fired later sees the stack as it is then), and a route writes it with the
 * same `stack = stack.push(…)` it always did — `var stack by nav`.
 */
public class RouteNav(
    private val read: () -> NavStack,
    private val write: (NavStack) -> Unit,
    /** The composition root's scope: a send launched here outlives the route. */
    public val scope: CoroutineScope,
) {
    public val stack: NavStack get() = read()

    public fun go(next: NavStack) {
        write(next)
    }

    public fun pop() {
        go(stack.pop())
    }

    public fun home() {
        go(NavStack())
    }

    public operator fun getValue(thisRef: Any?, property: KProperty<*>): NavStack = read()

    public operator fun setValue(thisRef: Any?, property: KProperty<*>, value: NavStack) {
        write(value)
    }
}
