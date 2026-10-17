package dev.centraid.shared.apps.photos

import dev.centraid.design.copy.PhotosCopy
import dev.centraid.shared.kit.CappedCount

/**
 * ONE PHOTOGRAPH, AS THE LIBRARY'S LAYOUT SEES IT — primitives only.
 *
 * Swift holds SwiftProtobuf cells and Kotlin holds Wire's, and neither can pass
 * its own to the other, so each shell copies the five fields the layout reads
 * into this and the rules run once. [thumbnailPath] is empty for a photograph
 * with no thumbnail yet.
 */
public class LibraryCell(
    public val assetId: String,
    public val day: String,
    public val video: Boolean,
    public val thumbnailPath: String,
    public val width: Int,
    public val height: Int,
)

/**
 * A DATE IN THE READER'S LOCALE — the one thing the layout cannot say for
 * itself. `CivilWords` spells a day in English from the copy tables; the
 * library has always spelled it the way the device does (`Fri, Aug 14`,
 * `August 2026`), so each shell supplies that and nothing else.
 *
 * The day is already the capture-local civil day, so an implementation formats
 * it at noon UTC in UTC and no zone can move it.
 */
public interface LibraryTitles {
    /** `August 2026`. */
    public fun month(year: Int, month: Int): String

    /** `Fri, Aug 14`, with the year when [withYear] — it is not this one. */
    public fun day(year: Int, month: Int, day: Int, withYear: Boolean): String
}

/** What a [TimelineRow] is. */
public enum class TimelineRowKind { MONTH, DAY, TILES }

/**
 * One row of the All grain. [id] is what a scroll position reports and what a
 * grain switch lands on, so it carries the day it belongs to.
 */
public class TimelineRow(
    public val kind: TimelineRowKind,
    public val id: String,
    public val day: String,
    /** A month's name or a day's; empty on a row of tiles. */
    public val title: String,
    /** The asset ids under a day header, for its "Select"; empty otherwise. */
    public val ids: List<String>,
    /** The packed tiles, indexed into the cells the rows were built from. */
    public val tiles: List<PackedTile>,
)

/** One Years or Months card: the prefix key, its name, its tally, its cover. */
public class LibraryPeriod(
    public val key: String,
    public val title: String,
    public val count: String,
    /** The newest photograph's thumbnail, or empty when none has one. */
    public val coverPath: String,
    public val anchorDay: String,
)

/** One item of a grain's list: a year header, a year card, or a pair of months. */
public class GrainItem(
    public val key: String,
    /** A year header's text; empty on a card or a pair. */
    public val header: String,
    public val periods: List<LibraryPeriod>,
)

/**
 * THE LIBRARY'S LAYOUT RULES, ONCE (#1029, photos port — v0's
 * `timeline-rows.ts` and `PhotoGrainView.tsx`).
 *
 * Which rows the cells pack into, where a month or a day header goes, which
 * cards a grain draws and how months pair up were written in both shells and
 * agreed only by being kept in step by hand. They are arithmetic over a width
 * and a list, so they live here; what is left to each shell is the drawing and
 * the date's spelling in the device's locale ([LibraryTitles]).
 *
 * The cells arrive newest first and already grouped by the read's order, so a
 * section is a run of equal `day`s and NOTHING IS RE-SORTED: a re-sort would
 * make this a different library from the one the lightbox walks.
 */
public object PhotosLibraryLayout {
    /** The key of the undated tail, which has one header and no day under it. */
    public const val UNDATED: String = "undated"

    /** A month header's height. */
    public const val MONTH_ROW: Int = 46

    /** A day header's height. */
    public const val DAY_ROW: Int = 34

    /** The scrub rail's width, and the thumb's height. */
    public const val RAIL_WIDTH: Int = 44
    public const val THUMB: Int = 44

    /** The rail's clearance from the top and bottom of what the member can see. */
    public const val RAIL_INSET: Int = 8

    /** The rail appears only for a library at least this many rows long. */
    public const val RAIL_MIN_ROWS: Int = 12

    /** A year card's cover height, as a share of the stage's width. */
    public const val YEAR_COVER_RATIO: Double = 0.72

    /** The gutter between the two month cards of a row, and a card's foot. */
    public const val CARD_GUTTER: Int = 8
    public const val CARD_BOTTOM: Int = 20

    /** THE MONTH A DAY BELONGS TO: its `YYYY-MM`, or [UNDATED] for no day. */
    public fun monthKey(day: String): String = if (day.isEmpty()) UNDATED else day.take(MONTH_LENGTH)

    /** `August 2026`, or "Undated" for the tail. */
    public fun monthTitle(monthKey: String, titles: LibraryTitles): String {
        if (monthKey == UNDATED) return PhotosCopy.PHOTOS_UNDATED
        val parts = monthKey.split('-').mapNotNull { it.toIntOrNull() }
        return if (parts.size == 2) titles.month(parts[0], parts[1]) else monthKey
    }

    private fun dayTitle(day: String, currentYear: Int, titles: LibraryTitles): String {
        val parts = day.split('-').mapNotNull { it.toIntOrNull() }
        return if (parts.size == 3) titles.day(parts[0], parts[1], parts[2], parts[0] != currentYear) else day
    }

    /**
     * CELLS INTO ROWS (v0's `buildRows`): a month header where the month
     * changes, a day header per day, then the day's cells justified at the
     * rung's height.
     *
     * THE UNDATED TAIL HAS ONE HEADER, "Undated", and no day under it — a day
     * header reading "Undated" beneath a month header reading "Undated" is the
     * same word twice.
     */
    public fun rows(
        cells: List<LibraryCell>,
        width: Double,
        rung: Int,
        currentYear: Int,
        titles: LibraryTitles,
    ): List<TimelineRow> {
        val target = PhotosTimeline.RUNG_HEIGHTS[PhotosTimeline.clampRung(rung)].toDouble()
        val rows = mutableListOf<TimelineRow>()
        var month: String? = null
        var start = 0
        while (start < cells.size) {
            val day = cells[start].day
            var end = start
            while (end < cells.size && cells[end].day == day) end += 1
            val monthKey = monthKey(day)
            if (monthKey != month) {
                month = monthKey
                rows += TimelineRow(
                    kind = TimelineRowKind.MONTH,
                    id = "m:$monthKey",
                    day = day,
                    title = monthTitle(monthKey, titles),
                    ids = emptyList(),
                    tiles = emptyList(),
                )
            }
            if (day.isNotEmpty()) {
                rows += TimelineRow(
                    kind = TimelineRowKind.DAY,
                    id = "d:$day",
                    day = day,
                    title = dayTitle(day, currentYear, titles),
                    ids = cells.subList(start, end).map { it.assetId },
                    tiles = emptyList(),
                )
            }
            val section = cells.subList(start, end)
            PhotoJustify.rows(section.map { PhotoBox(it.width, it.height) }, width, target)
                .forEachIndexed { index, tiles ->
                    rows += TimelineRow(
                        kind = TimelineRowKind.TILES,
                        id = "r:$day:$index",
                        day = day,
                        title = "",
                        ids = emptyList(),
                        // THE PACKER NAMES TILES WITHIN THE DAY; the library names them within the cells.
                        tiles = tiles.map { PackedTile(start + it.index, it.width, it.height) },
                    )
                }
            start = end
        }
        return rows
    }

    /**
     * PERIODS FROM CELLS (v0's `buildPeriods`), in the cells' own newest-first
     * order and never re-sorted. COVER = NEWEST: this vault has none of the
     * signals a key photograph is picked by, and a card must land on the
     * photograph at the top of that period in All. Undated photographs are in
     * All only — "sometime" is not a stretch of time.
     */
    public fun periods(cells: List<LibraryCell>, years: Boolean, titles: LibraryTitles): List<LibraryPeriod> {
        val width = if (years) YEAR_LENGTH else MONTH_LENGTH
        val order = mutableListOf<String>()
        val grouped = mutableMapOf<String, MutableList<LibraryCell>>()
        cells.forEach { cell ->
            if (cell.day.isEmpty()) return@forEach
            val key = cell.day.take(width)
            grouped.getOrPut(key) { order += key; mutableListOf() } += cell
        }
        return order.map { key ->
            val group = grouped.getValue(key)
            LibraryPeriod(
                key = key,
                title = if (years) key else monthTitle(key, titles),
                count = describeCounts(group),
                coverPath = (group.firstOrNull { it.thumbnailPath.isNotEmpty() } ?: group.first()).thumbnailPath,
                anchorDay = group.first().day,
            )
        }
    }

    /**
     * What a grain's list holds. Years: a card each. Months: two to a row,
     * PAIRED WITHIN A YEAR — December beside the previous January under a
     * heading true of only half is what this prevents — with a year header
     * only when the library spans more than one year. An odd month leaves its
     * column empty: a wider card would read as a bigger month. A pair's key is
     * its first month's.
     */
    public fun grainItems(periods: List<LibraryPeriod>, years: Boolean): List<GrainItem> {
        if (years) return periods.map { GrainItem("y:${it.key}", "", listOf(it)) }
        val spansYears = periods.map { it.key.take(YEAR_LENGTH) }.distinct().size > 1
        val items = mutableListOf<GrainItem>()
        periods.groupBy { it.key.take(YEAR_LENGTH) }.forEach { (year, months) ->
            if (spansYears) items += GrainItem("h:$year", year, emptyList())
            months.chunked(2).forEach { pair -> items += GrainItem("p:${pair.first().key}", "", pair) }
        }
        return items
    }

    /** The index of the item holding [day], or -1: a period's key is a prefix of every day in it. */
    public fun grainItemIndex(items: List<GrainItem>, day: String): Int =
        items.indexOfFirst { item -> item.periods.any { day.startsWith(it.key) } }

    /**
     * THE DAY BEHIND A SCROLL TARGET'S ID — a row's own day, or a card's newest
     * loaded day among [days] — so a grain switch lands where the member was.
     * The ids are the ones [rows] and [grainItems] mint.
     */
    public fun dayOfId(id: String?, days: List<String>): String {
        if (id == null || id.length < ID_PREFIX) return ""
        val body = id.drop(ID_PREFIX)
        return when (id.take(ID_PREFIX)) {
            "d:" -> body
            "r:" -> body.substringBefore(':')
            "y:", "p:" -> days.firstOrNull { it.isNotEmpty() && it.startsWith(body) } ?: ""
            else -> ""
        }
    }

    /** `3 photos · 1 video` — v0's `describeCounts`, one wording on every grain. */
    private fun describeCounts(cells: List<LibraryCell>): String {
        val videos = cells.count { it.video }
        val photographs = cells.size - videos
        val parts = buildList {
            if (photographs > 0) {
                add(CappedCount.phrase(photographs.toLong(), false, PhotosCopy.TILE_COUNT_ONE, PhotosCopy.TILE_COUNT_MANY))
            }
            if (videos > 0) {
                add(CappedCount.phrase(videos.toLong(), false, PhotosCopy.PHOTOS_VIDEO_ONE, PhotosCopy.PHOTOS_VIDEO_MANY))
            }
        }
        return parts.joinToString(" · ")
            .ifEmpty { CappedCount.phrase(0, false, PhotosCopy.TILE_COUNT_ONE, PhotosCopy.TILE_COUNT_MANY) }
    }

    private const val YEAR_LENGTH: Int = 4
    private const val MONTH_LENGTH: Int = 7
    private const val ID_PREFIX: Int = 2
}
