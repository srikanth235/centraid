import Foundation
import Security
import XCTest

@testable import CentraidApp

final class SecretReadTests: XCTestCase {
    func testUnavailableKeychainIsNotAnAbsentReceipt() {
        for status in [errSecInteractionNotAllowed, errSecAuthFailed, errSecDecode] {
            let answer = SecretStores.answerForRead(status: status, data: nil)
            XCTAssertFalse(answer.ok)
            XCTAssertFalse(answer.found)
            XCTAssertTrue(answer.value.isEmpty)
        }
    }

    func testMissingAndFoundValuesRemainDistinctSuccessfulReads() {
        let missing = SecretStores.answerForRead(status: errSecItemNotFound, data: nil)
        XCTAssertTrue(missing.ok)
        XCTAssertFalse(missing.found)
        let value = Data("receipt metadata".utf8)
        let present = SecretStores.answerForRead(status: errSecSuccess, data: value)
        XCTAssertTrue(present.ok)
        XCTAssertTrue(present.found)
        XCTAssertEqual(present.value, value)
    }

    func testSuccessWithoutDataIsNotAValidRead() {
        XCTAssertFalse(SecretStores.answerForRead(status: errSecSuccess, data: nil).ok)
    }
}
