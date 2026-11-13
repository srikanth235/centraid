import Foundation
import XCTest

@testable import CentraidApp

/// WHICH `BGTaskScheduler` IDENTIFIER CARRIES WHICH WINDOW (#1188, B7).
///
/// iOS keeps one pending request per identifier, so two windows sharing one replaced each other:
/// the one-off nudge (no charger) replaced the night shift (needs one), and the handler named
/// every processing task the night shift. These cases are the mapping, pure, with the windows
/// Rust sends (`crates/screens/src/passes/windows.rs`). The scheduler itself, and what iOS
/// grants, are device hand-offs.
final class BackgroundPassesTests: XCTestCase {
    private func window(_ name: String, charging: Bool, period: UInt32) -> Centraid_Core_V1_Window {
        var window = Centraid_Core_V1_Window()
        window.name = name
        window.requiresCharging = charging
        window.periodMinutes = period
        return window
    }

    func testEveryWindowRustSendsHasItsOwnIdentifier() {
        let periodic = window("centraid-sync-pass", charging: false, period: 15)
        let night = window("centraid-night-shift", charging: true, period: 60)
        let nudge = window("centraid-nudge", charging: false, period: 0)
        let identifiers = [periodic, night, nudge].map(BackgroundPasses.identifier(for:))
        XCTAssertEqual(Set(identifiers).count, 3, "two windows must never share a request: \(identifiers)")
        XCTAssertEqual(identifiers[0], BackgroundPasses.refreshIdentifier)
        XCTAssertEqual(identifiers[1], BackgroundPasses.processingIdentifier)
        XCTAssertEqual(identifiers[2], BackgroundPasses.nudgeIdentifier)
    }

    func testTheHandlerNamesTheWindowItWasWokenFor() {
        XCTAssertEqual(BackgroundPasses.windowName(for: BackgroundPasses.refreshIdentifier), "centraid-sync-pass")
        XCTAssertEqual(BackgroundPasses.windowName(for: BackgroundPasses.processingIdentifier), "centraid-night-shift")
        XCTAssertEqual(BackgroundPasses.windowName(for: BackgroundPasses.nudgeIdentifier), "centraid-nudge")
    }

    func testTheNameRoundTripsThroughTheIdentifier() {
        for (name, charging, period) in [
            ("centraid-sync-pass", false, UInt32(15)),
            ("centraid-night-shift", true, 60),
            ("centraid-nudge", false, 0),
        ] {
            let carried = BackgroundPasses.identifier(for: window(name, charging: charging, period: period))
            XCTAssertEqual(BackgroundPasses.windowName(for: carried), name)
        }
    }

    func testOnlyTheRefreshWindowIsNotAProcessingRequest() {
        XCTAssertFalse(BackgroundPasses.isProcessing(BackgroundPasses.refreshIdentifier))
        XCTAssertTrue(BackgroundPasses.isProcessing(BackgroundPasses.processingIdentifier))
        XCTAssertTrue(BackgroundPasses.isProcessing(BackgroundPasses.nudgeIdentifier))
    }
}
