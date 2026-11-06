import XCTest
@testable import CentraidApp

final class TimelineGeometryTests: XCTestCase {
    private let hour: Int64 = 3_600_000

    func testExpandedHourMovesOneHourAndResizeUsesEndAnchor() {
        let grid = TimelineGeometry(duration: 24 * hour, hourOffsets: (0..<24).map { Int64($0) * hour },
                                    spans: [TimelineSpan(start: 9 * hour, end: 10 * hour, minimumHeight: 192)], hourHeight: 64)
        XCTAssertEqual(grid.y(10 * hour) - grid.y(9 * hour), 192, accuracy: 0.001)
        XCTAssertEqual(grid.delta(anchor: 9 * hour, translation: grid.y(10 * hour) - grid.y(9 * hour), stepMinutes: 15), 60)
        XCTAssertEqual(grid.delta(anchor: 10 * hour, translation: grid.y(11 * hour) - grid.y(10 * hour), stepMinutes: 15), 60)
        XCTAssertEqual(grid.delta(anchor: 9 * hour, translation: grid.y(9 * hour - 900_000) - grid.y(9 * hour), stepMinutes: 15), -15)
        XCTAssertEqual(grid.delta(anchor: 12 * hour, translation: grid.y(12 * hour - 450_000) - grid.y(12 * hour), stepMinutes: 15), -15)
        XCTAssertEqual(grid.delta(anchor: 12 * hour, translation: grid.y(12 * hour + 450_000) - grid.y(12 * hour), stepMinutes: 15), 15)
    }

    func testOverlappingBlocksFitFullTextAndKeepTheirBoundaries() {
        let first = TimelineSpan(start: 9 * hour + 900_000, end: 10 * hour + 2_700_000, minimumHeight: 240)
        let second = TimelineSpan(start: 9 * hour + 2_700_000, end: 11 * hour + 900_000, minimumHeight: 300)
        let grid = TimelineGeometry(duration: 24 * hour, hourOffsets: (0..<24).map { Int64($0) * hour }, spans: [first, second], hourHeight: 64)
        XCTAssertGreaterThanOrEqual(grid.y(first.end) - grid.y(first.start), first.minimumHeight - 0.001)
        XCTAssertGreaterThanOrEqual(grid.y(second.end) - grid.y(second.start), second.minimumHeight - 0.001)
        XCTAssertLessThan(grid.y(first.start), grid.y(second.start))
        XCTAssertEqual(grid.delta(anchor: first.start, translation: grid.y(first.start + 1_800_000) - grid.y(first.start), stepMinutes: 15), 30)
    }
}
