# `crates/api-proto` — the schema workspace

Two protobuf packages, two compatibility promises, one generator ([#1020](https://github.com/srikanth235/centraid/issues/1020)).

## The two promises

| Package | Files | `buf breaking` runs against | What the promise means |
| --- | --- | --- | --- |
| `centraid.core.v1` | `proto/centraid/core/v1/*.proto` | the PR base **and every released `v*` tag inside the version window** (N = 3 minors) | A gateway's commitment to seats it does not control. A phone updates when the store lets it, so a field this package removes is a field some device in the field still sends. Rule category **FILE** — the strictest: a rename, a type change, a moved message and a deleted file are all refused. |
| `centraid.screen.v1` | `proto/centraid/screen/v1/screen.proto` | the PR base only | Shell-internal. The KMP shared module, SwiftUI and Compose ship in one artifact with the core that produces these messages, so a rename costs a recompile. Rule category **WIRE_JSON** — the wire and its JSON mapping stay compatible, names may move. |

The split is not cosmetic: it is why the gateway can promise stability to seats without freezing the shape of a screen that wave 3 has not written yet. `buf.yaml` at the repository root implements it as two modules over one import root, each excluding the other's subtree.

`centraid.screen.v1` may disappear entirely: open question 10 decides after wave 3 whether screen contracts stay protobuf or become Kotlin sealed classes plus SKIE, on the exit criterion written into the issue. Nothing in `centraid.core.v1` moves either way.

## The tree

| File | What it defines |
| --- | --- |
| `value.proto` | `Value` (SQLite's five storage classes), `NullValue`, `RecordKey` |
| `row.proto` | `RowImage`, `PriorDelta` — the absent-versus-NULL and delta-prior contracts |
| `log.proto` | `LogRow`, `LogPage`, `LogCursor`, `RebootstrapRequired`, `LogRequest` |
| `snapshot.proto` | `SnapshotHead` — the pointer; the artifact moves over iroh-blobs by digest |
| `intent.proto` | `Intent`, `BaseVersion`, `Outcome`, `Conflict`, `WaitingOn`, `ProducedRow` |
| `command.proto` | `Command`, `Principal`, `CommandOutcome` |
| `query.proto` | `PageQuery`, `PageOrder`, `PageCursor`, `PageRequest`, `Page`, `Row` |
| `change.proto` | `ChangeEvent`, `HealthEvent`, `ConnectivityEvent` |
| `handshake.proto` | `Hello`, `UpgradeRequired`, `Unsupported` |
| `pair.proto` | `PairTicket`, `PairRequest`, `PairResponse` |
| `admin.proto` | `DevicesList`, `DevicesRevoke`, `BackupNow` — command _inputs_, not a second envelope |
| `error.proto` | `ErrorCode` (closed) and `Error` |
| `envelope.proto` | `Envelope`, `Request`, `Response`, `Event`, `Cancel` |
| `screen/v1/screen.proto` | `ScreenState`, `ScreenEvent` — a placeholder envelope for wave 3 lane E |

Each file carries its own reasoning in comments, with the v0 `path:line` the shape came from. v0 is the executable specification, not code to migrate, so a comment that cites it is citing the spec.

## How the Rust types are generated

`build.rs`: [`protox`](https://docs.rs/protox) parses the tree in pure Rust and produces a `FileDescriptorSet`; [`prost-build`](https://docs.rs/prost-build) emits the Rust. **There is no `protoc` binary** on the build machines, and a codegen step that shells out to one is a step that works on one laptop.

`buf` is not in the build path. `buf.gen.yaml` documents what the other three consumers (Swift, Kotlin, TypeScript) generate, and `buf lint` / `buf breaking` are steps of `cargo xtask gate --profile pr`.

`build.rs` names every file rather than globbing. `tests/tree.rs` asserts the list and the directory agree, and that there are exactly two packages each declaring the package its directory implies.

## How to add a field

1. Add it with a **new field number**, never a reused one. `reserved` the number of anything you remove.
2. Ask whether the field is `optional`. On a scalar, proto3's `optional` is the only way to tell "absent" from "the default": a `uint64 commit_seq = 3` cannot say "there is no commit yet", and `optional uint64` can. `row.proto`'s `PriorDelta` is the case where the distinction is load-bearing — absent means "no prior is known", present-and-empty means "the statement touched only the key" — and `tests/roundtrip.rs` is what holds it.
3. Write the comment before the field. A field whose meaning lives only in a lane's head is a field the next reader guesses at.
4. Run `cargo test -p centraid-api-proto` and `cargo xtask gate --profile local`.
5. Run `buf lint` and `buf breaking --against '.git#branch=main,subdir=crates/api-proto/proto'`.

## What `buf breaking` refuses

Under **FILE** (`centraid.core.v1`), among others: deleting a file, message, enum, field or enum value; renaming any of them; moving a message between files or packages; changing a field's type, its cardinality (`optional` ↔ `repeated` ↔ singular), its `oneof` membership, or its JSON name; changing an enum value's number.

Under **WIRE_JSON** (`centraid.screen.v1`): changing a field's number or wire type, or its JSON name. Renaming a message or a field is allowed.

Neither category lets you reuse a field number. That is the one rule that has no workaround and no "but we control both ends": a reused number makes an old peer's bytes decode into a new meaning, silently.

## Unknown fields

#1020 requires that unknown fields be preserved and unknown message types be answered with `Unsupported{type}`. **prost 0.14 does not retain unknown fields** — verified against the vendored sources, not assumed. The invariant is held one layer out, at the frame, and the reasoning is **D-1020-C13** in `src/lib.rs`'s module documentation. The short form: nothing in the v1 plane relays a _decoded_ message, every payload that crosses a version boundary is `bytes`, and `Unsupported` carries the type name. `tests/roundtrip.rs::prost_drops_unknown_fields_which_is_why_nothing_relays_a_decoded_message` is the test that keeps the premise honest, and it is written to turn red if prost ever gains the feature — which would be a welcome red, because the decision could then be re-made with evidence.
