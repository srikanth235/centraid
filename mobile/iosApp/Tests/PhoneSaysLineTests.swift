import XCTest

@testable import CentraidApp

/// THE PHONE-SAYS LINE (#1183): when it is drawn at all, and the ids a flow finds it by.
final class PhoneSaysLineTests: XCTestCase {
    private func line(
        lead: String = "Phone says Ada Lovelase",
        action: String = "Use phone’s",
        field: String = "name",
        item: String? = nil
    ) -> Centraid_Core_V1_PhoneSays {
        var says = Centraid_Core_V1_PhoneSays()
        says.lead = lead
        says.actionLabel = action
        says.accessibilityLabel = "Use the name your phone has, Ada Lovelase"
        says.take.field = field
        if let item { says.take.itemKey = item }
        return says
    }

    func testAnEmptyLineDrawsNothing() {
        XCTAssertFalse(PhoneSaysLine.isDrawn(Centraid_Core_V1_PhoneSays()))
        XCTAssertFalse(PhoneSaysLine.isDrawn(line(lead: "")))
        XCTAssertFalse(PhoneSaysLine.isDrawn(line(action: "")))
    }

    func testALineWithWordsIsDrawn() {
        XCTAssertTrue(PhoneSaysLine.isDrawn(line()))
    }

    func testAWholeFieldIsIdentifiedByItsFieldAlone() {
        let ids = PhoneSaysLine.identifiers(for: line().take)
        XCTAssertEqual(ids.line, "phone-says-name")
        XCTAssertEqual(ids.take, "phone-says-take-name")
    }

    func testAnItemOfAFieldIsIdentifiedByFieldAndItem() {
        let ids = PhoneSaysLine.identifiers(for: line(field: "channels", item: "email:ada@lovelace.example").take)
        XCTAssertEqual(ids.line, "phone-says-channels-email:ada@lovelace.example")
        XCTAssertEqual(ids.take, "phone-says-take-channels-email:ada@lovelace.example")
    }

    func testATakeWithNothingNamedStillHasStableIds() {
        let ids = PhoneSaysLine.identifiers(for: Centraid_Core_V1_PhoneSaysTake())
        XCTAssertEqual(ids.line, "phone-says")
        XCTAssertEqual(ids.take, "phone-says-take")
    }
}
