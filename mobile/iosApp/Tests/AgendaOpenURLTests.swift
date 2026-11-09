import XCTest

@testable import CentraidApp

/// A WIDGET'S TAP IS A URL THAT CARRIES THE CORE'S OPAQUE KEY (#1173, wave 3): the
/// widget builds it from the snapshot's `open` field, the app reads the key back,
/// and a URL of any other shape is ignored.
final class AgendaOpenURLTests: XCTestCase {
    func testAKeyRoundTripsThroughTheURL() throws {
        for key in ["e:01HZ-abc:2026-11-07T15:00", "t:01HZ", "up_next", "add", "a b&c=d+e/f"] {
            let url = try XCTUnwrap(AgendaGlanceSnapshot.openURL(key), key)
            XCTAssertEqual(url.scheme, "centraid")
            XCTAssertEqual(AgendaGlanceSnapshot.openKey(from: url), key)
        }
    }

    func testTheURLNamesNoScreen() throws {
        let url = try XCTUnwrap(AgendaGlanceSnapshot.openURL("up_next"))
        XCTAssertEqual(url.absoluteString, "centraid://agenda?open=up_next")
    }

    func testNoKeyIsNoLink() {
        XCTAssertNil(AgendaGlanceSnapshot.openURL(nil))
        XCTAssertNil(AgendaGlanceSnapshot.openURL(""))
    }

    func testAURLOfAnotherShapeIsIgnored() throws {
        let others = [
            "https://agenda?open=add",
            "centraid://notes?open=add",
            "centraid://agenda/trash?open=add",
            "centraid://agenda?open=",
            "centraid://agenda?screen=agenda.trash",
            "centraid://agenda?open=add&screen=agenda.trash",
            "centraid://agenda",
        ]
        for text in others {
            let url = try XCTUnwrap(URL(string: text), text)
            XCTAssertNil(AgendaGlanceSnapshot.openKey(from: url), text)
        }
        let long = String(repeating: "x", count: AgendaGlanceSnapshot.maxOpenKeyLength + 1)
        let url = try XCTUnwrap(URL(string: "centraid://agenda?open=\(long)"))
        XCTAssertNil(AgendaGlanceSnapshot.openKey(from: url))
    }

    func testADocumentWithoutOpenKeysStillDecodes() throws {
        let json = """
            {"version":1,"state":"ready","today":"2026-11-07","now_local":"2026-11-07T10:30",
             "zone":"UTC","refresh_after":"2026-11-08T00:00",
             "words":{"up_next_title":"a","today_title":"b","reminders_title":"c","nothing_next":"d",
               "no_reminders":"e","unavailable":"f","stale":"g","overdue_label":"h","today_label":"i",
               "flagged_label":"j","add_label":"k"},
             "up_next":[{"id":"x","kind":"task","title":"t","time_label":"","day_label":"",
               "starts_local":"","ends_local":"","all_day":false,"tint":"agenda"}],
             "reminders":{"today_count":0,"overdue_count":0,"flagged_count":0,"rows":[]},
             "siri":{"next_sentence":"s"}}
            """
        let snapshot = try XCTUnwrap(AgendaGlanceSnapshot.decode(Data(json.utf8)))
        XCTAssertNil(snapshot.openAdd)
        XCTAssertNil(snapshot.upNext[0].open)
    }
}
