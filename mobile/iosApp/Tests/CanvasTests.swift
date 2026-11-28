import CoreGraphics
import XCTest
@testable import CentraidApp

final class CanvasTests: XCTestCase {
    // MARK: - ChartCanvasView

    func testChartLayoutEmptyState() {
        var chart = Centraid_Core_V1_RoomChart()
        chart.selectorID = "chart-empty"
        chart.emptySentence = "No readings yet."

        let layout = ChartLayout.build(from: chart)
        XCTAssertFalse(layout.hasData)
        XCTAssertTrue(layout.entries.isEmpty)
        XCTAssertTrue(layout.barRects.isEmpty)
        XCTAssertEqual(
            ChartLayout.spokenSummary(summary: chart.summary, emptySentence: chart.emptySentence, activeEntry: nil),
            "No readings yet."
        )
    }

    func testChartLayoutStackedAndGroupedBars() {
        var p1 = Centraid_Core_V1_RoomChartPoint()
        p1.id = "s1-d1"
        p1.x = 1
        p1.y = 40
        p1.xLabel = "Mon"
        p1.yLabel = "40"

        var p2 = Centraid_Core_V1_RoomChartPoint()
        p2.id = "s2-d1"
        p2.x = 1
        p2.y = 30
        p2.xLabel = "Mon"
        p2.yLabel = "30"

        var p3 = Centraid_Core_V1_RoomChartPoint()
        p3.id = "s3-d1"
        p3.x = 1
        p3.y = 50
        p3.xLabel = "Mon"
        p3.yLabel = "50"

        var s1 = Centraid_Core_V1_RoomChartSeries()
        s1.id = "food"
        s1.label = "Food"
        s1.mark = .bar
        s1.stack = "spend"
        s1.points = [p1]

        var s2 = Centraid_Core_V1_RoomChartSeries()
        s2.id = "travel"
        s2.label = "Travel"
        s2.mark = .bar
        s2.stack = "spend"
        s2.points = [p2]

        var s3 = Centraid_Core_V1_RoomChartSeries()
        s3.id = "income"
        s3.label = "Income"
        s3.mark = .bar
        s3.points = [p3]

        var chart = Centraid_Core_V1_RoomChart()
        chart.selectorID = "money-chart"
        chart.summary = "Weekly spending"
        chart.series = [s1, s2, s3]

        let layout = ChartLayout.build(from: chart)
        XCTAssertTrue(layout.hasData)
        XCTAssertTrue(layout.domain.hasBars)
        XCTAssertEqual(layout.domain.yMin, 0, accuracy: 0.001)
        XCTAssertGreaterThanOrEqual(layout.domain.yMax, 70)
        XCTAssertEqual(layout.legendItems.count, 3)

        XCTAssertEqual(layout.barRects.count, 3)
        XCTAssertEqual(layout.barRects[0].slotCount, 2)
        XCTAssertEqual(layout.barRects[0].slotIndex, 0)
        XCTAssertEqual(layout.barRects[1].slotIndex, 0)
        XCTAssertEqual(layout.barRects[1].yBase, 40, accuracy: 0.001)
        XCTAssertEqual(layout.barRects[1].yTop, 70, accuracy: 0.001)
        XCTAssertEqual(layout.barRects[2].slotIndex, 1)

        let active = layout.activeEntry(for: "s2-d1")
        XCTAssertEqual(active?.yDisplay ?? 0, 70, accuracy: 0.001)
        XCTAssertEqual(active.map(ChartLayout.readoutLabel(for:)), "Mon · 30")
    }

    func testChartLayoutRangeBandAndScrubHitTesting() {
        var pt1 = Centraid_Core_V1_RoomChartPoint()
        pt1.id = "day-1"
        pt1.x = 0
        pt1.y = 62
        pt1.yLow = 55
        pt1.yHigh = 72
        pt1.xLabel = "Mon"
        pt1.yLabel = "62 bpm"

        var pt2 = Centraid_Core_V1_RoomChartPoint()
        pt2.id = "day-2"
        pt2.x = 1
        pt2.y = 68
        pt2.yLow = 58
        pt2.yHigh = 78
        pt2.xLabel = "Tue"
        pt2.yLabel = "68 bpm"

        var pt3 = Centraid_Core_V1_RoomChartPoint()
        pt3.id = "day-3"
        pt3.x = 2
        pt3.y = 60
        pt3.yLow = 52
        pt3.yHigh = 70
        pt3.xLabel = "Wed"
        pt3.yLabel = "60 bpm"

        var series = Centraid_Core_V1_RoomChartSeries()
        series.id = "hr"
        series.mark = .line
        series.points = [pt1, pt2, pt3]

        var chart = Centraid_Core_V1_RoomChart()
        chart.selectorID = "health-hr"
        chart.summary = "Heart rate trend"
        chart.series = [series]

        let layout = ChartLayout.build(from: chart)
        XCTAssertLessThanOrEqual(layout.domain.yMin, 52)
        XCTAssertGreaterThanOrEqual(layout.domain.yMax, 78)

        let plotSize = CGSize(width: 300, height: 196)
        XCTAssertEqual(layout.nearestPointID(at: CGPoint(x: 12, y: 100), in: plotSize), "day-1")
        XCTAssertEqual(layout.nearestPointID(at: CGPoint(x: 150, y: 100), in: plotSize), "day-2")
        XCTAssertEqual(layout.nearestPointID(at: CGPoint(x: 290, y: 100), in: plotSize), "day-3")

        let active = layout.activeEntry(for: "day-2")
        XCTAssertEqual(
            ChartLayout.spokenSummary(summary: chart.summary, emptySentence: "", activeEntry: active),
            "Heart rate trend. Tue · 68 bpm"
        )
    }

    // MARK: - CalendarGridCanvasView

    func testCalendarGridLaneAssignment() {
        var a = Centraid_Core_V1_RoomCalendarItem()
        a.selectorID = "ev-a"
        a.startMinute = 540
        a.endMinute = 600

        var b = Centraid_Core_V1_RoomCalendarItem()
        b.selectorID = "ev-b"
        b.startMinute = 570
        b.endMinute = 660

        var c = Centraid_Core_V1_RoomCalendarItem()
        c.selectorID = "ev-c"
        c.startMinute = 600
        c.endMinute = 660

        var d = Centraid_Core_V1_RoomCalendarItem()
        d.selectorID = "ev-d"
        d.startMinute = 720
        d.endMinute = 780

        var allDay = Centraid_Core_V1_RoomCalendarItem()
        allDay.selectorID = "ev-all"
        allDay.allDay = true

        let placements = CalendarGridMath.assignLanes([d, b, allDay, c, a])
        XCTAssertEqual(placements.count, 4)

        let byID = Dictionary(uniqueKeysWithValues: placements.map { ($0.id, $0) })
        XCTAssertEqual(byID["ev-a"]?.lane, 0)
        XCTAssertEqual(byID["ev-a"]?.laneCount, 2)
        XCTAssertEqual(byID["ev-b"]?.lane, 1)
        XCTAssertEqual(byID["ev-b"]?.laneCount, 2)
        XCTAssertEqual(byID["ev-c"]?.lane, 0)
        XCTAssertEqual(byID["ev-c"]?.laneCount, 2)
        XCTAssertEqual(byID["ev-d"]?.lane, 0)
        XCTAssertEqual(byID["ev-d"]?.laneCount, 1)
    }

    func testCalendarGridSnapMinuteAndMonthGrouping() {
        XCTAssertEqual(CalendarGridMath.snapMinute(-10), 0)
        XCTAssertEqual(CalendarGridMath.snapMinute(68), 75)
        XCTAssertEqual(CalendarGridMath.snapMinute(1438), 1425)

        var d1 = Centraid_Core_V1_RoomCalendarDay()
        d1.day = "2026-11-01"
        d1.label = "1"
        var d2 = Centraid_Core_V1_RoomCalendarDay()
        d2.day = "2026-11-02"
        d2.label = "2"
        var d3 = Centraid_Core_V1_RoomCalendarDay()
        d3.day = "2026-12-01"
        d3.label = "1"

        let groups = CalendarGridMath.groupDaysByMonth([d1, d2, d3])
        XCTAssertEqual(groups.map(\.monthKey), ["2026-11", "2026-12"])
        XCTAssertEqual(groups[0].days.count, 2)
        XCTAssertEqual(groups[1].days.count, 1)
    }

    func testCalendarDayLayoutSeparatesOverdueOnlyOnToday() {
        var overdueTask = Centraid_Core_V1_RoomCalendarItem()
        overdueTask.selectorID = "t-over"
        overdueTask.kind = .task
        overdueTask.overdue = true
        overdueTask.done = false

        var doneOverdue = Centraid_Core_V1_RoomCalendarItem()
        doneOverdue.selectorID = "t-done"
        doneOverdue.kind = .task
        doneOverdue.overdue = true
        doneOverdue.done = true
        doneOverdue.allDay = true

        var today = Centraid_Core_V1_RoomCalendarDay()
        today.day = "2026-11-26"
        today.today = true
        today.items = [overdueTask, doneOverdue]

        var tomorrow = Centraid_Core_V1_RoomCalendarDay()
        tomorrow.day = "2026-11-27"
        tomorrow.today = false
        tomorrow.items = [overdueTask]

        let layouts = CalendarGridMath.buildDayLayouts(from: [today, tomorrow])
        XCTAssertEqual(layouts[0].overdueItems.map(\.selectorID), ["t-over"])
        XCTAssertEqual(layouts[0].allDayItems.map(\.selectorID), ["t-done"])
        XCTAssertTrue(layouts[1].overdueItems.isEmpty)
    }

    // MARK: - NoteEditorCanvasView

    func testNoteEditorSyncPreventsCaretJump() {
        var sync = NoteEditorSync()
        XCTAssertTrue(
            sync.shouldAdopt(
                remoteTitle: "Trip",
                remoteBody: "Lisbon",
                remoteRev: 0,
                localTitle: "",
                localBody: ""
            )
        )

        let seq1 = sync.nextSeq()
        let seq2 = sync.nextSeq()
        XCTAssertEqual(seq1, 1)
        XCTAssertEqual(seq2, 2)

        XCTAssertFalse(
            sync.shouldAdopt(
                remoteTitle: "Trip",
                remoteBody: "Lisb",
                remoteRev: 1,
                localTitle: "Trip",
                localBody: "Lisbon"
            )
        )
        XCTAssertFalse(
            sync.shouldAdopt(
                remoteTitle: "Trip",
                remoteBody: "Lisbon",
                remoteRev: 2,
                localTitle: "Trip",
                localBody: "Lisbon"
            )
        )
        XCTAssertTrue(
            sync.shouldAdopt(
                remoteTitle: "Trip",
                remoteBody: "Lisbon [[Packing]]",
                remoteRev: 2,
                localTitle: "Trip",
                localBody: "Lisbon [[Pac"
            )
        )
    }

    func testNoteTriggerDetector() {
        XCTAssertEqual(
            NoteTriggerDetector.detect(in: "See [[Lisbon"),
            NoteTriggerDetector.Match(trigger: "[[", query: "Lisbon")
        )
        XCTAssertNil(NoteTriggerDetector.detect(in: "See [[Lisbon]] today"))
        XCTAssertEqual(
            NoteTriggerDetector.detect(in: "Ask @Ana"),
            NoteTriggerDetector.Match(trigger: "@", query: "Ana")
        )
        XCTAssertEqual(
            NoteTriggerDetector.detect(in: "@"),
            NoteTriggerDetector.Match(trigger: "@", query: "")
        )
        XCTAssertNil(NoteTriggerDetector.detect(in: "Email ana@example.com"))
        XCTAssertNil(NoteTriggerDetector.detect(in: "Ask @Ana\nNext line"))
    }

    func testNoteMarkdownFormatActions() {
        XCTAssertEqual(NoteMarkdownFormat.apply(.heading, to: ""), "# ")
        XCTAssertEqual(NoteMarkdownFormat.apply(.checklist, to: "Intro"), "Intro\n- [ ] ")
        XCTAssertEqual(NoteMarkdownFormat.apply(.bullet, to: "Line\n"), "Line\n- ")
        XCTAssertEqual(NoteMarkdownFormat.apply(.bold, to: ""), "**text**")
        XCTAssertEqual(NoteMarkdownFormat.apply(.italic, to: ""), "*text*")
        XCTAssertEqual(NoteMarkdownFormat.apply(.code, to: ""), "`code`")
        XCTAssertEqual(NoteMarkdownFormat.apply(.wikilink, to: "See "), "See [[")
        XCTAssertEqual(NoteMarkdownFormat.apply(.mention, to: "Ask"), "Ask @")
        XCTAssertEqual(NoteMarkdownFormat.apply(.mention, to: "Ask "), "Ask @")
    }
}
