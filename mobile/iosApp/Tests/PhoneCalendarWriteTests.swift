import EventKit
import XCTest

@testable import CentraidApp

final class PhoneCalendarWriteTests: XCTestCase {
    private func instant(_ value: String) -> Date {
        ISO8601DateFormatter().date(from: value)!
    }

    func testCivilPrecisionAndDstRoundTrip() {
        XCTAssertEqual(PhoneCalendarWrite.date("2026-03-08T09:30", day: false, zone: "America/New_York"), instant("2026-03-08T13:30:00Z"))
        XCTAssertEqual(PhoneCalendarWrite.date("2026-03-08T09:30:00", day: false, zone: "America/New_York"), instant("2026-03-08T13:30:00Z"))
        XCTAssertNil(PhoneCalendarWrite.date("2026-03-08T02:30:00", day: false, zone: "America/New_York"))
        XCTAssertNil(PhoneCalendarWrite.date("2026-03-08T09:30", day: false, zone: "invalid/zone"))
        XCTAssertEqual(PhoneCalendarWrite.date("2026-11-01T01:30:00", day: false, zone: "America/New_York"), instant("2026-11-01T05:30:00Z"))
        XCTAssertEqual(PhoneCalendarWrite.date("2026-11-01T01:30:00.125", day: false, zone: "America/New_York"), instant("2026-11-01T05:30:00Z").addingTimeInterval(0.125))
    }

    func testInclusiveAllDayEndAdvancesACivilDayAcrossDst() {
        XCTAssertEqual(PhoneCalendarWrite.date("2026-03-08", day: true, zone: "America/New_York", inclusiveEnd: true), instant("2026-03-09T04:00:00Z"))
        XCTAssertNil(PhoneCalendarWrite.date("2026-02-30", day: true, zone: "UTC"))
    }

    func testRecurrencePreservesPublicEventKitPartsAndRefusesUnsupportedParts() {
        let yearly = PhoneCalendarWrite.recurrence("FREQ=YEARLY;BYWEEKNO=2,-1;BYDAY=MO;COUNT=4")
        XCTAssertEqual(yearly?.weeksOfTheYear, [2, -1])
        XCTAssertEqual(yearly?.recurrenceEnd?.occurrenceCount, 4)
        XCTAssertEqual(PhoneCalendarWrite.recurrence("FREQ=YEARLY;BYYEARDAY=100,-1")?.daysOfTheYear, [100, -1])
        for rule in ["FREQ=HOURLY", "FREQ=WEEKLY;WKST=SU", "FREQ=MONTHLY;BYMONTHDAY=1,no", "FREQ=DAILY;INTERVAL=0", "FREQ=WEEKLY;BYDAY=0MO", "FREQ=DAILY;COUNT=4;UNTIL=20261201", "FREQ=DAILY;COUNT="] {
            XCTAssertNil(PhoneCalendarWrite.recurrence(rule), rule)
        }
    }
}
