package dev.centraid.shared.shell

import centraid.screen.v1.FirstMove
import dev.centraid.design.CentraidCatalog

/**
 * An app failing [SpringboardPolicy.earnsGrid] becomes a FIRST MOVE
 * (#1020).
 *
 * Deliberately absent: dashed placeholder cards. They scale to identical apologies and they open empty apps. Every move
 * here lands somewhere that can TAKE content.
 */
public object FirstMoves {
    /**
     * LEVERAGE ORDER, not springboard order.
     *
     * `connectors` led, because one connection filled several apps at once.
     * There is no connector plane in v0 (#1029 §8; the rows it wrote are on
     * the deletion inventory), and the shell must not lead with a plane that
     * does not exist — so the order now starts with an app a member can
     * actually put something into.
     */
    public val FIRST_MOVE_ORDER: List<String> = listOf(
        "photos",
        "docs",
        "notes",
        "agenda",
        "tasks",
        "people",
        "tally",
        "locker",
    )

    /** Three, not one per empty app: a nudge as tall as its grid is no nudge. */
    public const val LIMIT: Int = 3

    /** The fallback mark for a move whose app the catalogue does not name. */
    private const val FALLBACK_ICON: String = "Plug"

    /**
     * Verb first, and each must land somewhere that can take content.
     *
     * One state, one spelling: v0 kept these in `@centraid/client/home-copy`
     * because desktop and mobile draw the SAME Home in two renderers. That
     * module retired with the v0 tree, so the strings live here — and the same
     * rule applies to the two shells this module now feeds.
     */
    private val COPY: Map<String, Pair<String, String>> = mapOf(
        "photos" to ("Bring in photos" to "The newest ones surface here."),
        "docs" to ("File a document" to "Versioned, restorable, yours."),
        "notes" to ("Write a note" to "The newest one shows up here."),
        "agenda" to ("Add an event" to "Your week, on the front page."),
        "tasks" to ("Add a task" to "The next thing to do."),
        "people" to ("Add someone" to "The people you keep up with."),
        "tally" to ("Log a shared expense" to "Who owes whom, settled."),
        "locker" to ("Save a secret" to "Passwords, behind the lock."),
    )

    /**
     * THE APP'S OWN MARK, from the emitted catalogue — never a second table.
     *
     * v0 read `meta.iconKey` off the app it was nudging toward, for the reason
     * that matters here: a move is an invitation to open a particular app, and
     * a nudge wearing a different glyph from the tile it leads to is two marks
     * for one destination. Every move is an app now that `connectors` is gone,
     * so the fallback is only reached by an id the catalogue does not carry.
     */
    private fun iconFor(id: String): String =
        CentraidCatalog.byId[id]?.iconKey ?: FALLBACK_ICON

    /**
     * The moves offered for a set of idle apps, at most [LIMIT].
     */
    public fun forIdle(idleAppIds: Collection<String>): List<FirstMove> {
        if (idleAppIds.isEmpty()) return emptyList()
        val idle = idleAppIds.toSet()
        val moves = mutableListOf<FirstMove>()
        for (id in FIRST_MOVE_ORDER) {
            if (moves.size >= LIMIT) break
            if (id !in idle) continue
            val copy = COPY[id] ?: continue
            moves += FirstMove(
                id = id,
                label = copy.first,
                hint = copy.second,
                icon_key = iconFor(id),
            )
        }
        return moves
    }
}
