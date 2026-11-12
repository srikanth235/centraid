# C ABI diagnostics and focused checks

The behavior rules are normative in [`CONTRACT.md`](../../../crates/core-ffi/CONTRACT.md). This page collects the focused checks and failure diagnosis that help locate an implementation or binding problem. Choose checks that cover the changed layer.

## Rust boundary checks

From the repository root:

```sh
cargo test -p centraid-core-ffi
cargo test -p centraid-core-ffi --features debug-fault --test contract a_real_panic_inside_call_poisons_the_handle_through_the_abi
RUSTUP_TOOLCHAIN=nightly cargo miri test -p centraid-core-ffi --test marshal_miri # when marshal.rs changed
cargo xtask rules
buf lint # and buf breaking against the PR base when buf is installed
```

`cargo test -p centraid-core-ffi` covers contract, symbol, reopen, and shelf-door tests. `debug-fault` exercises a real panic through the ABI. Miri applies to the marshal module's unsafe pointer and allocation work. The source rule and built-library check answer different questions about the five-symbol boundary; on Linux the latter can be counted with:

```sh
nm -D --defined-only target/debug/libcentraid_core_ffi.so | grep ' T centraid_' | wc -l
```

A signature change also needs the committed header regenerated:

```sh
CENTRAID_WRITE_HEADER=1 cargo build -p centraid-core-ffi
```

## Binding diagnostics

The Kotlin/JVM specs live in `mobile/core/src/jvmTest`: `AbiContractSpec`, `AbiRoundTripSpec`, `ScreensRoundTripSpec`, feature `*RoundTripSpec`s, `ConfigurationJsonSpec`, and `RequireDigestMatchesRustSpec`. `FakeCentraidAbi` covers lifecycle and poison cases. Put a new request's spec alongside the matching feature spec. The JVM suite must load the cdylib built for the test; it deliberately does not fall back to an ambient library.

There is no standalone Swift unit-test target. `Core.swift` is exercised by the iOS app's simulator test bundle; Linux cannot prove Swift binding behavior, iOS cinterop, a JNA-on-device path, or a phone panic injection. State those limits when handing off. For JDK discovery, Android packaging, R8, and stale platform libraries, see [mobile pitfalls](../land/mobile-pitfalls.md).
