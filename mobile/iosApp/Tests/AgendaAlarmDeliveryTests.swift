#if os(iOS)
import XCTest
@testable import CentraidApp

@MainActor
final class AgendaAlarmDeliveryTests: XCTestCase {
    private func plan() -> Centraid_Core_V1_AgendaNotificationSync {
        var source = Centraid_Core_V1_AgendaNotificationSource()
        source.entityID = "task"
        source.sourceStamp = "v1"
        var plan = Centraid_Core_V1_AgendaNotificationSync()
        plan.vaultID = "vault"
        plan.sources = [source]
        return plan
    }

    func testDeliveredOccurrenceRemainsValidWhenOnlyTheNextOccurrenceIsPending() {
        var current = plan()
        var next = Centraid_Core_V1_AgendaAlert()
        next.id = "daily"
        next.fireAtMs = 200
        current.alerts = [next]
        XCTAssertTrue(AgendaNotifications.mayPresent(current, vault: "vault", alert: "daily", entity: "task", source: "v1", fireAt: 100, now: 101))
        XCTAssertFalse(AgendaNotifications.mayPresent(current, vault: "another-vault", alert: "daily", entity: "task", source: "v1", fireAt: 100, now: 101))
        current.sources[0].sourceStamp = "v2"
        XCTAssertFalse(AgendaNotifications.mayPresent(current, vault: "vault", alert: "daily", entity: "task", source: "v1", fireAt: 100, now: 101))
    }

    func testSnoozeSuppressesTheOldQueuedCardUntilTheSnoozedOccurrenceIsDue() {
        var current = plan()
        var snoozed = Centraid_Core_V1_AgendaAlert()
        snoozed.id = "daily"
        snoozed.fireAtMs = 300
        current.snoozed = [snoozed]
        XCTAssertFalse(AgendaNotifications.mayPresent(current, vault: "vault", alert: "daily", entity: "task", source: "v1", fireAt: 100, now: 101))
        XCTAssertTrue(AgendaNotifications.mayPresent(current, vault: "vault", alert: "daily", entity: "task", source: "v1", fireAt: 300, now: 301))
    }
}
#endif
