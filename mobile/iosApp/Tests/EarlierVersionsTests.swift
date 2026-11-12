import XCTest

@testable import CentraidApp

/// THE EARLIER-VERSIONS ENTRY AND ROWS (#1185): when each is drawn, and the ids a flow finds them by.
final class EarlierVersionsTests: XCTestCase {
    private func entry(label: String = "Earlier versions") -> Centraid_Core_V1_EarlierEntry {
        var entry = Centraid_Core_V1_EarlierEntry()
        entry.label = label
        entry.countLabel = "2"
        entry.accessibilityLabel = "Earlier versions, 2"
        return entry
    }

    private func row(seq: Int64, current: Bool, restore: String = "Restore") -> Centraid_Core_V1_EarlierRow {
        var row = Centraid_Core_V1_EarlierRow()
        row.seq = seq
        row.current = current
        row.currentLabel = current ? "Current" : ""
        row.restoreLabel = current ? "" : restore
        return row
    }

    func testAnAbsentEntryDrawsNothing() {
        XCTAssertFalse(EarlierEntryRow.isDrawn(nil))
        XCTAssertFalse(EarlierEntryRow.isDrawn(Centraid_Core_V1_EarlierEntry()))
    }

    func testAnEntryWithWordsIsDrawnUnderItsId() {
        XCTAssertTrue(EarlierEntryRow.isDrawn(entry()))
        XCTAssertEqual(EarlierEntryRow.identifier, "earlier-entry")
    }

    func testTheCurrentRowHasItsTagAndNoRestore() {
        let current = row(seq: 0, current: true)
        XCTAssertTrue(CoreEarlierView.showsCurrentTag(current))
        XCTAssertFalse(CoreEarlierView.showsRestore(current))
    }

    func testAnEarlierRowRestoresAndHasNoTag() {
        let earlier = row(seq: 7, current: false)
        XCTAssertFalse(CoreEarlierView.showsCurrentTag(earlier))
        XCTAssertTrue(CoreEarlierView.showsRestore(earlier))
        XCTAssertFalse(CoreEarlierView.showsRestore(row(seq: 7, current: false, restore: "")))
    }

    func testRowsAreIdentifiedBySeq() {
        XCTAssertEqual(CoreEarlierView.rowIdentifier(7), "earlier-row-7")
        XCTAssertEqual(CoreEarlierView.restoreIdentifier(7), "earlier-restore-7")
    }
}
