import SwiftUI
import XCTest

@testable import CentraidApp

/// THE READABLE COLUMN (ruling 27): at iPad width a page's content stands in one centred column no wider
/// than `CentraidGeometry.readableWidth`; the opt-out (Photos' rows, the Calendar's grids) keeps the full
/// width; at phone width nothing changes.
@MainActor
final class ReadableColumnTests: XCTestCase {
    private final class Probe { var frame: CGRect = .zero }

    private func column(in width: CGFloat, enabled: Bool) -> CGRect {
        let probe = Probe()
        let view = Color.clear
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(
                GeometryReader { geometry in
                    Color.clear.onAppear { probe.frame = geometry.frame(in: .global) }
                }
            )
            .readableColumn(enabled)
            .frame(width: width, height: 600)
        let host = UIHostingController(rootView: view)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: width, height: 600))
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        return probe.frame
    }

    func testAListPageIsCappedAndCentredAtIPadWidth() {
        let frame = column(in: 1024, enabled: true)
        XCTAssertLessThanOrEqual(frame.width, CentraidGeometry.readableWidth + 0.5)
        XCTAssertEqual(frame.width, CentraidGeometry.readableWidth, accuracy: 0.5)
        XCTAssertEqual(frame.minX, (1024 - frame.width) / 2, accuracy: 1)
    }

    func testTheOptOutKeepsTheFullWidthAtIPadWidth() {
        let frame = column(in: 1024, enabled: false)
        XCTAssertEqual(frame.width, 1024, accuracy: 0.5)
        XCTAssertEqual(frame.minX, 0, accuracy: 0.5)
    }

    func testAPhoneIsUnchanged() {
        for enabled in [true, false] {
            let frame = column(in: 393, enabled: enabled)
            XCTAssertEqual(frame.width, 393, accuracy: 0.5)
            XCTAssertEqual(frame.minX, 0, accuracy: 0.5)
        }
    }
}
