import XCTest

@testable import CentraidApp

final class NotificationPlanTests: XCTestCase {
    func testFiredCardSurvivesAnEmptyFutureSet() {
        XCTAssertEqual(
            NotificationPlan.withdrawn(wanted: [], delivered: ["fired"], retain: true, explicit: []),
            []
        )
    }

    func testExplicitObsoleteCardIsWithdrawnEvenWhenItsNextAlarmUsesTheSameID() {
        XCTAssertEqual(
            NotificationPlan.withdrawn(
                wanted: ["edited", "future"], delivered: ["edited", "unrelated"], retain: true, explicit: ["edited"]
            ),
            ["edited"]
        )
    }

    func testAWithdrawnIDDoesNotDependOnAnOSInventoryRace() {
        XCTAssertEqual(
            NotificationPlan.withdrawn(wanted: [], delivered: [], retain: true, explicit: ["obsolete"]),
            ["obsolete"]
        )
    }

    func testLegacyOrVaultSwitchRequestClearsUnwantedDeliveredCards() {
        XCTAssertEqual(
            NotificationPlan.withdrawn(
                wanted: ["new-vault"], delivered: ["old-vault", "new-vault"], retain: false, explicit: []
            ),
            ["old-vault"]
        )
    }

    func testDismissedImmediateReceiptIsNotPostedAgainAndExpiryDropsItsHistory() {
        let first = NotificationPlan.rememberedImmediates(current: ["receipt"], previous: [], delivered: ["receipt"])
        XCTAssertEqual(first, ["receipt"])
        let afterDismissAndRestart = NotificationPlan.rememberedImmediates(
            current: ["receipt"], previous: first, delivered: []
        )
        XCTAssertEqual(afterDismissAndRestart, ["receipt"])
        XCTAssertTrue(
            NotificationPlan.rememberedImmediates(current: [], previous: afterDismissAndRestart, delivered: []).isEmpty
        )
        XCTAssertTrue(
            NotificationPlan.rememberedImmediates(current: ["next"], previous: afterDismissAndRestart, delivered: []).isEmpty
        )
    }
}
