# Where Centraid departs from the packs

The packs under [references/](references/swiftui/state-management.md) are general SwiftUI, Swift concurrency and Swift Testing advice. Repo docs win ([#1160](https://github.com/srikanth235/centraid/issues/1160) R5): where a pack disagrees with them, this file names the conflict and the winner, and [SKILL.md](SKILL.md) states the winner. Each row links the doc that owns the rule; the rule is not restated here.

## Departures

| Pack says | This repo | Why, and the owner |
| --- | --- | --- |
| Put business logic in a view model; MVVM is optional (Avd), `@Observable` models for shared data (twostraws) | Views own no business state: Rust makes the `ViewState`, Swift draws it and sends `ScreenEvent`s. `@Observable` is for shell plumbing (`ScreenStore`, pickers, players), not screen logic | [mobile/README.md](../../../mobile/README.md#the-abi-in-one-paragraph), [R-1047-K1](../../../docs/decisions.md#the-mobile-shell) |
| Label, string and accessibility text are built in the view; localise with String Catalogs | Every word is the `ViewState`'s; copy lives in `crates/screens/src/strings`. `localization.md` and the pack's localisation material are not copied | [docs/screens.md](../../../docs/screens.md), [DESIGN.md](../../../DESIGN.md) |
| Use system colours, SF Symbols, `.secondary`, semantic fonts; follow the HIG look (twostraws `design.md`, Avd) | Every value is a generated token or stated geometry; no SF Symbols; no `.secondary`. `design.md` is not copied | [DESIGN.md](../../../DESIGN.md), [docs/traps/design-tokens.md](../../../docs/traps/design-tokens.md) |
| Adopt Liquid Glass when targeting iOS 26 | Not a code rule: the platform draws chrome, the kit draws content. `liquid-glass.md` is not copied; pack lines that mention it are out of scope | [#1160](https://github.com/srikanth235/centraid/issues/1160) R2, [DESIGN.md](../../../DESIGN.md) |
| Never use Grand Central Dispatch (twostraws) | No new `DispatchQueue`, with one standing exception: the two serial queues in `Core.swift` that keep blocking C calls off the main thread and in order. Existing uses are migrated when their file is touched | [#1160](https://github.com/srikanth235/centraid/issues/1160) R1, [CONTRACT.md](../../../crates/core-ffi/CONTRACT.md) |
| Target Swift 6.4, iOS 27, Xcode 27; use `@ContentBuilder`, `ToolbarOverflowMenu`, `alert(item:)` | Swift 5.9 language mode, iOS 17.5 floor, Xcode 26.6. Code is written to compile under Swift 6 strict concurrency; the mode switch is its own change. Anything newer than 17.5 needs `#available` or is not used | `mobile/iosApp/project.yml`, `mobile/ios-deployment-target`, `.xcode-version`, [mobile/README.md](../../../mobile/README.md#the-ios-hand-off) |
| Prefer the `Tab` API and a tab bar | One root `NavigationStack`, no tab bar; apps are covers over Home, with the kit's own band | [DESIGN.md](../../../DESIGN.md) |
| Prefer Swift Testing for new tests (AvdLee's testing pack) | XCTest, as all ten test files are. Swift Testing is not used, so the pack is kept as reference only; adopting it is the owner's call | [references/xctest-in-this-repo.md](references/xctest-in-this-repo.md), [TESTING.md](../../../TESTING.md) |
| Add `#Preview` for every view | None in the tree: views draw Rust state, and a preview needs a fixture `ViewState`. Do not add previews as a drive-by | [mobile/README.md](../../../mobile/README.md#what-runs-here-and-what-is-a-hand-off) |
| One type per file (twostraws) | Match the neighbouring file; a screen's parts live together (`TodoRowViews.swift`) | the code itself |
| Avoid UIKit (twostraws) | Use SwiftUI unless the platform needs UIKit (secure fields, AVFoundation scan); the exceptions already in `Sources/` are the bar | [mobile/README.md](../../../mobile/README.md#the-abi-in-one-paragraph) |
| Add SwiftLint, `async_without_await` (Avd concurrency pack) | No SwiftLint in the repo; the gate is the simulator build and tests. `linting.md` is not copied | [docs/toolchain.md](../../../docs/toolchain.md) |
| Time operators from `swift-async-algorithms` | The package is not a dependency; `async-algorithms.md` is not copied, and a new third-party package is an owner decision | `mobile/iosApp/project.yml` |
| Instruments trace scripts (Avd) | Scripts are not copied; Instruments is used by hand | [SOURCES.md](SOURCES.md) |

## Rules a lint could enforce (follow-up, not done here)

Candidates if the owner later adds a Swift lint or strict-concurrency build setting: no new `ObservableObject`/`@Published`; no `DispatchQueue` outside `Core.swift`; `Task.detached` needs a nearby reason comment; no `@unchecked Sendable`/`nonisolated(unsafe)` without a comment; no `ForEach(…indices…)` or `\.offset`; no `AnyView`; no `Color(red:)`, hex or `.secondary` in `Sources/`; `@State` must be `private`; `.animation` without `value:`; `SWIFT_STRICT_CONCURRENCY = complete` once the tree is clean.
