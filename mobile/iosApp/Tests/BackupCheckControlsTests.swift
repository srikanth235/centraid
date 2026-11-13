import Foundation
import XCTest

@testable import CentraidApp

/// THE ONE FIXTURE BOTH SHELLS READ (`contracts/backup/check-controls.json`, #1188 B13): for each state, the
/// selectors the Check my backup page draws in order, the event each tap sends and how a row is inked. The
/// Android shell's `BackupCheckControlsTest` reads the same file. Nothing here draws.
final class BackupCheckControlsTests: XCTestCase {
    private func fixture() throws -> [String: Any] {
        // Tests/ -> iosApp -> mobile -> the repository root.
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("contracts/backup/check-controls.json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func action(_ name: String) -> Centraid_Core_V1_BackupCheckAction {
        switch name {
        case "start": return .check
        case "stop": return .stop
        default: return .none
        }
    }

    private func tone(_ name: String) -> Centraid_Core_V1_BackupCheckTone {
        switch name {
        case "ok": return .ok
        case "bad": return .bad
        default: return .notRun
        }
    }

    func testTheSharedFixtureHoldsOnThisShell() throws {
        let cases = try XCTUnwrap(try fixture()["cases"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(cases.count, 6)
        for entry in cases {
            let name = entry["name"] as? String ?? "?"
            let given = try XCTUnwrap(entry["state"] as? [String: Any], name)
            var state = Centraid_Core_V1_BackupCheckState()
            state.heading = given["heading"] as? String ?? ""
            state.running = given["running"] as? Bool ?? false
            state.action = action(given["action"] as? String ?? "none")
            state.actionLabel = given["action_label"] as? String ?? ""
            state.backUpNowLabel = given["back_up_now_label"] as? String ?? ""
            state.rows = (given["rows"] as? [[String: Any]] ?? []).map { row in
                var out = Centraid_Core_V1_BackupCheckRow()
                out.gatewayID = row["gateway_id"] as? String ?? ""
                out.tone = tone(row["tone"] as? String ?? "quiet")
                return out
            }
            XCTAssertEqual(entry["shown"] as? [String], BackupCheckControls.shown(state), name)
            let taps = entry["taps"] as? [String: String] ?? [:]
            for (tag, event) in taps {
                XCTAssertEqual(event, BackupCheckControls.eventFor(tag), "\(name): \(tag)")
            }
            let ink = entry["ink"] as? [String: String] ?? [:]
            for row in state.rows {
                XCTAssertEqual(ink[row.gatewayID], BackupCheckControls.ink(row.tone), "\(name): \(row.gatewayID)")
            }
        }
    }
}
