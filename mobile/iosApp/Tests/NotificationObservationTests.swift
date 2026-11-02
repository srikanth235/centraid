import Foundation
import XCTest
import os

@testable import CentraidApp

final class NotificationObservationTests: XCTestCase {
    func testReleasingTheOwnerUnregistersFromItsCenter() {
        let center = NotificationCenter()
        let name = Notification.Name("observation-lifetime-test")
        let count = OSAllocatedUnfairLock(initialState: 0)
        var observation: NotificationObservation? = NotificationObservation(
            center.addObserver(forName: name, object: nil, queue: nil) { _ in
                count.withLock { $0 += 1 }
            }, center: center
        )
        XCTAssertNotNil(observation)
        withExtendedLifetime(observation) {
            center.post(name: name, object: nil)
            XCTAssertEqual(count.withLock { $0 }, 1)
        }

        observation = nil
        center.post(name: name, object: nil)
        XCTAssertEqual(count.withLock { $0 }, 1)
    }
}
