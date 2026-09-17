package dev.centraid.shared.shell

import centraid.screen.v1.HomeTile
import centraid.screen.v1.Springboard
import centraid.screen.v1.ThingCount
import centraid.screen.v1.TileBody
import centraid.screen.v1.TileSize
import centraid.screen.v1.TileStatus

/**
 * SPRINGBOARD POLICY — one page's layout law (#1020, wave A).
 *
 * The seam: **it never touches a row.** `HomeMachine` folds arriving tiles;
 * this decides where they sit, which earned the grid, and what the springboard
 * as a whole is doing. The two stay apart because the first grows with the app
 * roster and the second does not, and because a layout law with no renderer in
 * it is a law a test can reach — a grid membership rule inline in a view has no
 * test at any tier (#905).
 *
 * KEEP IT PURE. No coroutines, no clock, no I/O, no platform import — the same
 * contract [ScreenMachine] states, for the same reason.
 */
public object SpringboardPolicy {
    /**
     * The hand-off's tile list, NOT the catalogue's order — the catalogue is the
     * all-apps listing and says nothing about the grid.
     *
     * Freshness decides what is IN a tile; it must never decide where the tile
     * sits. A grid that reordered itself as reads landed would move the target
     * under a member's thumb.
     */
    public val SPRINGBOARD_ORDER: List<String> = listOf(
        "photos",
        "docs",
        "notes",
        "agenda",
        "tasks",
        "people",
        "tally",
        "locker",
    )

    /**
     * The class follows the app's BODY, never its importance: a mosaic needs
     * area, prose needs measure, a figure or a chip needs neither.
     */
    private val TILE_SIZE: Map<String, TileSize> = mapOf(
        "agenda" to TileSize.TILE_SIZE_SMALL,
        "docs" to TileSize.TILE_SIZE_MEDIUM,
        // Notes' body IS the Docs preview body, and the class follows the body.
        "notes" to TileSize.TILE_SIZE_MEDIUM,
        "locker" to TileSize.TILE_SIZE_SMALL,
        "people" to TileSize.TILE_SIZE_SMALL,
        "photos" to TileSize.TILE_SIZE_LARGE,
        "tally" to TileSize.TILE_SIZE_SMALL,
        "tasks" to TileSize.TILE_SIZE_SMALL,
    )

    /** An app with no first-party tile (a gateway app) takes the 1x1. */
    public fun tileSize(appId: String): TileSize =
        TILE_SIZE[appId] ?: TileSize.TILE_SIZE_SMALL

    /** Full width on the two-column phone grid — `MEDIUM` and flattened `LARGE`. */
    public fun isWide(appId: String): Boolean =
        tileSize(appId) != TileSize.TILE_SIZE_SMALL

    /** The phone's springboard is two columns. A parameter, not a constant. */
    public const val MOBILE_COLUMNS: Int = 2

    /**
     * ORDER ONLY, AND ONLY FORWARDS — the packer that closes the holes.
     *
     * Mixed sizes leave a HOLE whenever a 1x1 is followed by a full-width tile:
     * the small takes one of two seats and the wide cannot start beside it, so
     * the row ends half empty. The answer is to pull the next small FORWARD past
     * the wides between them, and never to resize, drop or demote a tile to
     * make a row come out even — a grid that resized tiles to fill
     * itself would let layout overrule the body rule that chose the size. A lone
     * small at the END is not a hole.
     *
     * IT LIVES IN SHARED KOTLIN SO THE TWO SHELLS CANNOT DISAGREE. The first
     * build of wave A packed rows in SwiftUI and let Compose's span logic pack
     * them on Android, which is two packers for one grid; `.gridCellColumns`
     * being silently ignored outside a `Grid` is what made that visible, but the
     * duplication was the defect and one packer is the fix.
     */
    public fun packTiles(
        tiles: List<HomeTile>,
        columns: Int = MOBILE_COLUMNS,
    ): List<HomeTile> {
        val queue = tiles.toMutableList()
        val packed = mutableListOf<HomeTile>()
        while (queue.isNotEmpty()) {
            val next = queue.removeAt(0)
            packed += next
            if (next.wide) continue
            // Fill the rest of this smalls row; skip wides between partners.
            for (seat in 1 until columns) {
                val partner = queue.indexOfFirst { !it.wide }
                if (partner < 0) break
                packed += queue.removeAt(partner)
            }
        }
        return packed
    }

    /**
     * The packed tiles cut into rows, which is what a renderer actually draws.
     *
     * A wide tile is a row of its own; smalls fill up to [columns] seats.
     */
    public fun rows(
        tiles: List<HomeTile>,
        columns: Int = MOBILE_COLUMNS,
    ): List<List<HomeTile>> {
        val packed = packTiles(tiles, columns)
        val out = mutableListOf<List<HomeTile>>()
        var current = mutableListOf<HomeTile>()
        for (tile in packed) {
            if (tile.wide) {
                if (current.isNotEmpty()) { out += current; current = mutableListOf() }
                out += listOf(tile)
                continue
            }
            current += tile
            if (current.size == columns) { out += current; current = mutableListOf() }
        }
        if (current.isNotEmpty()) out += current
        return out
    }

    /**
     * The defensive body for the one case grading leaves: a tile that earned the
     * grid while loading and settled with nothing.
     *
     * Every line is what-to-DO, never what-is-missing ("no photos") — a quiet
     * tile is an invitation, not a failure.
     */
    public val TILE_EMPTY_COPY: Map<String, String> = mapOf(
        "agenda" to "Put something on the calendar",
        "docs" to "Add your first document",
        "locker" to "Unlock to see your items",
        "notes" to "Write your first note",
        "people" to "Add someone you know",
        "photos" to "Back up your first photo",
        "tally" to "Log your first expense",
        "tasks" to "Capture the next thing to do",
    )

    /**
     * May this app be called EMPTY.
     *
     * ONLY A LANDED PULL EARNS `EMPTY`. `lastSyncedAt` is v0's marker for a read
     * that actually completed, and an empty read lacking one is the CLONE
     * missing rather than the vault (v0 `#905` N). Here the same fact arrives as
     * [settled]: a tile whose read has not landed is `UNKNOWN`, and `UNKNOWN` is
     * the honest state — no replica, no grant or a failed read cannot claim to
     * know a vault is empty.
     */
    public fun combineStatus(
        hasContent: Boolean,
        loading: Boolean,
        unreachable: Boolean,
        settled: Boolean,
    ): TileStatus = when {
        hasContent -> TileStatus.TILE_STATUS_CONTENT
        loading -> TileStatus.TILE_STATUS_LOADING
        unreachable -> TileStatus.TILE_STATUS_UNKNOWN
        !settled -> TileStatus.TILE_STATUS_UNKNOWN
        else -> TileStatus.TILE_STATUS_EMPTY
    }

    /**
     * Three different kinds of yes:
     *
     *  - `CONTENT` — it has something.
     *  - `LOADING` — it may, and a read in flight holds its slot at full
     *    geometry: demoting and re-promoting a beat later is a relayout the
     *    member watches.
     *  - Locker — its body is a STATE and not a query result, so it always has
     *    something true to say and is never an invitation to fill it.
     *
     * `EMPTY` and `UNKNOWN` do not earn it.
     */
    public fun earnsGrid(status: TileStatus, body: TileBody?): Boolean {
        if (body?.locker != null) return true
        return status == TileStatus.TILE_STATUS_CONTENT ||
            status == TileStatus.TILE_STATUS_LOADING
    }

    /**
     * Every tile `UNKNOWN` — no replica session, no grant, or every read failed.
     *
     * The whole springboard's verdict and not one app's, which is why it is a
     * separate question from [earnsGrid]: demoting ONE unreadable tile beside
     * readable neighbours is right, demoting them ALL leaves a launcher with no
     * tiles at all.
     */
    public fun everyTileUnreadable(tiles: List<HomeTile>): Boolean =
        tiles.isNotEmpty() && tiles.all { it.status == TileStatus.TILE_STATUS_UNKNOWN }

    /**
     * Which apps the grid shows, and which fall to first moves.
     *
     * This lived inline in v0's `Home.tsx` until `#905` — which is exactly why
     * the defect it contained had no test at any tier, a renderer being the only
     * way to reach it.
     */
    public fun gridMembership(tiles: List<HomeTile>): Membership {
        val unreadable = everyTileUnreadable(tiles)
        val earned = mutableListOf<HomeTile>()
        val idle = mutableListOf<String>()
        for (tile in tiles) {
            if (unreadable || tile.earns_grid) earned += tile else idle += tile.app_id
        }
        return Membership(earned = earned, idleAppIds = idle)
    }

    public data class Membership(
        val earned: List<HomeTile>,
        val idleAppIds: List<String>,
    )

    /**
     * Sums ONLY counts a read actually returned.
     *
     * A withheld count (Locker) is OMITTED and never treated as zero, and a
     * capped count contributes its ceiling — which is why the status line says
     * "at least" when anything is capped. The one number describing the whole
     * vault is assembled from numbers each of which is true.
     */
    public fun countThings(tiles: List<HomeTile>): ThingCount {
        var total = 0
        var capped = false
        var settled = true
        for (tile in tiles) {
            if (tile.status == TileStatus.TILE_STATUS_LOADING) settled = false
            val count = tile.count ?: continue
            total += count.value_
            if (count.capped) capped = true
        }
        return ThingCount(total = total, capped = capped, settled = settled)
    }

    /**
     * Which of the three Homes this is.
     *
     *  - Any content -> the grid; one app having something is enough.
     *  - Else any loading -> loading: day one is a claim about the vault, and an
     *    unsettled read has not earned it.
     *  - Else all `UNKNOWN` -> the grid with empty tiles. We do not KNOW the
     *    vault is empty, so we do not say so.
     *  - Else every tile settled and empty -> first run.
     *
     * Tiles structurally unreadable from Home report `UNKNOWN`, so they never
     * vote the vault empty — but they must not veto a genuine first run either,
     * which is why `UNKNOWN` only wins when nothing loads and nothing has
     * content.
     */
    public fun springboardState(tiles: List<HomeTile>): Springboard {
        if (tiles.isEmpty()) return Springboard.SPRINGBOARD_LOADING
        if (tiles.any { it.status == TileStatus.TILE_STATUS_CONTENT }) {
            return Springboard.SPRINGBOARD_CONTENT
        }
        if (tiles.any { it.status == TileStatus.TILE_STATUS_LOADING }) {
            return Springboard.SPRINGBOARD_LOADING
        }
        val readable = tiles.filterNot { it.status == TileStatus.TILE_STATUS_UNKNOWN }
        if (readable.isEmpty()) return Springboard.SPRINGBOARD_CONTENT
        return Springboard.SPRINGBOARD_FIRST_RUN
    }
}
