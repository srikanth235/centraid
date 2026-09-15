package dev.centraid.shared.shell

import centraid.screen.v1.FirstMove
import dev.centraid.design.CentraidCatalog

/**
 * An app failing [SpringboardPolicy.earnsGrid] becomes a FIRST MOVE
 * (#1020, wave A; v0 `apps/mobile/src/screens/home/first-moves.ts`).
 *
 * Deliberately absent, and v0 says so in its own words: dashed placeholder
 * cards. They scale to identical apologies and they open empty apps. Every move
 * here lands somewhere that can TAKE content.
 */
public object FirstMoves {
    /**
     * LEVERAGE ORDER, not springboard order.
     *
     * `connectors` leads because one connection fills several apps at once,
     * which no single-app move can do.
     */
    public val FIRST_MOVE_ORDER: List<String> = listOf(
        "connectors",
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

    /** The one move that is not an app. */
    public const val CONNECTORS: String = "connectors"

    private const val CONNECTORS_ICON: String = "Plug"

    /**
     * Verb first, and each must land somewhere that can take content.
     *
     * One state, one spelling: v0 kept these in `@centraid/client/home-copy`
     * because desktop and mobile draw the SAME Home in two renderers. That
     * module retired with the v0 tree, so the strings live here — and the same
     * rule applies to the two shells this module now feeds.
     */
    private val COPY: Map<String, Pair<String, String>> = mapOf(
        CONNECTORS to ("Connect an account" to
            "Mail, calendar and contacts arrive on their own."),
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
     * for one destination. `connectors` is the one move that is not an app, so
     * it is the one entry with an icon of its own.
     */
    private fun iconFor(id: String): String =
        if (id == CONNECTORS) {
            CONNECTORS_ICON
        } else {
            CentraidCatalog.byId[id]?.iconKey ?: CONNECTORS_ICON
        }

    /**
     * The moves offered for a set of idle apps, at most [LIMIT].
     *
     * `connectors` is offered while ANY app is idle, because one connection
     * fills several at once — it is not itself an idle app and would otherwise
     * never appear.
     */
    public fun forIdle(idleAppIds: Collection<String>): List<FirstMove> {
        if (idleAppIds.isEmpty()) return emptyList()
        val idle = idleAppIds.toSet()
        val moves = mutableListOf<FirstMove>()
        for (id in FIRST_MOVE_ORDER) {
            if (moves.size >= LIMIT) break
            if (id != CONNECTORS && id !in idle) continue
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
