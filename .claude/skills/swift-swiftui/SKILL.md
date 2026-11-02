---
name: swift-swiftui
description: >-
  Write idiomatic, safe, maintainable Swift and SwiftUI. Use this skill whenever you write, review, refactor, debug or explain Swift code: views, view state, Swift concurrency (actors, Task, Sendable, @MainActor), error handling, value types and protocols, XCTest, or the iOS shell under mobile/iosApp. Trigger on .swift files, Xcode or XcodeGen, SwiftUI, "Main actor-isolated", Sendable or data-race diagnostics, type-checker timeouts, even when the user does not ask for "best practices". Closes with how Centraid's iOS shell applies them.
---

# Swift and SwiftUI best practices

Where common advice disagrees, this file says which to follow and why. The digests in `references/` hold the detailed API-level checklists.

## 1. Mindset

- **Write Swift-shaped code.** Model absence with `Optional`, failure with `throws` or `Result`, variation with `enum`s carrying data, and shared behaviour with protocols and extensions. Class hierarchies, singletons and `Manager`/`Helper` types are smells.
- **Make invalid states unrepresentable.** An enum with associated values beats a struct of optionals and bool flags that "must be set together". Validate once at the edge, then pass a type that cannot be wrong.
- **Prefer values.** `struct` and `enum` by default; a `class` only for identity, shared mutable state or framework requirements, and then `final`.
- **Views describe, they don't decide.** A SwiftUI view is a function of state. Business rules, persistence and networking live outside the view, where they can be tested.
- **Let the compiler work.** Strict concurrency checking, exhaustive `switch` and non-optional types turn bugs into build errors. Don't silence them.

## 2. Before you hand back code

- It builds with zero warnings, and the tests pass. Fix a warning rather than hiding it.
- No force unwrap (`!`), `try!` or `as!` on a path that can fail. Where a failure truly means a programmer error, use `preconditionFailure("why")` or `fatalError("why")` with a message that names the broken invariant.
- Check the deployment target before using a newer API. Gate it with `#available` or don't use it; never raise the target to make one call compile.

## 3. Types and API design

- **Naming follows the Swift API Design Guidelines:** clarity at the call site over brevity, no type names repeated in method names (`remove(_ item:)`, not `removeItem(_:)`), argument labels that read as a phrase, Booleans read as assertions (`isEmpty`, `canSave`), factory methods begin with `make`.
- **Never name a type after a framework type** (`Task`, `View`, `Text`, `Image`, `Color`, `Section`, `Label`, `Menu`, `Group`, `Settings`). Shadowing `Task` breaks every `Task { }` in the module.
- **No `Bool` parameters in shared APIs.** Use an enum (`.summary`, `.full`) or two methods; `render(true)` cannot be read at the call site.
- **Access control is a design tool.** Start `private`, widen to `internal`, and make something `public` only when another module needs it. `fileprivate` is rarely right.
- **Protocols for real abstraction only.** Introduce one when there are two conforming types or a test seam needs it, not to organise code. Prefer protocol extensions and generics to `any` existentials on hot paths.
- **Conform to the standard protocols** a type naturally supports: `Equatable`, `Hashable`, `Identifiable` (with a stable id), `Codable`, `Sendable`, `CustomStringConvertible` for anything a person reads in logs.
- **One primary type per file**, files grouped by feature, not by kind.

## 4. Optionals and errors

- Unwrap with `guard let value else { return }` at the top of a function and `if let value` for local branches. Don't nest optional chains past the point where a value has already been validated; past a guard, the value is not optional.
- `??` with a default only when the default is a real product answer, not to make a missing value disappear.
- **Throw typed, meaningful errors** (`enum ImportError: Error { case unreadable(URL) }`) and let them propagate to the place that can act: show the member an error state, retry, or translate. Catch only to recover, translate or present.
- **A failure the member caused must reach the member.** `print(error)` in a button action is a silent failure; surface it in the UI.
- `try?` discards the reason. Use it only when every failure means the same thing.

## 5. Concurrency

Write code that compiles cleanly under strict concurrency checking (Swift 6 mode), even in a Swift 5 target.

| Work | Put it on |
| --- | --- |
| Views, view state, anything UIKit/SwiftUI touches | `@MainActor` |
| CPU-heavy pure work (decoding, diffing, image work) | a `nonisolated` async function, or a background actor |
| Shared mutable state used off the main thread | an `actor` |
| A callback from C, the system or a framework on an unknown thread | hop with `Task { @MainActor in … }` |

- **Prefer `async`/`await` over completion handlers and Grand Central Dispatch.** Don't reach for `DispatchQueue.main.async` to fix an isolation error; fix the isolation.
- **`Task { }` inherits the caller's actor and priority.** `Task.detached` drops both; use it only when that is the point, and say why in a comment.
- **Structured over unstructured.** `async let` and task groups tie child work to the parent's lifetime and cancellation; a bare `Task` does not, so store it and cancel it when its owner goes away. In SwiftUI, prefer `.task { }`, which cancels when the view disappears.
- **Check cancellation** in long loops (`try Task.checkCancellation()`), and use `Task.sleep(for:)`.
- **Data that crosses actors is `Sendable`:** value types of `Sendable` members, or `final class` with only immutable stored properties. Fix a diagnostic at the type, not with `@unchecked Sendable` or `nonisolated(unsafe)`; those are last resorts with a comment that proves safety.
- **Watch actor reentrancy.** State read before an `await` may have changed after it. Re-check invariants after every suspension point.
- **Closures handed to non-concurrency APIs** (dispatch sources, notification blocks, timers) inherit the main actor if created inside a `@MainActor` type. If they run on another thread, Swift 6 traps at runtime; mark them `@Sendable` and hop explicitly.

## 6. State and data flow in SwiftUI

- **One source of truth per piece of state.** Derive everything else; never copy state into a second `@State` and try to keep the two in sync.
- **The owner holds it, the rest borrow it.** `@State` for state a view owns (including an `@Observable` model it creates), `@Bindable`/`Binding` to edit someone else's, `@Environment` for app-wide dependencies. Pass plain values to views that only read.
- **Prefer `@Observable` (iOS 17+) to `ObservableObject`.** It tracks the properties a view actually reads, so views redraw less, and needs no `@Published`. Mark caches, timers and handles `@ObservationIgnored`.
- **Never create an observable model in a view initializer** or as a default property value of a view that isn't `@State`; it is recreated on every parent redraw.
- **Avoid `Binding(get:set:)` in `body`.** Bind to the property and move side effects into `.onChange(of:)`.
- **`ForEach` needs stable identity.** Use `Identifiable` ids, never `\.self` on values that can repeat, and never array offsets for data that can be inserted or deleted. Don't use `ForEach($items)` for deletable rows; look the item up by id.

## 7. Views, layout and navigation

- **Small views, extracted by meaning.** Split a `body` into subviews (separate `struct`s, not computed properties or functions returning `some View`) when it grows past one screen or the type checker slows down. Subview structs get their own diffing.
- **Keep `body` cheap and pure.** No formatting objects created per call, no sorting or filtering of large collections, no side effects. Precompute in the model.
- **Modifier order matters** (`padding` then `background` differs from the reverse). Prefer the modern modifiers (`foregroundStyle`, `clipShape`, `overlay(alignment:)`).
- **Lay out with stacks, `Grid` and `ViewThatFits`**, not hard-coded frames or screen sizes. Respect safe areas and Dynamic Type; test the largest accessibility size.
- **`NavigationStack` with value-based `navigationDestination`**, driven by a path the model can change, rather than `NavigationLink(destination:)` with eager views.
- **Lazy containers for long lists** (`List`, `LazyVStack`), with stable ids.
- **Animate state changes, not views:** `withAnimation` around the mutation, or `.animation(_:value:)` scoped to the value that changed.

## 8. Accessibility and localisation

- Every interactive control has a label VoiceOver can read; icon-only buttons need one explicitly. Group related elements, hide decoration, and give state as a value (`accessibilityValue`), not in the label.
- Support Dynamic Type everywhere (system text styles, no fixed heights around text) and respect Reduce Motion.
- Minimum touch target 44×44 points.
- User-visible text is localisable; format numbers, dates, names, lists and measurements with `FormatStyle`, never string concatenation or `String(format:)`.

## 9. Testing

- Test the logic outside the views: models, reducers, formatters, mappings. A view that needs a test of its logic has logic in the wrong place.
- One behaviour per test, named for the behaviour. Arrange, act, assert.
- Inject time, randomness, the network and storage so tests are deterministic.
- `async` tests `await` the result; never sleep to wait for work. Test cancellation and the error paths, not only the happy path.
- Snapshot tests catch layout regressions; record them in both colour schemes and at a large Dynamic Type size.

## 10. Performance

Fast means the first frame after a tap shows at once and nothing blocks the main thread for more than 50 ms. Every change starts and ends with a **measurement**.

```text
reproduce -> measure (release build) -> find the line -> fix -> measure again -> commit with the numbers
```

1. **Reproduce** with written steps (or a UI test) that run the slow action.
2. **Measure an optimized build on a device where you can.** Debug Swift is several times slower and points at the wrong code; a simulator shares the host's CPU and disk, so its numbers bound the experience from below and are never a budget.
3. **Find the line** with the tool for the symptom. `xcrun xctrace record --template '<name>' --output <file>.trace --time-limit 10s` works with `--attach <process>`, `--launch -- <app>`, and `--device <name or UDID>` for a device (omit it for the simulator); `xcrun xctrace list templates` shows what is installed.

   | Symptom | Template or tool |
   | --- | --- |
   | Slow action, high CPU | `'Time Profiler'` |
   | Taps or scrolls freeze briefly | `'Hangs'` |
   | Scroll or animation stutters | `'Animation Hitches'` |
   | Memory grows | `'Allocations'`; `'Leaks'` for retained cycles |
   | Battery, heat, background work | `'Energy Log'`; look for timers and polling |
   | A view redraws too often | Instruments' SwiftUI template, or `let _ = Self._printChanges()` in `body` while debugging (remove it after) |

   Read a trace as text with `xcrun xctrace export --input <file>.trace --toc`, then `--xpath` for the table you need, rather than screenshotting the Instruments window.

4. **Fix**, then **measure again** with the same steps. Put before and after in the commit message: "Library opens in 40 ms, was 600 ms".

**Delete every `.trace` after reading it, and never commit or share one.** A trace stores the profiled process's environment, and an app started from an agent's shell inherits that shell's tokens.

Rules that fix most problems:

- **Show first, work after.** Put the screen up in the same frame as the tap, then load. Never make the UI wait for the work.
- **Main actor for UI only.** Decoding, file, database and core calls go elsewhere.
- **Decode at display size.** Downsample with ImageIO (`CGImageSourceCreateThumbnailAtIndex`) before showing, and cache the result.
- **Timers get a tolerance** (`timer.tolerance`) and stop when nothing on screen needs them; prefer no polling.
- **Narrow what a view reads;** with `@Observable`, fewer properties read means fewer redraws. Split views so a frequently changing value invalidates a small subtree.
- Avoid `AnyView` and deep conditional trees in lists; prefer `@ViewBuilder` and stable structure.

This repo's own budget checks: `cargo xtask gate --profile pr` runs `call-budget` and `search-budget` against the core (Rust-side numbers, ledgers under `contracts/ledgers/`); the ceilings for on-device journeys live in `tests/journeys.json` and are promoted only from a named physical device. The `ios-xctest-metrics` device lane (`nightly` profile, macOS with an attached device) runs `-only-testing:CentraidTests/BackgroundTransferMetrics`.

## 11. Compiler errors

Fix the first error first; later ones often come from it.

| Error | Fix |
| --- | --- |
| `cannot find 'X' in scope` right after adding a file | The target globs a directory: run `xcodegen generate`, then rebuild |
| `Main actor-isolated … from a nonisolated context` | Make the caller `@MainActor`, or `await` the call |
| `Sending 'x' risks causing data races` | Make the type `Sendable`, or keep it on one actor |
| `Capture of 'x' with non-sendable type in a @Sendable closure` | Capture a value (id, copy) instead of the reference, or make the type `Sendable` |
| `The compiler is unable to type-check this expression in reasonable time` | Split the view into subview structs or `let` constants; add explicit types |
| `ambiguous use of 'Task'` | A type in the module is named `Task`; rename it |
| `Call to main actor-isolated … in a synchronous nonisolated context` | Hop with `Task { @MainActor in … }`, or mark the caller `@MainActor` |
| `Type 'X' does not conform to protocol 'View'` (huge message) | Look at the first error inside `body`; the conformance error is its echo |
| `'X' is only available in iOS 18.0 or newer` | Wrap in `if #available(iOS 18, *)` with a fallback; never raise the deployment target (17.5) |
| `Reference to property 'x' in closure requires explicit use of 'self'` | Write `self.x`, or capture `[weak self]` where the closure can outlive it |
| `Generated/*.swift` missing or stale after a `.proto` change | Rebuild: Xcode's pre-build phase regenerates it; a _new_ `.proto` also needs `xcodegen generate` |

## 12. Swift 6 errors

The target is Swift 5.9 language mode, but new code must compile clean under Swift 6 strict concurrency (`-strict-concurrency=complete`).

| Error | Fix |
| --- | --- |
| Static `let` of a non-`Sendable` type (formatter, `UIFont`, `CFString`) | `@MainActor` on the enclosing type, a computed `var`, or a commented `nonisolated(unsafe)` |
| Notification or delegate callback "risks causing data races" | Copy the `Sendable` parts (an id, a flag) out of the notification first, then hop to the actor |
| Callback known to run on the main thread (a main-queue observer, a UIKit delegate) calls main-actor code | `MainActor.assumeIsolated { … }`; it traps at runtime if the thread is wrong, so use it only where the framework guarantees main |
| Observer token captured before it is assigned | Keep the token in a small `@MainActor` class |
| "pattern that the region-based isolation checker does not understand" in a task group | An array of `Task { @MainActor in … }`, awaiting each one |
| Vars mutated from `OperationQueue` or dispatch blocks under `NSLock` | `OSAllocatedUnfairLock(initialState:)`, or move the state into an `actor` |

## 13. Final checklist

- Builds with zero warnings; clean under strict concurrency checking.
- No force unwrap, `try!` or `as!` on a fallible path.
- UI work on `@MainActor`; no new GCD; every `Task.detached` justified.
- One source of truth per state; `@Observable` for new models.
- `ForEach` ids are stable; no offsets for mutable collections.
- Every control is accessible and Dynamic Type safe; text is localisable.
- Errors reach the member; nothing user-triggered fails silently.
- Logic is tested outside views.

**Done when** the app builds with zero warnings, strict concurrency reports nothing new, `xcodebuild … test` passes in the simulator (command in `mobile/README.md`; it needs a Mac, so a Linux session says it could not run it), and `cargo xtask gate --profile mobile-jvm` is green for anything the Rust core or generated tables feed.

## 14. In this repo

The iOS shell lives in `mobile/iosApp`, generated by XcodeGen from `project.yml` (Swift 5.9 language mode, iOS 17.5 deployment target).

- **The Rust core owns the product.** Screens, navigation, copy and business state come from the core through `ScreenStore` and `Core`; Swift views render what they are given and perform effects. Don't add business state, rules or user-facing strings in Swift.
- **Generated files are never edited.** `Design/Theme.swift`, `Design/Catalog.swift` and `Design/Words.swift` come from `contracts/tools/export-native-*.ts`; the protobuf types in `Sources/Generated` are built at compile time. Use their tokens and words; no raw colours or fonts in place of the theme.
- **`Core.swift` owns the two serial queues** that call the C ABI; nothing else adds a `DispatchQueue`. Read `crates/core-ffi/CONTRACT.md` before touching the bridge.
- `ScreenStore` is an `ObservableObject` today; new models use `@Observable`, and an existing one moves when its file is touched for other work.
- Tests are XCTest under `mobile/iosApp/Tests`. The simulator test command is in `mobile/README.md`; it needs a Mac, so a Linux session cannot run it and must say so.
- After adding a Swift file, regenerate the project (`xcodegen generate`).

## References

Detailed checklists, read when the task touches the area:

- `references/swift.md`: modern Swift and Foundation API choices, concurrency rules.
- `references/data.md`: data flow, property wrappers, shared state.
- `references/views.md`: view structure, composition, animation, list editing.
- `references/performance.md`: keeping SwiftUI fast.
- `references/accessibility.md`: Dynamic Type, VoiceOver, Reduce Motion.

The error tables (sections 11 and 12) and the measuring loop are adapted from [Bama](https://github.com/daveebbelaar/bama)'s macOS Swift skills (MIT, Dave Ebbelaar, [license](licenses/Bama-LICENSE)). The references are from [SwiftUI Pro](https://github.com/twostraws/SwiftUI-Agent-Skill) by Paul Hudson (MIT, [license](licenses/twostraws-SwiftUI-Agent-Skill-LICENSE)). They target recent iOS releases: check the deployment target before applying version-specific advice.
