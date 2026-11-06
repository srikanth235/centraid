import XCTest
@testable import CentraidApp

@MainActor
final class ScreenLifecycleTests: XCTestCase {
    func testColdStartReplaysActiveAfterTheRuntimeOpens() {
        let lifecycle = ScreenLifecycle()
        var received: [Bool] = []

        // The scene becomes active while Core.open is still running.
        lifecycle.changed(foreground: true)
        XCTAssertTrue(received.isEmpty)
        lifecycle.attach { received.append($0) }

        XCTAssertEqual(received, [true])
    }

    func testLeavingDuringStartupReplaysOnlyTheCurrentBackgroundState() {
        let lifecycle = ScreenLifecycle()
        var received: [Bool] = []

        lifecycle.changed(foreground: true)
        lifecycle.changed(foreground: false)
        lifecycle.attach { received.append($0) }

        // Replaying the old active state could ask permission in the background.
        XCTAssertEqual(received, [false])
    }

    func testAttachedRuntimeReceivesEachLaterTransition() {
        let lifecycle = ScreenLifecycle()
        var received: [Bool] = []

        lifecycle.attach { received.append($0) }
        lifecycle.changed(foreground: true)
        lifecycle.changed(foreground: false)
        lifecycle.changed(foreground: true)

        XCTAssertEqual(received, [true, false, true])
    }

    func testBackgroundLaunchWithoutASceneDoesNotInventForeground() {
        let lifecycle = ScreenLifecycle()
        var received: [Bool] = []

        lifecycle.attach { received.append($0) }

        XCTAssertTrue(received.isEmpty)
    }
}
