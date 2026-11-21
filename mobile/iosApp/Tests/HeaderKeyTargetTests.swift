import SwiftUI
import XCTest

@testable import CentraidApp

/// EVERY HEADER KEY IS A 44 PT TARGET (#1202, S13): the filter funnel, the filled create key and the bar's
/// icon keys measured 36 to 42 pt wide or tall. Measured as the frame the key lays out in.
@MainActor
final class HeaderKeyTargetTests: XCTestCase {
    private func size<V: View>(_ view: V) -> CGSize {
        let host = UIHostingController(rootView: view)
        return host.sizeThatFits(in: CGSize(width: 400, height: 400))
    }

    private func assertTarget(_ size: CGSize, _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertGreaterThanOrEqual(size.width, 44, "\(what) is \(size.width) wide", file: file, line: line)
        XCTAssertGreaterThanOrEqual(size.height, 44, "\(what) is \(size.height) tall", file: file, line: line)
    }

    func testTheFilterKeyIsAtLeast44() {
        var menu = Centraid_Core_V1_FilterMenu()
        menu.spoken = "Filter"
        assertTarget(size(FilterMenuButton(app: "notes", slot: FilterSlot(menu: menu, onPick: { _, _ in }, onClear: {}))), "the funnel")
    }

    func testTheFilledCreateKeyIsAtLeast44() {
        assertTarget(size(KitAccentKey(iconKey: "Plus", label: "Add", accent: .shell, action: {})), "the filled key")
    }

    func testABarIconKeyIsAtLeast44() {
        assertTarget(size(ToolbarIcon(iconKey: "Search", label: "Search", action: {})), "the bar icon key")
    }
}
