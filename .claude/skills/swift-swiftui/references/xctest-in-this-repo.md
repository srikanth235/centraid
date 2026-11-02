# XCTest in this repo

The ten files in `mobile/iosApp/Tests/` are the idiom; read the nearest one before writing another. This file states what they share. It is the repo's, not a pack's.

## Shape

- `final class FooTests: XCTestCase`, `@testable import CentraidApp` (the app target's `PRODUCT_MODULE_NAME`, `mobile/iosApp/project.yml`).
- The doc comment on the class says what the file proves and what it cannot (the part that needs a device is named as an owner hand-off, with a link to [docs/release/v1-handoffs.md](../../../../docs/release/v1-handoffs.md)). See `Tests/LibraryDeletionTests.swift` and `Tests/GatewayBrowseTests.swift`.
- Method names are sentences that state the rule: `testAnEditedAssetGoesOnlyWhenTheGatewayHasTheVersionTheLibraryHoldsNow`.
- Each rule has a negative case beside the positive one. A gate seen only green is a gate nobody saw refuse.

## What gets tested

Logic that has been pulled out of the OS: the decision structure of a browse (`GatewayBrowseRun`), which assets may be deleted (`LibraryDeletion`), the sleep merge, markdown parsing, clock formatting, the icon path parser, the typed-text state. The OS edge is a protocol with a fake (`ServiceFinder` and `AddressResolver` in `GatewayBrowseTests`; `ScreenCore` for `ScreenStore`). When a decision lives inside a UIKit-typed signature, extract it first, then test it. Do not test that SwiftUI draws.

## Mechanics

- A new file under `Tests/` is invisible until `xcodegen generate` (the target globs the directory when the project is generated).
- There is no `swift test` and no SwiftPM package: `Sources/` imports UIKit and links the core's C archive, so the simulator bundle is the only route ([mobile/README.md](../../../../mobile/README.md#the-ios-hand-off)).
- Run one class: `xcodebuild -project Centraid.xcodeproj -scheme Centraid -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -only-testing:CentraidTests/GatewayBrowseTests test`. Give each concurrent run its own `-derivedDataPath`.
- The test bundle uses `GENERATE_INFOPLIST_FILE`; it has no `Info.plist` of its own. Tests that read the app bundle (`FontRegistrationTests`) mean nothing outside a real app bundle.
- A Linux session cannot compile or run any of this. State that in the report; do not claim a test passes.

## Async and time

- `async` test methods; `await fulfillment(of: [expectation], timeout:)` in them. A synchronous test may use `wait(for:)`, as `GatewayBrowseTests` does.
- Make time a parameter (the browse takes `window:`), so a test passes a short one; never sleep to wait for something that should happen. A sleep to prove that something does not happen after a window closed is the one acceptable use.
- Actor-isolated code under test: mark the test method or class `@MainActor`, or `await` into the actor.

## Swift Testing

Not used in this tree. The packs' [references/testing/](testing/fundamentals.md) are kept for the day the owner adopts it, and [migration-from-xctest.md](testing/migration-from-xctest.md) is the route. Until then a new test is XCTest, in the file's own style.
