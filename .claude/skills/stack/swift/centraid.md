# Swift and SwiftUI in Centraid

## Repository constraints and completion

- The iOS shell lives in `mobile/iosApp`, uses Swift 6 language mode, and targets iOS 17.5. Check API availability before using newer APIs.
- Rust owns screens, navigation, copy, and business state. Swift renders `ViewState` and performs requested platform effects; do not add product rules or user-facing strings in the shell.
- Do not edit generated design or protobuf files. Read `crates/core-ffi/CONTRACT.md` before changing the ABI bridge. `Core.swift` owns the existing serial queues; do not add GCD queues.
- After adding a Swift source file, run `xcodegen generate` from `mobile/iosApp`.
- The simulator check requires macOS, Xcode, XcodeGen, and the generated project. The canonical [iOS verification commands](../../land/mobile-commands.md#ios) cover the prerequisites: if linked Rust code changed, rebuild the simulator core from the repository root first; from `mobile/iosApp`, export `CENTRAID_IOS_DEPLOYMENT_TARGET=$(cat ../ios-deployment-target)` and run `xcodegen generate` when adding a Swift source or proto. Ensure the XcodeGen project exists before building. See the [full iOS hand-off](../../../../mobile/README.md#the-ios-hand-off) for tool setup. Then, from `mobile/iosApp`, run:

  ```sh
  xcodebuild -project Centraid.xcodeproj -scheme Centraid \
    -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
  ```

  This is the required check, with the project's own Swift 6 language mode. Swift 6 enforces complete concurrency checking; fix actor isolation and ownership errors rather than suppressing checks or using blanket unsafe annotations. Preserve the iOS 17.5 deployment floor.

- Run `cargo xtask gate --profile mobile-jvm` when the change affects the Rust core or generated tables the shell consumes. Use the simulator command for iOS changes when macOS and a simulator are available; otherwise report that it could not run.
- Done means the required simulator test (when it can run) and the other applicable checks pass, your change adds no warnings or fallible force unwraps under the project's own settings, and relevant user-triggered failures reach the user.

## Working rules

- Prefer value types, explicit states, narrow access, and meaningful typed errors. Keep business logic outside views and keep view bodies cheap and descriptive.
- Keep UI and framework state on `@MainActor`; protect shared mutable state with actors. Prefer structured `async`/`await`; use unstructured tasks only when their lifetime is deliberately managed. Check cancellation in long-running work.
- Use one source of truth. Views own state with `@State`, edit borrowed state through `@Binding` or `@Bindable`, and receive plain values when they only read. Preserve custom binding semantics when changing data flow.
- Use stable element identity in dynamic collections. Keep controls accessible, support Dynamic Type and Reduce Motion, and localize visible text.
- For detailed API and review guidance, follow the relevant [Swift](general/swift.md), [data flow](general/data.md), [view](general/views.md), [accessibility](general/accessibility.md), or [diagnostics](general/diagnostics.md) reference. Use [performance](general/performance.md) for performance work.

## Common diagnostics

- `Main actor-isolated … from a nonisolated context`: isolate the caller or explicitly hop to the actor.
- `Sending 'x' risks causing data races`: make the transferred value `Sendable` or keep it within one actor.
- A slow type-check diagnostic: split the expression or extract a view struct.
- A missing source after adding a file: regenerate the Xcode project.
- A generated protobuf type missing after editing a proto: rebuild; adding a new proto also requires project regeneration.

See [compiler and concurrency diagnostics](general/diagnostics.md) for common error patterns. For performance work, measure the same user action before and after on an optimized device build; the full workflow is in [performance](general/performance.md).

The error examples are adapted from [Bama](https://github.com/daveebbelaar/bama)'s macOS Swift skills (MIT; [license](licenses/Bama-LICENSE)). The references are adapted from [SwiftUI Pro](https://github.com/twostraws/SwiftUI-Agent-Skill) by Paul Hudson (MIT; [license](licenses/twostraws-SwiftUI-Agent-Skill-LICENSE)). They target recent iOS releases; check the deployment target before applying version-specific advice.
