package dev.centraid.shared

import centraid.screen.v1.PhotosGridState
import centraid.screen.v1.PlaceRow
import centraid.screen.v1.PlacesData
import dev.centraid.shared.apps.photos.LibraryCell
import dev.centraid.shared.apps.photos.TimelineRowKind
import dev.centraid.shared.apps.photos.LibraryTitles
import dev.centraid.shared.apps.photos.PhotoBox
import dev.centraid.shared.apps.photos.PhotoJustify
import dev.centraid.shared.apps.photos.PhotosLibraryLayout
import dev.centraid.shared.apps.photos.PhotosTimeline
import dev.centraid.shared.apps.photos.PlacesMachine
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe

/**
 * THE LIBRARY'S LAYOUT RULES, WRITTEN ONCE (#1029, photos port): the justified
 * packing, the rows and cards over a width, and the pinch table's numbers.
 *
 * Both shells used to hold their own copy of each and agree by being kept in
 * step by hand. These are the numbers they both must now produce, so a change
 * to a rule is one edit and one red here rather than two edits and a visual
 * difference nobody sees until a device.
 */
class PhotosLibraryLayoutSpec : StringSpec({

    /** The titles a test can read: no locale, so the spec is the same everywhere. */
    val titles = object : LibraryTitles {
        override fun month(year: Int, month: Int): String = "M$year-$month"
        override fun day(year: Int, month: Int, day: Int, withYear: Boolean): String =
            "D$month-$day" + if (withYear) "/$year" else ""
    }

    fun cell(id: String, day: String, width: Int = 1500, height: Int = 1000, video: Boolean = false, thumb: String = "") =
        LibraryCell(assetId = id, day = day, video = video, thumbnailPath = thumb, width = width, height = height)

    "a full row fills the width to the point, folding its remainder into the last tile" {
        val rows = PhotoJustify.rows(List(4) { PhotoBox(3, 2) }, 400.0, 120.0)
        // 2.5 photographs of 120 high is not 400 wide; the third closes the row.
        rows.first().map { it.index } shouldBe listOf(0, 1, 2)
        rows.first().sumOf { it.width } + PhotoJustify.GAP * 2 shouldBe 400.0
        rows.first().map { it.height }.distinct().size shouldBe 1
    }

    "the trailing row keeps its natural height, capped at 1.25 times the target" {
        val rows = PhotoJustify.rows(listOf(PhotoBox(1000, 1000)), 400.0, 100.0)
        rows.size shouldBe 1
        // One square photograph could fill 400 wide; it stays 125 high instead.
        rows.single().single().height shouldBe 125.0
        rows.single().single().width shouldBe 125.0
    }

    "an unknown box packs square, and a zero width packs nothing" {
        val rows = PhotoJustify.rows(listOf(PhotoBox(0, 0), PhotoBox(1, 1)), 200.0, 100.0)
        rows.flatten().map { it.width / it.height } shouldBe listOf(1.0, 1.0)
        PhotoJustify.rows(listOf(PhotoBox(1, 1)), 0.0, 100.0) shouldBe emptyList()
        PhotoJustify.rows(listOf(PhotoBox(1, 1)), 100.0, 0.0) shouldBe emptyList()
    }

    "the skeleton rounds both halves of its count up, and every row is as wide as the container" {
        val rows = PhotoJustify.skeleton(300.0, 100.0, 400.0)
        // perRow = 3 + 1, rowCount = 4 + 1: twenty placeholders, packed.
        rows.sumOf { it.size } shouldBe 20
        rows.dropLast(1).forEach { row ->
            row.sumOf { it.width } + PhotoJustify.GAP * (row.size - 1) shouldBe 300.0
        }
    }

    "rows put a month header where the month changes, a day header per day, then the tiles" {
        val cells = listOf(
            cell("a", "2026-08-14"),
            cell("b", "2026-08-14"),
            cell("c", "2026-07-30"),
            cell("d", ""),
        )
        val rows = PhotosLibraryLayout.rows(cells, 300.0, PhotosTimeline.DEFAULT_RUNG, 2026, titles)
        rows.map { it.id } shouldBe listOf(
            "m:2026-08", "d:2026-08-14", "r:2026-08-14:0",
            "m:2026-07", "d:2026-07-30", "r:2026-07-30:0",
            "m:undated", "r::0",
        )
        rows[0].title shouldBe "M2026-8"
        // THIS YEAR'S DAYS CARRY NO YEAR.
        rows[1].title shouldBe "D8-14"
        rows[1].ids shouldBe listOf("a", "b")
        // THE UNDATED TAIL HAS ONE HEADER and no day under it.
        rows[6].kind shouldBe TimelineRowKind.MONTH
        rows[6].title shouldBe "Undated"
        rows.none { it.kind == TimelineRowKind.DAY && it.day.isEmpty() } shouldBe true
        // TILES NAME THEIR CELL BY ITS PLACE IN THE WHOLE LIST, not in the day.
        rows[5].tiles.map { it.index } shouldBe listOf(2)
        rows[7].tiles.map { it.index } shouldBe listOf(3)
    }

    "another year's day carries its year" {
        val rows = PhotosLibraryLayout.rows(listOf(cell("a", "2025-01-02")), 300.0, 0, 2026, titles)
        rows[1].title shouldBe "D1-2/2025"
    }

    "a rung past the table is clamped, not an error" {
        val rows = PhotosLibraryLayout.rows(listOf(cell("a", "2026-08-14")), 1000.0, 99, 2026, titles)
        // The largest rung is 168, and a lone trailing photograph stops at 1.25 times it.
        rows.last().tiles.single().height shouldBe 210.0
    }

    "periods keep the cells' order, cover with the newest thumbnail, and leave the undated out" {
        val cells = listOf(
            cell("a", "2026-08-14", video = true),
            cell("b", "2026-08-02", thumb = "t/b"),
            cell("c", "2026-07-30"),
            cell("d", "2025-12-31", thumb = "t/d"),
            cell("e", ""),
        )
        val months = PhotosLibraryLayout.periods(cells, years = false, titles = titles)
        months.map { it.key } shouldBe listOf("2026-08", "2026-07", "2025-12")
        months[0].title shouldBe "M2026-8"
        months[0].coverPath shouldBe "t/b"
        months[0].anchorDay shouldBe "2026-08-14"
        months[0].count shouldBe "1 photo · 1 video"
        val years = PhotosLibraryLayout.periods(cells, years = true, titles = titles)
        years.map { it.title } shouldBe listOf("2026", "2025")
    }

    "months pair within a year, and a year header appears only when the library spans two" {
        val cells = listOf("2026-08-14", "2026-07-30", "2026-05-01", "2025-12-31", "2025-01-01").map { cell(it, it) }
        val periods = PhotosLibraryLayout.periods(cells, years = false, titles = titles)
        val items = PhotosLibraryLayout.grainItems(periods, years = false)
        items.map { it.key } shouldBe listOf("h:2026", "p:2026-08", "p:2026-05", "h:2025", "p:2025-12")
        items.map { it.periods.size } shouldBe listOf(0, 2, 1, 0, 2)
        PhotosLibraryLayout.grainItems(periods.take(3), years = false).map { it.key } shouldBe
            listOf("p:2026-08", "p:2026-05")
        PhotosLibraryLayout.grainItems(PhotosLibraryLayout.periods(cells, true, titles), true).map { it.key } shouldBe
            listOf("y:2026", "y:2025")
        PhotosLibraryLayout.grainItemIndex(items, "2026-05-01") shouldBe 2
        PhotosLibraryLayout.grainItemIndex(items, "2024-01-01") shouldBe -1
    }

    "a scroll target's id names its day" {
        val days = listOf("2026-08-14", "2026-07-30")
        PhotosLibraryLayout.dayOfId("d:2026-08-14", days) shouldBe "2026-08-14"
        PhotosLibraryLayout.dayOfId("r:2026-08-14:3", days) shouldBe "2026-08-14"
        PhotosLibraryLayout.dayOfId("r::0", days) shouldBe ""
        PhotosLibraryLayout.dayOfId("p:2026-07", days) shouldBe "2026-07-30"
        PhotosLibraryLayout.dayOfId("y:2026", days) shouldBe "2026-08-14"
        PhotosLibraryLayout.dayOfId("m:2026-08", days) shouldBe ""
        PhotosLibraryLayout.dayOfId(null, days) shouldBe ""
    }

    "a pinch is a rung step inside All and a grain past its ends, by proto number" {
        val all = PhotosGridState.Grain.GRAIN_ALL.value
        val months = PhotosGridState.Grain.GRAIN_MONTHS.value
        PhotosTimeline.pinchNumbers(all, 2, 1.3f).let { (it.grain to it.rung) shouldBe (all to 3) }
        PhotosTimeline.pinchNumbers(all, 3, 1.3f).let { (it.grain to it.rung) shouldBe (all to 3) }
        PhotosTimeline.pinchNumbers(all, 0, 0.5f).let { (it.grain to it.rung) shouldBe (months to 0) }
        PhotosTimeline.pinchNumbers(all, 2, 1.0f).let { (it.grain to it.rung) shouldBe (all to 2) }
        // The unspecified grain is All, as the library draws it.
        PhotosTimeline.pinchNumbers(0, 1, 0.5f).let { (it.grain to it.rung) shouldBe (all to 0) }
        PhotosTimeline.pinch(PhotosGridState.Grain.GRAIN_MONTHS, 1, 1.3f).grain shouldBe PhotosGridState.Grain.GRAIN_ALL
    }

    "a place's pin stands in the state, sized by the square root of its count" {
        val data = PlacesData(
            places = listOf(
                PlaceRow(place_id = "big", asset_count = 100, latitude = 40.0, longitude = -120.0, has_coordinate = true),
                PlaceRow(place_id = "small", asset_count = 25, latitude = 30.0, longitude = -110.0, has_coordinate = true),
                PlaceRow(place_id = "nowhere", asset_count = 9),
            ),
        )
        val plotted = PlacesMachine.withPlot(data).places.associateBy { it.place_id }
        plotted.getValue("big").pin_y shouldBe 0.0
        plotted.getValue("small").pin_y shouldBe 1.0
        plotted.getValue("big").pin_size shouldBe PlacesMachine.PIN_CEILING.toDouble()
        // sqrt(25) / sqrt(100) = half the way from the floor to the ceiling.
        plotted.getValue("small").pin_size shouldBe 52.0
        // A row with no pin is left as it was: it is not on the plate.
        plotted.getValue("nowhere").pin_size shouldBe 0.0
    }
})
