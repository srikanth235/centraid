# Protobuf and prost in this repository

Open this before editing a `.proto`, `crates/api-proto/build.rs`, or code that encodes or decodes a message. No pack covers prost; this file is written for the repository and links the documents that own each rule instead of restating them. The owner of the schema workspace is [crates/api-proto/README.md](../../../../crates/api-proto/README.md): read its "How to add a field" and "What `buf breaking` refuses" sections first.

## The shape

| Fact | Where it is held |
| --- | --- |
| One package, `centraid.core.v1`, under `crates/api-proto/proto/centraid/core/v1/`. It is the language of the C ABI between a shell and the core it links; both ship in one artifact. | [api-proto README](../../../../crates/api-proto/README.md) |
| Rust types come from `crates/api-proto/build.rs` (`protox` parses, `prost-build` emits). **No `protoc` and no `buf` in the build path.** Import them as `centraid_api_proto::core_v1::...`. | `build.rs` header, `src/lib.rs` |
| Swift and Kotlin generate from the same files (`mobile/scripts/generate-swift-protos.sh`; Wire for Kotlin). `buf.gen.yaml` only documents them. | [buf.gen.yaml](../../../../buf.gen.yaml) |
| `buf lint` (STANDARD) and `buf breaking` (WIRE_JSON, against the PR base and every released tag in the version window) are `pr`-profile gate steps. | [buf.yaml](../../../../buf.yaml), [TESTING.md](../../../../TESTING.md) |
| `build.rs` **names every file** in `PROTOS`; a glob would hide a file nothing generates from. `tests/tree.rs` asserts the list and the directory agree. | `crates/api-proto/build.rs`, `tests/tree.rs` |

## Always

- **Add a field with a new number. Never reuse or renumber one.** When removing a field or enum value, `reserved` both its number and its name. A reused number makes an old peer's bytes decode into a new meaning, silently.
- **Add a new `.proto` file to `PROTOS` in `build.rs` in the same change**, with a comment saying why it is its own file (the existing entries are the model). `cargo test -p centraid-api-proto` fails on a mismatch.
- **Write the comment before the field.** A field whose meaning lives in a lane's head is a field the next reader guesses at.
- **Use `optional` on a scalar when absent differs from the default** (`PriorDelta` in `row.proto` is the case where it is load-bearing).
- **A write is a screen's `act`, not a new request kind.** `no-command-request` refuses a `command.proto` or a `Command` arm in `Request.kind`; the other structural rules are in [crates/xtask/README.md](../../../../crates/xtask/README.md#the-structural-rules).
- **Adding a field to `screens.proto` or a `*_screens.proto` message obliges both shells.** `native-shell-parity` fails until the Compose and SwiftUI shells each read it, or it is a row of `crates/xtask/src/native_parity_register.rs` as `Platform` or `Gap`.
- **Decode at the frame, and relay bytes, not decoded messages.** prost 0.14 drops unknown fields, so the invariant is held one layer out: payloads that cross a version boundary are `bytes`, and an unknown message type is answered with `Unsupported { type }` (D-1020-C13 in `crates/api-proto/src/lib.rs`; `tests/roundtrip.rs` holds it). The single decode of an envelope is `crates/core-ffi/src/marshal.rs`.
- **Map every core refusal to exactly one `ErrorCode`.** `ErrorCode` is a closed enum a shell branches on; `CoreError::code()` in `crates/core/src/error.rs` is the one place a variant chooses.

## Never

- **Never `include!` or hand-write generated prost output, and never commit it.** Types are built, not checked in.
- **Never edit a `.proto` while sharing a `CARGO_TARGET_DIR` with another worktree.** The build script's `OUT_DIR` is keyed by package identity, so the other lane's generated Rust leaks into your build and the gate verdict is worthless. Use a private target directory: [traps/shared-cargo-target.md](../../../../docs/traps/shared-cargo-target.md).
- **Never delete a field without reserving it, and never change its type or JSON name.** `buf breaking` refuses it; so does the next phone talking to an older core.
- **Never add a second generator for Rust** (`buf generate` with a Rust plugin). Two generators for one language is how checked-in output and build output drift.

## Using the generated types

| Work | Do |
| --- | --- |
| Encode | `message.encode_to_vec()`; hand the `Vec<u8>` across the ABI and free it with `centraid_free` ([CONTRACT.md clause 1](../../../../crates/core-ffi/CONTRACT.md#1-buffers-are-callee-allocated-and-released-only-through-free)) |
| Decode | `prost::Message::decode(bytes)`; map the `DecodeError` to a typed refusal with `?` (as `marshal.rs` does), never `.unwrap()` on bytes from outside |
| Enum fields | prost stores an `i32`; use the generated accessor (`field()` / `set_field()`), and treat an unknown value as an error the way the closed `ErrorCode` does, not as a default |
| A `oneof` | Match it exhaustively; the `_ =>` arm is where a new arm silently does nothing ([pat-exhaustive-enum](rules/pat-exhaustive-enum.md)) |
| A test of the wire | Round-trip it in `crates/api-proto/tests/roundtrip.rs` style; never hand-assemble bytes |

## Done when

`cargo test -p centraid-api-proto`, then `cargo xtask gate --profile local`; for a schema change the `pr` profile adds `buf lint` and `buf breaking`, which run `buf`.
