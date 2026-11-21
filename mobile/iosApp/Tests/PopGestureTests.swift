import UIKit
import XCTest

@testable import CentraidApp

/// THE EDGE SWIPE BACK WORKS WITH THE SYSTEM'S BACK BUTTON HIDDEN (#1202). Every page draws its own
/// chevron, and UIKit puts the interactive pop gesture away with the system button.
@MainActor
final class PopGestureTests: XCTestCase {
    func testTheNavigationControllerIsTheDelegateOfTheEdgeSwipe() {
        let nav = UINavigationController(rootViewController: UIViewController())
        nav.loadViewIfNeeded()
        XCTAssertTrue(nav.interactivePopGestureRecognizer?.delegate === nav)
    }

    func testTheSwipeBeginsOnlyWithAPageToGoBackTo() {
        XCTAssertFalse(UINavigationController.popMayBegin(depth: 1))
        XCTAssertTrue(UINavigationController.popMayBegin(depth: 2))
    }
}
