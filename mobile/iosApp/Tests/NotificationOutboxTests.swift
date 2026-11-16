import Foundation
import XCTest

@testable import CentraidApp

final class NotificationOutboxTests: XCTestCase {
    func testAddsPersistAndReopenWithSamePressIdentity() throws {
        let fixture = try Fixture()
        let first = try fixture.outbox.add(notificationID: "task-A", verb: 2)
        let reopened = NotificationOutbox.Store(url: fixture.url)

        XCTAssertEqual(try reopened.pending(), [first])
    }

    func testCorruptExcludedFileReachesDecoderAndIsNeverOverwritten() throws {
        let fixture = try Fixture()
        let bytes = Data("not-json".utf8)
        try bytes.write(to: fixture.url)
        try fixture.excludeFromBackup()

        XCTAssertThrowsError(try fixture.outbox.add(notificationID: "task-A", verb: 2)) { error in
            XCTAssertEqual(error as? NotificationOutbox.Failure, .corrupt)
        }
        XCTAssertThrowsError(try fixture.outbox.remove("press-A")) { error in
            XCTAssertEqual(error as? NotificationOutbox.Failure, .corrupt)
        }
        XCTAssertThrowsError(try fixture.outbox.pending()) { error in
            XCTAssertEqual(error as? NotificationOutbox.Failure, .corrupt)
        }
        XCTAssertEqual(try Data(contentsOf: fixture.url), bytes)
    }

    func testFailedAtomicReplacementDoesNotReturnPressOrOverwriteExistingQueue() throws {
        let fixture = try Fixture()
        let existing = try fixture.outbox.add(notificationID: "task-existing", verb: 2)
        let failing = NotificationOutbox.Store(url: fixture.url, failReplacementForTesting: true)

        XCTAssertThrowsError(try failing.add(notificationID: "task-new", verb: 2))
        XCTAssertEqual(try fixture.outbox.pending(), [existing])
        let finalValues = try fixture.url.resourceValues(forKeys: [.isExcludedFromBackupKey, .fileProtectionKey])
        XCTAssertEqual(finalValues.isExcludedFromBackup, true)
        XCTAssertEqual(finalValues.fileProtection, .completeUntilFirstUserAuthentication)
    }

    func testRemovePersistsOnlySelectedIdentityAndFailedRemoveKeepsPress() throws {
        let fixture = try Fixture()
        let first = try fixture.outbox.add(notificationID: "task-A", verb: 2)
        let second = try fixture.outbox.add(notificationID: "task-B", verb: 2)
        try fixture.outbox.remove(first.pressID)

        XCTAssertEqual(try NotificationOutbox.Store(url: fixture.url).pending(), [second])

        let failing = NotificationOutbox.Store(url: fixture.url, failReplacementForTesting: true)
        XCTAssertThrowsError(try failing.remove(second.pressID))
        XCTAssertEqual(try NotificationOutbox.Store(url: fixture.url).pending(), [second])
    }

    private final class Fixture {
        let root: URL
        var url: URL
        let outbox: NotificationOutbox.Store

        init() throws {
            root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            url = root.appendingPathComponent("notification-outbox.json")
            outbox = NotificationOutbox.Store(url: url)
        }

        deinit { try? FileManager.default.removeItem(at: root) }

        func excludeFromBackup() throws {
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try url.setResourceValues(values)
        }
    }
}
