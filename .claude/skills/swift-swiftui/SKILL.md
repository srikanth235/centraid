---
name: swift-swiftui
description: Swift, Swift concurrency, SwiftUI and XCTest rules for Centraid's iOS shell (mobile/iosApp). Use when writing, reviewing or debugging any .swift file in this repo - a view for a Rust ViewState, an effect performer, ScreenStore or Core, a test - or on Sendable, actor-isolation, "Main actor-isolated", ObservableObject/@Observable, ForEach identity, type-checker timeout or "cannot find in scope" errors.
---

# Swift and SwiftUI in the iOS shell

The Rust core decides what a person sees; Swift draws a `ViewState`, sends `ScreenEvent`s and performs the platform work Rust asks for ([mobile/README.md](../../../mobile/README.md#the-abi-in-one-paragraph), [crates/core-ffi/CONTRACT.md](../../../crates/core-ffi/CONTRACT.md), [docs/screens.md](../../../docs/screens.md)). Where this file and a repo doc disagree, the doc wins; [CENTRAID.md](CENTRAID.md) lists every place the packs this skill draws on were overruled.

Toolchain facts (read them again if a change touches build settings): language mode `SWIFT_VERSION: "5.9"` in `mobile/iosApp/project.yml`, deployment floor in `mobile/ios-deployment-target` (17.5), Xcode pinned in `.xcode-version` (26.6). Write code that would compile clean in Swift 6 language mode (the switch is a separate change, [#1160](https://github.com/srikanth235/centraid/issues/1160) R1). A Linux session has no Swift compiler: you cannot build, so reason from the code and say so in the report.

## Where work goes

| Work | Put it in |
| --- | --- |
| A label, sentence, chip, hue, enabled flag, empty-state choice, accessibility label, destination | The Rust `ViewState`. A view that needs one the state lacks reports a gap in Rust, never computes it ([R-1047-K1](../../../docs/decisions.md#the-mobile-shell)) |
| Draw one `ViewState` arm | A `View` struct, routed from `Sources/RustScreenHost.swift`; takes the state plus `send` closures |
| A tap, edit, appearance | `store.send(instance, .event)`; the view holds no business state |
| A platform capability Rust asks for (Keychain, Photos, EventKit, BGTask, NWBrowser) | An effect performer beside `ScreenStore` that answers with an `EffectResult` |
| Pure formatting or parsing the shell must own | A free-standing type with no UIKit in its signature, so a test can reach it |
| A design value (colour, type, spacing, radius, icon) | `Theme` / `CentraidTokens` / `CentraidCatalog`; never a literal |

## Concurrency

Rules for iOS 17.5 on Swift 5.9 mode, written to stay clean under Swift 6.

| Work | Use |
| --- | --- |
| Views, `ScreenStore`, `ShellModel`, anything a view reads | `@MainActor` on the type |
| Shared mutable state off the main thread | An `actor` (as `Core`); one owner, small isolated sections |
| Blocking or CPU-heavy work (decode, directory walk, HealthKit statistics) | A `nonisolated` async function that does not inherit the caller's actor (`@concurrent`, Swift 6.2 compiler; not yet used in this tree, so confirm it builds) or, as existing code does, `Task.detached(priority:)` with a comment saying why it must not inherit the actor |
| A blocking C call | The serial queues inside `Core` (see below); nowhere else |
| N known parallel awaits / unknown count | `async let` / `withTaskGroup` |
| Fire-and-forget from a synchronous `@MainActor` method | `Task { }` (inherits the actor); hold the handle if it must be cancelled |
| A delegate or OS callback (`@objc`, `URLSessionDelegate`, `PHPhotoLibraryChangeObserver`) | `nonisolated` method that hops with `Task { @MainActor in }`; closure parameters `@Sendable` |
| A callback API with one answer | `withCheckedContinuation`, resumed exactly once on every path |
| A stream of values | `AsyncStream` with a stated buffering policy; end it when its owner dies |
| A delay or timeout | `try await Task.sleep(for:)` inside a cancellable `Task`, never `asyncAfter` |

- `Core.swift` keeps two serial `DispatchQueue`s on purpose: `centraid_call` and `centraid_next_event` block, must run off the main thread (the core asserts the UI thread by name in debug), and the screens lane must answer in the order sent ([CONTRACT.md](../../../crates/core-ffi/CONTRACT.md)). That is the one reason a new queue is acceptable. Every other `DispatchQueue` in `Sources/` is legacy: touch one, replace it.
- Data that crosses an isolation boundary is `Sendable`: a struct or enum of `Sendable` values, or a `final class` of `let` properties. The generated SwiftProtobuf messages are value types, so they cross freely.
- Fix a diagnostic at its type. `@unchecked Sendable`, `nonisolated(unsafe)` and `@preconcurrency` need a comment stating the invariant that makes them safe (compare the `Raw` pointer wrapper in `Core.swift`).
- **Runtime trap the compiler misses.** A closure made in a `@MainActor` type and handed to an API with no `@Sendable` parameter (`DispatchSource`, `DispatchWorkItem`, `AVCaptureSession` handlers, `NWBrowser` handlers) inherits the main actor; when it runs on another queue Swift 6 traps. Write it `{ @Sendable in ... }`, hop explicitly, and run the background path once.
- Check `Task.isCancelled` (or call a throwing `Task` API) in loops that outlive a screen. `.task { }` on a view is cancelled with the view; prefer it to a `Task` stored by hand.

## State

| Need | Use |
| --- | --- |
| A model object a view reads | `@Observable` `@MainActor final class` (new code) |
| The view that creates the model | `@State private var model = Model()` |
| A model passed in that the view binds to | `@Bindable var model` |
| A model many views need | `.environment(model)` and `@Environment(Model.self)` |
| One value the view alone owns | `@State private var` (always `private`) |
| A value the parent owns and the child edits | `@Binding` |
| A cache or handle on a model | `@ObservationIgnored` |
| Small user preference | `@AppStorage` in a view only (never inside an `@Observable`); secrets in the Keychain via `SecretStores` |

- `ObservableObject`, `@Published`, `@StateObject`, `@ObservedObject` and `@EnvironmentObject` are legacy: leave them in files you do not otherwise touch; migrate the type when its file is touched for other work ([observable-migration](references/observable-migration.md)). Never write a new one.
- Views read `ScreenStore` (navigation, `views[instance]`); they never keep a copy of what Rust pushed, and never cache a derived business value in `@State`.
- `@State` seeded from a parent value is a one-time seed. If the parent value can change, read it directly or key the view with `.id`.
- A stored closure in a custom `@Environment` key defeats change detection: put data and a method on a struct or `@Observable` instead (existing keys such as `\.askChat` predate this; do not copy them).

## Navigation, sheets, lists

- One `NavigationStack(path:)` with `navigationDestination(for:)`, registered once per type; Rust holds the stack and the shell mirrors it ([RustScreenHost](../../../mobile/iosApp/Sources/RustScreenHost.swift)). Never `NavigationView`, never `NavigationLink(destination:)` beside it.
- Present with `sheet(item:)`, not `sheet(isPresented:)` plus a separate value. Anything a sheet or dialog shows is drawn from the kit, not hand-rolled.
- Rows: a tappable row is a `Button` with `KitRowPress`, never `onTapGesture`.
- `ForEach` identity comes from the element: `Identifiable` or `id: \.stableField`. Never `.indices`, never `\.offset`, never an id built from editable text, never an id minted inside `body`. Never `ForEach($items)` over data that can be deleted while the row is on screen: look the element up by id.
- A `List` row or `ForEach` element yields a constant number of views.
- `LazyVStack` inside `ScrollView` for long content; no `AnyView`; no `GeometryReader` where `containerRelativeFrame`, `visualEffect` or a `Layout` does it.

## Design values

- Colours, type, spacing, radii and icons come from the generated tables through `Theme.color(_:_:)`, `.centraidType(_:)`, `Theme.spacing`, `Theme.radius` and `CentraidCatalog`. No hex, no `Color(red:)`, no `.secondary`/`.primary`, no SF Symbols, no `Font.system` ([DESIGN.md](../../../DESIGN.md), [trap](../../../docs/traps/design-tokens.md)).
- Never edit `Design/{Theme,Catalog,Words}.swift` or `Sources/Generated/**`; they are emitted ([generated files](../../../mobile/README.md#generated-files--do-not-edit)). A missing token is a change in `packages/design`.
- Liquid Glass exists on iOS 26 and is out of scope here: the platform draws chrome, the kit draws content ([DESIGN.md](../../../DESIGN.md)); do not call `glassEffect` or its styles, and do not apply any pack advice about them.
- Reduced motion: read `@Environment(\.accessibilityReduceMotion)` and drop the slide to a fade (see `OnboardingViews.swift`). `.animation` always takes `value:`.
- Dynamic Type is capped once at the root ([DESIGN.md](../../../DESIGN.md)); views do not re-cap.

## Accessibility

- Every label comes from the `ViewState` (`row.accessibilityLabel`), never a string made in the view. Decorative icons are `.accessibilityHidden(true)`.
- Icon-only controls are `Button`s with a label; targets are at least `CentraidGeometry.targetMinCoarse` (44).
- Interactive and asserted elements carry an `accessibilityIdentifier` following [mobile/maestro/flows/selectors.md](../../../mobile/maestro/flows/selectors.md); pair a new id with the flow that proves it selects one thing.
- Group a row with `.accessibilityElement(children: .combine)` only when its parts read as one sentence.

## Performance

- A `View` is an invalidation boundary: pass it only what it reads; split fast-changing state into the smallest subview.
- `body` is cheap and pure: no sorting, formatting, I/O, `Date()`, or object creation in it. Compute in Rust or in the model once.
- Decode images off the main actor and downsample to the display size ([PhotosLightboxStage](../../../mobile/iosApp/Sources/PhotosLightboxStage.swift)).
- Profile with Instruments before optimising; present a speed-up as a measured one.
- If the type checker reports it cannot check an expression, split the view into subviews or `let` constants (the app root does this on purpose).

## Testing

- Unit tests are XCTest, `final class FooTests: XCTestCase`, `@testable import CentraidApp`, sentence-style names (`testAnIPv4EndpointIsHostColonPort`), the invariant stated in the doc comment. Swift Testing is not used in this tree; do not introduce it in one file ([CENTRAID.md](CENTRAID.md)).
- Reach logic through a seam (`ScreenCore`, `ServiceFinder`, a fake) and test the decision, not the OS. What needs a device or simulator is an owner hand-off ([mobile/README.md](../../../mobile/README.md#what-runs-here-and-what-is-a-hand-off)).
- Async: `async` test methods and `await fulfillment(of:)`; never `wait(for:)` in an async test; never sleep to wait for a positive result.
- Every behaviour change gets a negative case beside the positive one.
- No `#Preview`, no snapshot test, until swift-snapshot-testing is added (README hand-off).
- Write tests in [references/xctest-in-this-repo.md](references/xctest-in-this-repo.md).

## Names Swift already uses

Never name a type `Task`, `View`, `Color`, `Image`, `Text`, `Section`, `Label`, `Menu`, `Group`, `Scene`, `Result`, `Error` or `Data`. A type called `Task` breaks every `Task { }`; the generated protobuf types are `Centraid_Core_V1_*` for the same reason.

## Always

- Match the neighbouring file: header comment states the invariant, one type per file unless the types are one idea.
- Add a new `Sources/**.swift` or `Tests/**.swift`, then run `xcodegen generate`: the project is generated and globbing happens then.
- Optional-unwrap with `guard let` / `if let x`; propagate or show a failure; a failure a member caused is never swallowed with `print`.
- Use `Task.sleep(for:)`, `URL.appending(path:)`, `FormatStyle`, `foregroundStyle`, `clipShape(.rect(cornerRadius:))`, `onChange(of:) { old, new in }`.
- Gate any iOS 18 or later API with `#available` (the floor is 17.5).

## Never

- `DispatchQueue` for new code outside `Core`; `Thread`, semaphores or locks in async code; `Task.detached` without a stated reason.
- `@unchecked Sendable` or `nonisolated(unsafe)` to silence a diagnostic.
- A new `ObservableObject`; `ForEach` over indices; `AnyView`; `onTapGesture` for a button.
- Business logic, copy, counting or a timer in a view; a literal colour or font.
- Calling `centraid_*` symbols except through `Core`; holding a buffer past `centraid_free`.
- Editing a generated file, a `.xcodeproj`, or `project.yml` settings to make a build pass.
- `try!`, `!` on data from outside the process, `fatalError` for a recoverable failure.

## Compiler and runtime errors

Fix the first error first; later ones often follow from it.

| Error | Fix |
| --- | --- |
| `cannot find 'X' in scope` after adding a file | `xcodegen generate` (globbed at generation); for `Centraid_Core_V1_*` the pre-build proto phase must have run |
| `Main actor-isolated ... cannot be used from a nonisolated context` | Make the caller `@MainActor`, or `await` the call; do not sprinkle `MainActor.run` |
| `Call to main actor-isolated initializer in a synchronous nonisolated context` | Create the object inside a `@MainActor` context or make the factory `@MainActor` |
| `Sending 'x' risks causing data races` | Send a `Sendable` value or a snapshot; keep the reference on one actor |
| `Capture of 'x' with non-sendable type in a '@Sendable' closure` | Copy the needed `Sendable` fields before the closure; do not capture `self` of a non-`Sendable` class |
| `Static property 'x' is not concurrency-safe` | `let` of a `Sendable` type, `@MainActor` on the owner, or a commented `nonisolated(unsafe)` |
| `Actor-isolated property cannot be mutated from a non-isolated context` | Add an actor method that mutates, `await` it |
| `Expression is 'async' but is not marked with 'await'` | Add `await`; the caller must be async or a `Task` |
| `Reference to property in closure requires explicit use of 'self'` | `self.` or `[weak self]` per ownership; a `Task` on a long-lived object captures `[weak self]` |
| `Conformance of 'X' to protocol 'Y' crosses into main actor-isolated code` | Prefer an isolated conformance (`extension X: @MainActor Y`) on Swift 6.2; else `nonisolated` for requirements that need no state |
| `Type 'X' does not conform to protocol 'Sendable'` on a class | `final class` with `let` stored properties, or make it an `actor`/`@MainActor` |
| `The compiler is unable to type-check this expression in reasonable time` | Extract subviews, `let` intermediates, give literals types |
| `Ambiguous use of 'Task'` | A type in your code is named `Task`; rename it |
| `Instance method 'wait' is unavailable from asynchronous contexts` | `await fulfillment(of:timeout:)` |
| `Cannot find '$model' in scope` on an `@Observable` | The view needs `@Bindable var model` to project bindings |
| Runtime: `EXC_BREAKPOINT` in `_dispatch_assert_queue_fail` | A main-actor closure ran on a background queue; mark it `@Sendable` and hop |
| Runtime: `-34018` from `SecItem*` | The entitlement is missing; see `project.yml` `entitlements`, not the call site |

## Go deeper

| When | Open |
| --- | --- |
| Moving an `ObservableObject` to `@Observable` | [references/observable-migration.md](references/observable-migration.md) |
| Writing or reviewing a test | [references/xctest-in-this-repo.md](references/xctest-in-this-repo.md) |
| Property wrappers, `@Observable` granularity | [references/swiftui/state-management.md](references/swiftui/state-management.md) |
| Splitting a big view, `@ViewBuilder` | [references/swiftui/view-structure.md](references/swiftui/view-structure.md) |
| Lists, `ForEach`, identity | [references/swiftui/list-patterns.md](references/swiftui/list-patterns.md) |
| Redraw cost, `_printChanges` | [references/swiftui/performance-patterns.md](references/swiftui/performance-patterns.md) |
| Custom environment keys, `@Entry` | [references/swiftui/environment-patterns.md](references/swiftui/environment-patterns.md) |
| Sheets, alerts, stacks | [references/swiftui/sheet-navigation-patterns.md](references/swiftui/sheet-navigation-patterns.md) |
| Scroll position, `ScrollViewReader` | [references/swiftui/scroll-patterns.md](references/swiftui/scroll-patterns.md) |
| Focus | [references/swiftui/focus-patterns.md](references/swiftui/focus-patterns.md) |
| VoiceOver, Dynamic Type | [references/swiftui/accessibility-patterns.md](references/swiftui/accessibility-patterns.md) |
| Animation | [basics](references/swiftui/animation-basics.md), [transitions](references/swiftui/animation-transitions.md), [advanced](references/swiftui/animation-advanced.md) |
| Layout and safe areas | [references/swiftui/layout-best-practices.md](references/swiftui/layout-best-practices.md) |
| Image decoding | [references/swiftui/image-optimization.md](references/swiftui/image-optimization.md) |
| Toolbars, text, modifiers | [toolbar](references/swiftui/toolbar-patterns.md), [text](references/swiftui/text-patterns.md), [modifiers](references/swiftui/modifier-patterns.md) |
| A deprecated API | [latest-apis](references/swiftui/latest-apis.md), [soft-deprecation](references/swiftui/soft-deprecation.md) |
| A review checklist for SwiftUI | [references/swiftui-pro/](references/swiftui-pro/api.md): api, data, views, navigation, performance, accessibility, swift, hygiene |
| Actor isolation, reentrancy | [references/concurrency/actors.md](references/concurrency/actors.md) |
| `Sendable` | [references/concurrency/sendable.md](references/concurrency/sendable.md) |
| `Task`, groups, cancellation | [references/concurrency/tasks.md](references/concurrency/tasks.md) |
| Threads versus isolation | [references/concurrency/threading.md](references/concurrency/threading.md) |
| Retain cycles in tasks | [references/concurrency/memory-management.md](references/concurrency/memory-management.md) |
| Strict-concurrency migration | [references/concurrency/migration.md](references/concurrency/migration.md) |
| `AsyncSequence`, `AsyncStream` | [references/concurrency/async-sequences.md](references/concurrency/async-sequences.md) |
| `@Observable` across actors | [references/concurrency/observation.md](references/concurrency/observation.md) |
| Async tests | [references/concurrency/testing.md](references/concurrency/testing.md) |
| Terms | [references/concurrency/glossary.md](references/concurrency/glossary.md) |
| Swift Testing, if the owner adopts it | [references/testing/fundamentals.md](references/testing/fundamentals.md) and its neighbours |

Pack references quote iOS 18 to 27 APIs and Xcode 27 toolchain features; the floor here is iOS 17.5 on Xcode 26.6, so check availability before using any.

## Done when

The change builds with zero warnings and no new Swift 6 diagnostics, and on a Mac the simulator command from [mobile/README.md](../../../mobile/README.md#the-ios-hand-off) is green: `xcodegen generate` in `mobile/iosApp`, then `xcodebuild -project Centraid.xcodeproj -scheme Centraid -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test`. A Linux session cannot run it; say so in the report and name the owner hand-off. On any machine, `cargo xtask doc-links` passes for the docs you touched, and a token or word change is regenerated, never hand-edited.
