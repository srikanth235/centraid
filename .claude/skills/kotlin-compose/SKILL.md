---
name: kotlin-compose
description: >-
  Write, review, debug, and explain Kotlin, coroutines, Flow, and Jetpack Compose in Centraid, including Kotlin Multiplatform, Gradle, and Android tests. Trigger on Kotlin source, Compose behavior, coroutine or Flow bugs, and Android shell changes.
---

# Kotlin and Compose

Use Kotlin's type system to make invalid states hard to represent. Prefer immutable values, exhaustive sealed types, and small functions with clear ownership. Keep product rules and durable state in the Rust core; the Android shell renders its state and handles effects.

## Before changing code

- Read the relevant repository code and contracts first. For core calls, read [`crates/core-ffi/CONTRACT.md`](../../../crates/core-ffi/CONTRACT.md).
- Keep `commonMain` platform-free. Do not add ViewModels or a DI framework to the Android shell.
- Generated files (`design/Tokens.kt`, `design/Catalog.kt`, and `design/Words.kt`) are outputs of `cargo xtask design`; edit `design/tokens.toml` (or the Rust word catalogue) instead.
- Use the version catalog in [`mobile/gradle/libs.versions.toml`](../../../mobile/gradle/libs.versions.toml). Read the `kotlin` and `coroutines` versions there, and check APIs and language feature support against them before recommending a pattern.
- Dependency changes include updated lockfiles. Follow [`mobile/README.md`](../../../mobile/README.md) for the applicable commands.

## Core practices

- **Errors:** throw for violated programmer invariants; model expected failures in domain/UI state. Never swallow `CancellationException`. Be careful with `runCatching` and broad catches in suspending code.
- **Coroutines:** give every coroutine an owner whose lifetime matches the work. Use lifecycle-bound scopes for UI events; make blocking functions main-safe with an injected dispatcher. Use `coroutineScope` when children fail together and `supervisorScope` when they are independent.
- **Flow:** use `StateFlow` for current state and `Flow` for streams. Collection in Compose should respect lifecycle where applicable. `SharedFlow` and `Channel` are in-memory delivery mechanisms with explicit loss, buffering, and replay behavior; neither makes an important outcome durable. Persist important outcomes and acknowledge them after handling.
- **Compose:** render from state, hoist state to the lowest common owner, and keep side effects in effect handlers. Use stable lazy-list keys, apply caller modifiers to reusable roots, and expose accessible semantics.
- **KMP and Gradle:** keep platform APIs out of `commonMain`; keep versions in the catalog and dependency locks current.

Read the focused references when useful: [coroutines](references/coroutines.md), [Flow](references/flows.md), [Compose](references/compose.md), [testing](references/testing.md), and [compiler, runtime, and performance diagnostics](references/diagnostics.md).

## Repository checks and completion

Choose the narrowest check that covers the change. For Kotlin core binding changes, run `cargo xtask gate --profile mobile-jvm`; it runs the core JVM tests but does not compile Compose or run device tests. For Android shell changes, follow the checks in [`mobile/README.md`](../../../mobile/README.md). State clearly which relevant checks could not run. Do not suppress a warning or weaken a gate to make it pass.

The work is ready when the requested behavior is implemented, generated outputs are regenerated and committed when their sources changed (never hand-edited), applicable checks pass, and affected documentation is current. For the complete mobile build and device verification matrix, follow the [mobile verification skill](../mobile-verify/SKILL.md).

The initial Kotlin guidance and compiler error table were adapted from [Bama](https://github.com/daveebbelaar/bama), MIT, with its license in [`licenses/Bama-LICENSE`](licenses/Bama-LICENSE). The Compose and Android testing guidance was adapted from [android-skills](https://github.com/rcosteira79/android-skills), MIT, with its license in [`licenses/rcosteira79-android-skills-LICENSE`](licenses/rcosteira79-android-skills-LICENSE). Repository conventions and contracts above govern this project.
