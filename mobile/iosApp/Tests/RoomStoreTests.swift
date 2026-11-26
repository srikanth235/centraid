import SwiftUI
import XCTest
@testable import CentraidApp

final class RoomStoreTests: XCTestCase {
    func testRoomTextSyncSeqRevRule() {
        var sync = RoomTextSync()
        XCTAssertTrue(sync.shouldAdopt(remoteValue: "hello", remoteRev: 0, localText: ""))

        let s1 = sync.nextSeq()
        XCTAssertEqual(s1, 1)
        let s2 = sync.nextSeq()
        XCTAssertEqual(s2, 2)

        XCTAssertFalse(sync.shouldAdopt(remoteValue: "h", remoteRev: 1, localText: "he"))
        XCTAssertFalse(sync.shouldAdopt(remoteValue: "he", remoteRev: 2, localText: "he"))
        XCTAssertTrue(sync.shouldAdopt(remoteValue: "hello", remoteRev: 2, localText: "he"))
    }

    func testParseAppearance() {
        XCTAssertEqual(RoomStore.parseAppearance(#"{"v":1,"value":"light"}"#), .light)
        XCTAssertEqual(RoomStore.parseAppearance(#"{"v":1,"value":"dark"}"#), .dark)
        XCTAssertNil(RoomStore.parseAppearance(#"{"v":1,"value":"system"}"#))
        XCTAssertNil(RoomStore.parseAppearance("not json"))
    }

    func testTodayGlanceSnapshotDecodeAndOpenURL() throws {
        let json = """
        {"v":1,"title":"Today","day":"2026-11-26","summary":"1 event","lines":[{"text":"Dentist","url":"centraid://open/event/ev1","kind":"event"}]}
        """
        let snapshot = try XCTUnwrap(TodayGlanceSnapshot.decode(Data(json.utf8)))
        XCTAssertEqual(snapshot.title, "Today")
        XCTAssertEqual(snapshot.lines.count, 1)
        XCTAssertEqual(snapshot.lines[0].text, "Dentist")

        let url = try XCTUnwrap(URL(string: snapshot.lines[0].url))
        let parsed = try XCTUnwrap(TodayGlanceSnapshot.parseOpenURL(url))
        XCTAssertEqual(parsed.kind, "event")
        XCTAssertEqual(parsed.id, "ev1")

        XCTAssertNil(TodayGlanceSnapshot.decode(Data(#"{"v":2,"title":"Today","day":"2026-11-26","summary":"","lines":[]}"#.utf8)))
    }
}
