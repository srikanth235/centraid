import SwiftUI
import XCTest

@testable import CentraidApp

/// RETURN MOVES TO THE NEXT FIELD (#1202, S13): "next" on every field but the last, which says "done" and
/// puts the keyboard away.
final class FocusChainTests: XCTestCase {
    func testReturnWalksTheFieldsAndTheLastPutsTheKeyboardAway() {
        XCTAssertEqual(FocusChain.next(after: 0, last: 3), 1)
        XCTAssertEqual(FocusChain.next(after: 2, last: 3), 3)
        XCTAssertNil(FocusChain.next(after: 3, last: 3))
    }

    func testTheKeySaysNextExceptOnTheLastField() {
        XCTAssertTrue(FocusChain.saysNext(index: 0, last: 3))
        XCTAssertTrue(FocusChain.saysNext(index: 2, last: 3))
        XCTAssertFalse(FocusChain.saysNext(index: 3, last: 3))
        // A title over a body: the title says next, the body is the last stop.
        XCTAssertTrue(FocusChain.saysNext(index: 0, last: 1))
    }
}
