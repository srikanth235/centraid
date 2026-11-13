---
name: kotlin-diagnostics
description: Kotlin and Compose compiler diagnostics, Android runtime checks, and measurement guidance for performance work.
---

# Kotlin and Android diagnostics

Fix the earliest compiler error first; later diagnostics may follow from it. Warnings configured as errors are part of the build contract. Fix the cause instead of suppressing it; when suppression is justified, name the exact check and keep it on the narrowest declaration.

## Common compiler and lint errors

| Diagnostic | Response |
| --- | --- |
| Smart cast impossible because a property is mutable | Copy the validated value into a local `val`, or make the property immutable. |
| Suspend function called outside a coroutine | Make the caller suspend or launch from a lifecycle-owned scope; do not use `runBlocking` to bypass the boundary. |
| `@Composable` called outside a composable context | Move the call into a composable or compute and pass the value from the correct context. |
| Non-exhaustive `when` | Add missing cases; avoid a catch-all `else` for sealed types or enums. |
| Nullable value supplied where non-null is required | Handle null where it enters with an early return or a meaningful `requireNotNull`; avoid `!!` for expected absence. |
| Android API requires a newer SDK (`NewApi`) | Guard with an SDK check or `@RequiresApi`; do not raise the repository's minimum SDK just to silence the lint. |
| Android/JVM reference unresolved in `commonMain` | Keep common code platform-free; use a narrow `expect`/`actual` or injected interface. |
| Compose `ModifierParameter` | Put `modifier: Modifier = Modifier` first among optional parameters and apply it to the root. |
| Gradle lockfile mismatch | Follow [`mobile/README.md`](../../../../../mobile/README.md) to rewrite lockfiles in both Android build modes and commit them. |
| Compose compiler reports unstable parameters | Prefer immutable parameter types and avoid capturing unstable values; inspect the call site before adding annotations. |

## Android release and runtime health

- R8 shrinks release builds but not debug builds. If code reached by reflection or name lookup works in debug and fails in release, add a narrow, explained keep rule in `mobile/androidApp/proguard-rules.pro` and verify the release behavior.
- Disk, database, core calls, and image decoding must not block the main thread. Main-thread stalls can cause dropped frames or ANRs; put blocking work behind a main-safe API.
- Respect the app's minimum SDK and guard newer platform APIs.
- A passing JVM test does not compile Compose or validate Kotlin/Native actuals. Run the target-specific build/test required by the change. `commonTest` code is compiled per declared target, so a green JVM task alone cannot prove the iOS compile.
- For the authoritative set of mobile build, emulator, simulator, and device checks, follow the [mobile verification skill](../../../land/mobile.md). Report exactly which layers ran; do not describe an unrun device check as verified.

## Measure performance changes

Use this workflow only when the change is intended to fix a performance problem:

```text
reproduce -> measure -> locate the cost -> fix -> repeat the same measurement
```

Reproduce with steps, a UI test, or a benchmark. Measure a release-like build on a named physical device; debug builds and emulators are not device performance budgets. Select a tool based on the symptom:

| Symptom | Useful evidence |
| --- | --- |
| Janky scroll or animation | Perfetto system trace; inspect long `Choreographer#doFrame` and `Recomposer` slices. |
| Unexpected recomposition | Layout Inspector recomposition counts and Compose compiler stability reports. |
| Slow action or high CPU | Android Studio CPU profiler. |
| Growing memory use | Memory profiler and heap dump; inspect retained activities and scopes. |
| ANR or startup stall | Perfetto plus the ANR main-thread stack; look for disk, database, or core calls on `Main`. |
| Battery or wakeups | Energy profiler; inspect wake locks, alarms, and polling. |
| Repeatable startup or frame timing | Macrobenchmark with `StartupTimingMetric` or `FrameTimingMetric`, if the task and physical-device lane are available. |

Repeat the same scenario and setup after the fix, then record comparable before/after results. Do not assume a benchmark task exists: check the Gradle project and [`mobile/README.md`](../../../../../mobile/README.md). Delete profiler exports, heap dumps, and traces after review; do not commit or share them because they can contain process memory or environment details.

General fixes worth checking after measurement include rendering immediate state before loading, moving blocking work off the main thread, decoding images near display size, using stable keys and parameters, reading state late, and stopping unnecessary polling when a screen leaves composition. Apply only the fix supported by evidence.
