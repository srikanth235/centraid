import XCTest

@testable import CentraidApp

/// A player's time as `m:ss`: the shared module's `MediaFormatSpec` clock cases,
/// kept with the Swift type they became (#1135).
final class MediaClockTests: XCTestCase {
    func testALengthReadsMinutesAndSecondsAndHoursPastTheHour() {
        XCTAssertEqual(MediaClock.of(seconds: Int64(0)), "0:00")
        XCTAssertEqual(MediaClock.of(seconds: Int64(4)), "0:04")
        XCTAssertEqual(MediaClock.of(seconds: Int64(64)), "1:04")
        XCTAssertEqual(MediaClock.of(seconds: Int64(727)), "12:07")
        XCTAssertEqual(MediaClock.of(seconds: Int64(3_599)), "59:59")
        XCTAssertEqual(MediaClock.of(seconds: Int64(3_600)), "1:00:00")
        // A 61-minute recording is not `61:40`.
        XCTAssertEqual(MediaClock.of(seconds: Int64(3_700)), "1:01:40")
        XCTAssertEqual(MediaClock.of(seconds: Int64(-5)), "0:00")
    }

    func testAPlayersFractionOfASecondIsTruncatedAndAStreamThatHasNotLoadedIsNought() {
        XCTAssertEqual(MediaClock.of(seconds: 4.9), "0:04")
        XCTAssertEqual(MediaClock.of(seconds: 3_700.2), "1:01:40")
        XCTAssertEqual(MediaClock.of(seconds: Double.nan), "0:00")
        XCTAssertEqual(MediaClock.of(seconds: Double.infinity), "0:00")
        XCTAssertEqual(MediaClock.of(seconds: -1.0), "0:00")
    }
}
