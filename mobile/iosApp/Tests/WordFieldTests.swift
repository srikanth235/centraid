import XCTest

@testable import CentraidApp

/// `words.enter`'s cell, where a run of words typed into one cell spreads on
/// (#1047 E5): the cell must come to rest on the word the machine kept, not on
/// the run the member typed.
final class WordFieldTests: XCTestCase {
    func testARunKeepsItsFirstWordAsTheMachineSplitsIt() {
        XCTAssertEqual(WordField.keptWord(of: "abandon ability able"), "abandon")
        XCTAssertEqual(WordField.keptWord(of: "abandon "), "abandon")
        XCTAssertEqual(WordField.keptWord(of: "abandon\nability"), "abandon")
        // `spread` keeps an empty first part, so a leading space leaves the
        // cell empty and the word goes on to the next one.
        XCTAssertEqual(WordField.keptWord(of: " abandon"), "")
    }

    func testOneWordIsNotARun() {
        XCTAssertNil(WordField.keptWord(of: "abandon"))
        XCTAssertNil(WordField.keptWord(of: ""))
    }
}
