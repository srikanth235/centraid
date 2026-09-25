# Protocol and feature contracts

Policy and shape for the wire between a phone and the laptop it backs up to, and for the C ABI between the shell and the core. Settled with [#468](https://github.com/srikanth235/centraid/issues/468) as C1–C3, restated for the one tree by [#1020](https://github.com/srikanth235/centraid/issues/1020) and [#1025](https://github.com/srikanth235/centraid/issues/1025), and reshaped by [#1029](https://github.com/srikanth235/centraid/issues/1029) — the gateway API's own surface is [gateway.md](gateway.md).

## C1 — Two contracts

### (a) Protocol contract — always

Wire schema changes **never break parsing** in either direction:

| Rule | Detail |
| --- | --- |
| New fields | Optional with defaults on the reader |
| Optional → required | Forbidden without a coordinated floor bump |
| Removed fields | `reserved`, never reused; stay accepted (ignored) until the floor drops them |
| Types | Never narrow without a floor |
| Discriminants | Add new `oneof` members only as unknown-tolerant (`Unsupported`) or behind a capability |

The handshake and parsers stay green across versions even when a **feature** is unavailable. `buf breaking` holds the rules mechanically (see [the v1 wire](#the-v1-wire-two-packages-two-promises-1020)).

### (b) Feature contract — per feature

New product capability requires a **capability flag** in `Hello.capabilities` (or a version-window move).

- An old gateway or an old app shows a clear **"update the gateway"** / **"update the app"** wall — the shell renders `UpgradeRequired`.
- **No fallback paths.** No degraded modes. No defensive branches scattered through feature code that pretend an old host can half-run the new flow.
- Capability detection happens in **exactly one place** — the handshake (`judge` in `crates/protocol/src/version.rs`) — not re-derived in every screen.

**Decided:** no-fallback is confirmed policy, not a proposal. Both ends are under one maintainer pre-1.0; every fallback branch is permanent review tax.

### How the two halves interact

```
parse always succeeds  →  capability check  →  feature runs OR single update wall
```

Never: parse succeeds → feature code branches into three historical shapes.

## C2 — `COMPAT(name)` tagging

Every back-compat shim carries a machine-grepable comment:

```rust
// COMPAT(name): added <version or date>, drop when floor >= <schema_version>
```

| Required               | Meaning                       |
| ---------------------- | ----------------------------- |
| `name`                 | Stable id for the shim family |
| `added`                | Version or date introduced    |
| `drop when floor >= …` | When cleanup is allowed       |

**Ban:** untagged dual-path code that exists only for older peers. One `rg 'COMPAT\('` must produce the complete cleanup backlog. Cleanup floors cite the wire `schema_version` or a capability name, never the product version.

## C3 — Wire-schema purity

Schemas are **structural declarations only**:

- No transforms, preprocess, or coercion inside the schema definition. A `.proto` file declares shapes; a canonical-JSON `input` is validated against the command's own input schema in `crates/vault`, once.
- Normalization is an **explicit post-validation pass** with a named function.
- Tagged unions use one `oneof` with a clear discriminant, not ad-hoc optional field combinations.

Keeps generated clients (Rust, Kotlin, Swift, TypeScript), docs, and human readers aligned; prevents "schema that is really a parser."

## The v1 wire: two packages, two promises ([#1020](https://github.com/srikanth235/centraid/issues/1020))

The screen and core wires are protobuf, defined in [`crates/api-proto`](../crates/api-proto/README.md) as **two packages with two different compatibility promises** ([R-1020-4](decisions.md#v1-platform--rust-core-kmp-shell-electron-seat-gateway-anywhere-1020)):

| Package | What it carries | Promise | Checked against |
| --- | --- | --- | --- |
| `centraid.core.v1` | Queries, commands, rows, change events, the pairing handshake, the admin command inputs | A **gateway compatibility commitment**: a member's paired phone depends on it | `buf breaking` against **the PR base and every released tag inside the version window** — a chain of individually-compatible commits can still break the release a member is running |
| `centraid.screen.v1` | Screen states and screen events | **Shell-internal**; it may change every release | `buf breaking` against the PR base only |

One schema with one promise would force the weaker half to carry the stronger half's cost: a screen-state field rename would become a wire break, so screen shapes would ossify or the promise would quietly stop being kept.

### The version window

`Hello` carries `schema_version`, `min_supported`, the product version and `capabilities`. The product version is **display only**: a client must not refuse to connect because product strings differ, because a client that refuses an unfamiliar gateway version cannot be fixed from the gateway side. The judgement is symmetric (`crates/protocol/src/version.rs`):

```
ok iff peer.schema_version >= local.min_supported
    && local.schema_version >= peer.min_supported
```

`SCHEMA_VERSION` and `MIN_SUPPORTED` are both `1` today.

**What is left of `crates/protocol`** is the call session and the version window, and **no iroh type appears in it**. The stream framing, the handshake, the ALPNs and the transport trait were deleted with the seat plane, and `contracts/protocol/framing-golden.json` with them: that fixture existed so a Swift and a Kotlin implementation of the framing could be held to one answer, and neither has a frame to build. Both survivors are read by `crates/core`'s **call door**, where the peer is the shell in the same process: `session::Session` mints a request id, decides whether a `Cancel` may cancel it and settles it, and `version::judge` answers a shell's `Hello` — which is exactly the version-skew case a shell linking a prebuilt core is.

**Compatibility, in four rules.** A gateway supports clients from the last **N = 3** minor releases; a client outside the window gets a typed `UpgradeRequired` the shell renders, and a gateway older than the client is allowed as long as the client's `min_supported` admits it. On the gateway API the same comparison is [`VERSION_WINDOW`](gateway.md#versioning), carried in both directions. Migrations are forward-only, held as fixtures in `contracts/migrations`, and a file newer than its binary refuses to open with `DowngradeRefused` rather than guessing.

**Unknown fields, and the honest limit.** The rule is that unknown fields are preserved and unknown message types are answered with `Unsupported{type_url}`, never dropped silently. prost 0.14 does not retain unknown fields — verified in the vendored source rather than assumed — so the invariant is held **one layer out**, at the frame: nothing in the v1 plane relays a _decoded_ message, and every payload that crosses a version boundary is opaque `bytes`. The residual gap is named rather than papered over: a **field** added in a future release is invisible to this build, and a middlebox that decoded and re-encoded would lose it. A test turns red if prost ever gains the feature ([D-1020-C13](decisions.md#wave-2-lane-rulings-1020)).

**An intent's and a command's `input` are `bytes` carrying canonical JSON**, not a message per action and not `Any`. The input _is_ the hash preimage — the payload hash (lowercase hex BLAKE3, [#1025](https://github.com/srikanth235/centraid/issues/1025) S4) is taken over canonical JSON (`canonical_json` in `crates/media/src/format.rs`) and the gateway compares in constant time — and protobuf serialisation is explicitly not canonical, so a proto body could not carry a payload hash at all ([D-1020-C12](decisions.md#wave-2-lane-rulings-1020)).

**There is no local channel.** The seat socket, its `0x00`/`0x01` channel tag and `LOCAL_PROTOCOL_VERSION` went with the desktop shell ([R-1029-1](decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21)). The one boundary a shell crosses today is the five-symbol C ABI, whose contract is [`crates/core-ffi/CONTRACT.md`](../crates/core-ffi/CONTRACT.md).

## The gateway API's ALPN: `centraid-gateway/1` ([#1029](https://github.com/srikanth235/centraid/issues/1029), [scope amendment 2026-09-21](https://github.com/srikanth235/centraid/issues/1029#issuecomment-5755559795))

v0 is a phone backing up to the member's own laptop. The gateway API — the same HTTP requests, headers, signatures, JSON bodies and refusal shapes `gateway-client` signs and `gateway-server` routes — is carried as **HTTP/1.1 over one iroh bidirectional stream** under the ALPN **`centraid-gateway/1`**. One iroh dial gives the LAN-direct, hole-punched and relayed paths, so a laptop behind NAT needs no port forwarding and no certificate. The carrier's version (`/1`) is not the protocol version: `PROTOCOL_MIN`/`PROTOCOL_MAX` are negotiated _inside_ the requests this carries.

The ALPN is declared once, in the rules — `centraid_gateway_core::ALPN` — and imported by both ends, so the listener and the dialler cannot disagree about a string whose mismatch is a hang rather than a compile error. The laptop's endpoint offers it and calls `accept`; **the phone's endpoint offers no ALPN and never calls `accept`** — it dials, and accepts no inbound connection. `cargo xtask rules`' `no-listening-socket` enforces both halves.

## Canonical JSON, and where a hash is taken

**A command's `input` is `bytes` carrying canonical JSON**, not a message per action and not `Any` — the input _is_ the hash preimage, and protobuf serialisation is explicitly not canonical, so a proto body could not carry a payload hash at all ([D-1020-C12](decisions.md#wave-2-lane-rulings-1020)). The canonical form sorts object keys by **UTF-16 code unit**, never by locale collation, and still spells numbers the way `JSON.stringify` does (`ryu-js`): Reference A judged that spelling vestigial, since its only purpose was byte parity with a TypeScript tree that no longer exists, and **it has not been changed** — see the #1029 receipt.

**The intent plane is gone.** `seat_outbox`, `base_versions`, `depends_on`, `WaitingOn` and the outcome ledger were the offline-write machinery of a device that was not the authority. The phone **is** the authority: a write is a local transaction, not a queued claim, and there is nothing to settle, conflict or park. What survives is canonical JSON for the audit hash, and `NeededBytes`.

**What is queued instead is the backup**, and its identity is the object's: a name is the BLAKE3 of its bytes and storage is write-once, so a re-declared object is a no-op and a re-run of an interrupted drain costs nothing. See [gateway.md](gateway.md).

## The member sentence and its detail (#1015 R-NY-10)

Anything a producer hands the shell **to display** travels in two registers, and the shell prints one of them.

| Register | What it is | Who reads it |
| --- | --- | --- |
| The member sentence | A whole sentence about the member's vault, in member words, one error noun, sentence case | Every screen, **verbatim** |
| `detail` | The raw text — exception, database message, path | Logs and support bundles only ([logs.md](logs.md)) |

The producer owes both. On the wire, `centraid.core.v1.Error` carries `sentence` — built from the error `code` alone, with no layer's own text interpolated into it (`sentence_for_code` in `crates/core/src/error.rs`) — beside `detail`, which is for logs only and once carried a SQLite `RAISE(ABORT)` message onto a member's screen. `CommandOutcome.reason` is an owner-facing sentence on the same terms: the author's words for a failed precondition, the access plane's sentence for a denial, with the raw predicate kept for the audit trail. A gateway refusal follows the same split from the other side: [`ErrorBody`](gateway.md#the-refusal-body) carries a **code and never a sentence**, and the shell derives the wording.

**A shell never repairs a string it was given.** A regex that lowers engine vocabulary after the fact catches one shape and misses the next; a producer that emits engine vocabulary is a bug at the producer.

## Related

- [decisions.md](decisions.md) — C1, R-1020-4, the #1025 slice rulings
- [SECURITY.md](../SECURITY.md) — transport trust boundaries
- [ARCHITECTURE.md](../ARCHITECTURE.md) — the crates and what crosses between the shells
- [`crates/api-proto`](../crates/api-proto/README.md) — the schema tree, and how to add a field
- [`crates/protocol`](../crates/protocol/src/lib.rs) — the call session and the version window
- [gateway.md](gateway.md) — the gateway API, its signing and its refusal body
