import SwiftUI
import XCTest

@testable import CentraidApp

/// Completion belongs to the page, including the background drawn under the owner prompt.
@MainActor
final class WordsShowLifecycleTests: XCTestCase {
    func testFinishedOwnerCheckBackgroundLeavesOnAppearance() async throws {
        let finished = expectation(description: "Finished words page leaves")
        let model = Model(finished: true)
        let page = try host(model: model, onDone: { finished.fulfill() })

        let result = await XCTWaiter.fulfillment(of: [finished, page.appeared], timeout: 5)
        XCTAssertEqual(result, .completed)
        close(page)
    }

    func testOwnerCheckCancellationLeavesWithoutShowingWords() async throws {
        let appeared = expectation(description: "Owner check background appears")
        let finished = expectation(description: "Cancelled words page leaves")
        let model = Model(finished: false)
        var completions = 0
        let page = try host(model: model, onDone: {
            completions += 1
            finished.fulfill()
        }, onAppear: { appeared.fulfill() })

        let appearedResult = await XCTWaiter.fulfillment(of: [appeared, page.appeared], timeout: 5)
        XCTAssertEqual(appearedResult, .completed)
        XCTAssertEqual(completions, 0)
        XCTAssertTrue(model.state.checkNow)
        XCTAssertTrue(model.state.words.isEmpty)
        model.state.finished = true

        let finishedResult = await XCTWaiter.fulfillment(of: [finished], timeout: 5)
        XCTAssertEqual(finishedResult, .completed)
        XCTAssertEqual(completions, 1)
        XCTAssertTrue(model.state.checkNow)
        XCTAssertTrue(model.state.words.isEmpty)
        close(page)
    }

    private func host(
        model: Model,
        onDone: @escaping () -> Void,
        onAppear: @escaping () -> Void = {}
    ) throws -> HostedPage {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
        let appeared = expectation(description: "Hosting controller completed appearance")
        let controller = HostingController(rootView: Page(model: model, onDone: onDone, onAppear: onAppear))
        controller.onAppeared = { appeared.fulfill() }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        return HostedPage(
            window: window,
            previousKeyWindow: previousKeyWindow,
            controller: controller,
            appeared: appeared
        )
    }

    private func close(_ page: HostedPage) {
        // SwiftUI onAppear/onDone can precede UIKit's completed presentation. Both tests wait
        // for viewDidAppear before hiding. A hidden window need not emit viewDidDisappear;
        // detach its root explicitly and restore the app's previous key window.
        page.controller.onAppeared = nil
        page.window.isHidden = true
        page.window.rootViewController = nil
        page.previousKeyWindow?.makeKeyAndVisible()
        XCTAssertTrue(page.window.isHidden)
        XCTAssertNil(page.window.rootViewController)
    }

    private struct HostedPage {
        let window: UIWindow
        let previousKeyWindow: UIWindow?
        let controller: HostingController
        let appeared: XCTestExpectation
    }

    private final class HostingController: UIHostingController<Page> {
        var onAppeared: (() -> Void)?

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            onAppeared?()
        }

    }

    private final class Model: ObservableObject {
        @Published var state: Centraid_Core_V1_WordsShowState

        init(finished: Bool) {
            state = .with {
                $0.checkNow = true
                $0.finished = finished
            }
        }
    }

    private struct Page: View {
        @ObservedObject var model: Model
        let onDone: () -> Void
        let onAppear: () -> Void

        var body: some View {
            WordsShowView(state: model.state, send: { _ in }, onDone: onDone)
                .onAppear(perform: onAppear)
        }
    }
}
