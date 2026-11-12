import Foundation
import XCTest

@testable import CentraidApp

/// EVERY STORE APPLIES A STREAMING ANSWER'S DELTAS THE SAME WAY (#1188 C14): the cases are the shared
/// fixture Rust's `chat::delta` and the Android store read too.
final class ViewDeltaTests: XCTestCase {
    func testTheSharedFixturesDeltasAppliedInOrderReproduceTheState() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("fixtures/chat-deltas.txt")
        let text = try String(contentsOf: url, encoding: .utf8)
        let kept = text.components(separatedBy: "\n").filter { !$0.hasPrefix("# ") }.joined(separator: "\n")
        let cases = kept.components(separatedBy: "\n====\n")
        XCTAssertGreaterThanOrEqual(cases.count, 4)
        func field(_ block: String, _ key: String) -> String {
            block.components(separatedBy: "\n").first { $0.hasPrefix(key) }
                .map { String($0.dropFirst(key.count)).trimmingCharacters(in: .whitespaces) } ?? ""
        }
        for fixture in cases {
            let name = field(fixture, "name:")
            var view = Centraid_Core_V1_ViewState()
            view.instance = 1
            view.revision = UInt64(field(fixture, "revision:")) ?? 0
            var chat = Centraid_Core_V1_ChatState()
            chat.activity = field(fixture, "activity:")
            chat.messages = field(fixture, "messages:").components(separatedBy: ";").filter { !$0.isEmpty }.map { pair in
                var message = Centraid_Core_V1_ChatMessage()
                let halves = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                message.id = UInt64(halves[0]) ?? 0
                message.text = halves.count > 1 ? String(halves[1]) : ""
                return message
            }
            view.kind = .chat(chat)
            let deltas = fixture.components(separatedBy: "--- deltas\n")[1].components(separatedBy: "\n--- expect")[0]
            for line in deltas.components(separatedBy: "\n") {
                let parts = line.split(separator: "|", maxSplits: 4, omittingEmptySubsequences: false).map(String.init)
                var add = Centraid_Core_V1_ChatAppend()
                add.messageID = UInt64(parts[2]) ?? 0
                add.activity = parts[3]
                add.text = parts[4]
                var delta = Centraid_Core_V1_ViewDelta()
                delta.instance = 1
                delta.base = UInt64(parts[0]) ?? 0
                delta.revision = UInt64(parts[1]) ?? 0
                delta.kind = .chatAppend(add)
                view = ViewDeltas.apply(delta, to: view) ?? view
            }
            let expect = fixture.components(separatedBy: "--- expect\n")[1]
            guard case .chat(let result)? = view.kind else { return XCTFail(name) }
            XCTAssertEqual(field(expect, "revision:"), String(view.revision), name)
            XCTAssertEqual(field(expect, "activity:"), result.activity, name)
            XCTAssertEqual(field(expect, "messages:"), result.messages.map { "\($0.id)=\($0.text)" }.joined(separator: ";"), name)
        }
    }
}
