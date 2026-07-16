# iroh-wasm vs. an official iroh 1.0 browser binding — evaluation

**Issue #419 (M0.1). Date: 2026-07-16. Verdict: KEEP.**

## Question

Can `apps/web/iroh-wasm/` (the bespoke `centraid-web-iroh` crate) be replaced
by a first-party browser/WASM binding shipped with iroh 1.0?

## n0's documented guidance: FFI for native, app-owned WASM for browsers

n0 documents the browser story at
<https://docs.iroh.computer/languages/wasm-browser>, and it prescribes exactly
the approach this crate takes:

> Currently we don't bundle iroh's Wasm build as an NPM package.

The page directs browser consumers to compile the `iroh` Rust crate to WASM
behind an **application-specific `wasm-bindgen` wrapper** — i.e. a crate like
this one — and recommends `iroh = { version = "1", default-features = false }`
(dropping `metrics`). Our `Cargo.toml` matches: `default-features = false`
plus `tls-ring`.

For every non-browser surface the guidance is **FFI** — the NAPI package for
Node/desktop, the uniffi bindings for Swift/Kotlin. So the binding split across
centraid is already the recommended one:

| Surface | Binding | Status |
| --- | --- | --- |
| `apps/desktop`, gateway (`packages/tunnel`) | `@number0/iroh` NAPI (FFI) | correct |
| `apps/mobile` (`centraid-tunnel`) | uniffi Swift/Kotlin (FFI) | correct |
| `apps/web` (browser PWA) | this crate — app-owned `wasm-bindgen` | correct |

**Browser deployments are relay-only.** Browsers cannot send UDP, so — per the
same page — *"All connections from browsers to somewhere else need to flow via
a relay server"*, though they remain end-to-end encrypted (the relay cannot
decrypt). The crate binds with `presets::N0`, so the PWA's reachability depends
on n0 relay availability; a self-hosted relay is the standing insurance policy.
This is a browser-only constraint — desktop and mobile still hole-punch to
direct paths.

## What n0 actually ships in 1.0

The iroh-ffi 1.0.0 project publishes four bindings — **none of them a browser
binding**:

| Language | Package | Kind |
| --- | --- | --- |
| Python | `iroh` (PyPI) | native ext |
| Swift | `IrohLib` (SwiftPM / CocoaPods) | xcframework |
| Kotlin/JVM | `computer.iroh:iroh` (Maven Central) | JNI/JNA, desktop + Android |
| JavaScript | `@number0/iroh` (npm) | **NAPI (Node/React Native)** |

The JavaScript package is a **NAPI native addon**, not a browser module. Its
`optionalDependencies` are per-platform native binaries
(`@number0/iroh-darwin-arm64`, `@number0/iroh-android-arm64`,
`@number0/iroh-linux-x64-gnu`, …); there is no `browser` field, no `.wasm`
artifact, and it requires Node's N-API — it cannot load in a browser. iroh-ffi
mirrors "the stabilized iroh 1.0 surface" for Python/Swift/Kotlin/Node only;
there is no `wasm32-unknown-unknown` / `wasm-bindgen` target in the FFI
project.

Evidence:
- `@number0/iroh` npm metadata — `main: iroh-js/index.js`, NAPI, platform
  native `optionalDependencies`, no `browser` field.
- iroh-ffi README "Published Packages" lists exactly the four above.

## What our crate does that an FFI binding would have to cover

`src/lib.rs` compiles the **`iroh` Rust crate itself** (v1.0.0,
`wasm32-unknown-unknown`, `tls-ring`, no default features) to WASM via
`wasm-bindgen`. It is not a vendored FFI — it is a first-party embedding of
iroh in the browser, exposing exactly the tunnel surface:

- `BrowserEndpoint.spawn(secretKey?)` with a custom `QuicTransportConfig`
  (15 s keep-alive, 60 s max idle) for pooled-connection warmth.
- `pair_gateway(ticket, requestJson)` over the `centraid/gw-pair/1` ALPN.
- `request(...)` over `centraid/tunnel/1`: the u32-BE + UTF-8 JSON header
  frame, raw body, FIN — the same wire protocol as `packages/tunnel`.
- Pooled tunnel connection with redial-on-stale (`open_tunnel_stream`).
- `BrowserResponse` with a `ReadableStream` body (`wasm-streams`) so SSE and
  streamed responses stay live.

Consumed by `apps/web/src/iroh-transport.ts` (`pairGatewayOverIroh`,
`irohFetch`, the service-worker bridge).

## Verdict: KEEP

Not "no alternative exists" — **this crate is the architecture n0 documents for
browsers**. There is no official browser/WASM binding to migrate to
(`@number0/iroh` is Node-only NAPI), and the WASM guidance explicitly says the
Wasm build is not bundled as an NPM package, pointing consumers at an
app-specific `wasm-bindgen` wrapper over the `iroh` crate. That is what
`src/lib.rs` is. Nothing to delete; no porting of `iroh-transport.ts`.

The `apps/web/iroh-wasm` crate is therefore **not** the same kind of liability
the mobile module's hand-vendored iroh-ffi was (issue #419 M0.1 grouped them
together as "both vendored layers"). That framing was wrong: the mobile module
vendored *generated FFI artifacts* n0 publishes and supports, so deleting the
vendoring was pure win; this crate embeds the *upstream `iroh` crate itself*,
which is the prescribed browser path. Only one of the two layers was a vestige.

Our crate is already minimal and idiomatic: it depends on the published `iroh`
1.0.0 + `iroh-tickets` 1.0.0 crates (not a fork), so it tracks upstream iroh
directly. The only maintenance surface is the ~289-line `lib.rs` glue.

## Proposed follow-up (not filed — orchestrator to decide)

> **Title:** Track upstream for an official iroh browser/WASM binding
>
> **Body:** iroh-ffi 1.0 ships no browser binding (`@number0/iroh` is
> Node/NAPI), and n0's WASM guidance
> (<https://docs.iroh.computer/languages/wasm-browser>) states *"Currently we
> don't bundle iroh's Wasm build as an NPM package"*, directing browser
> consumers to an app-specific `wasm-bindgen` wrapper over the `iroh` crate —
> which is exactly what `apps/web/iroh-wasm` is. The word **"currently"** is
> the trigger to watch: if n0 later publishes that Wasm build as an NPM
> package, re-run this evaluation against the gw-pair + framed-tunnel +
> streaming-body surface. Low priority; our crate tracks upstream iroh 1.0.x
> crates directly, so security fixes flow through a normal `cargo update`.
