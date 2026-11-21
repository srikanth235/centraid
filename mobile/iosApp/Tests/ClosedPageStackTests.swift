import XCTest

@testable import CentraidApp

/// A PAGE THE CORE CLOSED LEAVES THE STACK (#1202, S13). A restore closes every screen, the words page
/// among them; the entry must leave `path` (or the sheet) and the stack must be rebuilt, or the member
/// sits on bare paper with a back key until the app is relaunched.
@MainActor
final class ClosedPageStackTests: XCTestCase {
    private func entry() -> RustEntry { RustEntry.make(Centraid_Core_V1_Route()) }

    func testAClosedPageLeavesThePathAndTheStackIsRebuilt() {
        let closed = entry()
        let other = entry()
        var path: [ShellModel.Route] = [.rust(other), .rust(closed)]
        var sheet: RustEntry?
        var epoch = 0
        ShellModel.dropClosed(closed, path: &path, sheet: &sheet, epoch: &epoch)
        XCTAssertEqual(path, [.rust(other)])
        XCTAssertEqual(epoch, 1)
    }

    func testAClosedPageAlreadyOffThePathStillRebuildsTheStack() {
        // The restore case: `path` was already empty, and SwiftUI still drew the page.
        let closed = entry()
        var path: [ShellModel.Route] = []
        var sheet: RustEntry?
        var epoch = 4
        ShellModel.dropClosed(closed, path: &path, sheet: &sheet, epoch: &epoch)
        XCTAssertTrue(path.isEmpty)
        XCTAssertEqual(epoch, 5)
    }

    func testAClosedSheetIsDismissed() {
        let closed = entry()
        var path: [ShellModel.Route] = []
        var sheet: RustEntry? = closed
        var epoch = 0
        ShellModel.dropClosed(closed, path: &path, sheet: &sheet, epoch: &epoch)
        XCTAssertNil(sheet)
    }

    func testAnotherSheetIsLeftAlone() {
        let closed = entry()
        let shown = entry()
        var path: [ShellModel.Route] = []
        var sheet: RustEntry? = shown
        var epoch = 0
        ShellModel.dropClosed(closed, path: &path, sheet: &sheet, epoch: &epoch)
        XCTAssertEqual(sheet, shown)
    }
}
