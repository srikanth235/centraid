import XCTest

@testable import CentraidApp

/// A NIGHT IS COUNTED ONCE (#1129): the watch's stages and the phone's unstaged "asleep" overlap,
/// and `HealthKitReader.merged` makes one run of them, so the minutes are the union's.
final class HealthSleepMergeTests: XCTestCase {
    private let base = Date(timeIntervalSince1970: 1_800_000_000)

    private func at(_ minutes: Double) -> Date { base.addingTimeInterval(minutes * 60) }

    func testOverlappingSourcesAreOneRun() {
        let runs = HealthKitReader.merged([
            (at(0), at(120)), (at(120), at(240)), (at(240), at(420)), // the watch's three stages, touching
            (at(10), at(410)), // the phone's interval, inside them
        ])
        XCTAssertEqual(runs.count, 1)
        XCTAssertEqual(runs[0].1.timeIntervalSince(runs[0].0), 420 * 60)
    }

    func testAGapAwakeIsTwoRunsAndUnsortedInputIsSorted() {
        let runs = HealthKitReader.merged([(at(300), at(400)), (at(0), at(200)), (at(50), at(100)), (at(10), at(10))])
        XCTAssertEqual(runs.map { $0.1.timeIntervalSince($0.0) / 60 }, [200, 100])
    }

    func testKindNamesFallBackToOther() {
        XCTAssertEqual(HealthKitReader.kind(.running), "running")
        XCTAssertEqual(HealthKitReader.kind(.traditionalStrengthTraining), "traditionalStrengthTraining")
        XCTAssertEqual(HealthKitReader.kind(.elliptical), "other")
    }
}
