import Foundation
import XCTest
@testable import CentraidApp

final class LibraryStreamTests: XCTestCase {
    func testPhotoKitErrorBeforeFirstDataIsUnreadable() async {
        let stream = LibraryStream()

        stream.finish(NSError(domain: "PhotoKitFixture", code: 9))

        if case .failed = await stream.first() {
            return
        }
        XCTFail("a PhotoKit read error before its first chunk must not look like a missing original")
    }

    func testClosingBeforeFirstDataCancelsThePhotoKitRequestAndUnblocksFirst() async {
        let stream = LibraryStream()
        let cancelled = LockedFlag()
        stream.cancel = { cancelled.set() }
        let first = Task { await stream.first() }

        stream.close()

        if case .cancelled = await first.value {
            XCTAssertTrue(cancelled.isSet)
        } else {
            XCTFail("closing a pending request must be distinguished from an empty resource")
        }
    }
}

private final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false

    var isSet: Bool {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func set() {
        lock.lock()
        value = true
        lock.unlock()
    }
}
