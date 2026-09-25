package dev.centraid.core

/**
 * The JVM host's actuals (#1020, D-1020-E2).
 *
 * The JVM target exists for the tests: it is how this repository proves the
 * binding, the state machines and the navigation model on a machine with no
 * Android SDK, no Xcode and no device. It also runs the real ABI round trip
 * against `libcentraid_core_ffi.so`, which is the only place in CI where Kotlin
 * and the Rust core meet today.
 */
internal actual fun openCentraidAbi(config: String, uiThreadName: String): AbiOpen =
    JnaCentraidAbi.open(config)

/**
 * THE THREAD NAME IS THE UI THREAD ON A JVM HOST.
 *
 * There is no `Looper` here, so the name the shell passed into
 * `CoreConfiguration` — and into the core's own `uiThreadName` config field, so
 * the two sides agree — is the whole test. A JVM host's "UI thread" is whatever
 * a test or a desktop toolkit named it; the assertion's job is to be wrong on
 * the same thread the core would be wrong on.
 */
internal actual fun assertNotOnUiThread(operation: String, uiThreadName: String) {
    if (uiThreadName.isEmpty()) return
    val current = Thread.currentThread().name
    // THE COROUTINE DEBUG AGENT RENAMES THREADS. With `kotlinx-coroutines-debug`
    // on the classpath — which `kotlinx-coroutines-test` and Kotest both turn on
    // — a thread named `centraid-ui` reports as
    // `centraid-ui @spec-scope-1871678080#10`. An equality check against the
    // bare name is therefore an assertion that passes in production and never
    // fires under test, which is the worst of the two ways to be wrong.
    if (current.substringBefore(" @") == uiThreadName) {
        throw UiThreadCallError(current)
    }
}
