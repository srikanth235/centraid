# Binding invariants, pitfalls and final checklist

These are the rules the two bindings (`mobile/core` in Kotlin and `mobile/iosApp/Sources/Core.swift`) and the boundary code must keep. [`CONTRACT.md`](../../../crates/core-ffi/CONTRACT.md) is normative for the C side; the binding-side rules below (threading, buffering, handle ownership, seed redaction, feature sets, packaging) are stated only here.

## What must stay true

- **Buffers are callee-allocated and freed only by `centraid_free(buf, len)`** with the exact length, never `free(3)` or a language cleaner. A null `buf` is a no-op. Both bindings copy the bytes into host memory and free in the same `finally`/defer on every path; Kotlin asserts `buffersHandedOver == buffersFreed`.
- **A timeout (`TIMEOUT`, -5) from `next_event` leaves the out-pointers untouched.** It is not an error: loop again. Zero the locals before the call so freeing is safe either way. Both bindings poll with 1000 ms (`READER_TIMEOUT_MS`, the Swift pump).
- **Inputs are borrowed for the call.** Null pointer with length 0 is the empty slice; null with non-zero length is `BAD_ARGUMENT`.
- **`call` is reentrant; the FFI takes no lock.** Serialisation, if any, is the core's.
- **Request ids are the caller's.** Non-zero is used as-is; 0 is the handshake's. `Cancel` names an unbounded request; an unknown id is a no-op; id 0 is refused.
- **Events are never dropped.** The core's queue is bounded (1024) and drops nothing; a full queue becomes `HealthEvent{stalled}`. Kotlin's event flow therefore uses `BufferOverflow.SUSPEND` (a `DROP_OLDEST` buffer would turn a reportable stall into a stale screen). Keep exactly ONE reader per core.
- **`close` unblocks `next_event` with `CLOSED` (-3)** after delivering accepted events. After `close` the pointer dangles: null your copy. Never race `close` with `call`.
- **A panic never crosses the boundary.** It becomes `PANICKED` (-4) with an `ERROR_CODE_INTERNAL` body and a diagnostic id and poisons the handle: every later call, `next_event` included, returns the same. The shell restarts the core deliberately. A panic in `open` returns no handle.
- **A refusal is typed.** Rust returns a negative status and an `Error` body; Kotlin surfaces `CoreOutcome.Failed(CoreFailure.Refused/Closed/Poisoned/BadArgument/Malformed/StaleArtifact...)`, Swift throws `Core.Failure`. The member-facing sentence is the core's; a shell never invents one. A binding returns an answer or a typed refusal, never `null`.
- **Threading.** Never touch the ABI on the UI thread. Kotlin `call` and `open` hop to the core dispatcher with `withContext` and then call `assertNotOnUiThread(operation, uiThreadName)`; the assertion is AFTER the hop because the realistic bug is a shell that passed `Dispatchers.Main` as the dispatcher. Rust also checks by thread name when `uiThreadName` is configured. Swift runs calls on serial `DispatchQueue`s: `calls` for screens (ordered, so a push is not overtaken) and `bulk` for the byte stage door (so a stream never holds a tap), and the event pump on its own thread.
- **One handle per vault file per process** (`SingleHandleGuard` in Kotlin). A shell opens a directory (`{"shelf": dir}`) and Rust opens each vault under it.
- **Artifact identity.** `Hello.identity` (an `ArtifactIdentity`) carries `git_sha`, `digest`, `schema_version`; `centraid_open` takes `expectedIdentity`; a mismatch is refused (`StaleCore`) before a handle exists. Kotlin also runs the handshake in `CentraidCore.open` and `requireDigest`: an empty expectation is NOT a match, a `dev` build on either side is "not checked" with a warning, a different digest is `StaleArtifact`. Check how the config JSON is built before assuming a digest is sent: today's shell call sites pass none, so a development core is accepted with a warning.
- **The seed crosses the ABI once, in the open config, and is redacted from every `toString`/log.** Absent means a keyless core (sealing doors refuse with `PEER_UNREACHABLE`); present-and-malformed is `BAD_ARGUMENT`.
- **Unknown protobuf fields do not survive a round trip** (prost does not retain them); nothing across the boundary relays a decoded message.

## Pitfalls

- **The shell links a stale core.** iOS links the Rust archive by path, Android loads a copied `jniLibs` `.so`; neither rebuilds on a Rust change, so a new request kind can compile on every layer and answer as the old version. Run `mobile/scripts/ios-core.sh` and `mobile/scripts/android-core.sh` first, and compare mtimes. `:core:jvmTest` builds its own cdylib, so it cannot go stale.
- **Feature set drift.** Phone builds use `--features llama`; the JVM tests and the PR gate build without it, and the two JVM commands (`cargo build -p centraid-core-ffi`, the `spike-fixture` run) must use the same features or the library rebuilds.
- **Wrong JNA package.** JNA must come in as the `@aar` on Android (the jar has no `libjnidispatch.so` for Android), and a class reached by name needs an R8 keep rule in `androidApp/proguard-rules.pro` (`CentraidLibrary`'s method names are the C symbols).
- **`defer { centraid_free }` without a status check** frees whatever was in the pointers on a timeout; zero them first.
- **Putting a new feature in the open config** or a new symbol because it looks easier. The config is read once and logged; features go in protobuf.
- **Treating `TIMEOUT` as a failure** restarts a healthy core once a second.
- **Unsafe outside `marshal.rs`** escapes miri; keep it there.
- **Generated Swift/Kotlin types** are built, not committed (Swift) or built by Gradle (Wire). Never hand-write a message type.

## Final checklist

- [ ] `CONTRACT.md` and `README.md` were read; a changed or new clause has a `Test:` line and a test in `tests/contract.rs`.
- [ ] Still exactly five exported symbols; the header regenerated and committed if a signature changed.
- [ ] New capability is a request kind: proto arm (never a reused number), `build.rs` entry, `Handle::call` dispatch, `request_kind` classification.
- [ ] All unsafe is in `marshal.rs`; every buffer is freed through `centraid_free` on every path in both bindings, including the timeout.
- [ ] `TIMEOUT` is handled as a normal answer; `PANICKED` poisons and is surfaced as a typed failure.
- [ ] Kotlin hops dispatcher then asserts off the UI thread; Swift uses the right lane.
- [ ] Both bindings return a typed refusal, never `null`; neither invents member-facing words.
- [ ] Artifact identity and open-config changes were made on both sides together.
- [ ] `cargo test -p centraid-core-ffi`, `cargo xtask rules` and `./gradlew mobileJvm` ran; the Swift binding, iOS cinterop and on-device runs are named as not run.
- [ ] The Rust core was rebuilt for each platform before any device check.
