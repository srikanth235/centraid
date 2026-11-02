---
name: kotlin-compose
description: >-
  Write idiomatic, safe, maintainable Kotlin, coroutines and Jetpack Compose. Use this skill whenever you write, review, refactor, debug or explain Kotlin code: composables, state, side effects, coroutines and Flow, Kotlin Multiplatform source sets, Gradle and the version catalog, Android tests (JUnit, Robolectric, Roborazzi, coroutines-test), R8 or ANRs. Trigger on .kt or .kts files, Compose recomposition or stability questions, dispatcher or cancellation bugs, expect/actual, even when the user does not ask for "best practices". Closes with how Centraid's Android shell applies them.
---

# Kotlin and Jetpack Compose best practices

Where common advice disagrees, this file says which to follow and why. The digests in `references/` go deeper on coroutines, Flow, Compose and testing.

## 1. Mindset

- **Write Kotlin-shaped code.** Null safety instead of sentinel values, `sealed` types instead of type codes, data and value classes instead of bags of fields, extension functions instead of `Utils` objects, expressions (`when`, `if`, `try`) instead of temporary `var`s.
- **Make invalid states unrepresentable.** A `sealed interface` with one case per state (`Loading`, `Ready(data)`, `Failed(reason)`) beats a class with nullable fields and `isLoading` flags that must agree.
- **Immutable by default.** `val` over `var`, read-only collection types in signatures, `copy()` to change a data class.
- **Composables describe UI from state.** Logic, IO and rules live outside them, where they can be tested without a device.

## 2. Before you hand back code

- It compiles with no warnings and the tests pass; fix a warning rather than suppressing it. A `@Suppress` names the exact check and sits on the narrowest declaration.
- No `!!` on a value that can legitimately be null. Where null means a programmer error, `checkNotNull(x) { "why" }` or `requireNotNull` says which invariant broke.
- No `GlobalScope`, no `runBlocking` outside tests and `main`.

## 3. Language idioms

- **Null handling:** `?.let`, `?:` with an early `return` or `throw`, smart casts after a check. Past a validation point, the type should be non-null; don't keep `?.`-chaining a value you already proved present.
- **`when` is exhaustive over sealed types and enums.** Don't add an `else` branch that hides a newly added case.
- **Scope functions sparingly:** `let` for nullable transforms, `apply` for configuring an object, `also` for side effects in a chain. Nested scope functions with `it` are hard to read; name the parameter.
- **Collections:** standard operators (`map`, `filter`, `associateBy`, `groupBy`, `firstOrNull`); `asSequence()` only for long chains over large collections.
- **Value classes** (`@JvmInline value class UserId(val raw: String)`) for ids and units that must not mix.
- **Named arguments** for Booleans and for several parameters of one type; better still, replace a Boolean parameter with an enum.
- **`object` for stateless singletons only.** Global mutable state in an `object` is a hidden dependency; pass it in.
- **No `Utils`, `Helper` or `Manager` types.** Name the thing by what it does.

## 4. Errors

- Throw for programmer errors (`require`, `check`, `error`). Model expected failures in the type: a sealed result, or `Result` at a boundary.
- **Never swallow `CancellationException`.** `runCatching` and `catch (e: Exception)` catch it too; rethrow it, or catch narrower types.
- Catch only to recover, translate or present. A failure the user caused reaches the user as an error state, not a log line.

## 5. Coroutines

- **Structured concurrency:** every coroutine runs in a scope tied to a lifecycle (`rememberCoroutineScope`, `LaunchedEffect`, a scope the owner cancels). A coroutine that outlives its owner is a leak.
- **Suspend functions are main-safe.** A function that blocks (disk, database, native calls, heavy CPU) switches itself with `withContext(dispatcher)`; callers don't have to know.
- **Inject dispatchers** instead of hard-coding `Dispatchers.IO`, so tests can substitute a test dispatcher.
- **Cancellation is cooperative.** Long loops call `ensureActive()` or `yield()`; cleanup goes in `finally`, with `withContext(NonCancellable)` only for cleanup that must finish.
- **`coroutineScope` when any child failing should fail all; `supervisorScope` when children are independent.**
- **Don't mix blocking and suspending code.** No `Thread.sleep` in a coroutine; use `delay`.

## 6. Flow

- `StateFlow` for state (always has a value, conflates); `SharedFlow` for events that must not be replayed as state. Expose read-only types (`StateFlow`, `Flow`), keep the `Mutable…` private.
- **Collect with the lifecycle:** `collectAsStateWithLifecycle()` (or `collectAsState()` where lifecycle is handled by the caller) in Compose; `repeatOnLifecycle` elsewhere.
- Cold flows restart per collector. Share expensive upstream work with `stateIn` or `shareIn` and a deliberate `SharingStarted` policy.
- `flowOn` changes the upstream dispatcher; never `withContext` inside `flow { }`.
- `distinctUntilChanged`, `debounce`, `combine` and `flatMapLatest` express intent; hand-rolled equivalents rarely get cancellation right.

## 7. Compose

**State**

- **Hoist state** to the lowest common owner. Composables take state in and send events out (`value`, `onValueChange`); a reusable composable owns no business state.
- `remember` for values that survive recomposition, `rememberSaveable` for ones that must survive configuration change and process death. Key `remember` on its inputs.
- `derivedStateOf` when a value derived from state changes less often than its inputs.
- Read state as late as possible (in a lambda or a later phase) so a change invalidates the smallest scope.

**Side effects**

- No side effects in the composition body. Use `LaunchedEffect(key)` for suspend work tied to a key, `DisposableEffect` for register/unregister pairs, `SideEffect` to publish to non-Compose code, `rememberUpdatedState` for a long-lived effect that reads the latest callback.
- Choose effect keys deliberately: `Unit` runs once, a changing key restarts the effect.

**Performance**

- Stable parameters let Compose skip. Prefer immutable types and Kotlin's immutable collection types for parameters; lambdas that capture unstable values defeat skipping.
- Lazy lists get stable `key`s and a `contentType`; never index-based keys for data that can change.
- No expensive work in composition: sort, filter and format outside, or `remember` it keyed on inputs.
- `Modifier` is the first optional parameter, defaulting to `Modifier`, and is applied to the root. Order matters (`padding` then `clickable` differs from the reverse).

**Accessibility**

- Every interactive element has a content description or text; decorative images get `contentDescription = null`. Merge semantics for compound rows; touch targets are at least 48dp; text scales with the system font size.

## 8. Kotlin Multiplatform

- `commonMain` holds platform-free code; it never imports Android or JVM-only APIs.
- `expect`/`actual` for the smallest platform surface; prefer an interface in common code with platform implementations injected.
- `commonTest` compiles once per target; a green JVM test proves nothing about another target's actuals.

## 9. Gradle

- Versions live in the version catalog (`libs.versions.toml`); no versions inline in a build script.
- Dependency lockfiles are part of the change when a dependency moves.
- Prefer configuration that is lazy and cache-friendly; don't resolve configurations at configuration time.

## 10. Testing

- Test logic on the JVM without a device: pure functions, state mapping, effect handling.
- `runTest` with a test dispatcher; never `Thread.sleep` or real delays. Advance virtual time explicitly.
- Compose UI tests assert on semantics (text, content description, test tags), not on layout details. Robolectric runs them on the JVM; screenshot tests (Roborazzi) catch visual regressions.
- One behaviour per test, named for the behaviour; test the error and cancellation paths.

## 11. Release and runtime health

- R8 keep rules are narrow and explained; a broad `-keep class **` hides real problems.
- Nothing slow on the main thread: disk, database and native calls belong on a background dispatcher, or the app gets ANRs.
- Respect the minimum SDK: gate newer APIs with a version check.

## 12. Performance

Fast means the first frame after a tap shows at once and no frame or main-thread task takes long enough to drop frames (16 ms at 60 Hz) or trip an ANR. Every change starts and ends with a **measurement**.

```text
reproduce -> measure (release build) -> find the line -> fix -> measure again -> commit with the numbers
```

1. **Reproduce** with written steps, a UI test, or a Macrobenchmark that runs the slow action.
2. **Measure a release-like build, on a real device.** Debug builds disable R8 and optimizations, and Compose in debug is far slower; an emulator shares the host's CPU and disk, so its numbers bound the experience from below and are never a budget. Profile the `release` build type (R8 on), or a `profileable` copy of it, so tracing works without debug overhead.
3. **Find the line** with the tool for the symptom:

   | Symptom | Tool |
   | --- | --- |
   | Janky scroll or animation | Perfetto system trace (`ui.perfetto.dev`, or Android Studio's System Trace); look for long `Choreographer#doFrame` and `Recomposer` slices |
   | A composable redraws too often | Layout Inspector's recomposition counts; Compose compiler reports for unstable parameters |
   | Slow action, high CPU | Android Studio CPU profiler (Callstack Sample or Java/Kotlin Method Recording) |
   | Memory grows | Android Studio Memory profiler: heap dump, then look for retained activities and scopes |
   | ANR or startup stall | Perfetto trace plus the main thread's stack in the ANR trace; check for disk, database or core calls on `Main` |
   | Battery, wakeups | Energy profiler in Android Studio; look at wake locks, alarms and polling |
   | A repeatable number | Macrobenchmark (`StartupTimingMetric`, `FrameTimingMetric`) |

   Repeatable numbers come from Macrobenchmark: `./gradlew -Pcentraid.android=true :androidApp:connectedBenchmarkAndroidTest`, which is how the `android-macrobenchmark` device lane (`nightly` profile) runs it, on a named physical device only, never an emulator.

4. **Fix**, then **measure again** with the same steps. Put before and after in the commit message: "Library opens in 40 ms, was 600 ms".

**Delete every Perfetto trace, heap dump and profiler export after reading it, and never commit or share one.** A trace or dump can contain the process's environment and memory, and an app started from an agent's shell inherits that shell's tokens.

Rules that fix most problems:

- **Show first, work after.** Render the screen state in the same frame as the tap, then load.
- **Main thread for UI only.** Disk, database, native core calls and decoding go to a background dispatcher.
- **Decode images at display size** (Coil/ImageDecoder size hints, `inSampleSize`) and cache them.
- **Stable keys, stable parameters, late reads** (section 7): the three fixes behind most recomposition problems.
- **No polling without a reason.** Timers and `delay` loops stop when the screen leaves composition.

This repo's own budget checks: `cargo xtask gate --profile pr` runs `call-budget` and `search-budget` against the core (ledgers in `contracts/ledgers/`), and the ceilings for on-device journeys sit in `tests/journeys.json`, promoted only from a named physical device. The `:androidApp:connectedBenchmarkAndroidTest` task is named by the gate and `mobile/README.md`, but no benchmark module is in the Gradle build yet; confirm it exists before relying on it.

## 13. Compiler and lint errors

Fix the first error first; later ones often come from it. Kotlin warnings are errors where the build says so; do not suppress to go green.

| Error | Fix |
| --- | --- |
| `Smart cast to 'T' is impossible, because 'x' is a mutable property` | Copy to a local `val` first (`val x = x ?: return`), or make the property a `val` |
| `Suspend function 'f' should be called only from a coroutine or another suspend function` | Make the caller `suspend`, or launch from a lifecycle-bound scope; never `runBlocking` to get around it |
| `@Composable invocations can only happen from the context of a @Composable function` | Move the call into a composable, or compute the value there and pass it into the lambda |
| `'when' expression must be exhaustive` | Add the missing branches; do not add `else` over a sealed type |
| `Type mismatch: inferred type is T? but T was expected` | Handle null where it enters (`?: return`, `requireNotNull(x) { "why" }`); avoid `!!` |
| `Call requires API level 26 (current min is 24)` (`NewApi`) | Gate with `Build.VERSION.SDK_INT >= …` or `@RequiresApi`; never raise `minSdk` to make it compile |
| `Unresolved reference` in `commonMain` for an Android or JVM class | `commonMain` takes no platform imports; use an `expect`/`actual` or an interface the shell supplies |
| Compose lint `ModifierParameter` | Move `modifier: Modifier = Modifier` first among the optional parameters and apply it to the root |
| Gradle lockfile mismatch after a version change | Rewrite the locks with `--write-locks` as `mobile/README.md` lays out (both modes); commit the lockfiles with the change |
| Compose "unstable parameter" skipped-restart in the compiler report | Use an immutable type or a lambda that reads late; see section 7 |

## 14. Final checklist

- No warnings; no `!!`, `GlobalScope` or `runBlocking` in product code.
- `CancellationException` is never swallowed.
- Every coroutine has a lifecycle-bound scope; blocking work is off the main thread with an injected dispatcher.
- State is hoisted, immutable and read late; side effects only in effect handlers.
- Lazy lists have stable keys; composables take `Modifier` first.
- Every interactive element is accessible.
- `commonMain` has no platform imports.

**Done when** the build has no warnings, `cargo xtask gate --profile mobile-jvm` is green (it runs `:core:jvmTest` against the real cdylib and fails on generated-table drift; the Android shell's own unit tests run separately, see `mobile/README.md`). The gate does not compile Compose or run a device; say so if you could not.

## 15. In this repo

The Android shell is `mobile/androidApp` (Compose, minSdk 24, targetSdk 36); the shared Kotlin Multiplatform binding of the Rust core is `mobile/core`.

- **The Rust core owns state, navigation and copy.** `dev.centraid.core.Screens` exposes the screen runtime as flows; the shell renders them and performs effects in `kit/ScreenEffects.kt`. There are no ViewModels and no DI framework; don't add either, or business state in composables.
- **Generated files are never edited:** `design/Tokens.kt`, `design/Catalog.kt` and `design/Words.kt` come from `contracts/tools/export-native-*.ts`. Style with those tokens, not raw Material colours or type.
- **Core calls never run on the main thread.** The binding hops to the core dispatcher; read `crates/core-ffi/CONTRACT.md` before touching it.
- `commonMain` must not import platform APIs; the gate checks it.
- Run `cargo xtask gate --profile mobile-jvm` for the Kotlin side. Dependency lockfiles are committed.

## References

Read when the task touches the area:

- `references/coroutines.md`: scopes, dispatchers, cancellation, structured concurrency.
- `references/flows.md`: StateFlow, SharedFlow, operators, collection.
- `references/compose.md`: state, composition, effects, performance and crash patterns.
- `references/testing.md`: what to test where, coroutine tests, Compose tests.

The error table and measuring loop (sections 12 and 13) are adapted from [Bama](https://github.com/daveebbelaar/bama) (MIT, Dave Ebbelaar, [license](licenses/Bama-LICENSE)). The references are from [android-skills](https://github.com/rcosteira79/android-skills) by Ricardo Costeira (MIT, [license](licenses/rcosteira79-android-skills-LICENSE)). Where they assume ViewModels or a DI framework, section 13 wins.
