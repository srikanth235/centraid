package dev.centraid.shared.nav

import centraid.core.v1.Route

/**
 * WHERE THE SHARED SIDE POINTS A SHELL (#1135).
 *
 * The navigation model is Rust's: the stack, the tabs and the band live in
 * `crates/screens` and the shells draw `Navigation`. What remains is the one
 * thing the chat's cards (until lane I's chat is Rust's) still spell on this
 * side: a destination that is a [Route] Rust understands. Home, search and every
 * app's rows carry the route they open; they are not built here.
 */
public sealed interface Destination {
    /**
     * A screen Rust owns, drawn from its view state. Pushing it sends `NavPush`
     * to the runtime; popping it, `NavPopped`.
     */
    public data class RustScreen(val route: Route) : Destination
}
