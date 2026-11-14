import Foundation
import XCTest
import os

@testable import CentraidApp

@MainActor
final class NotificationHandoffTests: XCTestCase {
    func testBackgroundResponseCompletesOnceOnMainAfterSuspendingAnswer() async {
        let started = expectation(description: "Notification answer suspended")
        let events = OSAllocatedUnfairLock(initialState: [String]())
        let (stream, resume) = AsyncStream<Void>.makeStream()
        let handoff = await Task.detached {
            XCTAssertFalse(Thread.isMainThread)
            return NotificationHandoff.perform(answer: {
                XCTAssertTrue(Thread.isMainThread)
                events.withLock { $0.append("answer started") }
                started.fulfill()
                var iterator = stream.makeAsyncIterator()
                _ = await iterator.next()
                XCTAssertTrue(Thread.isMainThread)
                events.withLock { $0.append("answer finished") }
            }, completion: {
                XCTAssertTrue(Thread.isMainThread)
                events.withLock { $0.append("completed") }
            })
        }.value

        let result = await XCTWaiter.fulfillment(of: [started], timeout: 5)
        XCTAssertEqual(result, .completed)
        XCTAssertEqual(events.withLock { $0 }, ["answer started"])
        resume.yield(())
        resume.finish()
        await handoff.value
        XCTAssertEqual(events.withLock { $0 }, ["answer started", "answer finished", "completed"])
    }
}
