package dev.centraid.shared.nav

/**
 * ONE CHANGE TO THE STACK, AS AN APP'S ROUTING DECIDES IT.
 *
 * Most intents push one page, and an `<App>Routing` answers those with a
 * [Destination]. Some do more than push, and the more is the decision: a band
 * place swaps the top entry in place (Notes' Notes · Notebooks · Journal), a
 * finished page pops itself (Money's import Done), a page leaves the entry
 * under it re-spelled before pushing over it (Notes' history over a note that
 * is no longer new). Every one of those is "drop the top or not, then push
 * these", so that is the whole type: there is no second vocabulary of moves
 * for a shell to learn.
 *
 * Android applies it to its [NavStack] ([applying]); iOS, whose stack is a
 * SwiftUI path of its own routes, is handed the same move spelled ([ScreenMove]).
 */
public data class NavMove(
    /** Drop the top entry first. Never Home: the floor stays (`NavStack.pop`). */
    val dropsTop: Boolean = false,
    /** Then push these, in order; the last is the page the member lands on. */
    val pushes: List<Destination> = emptyList(),
) {
    public companion object {
        public fun push(destination: Destination): NavMove = NavMove(pushes = listOf(destination))

        /** In place: the top entry becomes [destination], so back does not walk through it. */
        public fun swap(destination: Destination): NavMove = NavMove(dropsTop = true, pushes = listOf(destination))

        /** The page is done: back to the one under it. */
        public val Pop: NavMove = NavMove(dropsTop = true)
    }
}

/** [move], applied: the top dropped (unless it is the floor), then each push. */
public fun NavStack.applying(move: NavMove): NavStack {
    val kept = if (move.dropsTop && entries.size > 1) entries.dropLast(1) else entries
    return NavStack(kept + move.pushes)
}

/**
 * A [NavMove], SPELLED FOR A SHELL THAT KEYS ITS SCREENS BY ID: drop the top or
 * not, then push each opening ([ScreenOpenings.of] of each destination).
 */
public class ScreenMove(
    public val dropsTop: Boolean,
    public val openings: List<ScreenOpening>,
)

public object ScreenMoves {
    /**
     * [move], spelled; null for no move, or for one that pushes a destination
     * no route spells (half a move would land the member somewhere nobody chose).
     */
    public fun of(move: NavMove?): ScreenMove? {
        if (move == null) return null
        val openings = move.pushes.map { ScreenOpenings.of(it) ?: return null }
        return ScreenMove(move.dropsTop, openings)
    }

    /** A push of [destination], spelled — the shape every push-only routing answers. */
    public fun push(destination: Destination?): ScreenMove? = destination?.let { of(NavMove.push(it)) }
}
