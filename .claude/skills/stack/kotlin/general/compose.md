---
name: compose
description: Repository-focused guidance for state, effects, layout, accessibility, and performance in Jetpack Compose.
---

# Compose in Centraid

Compose is the Android shell's rendering layer. The Rust core owns product state, navigation, and copy; the shell renders core state and handles effects in `mobile/androidApp`. There are no ViewModels or DI framework in this shell. Keep business rules in the core and avoid adding a second state owner in Compose.

## State and composition

- Keep framework-only state such as scroll position and focus in Compose. Hoist shared UI state to the lowest common owner; pass values down and callbacks up.
- Composables should be repeatable descriptions of UI. Keep I/O, business decisions, and side effects out of the composition body.
- Use `remember` for values that need to survive recomposition and key it on every input that changes the value. Use `rememberSaveable` only when the value should survive recreation and is saveable.
- Use `LaunchedEffect(key)` for suspend work tied to composition and those keys, `DisposableEffect` for paired registration and cleanup, and `SideEffect` to publish committed values to non-Compose code. Choose keys to match the lifetime.
- Read state as late as practical, such as inside layout or draw lambdas, so changes invalidate the smallest possible scope.

## Layout and API shape

- Reusable composables accept `modifier: Modifier = Modifier` as the first optional parameter and apply it to their root. Modifier order changes behavior; for example, padding before click handling gives a different touch area than padding after it.
- Prefer slot APIs for caller-provided content instead of Boolean flags that combine unrelated layouts. Keep composables small enough that state ownership and semantics are clear.
- Lazy lists use stable item keys derived from item identity. Avoid index keys when entries can be inserted, removed, or reordered.
- Give every interactive control an accessible name or visible text. Set decorative image descriptions to `null`, preserve useful grouping semantics, and keep touch targets at least 48dp.

## Performance

Profile only when the change addresses a measured performance issue. For other UI work, avoid obvious main-thread blocking and unnecessary work in composition without adding profiling steps.

For performance changes, reproduce the symptom, measure a release-like build on a named physical device, inspect the relevant trace or profiler, apply the fix, and repeat the same measurement. Use Perfetto for frame or main-thread stalls, Layout Inspector and compiler reports for recomposition and stability, CPU and memory profilers for their respective symptoms, and Macrobenchmark for repeatable startup or frame metrics. Record comparable before and after results. Do not rely on debug-build or emulator timings as device budgets.

Do not commit or share profiler exports, heap dumps, or Perfetto traces. They may contain process memory or environment details. The repository's `mobile/README.md` and `cargo xtask gate --profile pr` define available checks and budgets; confirm a benchmark task exists before relying on it.

## Multiplatform boundary

`commonMain` stays free of Android and JVM APIs. Put platform-specific behavior behind the smallest `expect`/`actual` surface or an injected interface. A JVM test alone does not validate other declared targets.
