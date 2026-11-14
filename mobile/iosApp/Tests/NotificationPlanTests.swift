import Foundation
import XCTest

@testable import CentraidApp

/// THE ONE FIXTURE BOTH SHELLS READ (`contracts/notify/reconcile-cases.json`, #1188): each case is a
/// set from Rust, the delivered ids still live, what the OS holds pending and delivered, and the plan
/// that follows. The Android shell's `NotifyPlanTest` reads the same file.
final class NotificationPlanTests: XCTestCase {
    private func fixture() throws -> [String: Any] {
        // Tests/ -> iosApp -> mobile -> the repository root.
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("contracts/notify/reconcile-cases.json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testTheSharedFixtureHoldsOnThisShell() throws {
        let root = try fixture()
        let now = try XCTUnwrap(root["now_ms"] as? Int64)
        let cases = try XCTUnwrap(root["cases"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(cases.count, 9)
        for entry in cases {
            let name = entry["name"] as? String ?? "?"
            let wanted = (entry["wanted"] as? [[String: Any]] ?? []).map { item -> Centraid_Core_V1_PendingNotification in
                var out = Centraid_Core_V1_PendingNotification()
                out.notificationID = item["id"] as? String ?? ""
                out.fireAtMs = (item["fire_at_ms"] as? NSNumber)?.int64Value ?? 0
                out.immediate = item["immediate"] as? Bool ?? false
                return out
            }
            let plan = NotificationPlan.reconcile(
                wanted: wanted,
                live: entry["live"] as? [String] ?? [],
                pending: entry["pending"] as? [String] ?? [],
                delivered: entry["showing"] as? [String] ?? [],
                nowMs: now
            )
            let expected = try XCTUnwrap(entry["plan"] as? [String: [String]], name)
            XCTAssertEqual(plan.removePending, expected["removePending"], name)
            XCTAssertEqual(plan.removeDelivered, expected["removeShowing"], name)
            XCTAssertEqual(plan.schedule.map(\.notificationID), expected["schedule"], name)
            XCTAssertEqual(plan.post.map(\.notificationID), expected["post"], name)
        }
    }

    func testRetainedFiredCardSurvivesAnEmptyFutureAndLiveSet() {
        let plan = NotificationPlan.reconcile(
            wanted: [], live: [], pending: [], delivered: ["fired"], nowMs: 10_000,
            retainDelivered: true
        )
        XCTAssertTrue(plan.removeDelivered.isEmpty)
    }

    func testExplicitChangedSourceWithdrawalWinsEvenWhenTheNextAlarmUsesTheSameID() {
        let wanted: Centraid_Core_V1_PendingNotification = .with {
            $0.notificationID = "edited"; $0.fireAtMs = 20_000
        }
        let plan = NotificationPlan.reconcile(
            wanted: [wanted], live: ["edited", "unrelated"], pending: [],
            delivered: ["edited", "unrelated"], nowMs: 10_000,
            retainDelivered: true, cancelDeliveredIDs: ["edited"]
        )
        XCTAssertEqual(plan.removeDelivered, ["edited"])
        XCTAssertEqual(plan.schedule.map(\.notificationID), ["edited"])
    }

    func testAnExplicitWithdrawalDoesNotDependOnAnOSInventoryRace() {
        let plan = NotificationPlan.reconcile(
            wanted: [], live: [], pending: [], delivered: [], nowMs: 10_000,
            retainDelivered: true, cancelDeliveredIDs: ["obsolete"]
        )
        XCTAssertEqual(plan.removeDelivered, ["obsolete"])
    }

    func testLegacyOrVaultSwitchPlanStillClearsUnwantedDeliveredCards() {
        let wanted: Centraid_Core_V1_PendingNotification = .with {
            $0.notificationID = "new-vault"; $0.fireAtMs = 20_000
        }
        let plan = NotificationPlan.reconcile(
            wanted: [wanted], live: [], pending: [], delivered: ["old-vault", "new-vault"], nowMs: 10_000
        )
        XCTAssertEqual(plan.removeDelivered, ["old-vault"])
    }

    func testDismissedImmediateReceiptIsNotPostedAgainAndExpiryDropsItsHistory() {
        let first = NotificationPlan.rememberedImmediates(current: ["receipt"], previous: [], delivered: ["receipt"])
        XCTAssertEqual(first, ["receipt"])
        let afterDismissAndRestart = NotificationPlan.rememberedImmediates(
            current: ["receipt"], previous: first, delivered: []
        )
        XCTAssertEqual(afterDismissAndRestart, ["receipt"])
        XCTAssertTrue(NotificationPlan.rememberedImmediates(current: [], previous: afterDismissAndRestart, delivered: []).isEmpty)
        XCTAssertTrue(NotificationPlan.rememberedImmediates(current: ["next"], previous: afterDismissAndRestart, delivered: []).isEmpty)
    }
}
