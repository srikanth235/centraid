# Trap — device-only runtime gaps

Every automated lane in this repo runs on Node (vitest) or the desktop JVM (`android/src/test`). The phone runs Hermes and Android's libcore. Where those runtimes disagree, a green suite proves nothing: the code is exercised on the runtime that has the API, and ships to the one that does not.

Both gaps below cost the `mobile-device-gate` lane days of red before the device's own logs were readable (#905).

## Hermes ships no ES2023 change-array-by-copy

`toSorted`, `toReversed`, `toSpliced` and `Array.prototype.with` are absent, so calling one throws `TypeError: undefined is not a function` at render time and redboxes the screen. Node has all four, so vitest never sees it.

`oxlint.config.ts` bans them through `no-restricted-properties`. Watch the rule's `files` glob: it covered `apps/mobile/src/**` and `packages/core/src/time/**` only, while the mobile bundle also reaches ~112 modules under `packages/*` — the pure logic and copy modules that `apps/mobile/src` imports (blueprint app roots, `components/*.tsx` and `queries/*` belong to the web and desktop seats and are NOT bundled). A ban that does not cover everything the bundle reaches is a ban with a hole in it.

`unicorn/no-array-reverse` wants `toReversed()`, which is the method Hermes lacks. Inside mobile-reachable code that rule loses: suppress it per line with `governance: allow-no-unjustified-suppressions runtime capability gap`, the pattern already used at `apps/mobile/src/lib/replica/sqlite-intent-store.ts`.

## Android's `InetAddress.getLoopbackAddress()` is not 127.0.0.1

It answers `::1`. A `ServerSocket` bound to `::1` is not dual-stack — it **refuses** IPv4 connections — so the tunnel's localhost proxy bound a port, reported it, and then every request to `http://127.0.0.1:<port>` died on the device with `java.net.ConnectException`. Pairing still succeeded (it rides iroh from Kotlin and never touches the proxy), so from the outside the phone looked paired and simply never asked for a row.

The desktop JVM answers `127.0.0.1` for the same call, so `android/src/test` cannot catch it. Bind the literal — `InetAddress.getByName("127.0.0.1")` — matching iOS (`NWEndpoint.hostPort(host: .ipv4(.loopback), …)`) and the Node reference proxy (`server.listen(port, "127.0.0.1")`).

## Reading the device instead of guessing

`console.warn` does not reach logcat in the release Hermes build; `console.error` does. Diagnostics meant for CI must use `console.error` or they are invisible. The harness digest (`tests/agent-e2e-mobile/lib/harness.mjs`) dedupes repeated messages so a retry ladder cannot push the one line that says why out of the tail, and the CI gateway traces the whole `_vault` plane — a phone that never asked and a phone whose data path alone is broken look identical on a narrower trace.
