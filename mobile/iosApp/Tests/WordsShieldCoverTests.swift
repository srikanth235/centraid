import SwiftUI
import XCTest

@testable import CentraidApp

/// The capture shield covers a secure page only while it is captured or the scene is not active,
/// and never covers a page that is not secure: a Locker that is open and in front is never blank.
final class WordsShieldCoverTests: XCTestCase {
    func testAnOpenActiveUncapturedPageIsNeverCovered() {
        XCTAssertFalse(WordsShield<EmptyView>.covers(secure: true, captured: false, active: true))
    }

    func testASecurePageIsCoveredWhileCapturedOrInactive() {
        XCTAssertTrue(WordsShield<EmptyView>.covers(secure: true, captured: true, active: true))
        XCTAssertTrue(WordsShield<EmptyView>.covers(secure: true, captured: false, active: false))
    }

    func testAPageThatIsNotSecureIsNeverCovered() {
        XCTAssertFalse(WordsShield<EmptyView>.covers(secure: false, captured: true, active: false))
    }
}
