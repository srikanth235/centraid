import Foundation
import XCTest

@testable import CentraidApp

/// AN ANSWER'S MARKDOWN IS STYLING, NEVER ITS MARKERS (R-CHAT-2 follow-up).
final class ChatMarkdownTests: XCTestCase {
    private func words(_ block: ChatMarkdown.Block) -> String {
        switch block {
        case let .paragraph(text), let .heading(text), let .item(_, text):
            return String(text.characters)
        case let .table(rows):
            return rows.map { $0.map { String($0.characters) }.joined(separator: "|") }.joined(separator: ";")
        case let .code(code):
            return code
        }
    }

    /// A block as the shared fixture writes it (`mobile/fixtures/chat-markdown.txt`).
    private func written(_ block: ChatMarkdown.Block) -> String {
        switch block {
        case let .paragraph(text): return "p:" + String(text.characters)
        case let .heading(text): return "h:" + String(text.characters)
        case let .item(marker, text): return "i:" + marker + " " + String(text.characters)
        case .table: return "t:" + words(block)
        case let .code(code): return "c:" + code.replacingOccurrences(of: "\n", with: "\\n")
        }
    }

    func testEveryCaseOfTheSharedFixtureReadsTheSameOnBothShells() throws {
        // …/mobile/iosApp/Tests/ChatMarkdownTests.swift → …/mobile/fixtures/chat-markdown.txt
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("fixtures/chat-markdown.txt")
        let text = try String(contentsOf: url, encoding: .utf8)
        let kept = text.components(separatedBy: "\n").filter { !$0.hasPrefix("# ") }.joined(separator: "\n")
        let cases = kept.components(separatedBy: "\n====\n")
        XCTAssertGreaterThanOrEqual(cases.count, 9)
        for fixture in cases {
            let lines = fixture.components(separatedBy: "\n")
            let name = lines.first { $0.hasPrefix("name:") } ?? "?"
            let streaming = (lines.first { $0.hasPrefix("streaming:") } ?? "").contains("yes")
            let input = fixture.components(separatedBy: "--- input\n")[1].components(separatedBy: "\n--- blocks")[0]
            let expected = fixture.components(separatedBy: "--- blocks\n")[1]
                .trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n")
            XCTAssertEqual(ChatMarkdown.blocks(input, streaming: streaming).map(written), expected, name)
        }
    }

    func testBoldItalicAndCodeLoseTheirMarkers() {
        let blocks = ChatMarkdown.blocks("You spent **$380.50** on *food* and `gas`.")
        XCTAssertEqual(blocks.map(words), ["You spent $380.50 on food and gas."])
    }

    func testBulletsAndNumbersBecomeItems() {
        let blocks = ChatMarkdown.blocks("Three things:\n\n- one\n* two\n1. first\n2) second")
        XCTAssertEqual(blocks.count, 5)
        XCTAssertEqual(blocks.map(words), ["Three things:", "one", "two", "first", "second"])
        guard case let .item(marker, _) = blocks[1], case let .item(number, _) = blocks[3] else {
            return XCTFail("list lines are items")
        }
        XCTAssertEqual(marker, "•")
        XCTAssertEqual(number, "1.")
    }

    func testAStarThatOpensBoldIsNotAListItem() {
        let blocks = ChatMarkdown.blocks("**Bold** start")
        XCTAssertEqual(blocks.count, 1)
        XCTAssertEqual(words(blocks[0]), "Bold start")
    }

    func testHeadingsKeepTheirWordsAndDropTheHash() {
        XCTAssertEqual(ChatMarkdown.blocks("## Today").map(words), ["Today"])
    }

    func testALinkKeepsItsWordsAndIsNotTappable() {
        let text = ChatMarkdown.inline("see [the site](https://example.com)")
        XCTAssertEqual(String(text.characters), "see the site")
        XCTAssertTrue(text.runs.allSatisfy { $0.link == nil })
    }

    func testAnUnclosedMarkerWhileStreamingShowsNoAsterisks() {
        XCTAssertEqual(String(ChatMarkdown.inline("You spent **$38", streaming: true).characters), "You spent $38")
        XCTAssertEqual(ChatMarkdown.withoutMarkers("**a** `b`"), "a b")
    }

    func testTheSpokenTextHasNoMarkers() {
        XCTAssertEqual(ChatMarkdown.plain("**Hi** there"), "Hi there")
    }
}
