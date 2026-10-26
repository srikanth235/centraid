import XCTest

@testable import CentraidApp

/// THE FIELD'S TYPING AGAINST THE MACHINE'S ECHOES (#1047 walk, B1): a value
/// the machine says replaces what the member typed only when it is not an echo
/// of the field's own typing. Both shells' text fields ask `TypedText`. The ten
/// cases of the shared module's `TypedTextSpec`, kept with the type it became
/// (#1135).
final class TypedTextTests: XCTestCase {
    private func typed(_ initial: String, _ keys: String...) -> TypedText {
        let text = TypedText(initial: initial)
        for key in keys { _ = text.edited(next: key) }
        return text
    }

    func testASaveThatLandsMidTypingDoesNotTakeBackTheKeystrokesTypedSince() {
        let t = typed("", "Body of the w", "Body of the wa", "Body of the wal")
        XCTAssertNil(t.answer(value: "Body of the w", shown: "Body of the wal", open: false))
        // The save of "Body of the w" lands: CLEAN, a new baseline, the reload gate opens.
        XCTAssertNil(t.answer(value: "Body of the w", shown: "Body of the wal", open: true))
        XCTAssertNil(t.answer(value: "Body of the wa", shown: "Body of the wal", open: false))
        XCTAssertNil(t.answer(value: "Body of the wal", shown: "Body of the wal", open: true))
    }

    func testTheFirstSaveThatMintsTheIdDoesNotTakeBackWhatWasTypedAfterIt() {
        let t = typed("", "W", "Wa", "Wal")
        XCTAssertNil(t.answer(value: "W", shown: "Wal", open: false))
        XCTAssertNil(t.answer(value: "W", shown: "Wal", open: true))
    }

    func testALateEchoWhileTypingIsNeverAdopted() {
        let t = typed("", "a", "ab", "abc")
        XCTAssertNil(t.answer(value: "a", shown: "abc"))
        XCTAssertNil(t.answer(value: "ab", shown: "abc"))
    }

    func testAnEchoOfAnEmptiedFieldIsNotAClear() {
        // Typed x, erased it, typed y.
        let t = typed("", "x", "", "y")
        XCTAssertNil(t.answer(value: "x", shown: "y"))
        XCTAssertNil(t.answer(value: "", shown: "y"))
        XCTAssertNil(t.answer(value: "y", shown: "y"))
    }

    func testAClearAfterSubmitLandsEvenToAValueTheMemberOnceTyped() {
        let t = typed("", "W", "", "Work")
        XCTAssertNil(t.answer(value: "Work", shown: "Work"))
        XCTAssertEqual(t.answer(value: "", shown: "Work"), "")
    }

    func testAClearLandsWhenTheStatesBetweenWereConflatedAway() {
        let t = typed("", "a", "ab", "a")
        // The view only ever saw the final echo: every keystroke is heard.
        XCTAssertNil(t.answer(value: "a", shown: "a"))
        XCTAssertEqual(t.answer(value: "", shown: "a"), "")
    }

    func testAValueTheMemberDidNotTypeLands() {
        // A splice, a remote load, a generated value.
        let t = typed("abc", "abcd")
        XCTAssertNil(t.answer(value: "abcd", shown: "abcd"))
        XCTAssertEqual(t.answer(value: "abcd [[Plan]]", shown: "abcd"), "abcd [[Plan]]")
    }

    func testAClosedGateHoldsAValueTheMemberDidNotType() {
        let t = typed("abc")
        XCTAssertNil(t.answer(value: "xyz", shown: "abc", open: false))
        XCTAssertEqual(t.answer(value: "xyz", shown: "abc", open: true), "xyz")
    }

    func testTypingBackToTheMachinesStaleValueIsStillSent() {
        let t = TypedText(initial: "a")
        XCTAssertTrue(t.edited(next: "ab"))
        XCTAssertTrue(t.edited(next: "a"))
        XCTAssertFalse(t.edited(next: "a"))
        XCTAssertNil(t.answer(value: "ab", shown: "a"))
        XCTAssertNil(t.answer(value: "a", shown: "a"))
    }

    func testAfterAnAdoptionTheAdoptedValueIsNotResent() {
        let t = typed("", "a")
        XCTAssertNil(t.answer(value: "a", shown: "a"))
        XCTAssertEqual(t.answer(value: "loaded", shown: "a"), "loaded")
        XCTAssertFalse(t.edited(next: "loaded"))
        XCTAssertTrue(t.edited(next: "loaded!"))
    }
}
