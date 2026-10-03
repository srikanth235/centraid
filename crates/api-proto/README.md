# `crates/api-proto` — the schema workspace

Two protobuf packages, two compatibility promises, one generator ([#1020](https://github.com/srikanth235/centraid/issues/1020)).

## The two promises

| Package | Files | `buf breaking` runs against | What the promise means |
| --- | --- | --- | --- |
| `centraid.core.v1` | `proto/centraid/core/v1/*.proto` | the PR base **and every released `v*` tag inside the version window** (N = 3 minors) | The C ABI's language between a shell and the core it links, which ship in one artifact. Rule category **WIRE_JSON** since [#1080](https://github.com/srikanth235/centraid/issues/1080): no gateway speaks it any more (the gateway's protocol is its own, `crates/gateway2/src/rules`), so a deleted message or file reaches no install; what is refused is a byte read under a new meaning — a changed number, wire type or JSON name, and a deletion whose name and number are not both reserved. |
| `centraid.screen.v1` | `proto/centraid/screen/v1/screen.proto` | the PR base only | Shell-internal. The KMP shared module, SwiftUI and Compose ship in one artifact with the core that produces these messages, so a rename costs a recompile. Rule category **WIRE_JSON** — the wire and its JSON mapping stay compatible, names may move. |

Both packages carry the same category now, and `buf.yaml` at the repository root still implements them as two modules over one import root, each excluding the other's subtree, so the promise can diverge again without restructuring the workspace.

`centraid.screen.v1` may disappear entirely: open question 10 decides whether screen contracts stay protobuf or become Kotlin sealed classes plus SKIE — one of its three exit criteria has tripped and a device measurement settles the other two ([D-1020-X3](../../docs/decisions.md)). Nothing in `centraid.core.v1` moves either way.

## The tree

| File | What it defines |
| --- | --- |
| `value.proto` | `Value` (SQLite's five storage classes), `NullValue`, `RecordKey` |
| `row.proto` | `RowImage`, `PriorDelta` — the absent-versus-NULL and delta-prior contracts |
| `command.proto` | `Command`, `Principal`, `CommandOutcome` |
| `query.proto` | `PageQuery`, `PageOrder`, `PageCursor`, `PageRequest`, `Page`, `Row` |
| `change.proto` | `ChangeEvent`, `HealthEvent`, `ConnectivityEvent` |
| `handshake.proto` | `Hello`, `UpgradeRequired`, `Unsupported` |
| `error.proto` | `ErrorCode` (closed), `Error`, and `VaultMoved`, the one companion a refusal carries |
| `envelope.proto` | `Envelope`, `Request`, `Response`, `Event`, `Cancel` |
| `vault.proto` | `FoundRequest` — founding a vault over the ABI |
| `phone.proto` | the phone's backup plane: pair, drain, hand-off, settle, reconcile, pins, fetch an original, restore, status, releasable/released ([#1080](https://github.com/srikanth235/centraid/issues/1080)) |
| `originals.proto` | the originals on this phone and the albums whose originals stay |
| `screen/v1/screen.proto` | `ScreenState`, `ScreenEvent`, the per-screen states and `SeatState` — one file by design (D-1020-E3a) |

Each file carries its own reasoning in comments.

## How the Rust types are generated

`build.rs`: [`protox`](https://docs.rs/protox) parses the tree in pure Rust and produces a `FileDescriptorSet`; [`prost-build`](https://docs.rs/prost-build) emits the Rust. **There is no `protoc` binary** on the build machines, and a codegen step that shells out to one is a step that works on one laptop.

`buf` is not in the build path. `buf.gen.yaml` documents what the other three consumers (Swift, Kotlin, TypeScript) generate, and `buf lint` / `buf breaking` are steps of `cargo xtask gate --profile pr`.

`build.rs` names every file rather than globbing. `tests/tree.rs` asserts the list and the directory agree, and that there are exactly two packages each declaring the package its directory implies.

## How to add a field

1. Add it with a **new field number**, never a reused one. `reserved` the number **and** the name of anything you remove.
2. Ask whether the field is `optional`. On a scalar, proto3's `optional` is the only way to tell "absent" from "the default": a `uint64 commit_seq = 3` cannot say "there is no commit yet", and `optional uint64` can. `row.proto`'s `PriorDelta` is the case where the distinction is load-bearing — absent means "no prior is known", present-and-empty means "the statement touched only the key" — and `tests/roundtrip.rs` is what holds it.
3. Write the comment before the field. A field whose meaning lives only in a lane's head is a field the next reader guesses at.
4. Run `cargo test -p centraid-api-proto` and `cargo xtask gate --profile local`.
5. Run `buf lint` and `buf breaking --against '.git#branch=main,subdir=crates/api-proto/proto'`.

## What `buf breaking` refuses

Under **WIRE_JSON** (both packages): changing a field's number, wire type or JSON name; deleting a field or an enum value without reserving **both** its number and its name (`reserved 3; reserved "device_secret";`). Deleting a message, an enum or a file, moving a message between files, and renaming a message are allowed.

Neither category lets you reuse a field number. That is the one rule that has no workaround and no "but we control both ends": a reused number makes an old peer's bytes decode into a new meaning, silently.

## Unknown fields

#1020 requires that unknown fields be preserved and unknown message types be answered with `Unsupported{type}`. **prost 0.14 does not retain unknown fields** — verified against the vendored sources, not assumed. The invariant is held one layer out, at the frame, and the reasoning is **D-1020-C13** in `src/lib.rs`'s module documentation. The short form: nothing in the plane relays a _decoded_ message, every payload that crosses a version boundary is `bytes`, and `Unsupported` carries the type name. `tests/roundtrip.rs::prost_drops_unknown_fields_which_is_why_nothing_relays_a_decoded_message` is the test that keeps the premise honest, and it is written to turn red if prost ever gains the feature — which would be a welcome red, because the decision could then be re-made with evidence.
