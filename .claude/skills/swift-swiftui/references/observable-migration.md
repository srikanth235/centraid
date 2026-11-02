# Moving an `ObservableObject` to `@Observable`

Ruling ([#1160](https://github.com/srikanth235/centraid/issues/1160) R1): new code uses `@Observable`; an `ObservableObject` migrates when its file is touched for other work. Migrate one type per change and keep the change reviewable. The tree's legacy types are `ScreenStore`, `ShellModel`, `ChatModel`, `DocsFiles`, `DocsFollow`, `LightboxPlayer` and `LightboxMedia`.

## The type

1. Delete `: ObservableObject` and add `@Observable` above `final class`; keep `@MainActor`.
2. Delete `@Published`. A `private(set)` stays.
3. Mark anything a view must not redraw for with `@ObservationIgnored`: callbacks (`onAnnounce`), observer tokens, continuations, caches, queues, `weak` delegates.
4. Delete `import Combine` when no `$property` publisher, `AnyCancellable` or `PassthroughSubject` is left.
5. Keep an initialiser that takes the dependencies (`ScreenStore.init(core:)`). Observation does not change injection.

## The views

| Before | After |
| --- | --- |
| `@StateObject private var m = Model()` | `@State private var m = Model()` |
| `@ObservedObject var m: Model` | `var m: Model`, or `@Bindable var m: Model` when the body writes `$m.x` |
| `@EnvironmentObject var m: Model` | `@Environment(Model.self) private var m` |
| `.environmentObject(m)` | `.environment(m)` |
| `$m.path` in a view that did not declare `@Bindable` | `@Bindable var m = m` as the first line of `body`, or a `@Bindable` property |

A process-wide singleton (`ShellModel.shared`) is held by `@State private var shell = ShellModel.shared`; `@State` keeps the same instance.

## What does not translate

- **Combine pipelines on `$property`.** `ChatModel` subscribes to `store.$views.sink`. There is no publisher on an `@Observable` property: use `withObservationTracking` in a loop, or give the owner an `AsyncStream` of what changed. Migrate the sink and the store it watches together.
- **`objectWillChange`.** Nothing replaces it; remove the call and read the property where it is needed.
- **Redraw granularity changes.** `@Observable` redraws a view for the properties its `body` reads, not for any `@Published` change, so a view that relied on a redraw from an unrelated property stops redrawing. Read it, or restructure.
- **`@AppStorage` inside the class** never worked with either model; leave it in a view.

## Check

The first run on a Mac decides, since a Linux session cannot compile. Read [the pack's state rules](swiftui/state-management.md) for granularity and [observation across actors](concurrency/observation.md) before a type that other actors touch.
