import XCTest

@testable import CentraidApp

/// HEALTH'S WIDGET SNAPSHOT AS THE SHELL READS IT (#1185): a version-1 document
/// decodes, any other does not, the tap's URL carries the core's opaque key, and
/// staleness is a comparison of the document's own civil strings.
final class HealthGlanceSnapshotTests: XCTestCase {
    private let sample = """
        {"version":1,"state":"ready","today":"2026-11-11","zone":"Europe/Berlin",
         "refresh_after":"2026-11-12T00:00","open":"home",
         "words":{"title":"Health","empty":"No store","nothing":"Nothing yet","stale":"Out of date",
                  "stale_hint":"Open Centraid","unavailable":"Unavailable","steps_caption":"steps today"},
         "figures":[{"metric":"steps","label":"Steps","value":"8,412","unit":"","text":"8,412"},
                    {"metric":"weight","label":"Weight","value":"72.4","unit":"kg","text":"72.4 kg"}],
         "sleep_line":"Slept 7 h 12 min","future_key":1}
        """

    func testAVersionOneDocumentDecodes() throws {
        let snapshot = try XCTUnwrap(HealthGlanceSnapshot.decode(Data(sample.utf8)))
        XCTAssertEqual(snapshot.state, "ready")
        XCTAssertEqual(snapshot.open, "home")
        XCTAssertEqual(snapshot.words.stepsCaption, "steps today")
        XCTAssertEqual(snapshot.figures.map(\.metric), ["steps", "weight"])
        XCTAssertEqual(snapshot.figures[1].text, "72.4 kg")
        XCTAssertEqual(snapshot.sleepLine, "Slept 7 h 12 min")
    }

    func testAnotherVersionOrBrokenJSONIsNothing() {
        let other = sample.replacingOccurrences(of: "\"version\":1", with: "\"version\":2")
        XCTAssertNil(HealthGlanceSnapshot.decode(Data(other.utf8)))
        XCTAssertNil(HealthGlanceSnapshot.decode(Data("{".utf8)))
        XCTAssertNil(HealthGlanceSnapshot.decode(Data("{\"version\":1}".utf8)))
    }

    func testStaleOnceRefreshAfterHasPassedInTheDocumentsZone() throws {
        let snapshot = try XCTUnwrap(HealthGlanceSnapshot.decode(Data(sample.utf8)))
        let deadline = try XCTUnwrap(snapshot.refreshDate)
        XCTAssertFalse(snapshot.isStale(now: deadline.addingTimeInterval(-60)))
        XCTAssertTrue(snapshot.isStale(now: deadline))
        // 2026-11-12T00:00 in Berlin (UTC+1 in November) is 2026-11-11T23:00Z.
        XCTAssertEqual(deadline.timeIntervalSince1970, 1_794_438_000)
    }

    func testOnlyAReadyDocumentCanBeStale() throws {
        var snapshot = try XCTUnwrap(HealthGlanceSnapshot.decode(Data(sample.utf8)))
        snapshot.state = "empty"
        XCTAssertFalse(snapshot.isStale(now: .distantFuture))
        snapshot.state = "ready"
        snapshot.refreshAfter = "garbage"
        XCTAssertTrue(snapshot.isStale(now: .distantPast))
    }

    func testTheKeyRoundTripsThroughTheURL() throws {
        let url = try XCTUnwrap(HealthGlanceSnapshot.openURL("home"))
        XCTAssertEqual(url.absoluteString, "centraid://health?open=home")
        XCTAssertEqual(HealthGlanceSnapshot.openKey(from: url), "home")
        XCTAssertNil(HealthGlanceSnapshot.openURL(""))
    }

    func testAURLOfAnotherShapeIsIgnored() throws {
        let others = [
            "https://health?open=home",
            "centraid://agenda?open=home",
            "centraid://health/trends?open=home",
            "centraid://health?open=",
            "centraid://health?screen=health.home",
            "centraid://health?open=home&screen=health.home",
            "centraid://health",
        ]
        for text in others {
            let url = try XCTUnwrap(URL(string: text), text)
            XCTAssertNil(HealthGlanceSnapshot.openKey(from: url), text)
        }
    }
}
