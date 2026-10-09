import Foundation
import XCTest

@testable import CentraidApp

/// AN ANSWER'S MARKDOWN IS STYLING, NEVER ITS MARKERS (R-CHAT-2 follow-up).
final class ChatMarkdownTests: XCTestCase {
    private func words(_ block: ChatMarkdown.Block) -> String {
        switch block {
        case let .paragraph(text), let .heading(text), let .item(_, text):
            return String(text.characters)
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
