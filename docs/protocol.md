# Protocol and feature contracts

Policy and shape for the wire between a gateway and its seats — the mobile shells, the desktop's `centraid seat` sidecar — and for the local channel the desktop and the browser Companion speak to a seat. Settled with [#468](https://github.com/srikanth235/centraid/issues/468) as C1–C3, and restated for the one tree by [#1020](https://github.com/srikanth235/centraid/issues/1020) and [#1025](https://github.com/srikanth235/centraid/issues/1025).

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

- An old gateway or seat shows a clear **"update the gateway"** / **"update the app"** wall — the shell renders `UpgradeRequired`.
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

The wire is protobuf over iroh QUIC, defined in [`crates/api-proto`](../crates/api-proto/README.md) as **two packages with two different compatibility promises** ([R-1020-4](decisions.md#v1-platform--rust-core-kmp-shell-electron-seat-gateway-anywhere-1020)):

| Package | What it carries | Promise | Checked against |
| --- | --- | --- | --- |
| `centraid.core.v1` | Queries, commands, rows, change events, the pairing handshake, the admin command inputs | A **gateway compatibility commitment**: a member's paired phone depends on it | `buf breaking` against **the PR base and every released tag inside the version window** — a chain of individually-compatible commits can still break the release a member is running |
| `centraid.screen.v1` | Screen states and screen events | **Shell-internal**; it may change every release | `buf breaking` against the PR base only |

One schema with one promise would force the weaker half to carry the stronger half's cost: a screen-state field rename would become a wire break, so screen shapes would ossify or the promise would quietly stop being kept.

### The version window

`Hello` carries `schema_version`, `min_supported`, the product version and `capabilities`. The product version is **display only**: a seat must not refuse to connect because product strings differ, because a seat that refuses an unfamiliar gateway version cannot be fixed from the gateway side. The judgement is symmetric (`crates/protocol/src/version.rs`):

```
ok iff peer.schema_version >= local.min_supported
    && local.schema_version >= peer.min_supported
```

`SCHEMA_VERSION` and `MIN_SUPPORTED` are both `1` today.

**The framing is `u32BE(len) ‖ body`** with a 256 KiB ceiling and three named refusals, in [`crates/protocol`](../crates/protocol/src/lib.rs) — a crate in which **no iroh type appears**, because deterministic simulation is the primary sync proof and a protocol that named a real network could not be one. `crates/net` implements the transport traits over iroh and `crates/sim` implements them over `turmoil`. The byte-level facts are a fixture (`contracts/protocol/framing-golden.json`), regenerated and diffed by a test, because that is the only form in which a Swift or Kotlin implementation can be held to the same answer.

**Compatibility, in four rules.** A gateway supports seats from the last **N = 3** minor releases; `open` and the pairing handshake exchange `{schema_version, min_supported}`; a seat outside the window gets a typed `UpgradeRequired` the shell renders, and a gateway older than the seat is allowed as long as the seat's `min_supported` admits it. Migrations are forward-only, held as fixtures in `contracts/migrations`, and a file newer than its binary refuses to open with `DowngradeRefused` rather than guessing.

**Unknown fields, and the honest limit.** The rule is that unknown fields are preserved and unknown message types are answered with `Unsupported{type_url}`, never dropped silently. prost 0.14 does not retain unknown fields — verified in the vendored source rather than assumed — so the invariant is held **one layer out**, at the frame: nothing in the v1 plane relays a _decoded_ message, and every payload that crosses a version boundary is opaque `bytes`. The residual gap is named rather than papered over: a **field** added in a future release is invisible to this build, and a middlebox that decoded and re-encoded would lose it. A test turns red if prost ever gains the feature ([D-1020-C13](decisions.md#wave-2-lane-rulings-1020)).

**An intent's and a command's `input` are `bytes` carrying canonical JSON**, not a message per action and not `Any`. The input _is_ the hash preimage — the payload hash (lowercase hex BLAKE3, [#1025](https://github.com/srikanth235/centraid/issues/1025) S4) is taken over canonical JSON (`canonical_json` in `crates/vault/src/intents.rs`) and the gateway compares in constant time — and protobuf serialisation is explicitly not canonical, so a proto body could not carry a payload hash at all ([D-1020-C12](decisions.md#wave-2-lane-rulings-1020)).

**The desktop's local channel is not on this wire.** The seat socket's frame carries a channel tag: `0x00` is a `centraid.core.v1` envelope byte-identical to what crosses iroh, `0x01` is one UTF-8 JSON local message naming things that cannot exist remotely — a peer uid, a byte offset into a file this process can see, a capability token for a child on this machine. Adding those to `centraid.core.v1` would put them under its FILE promise to seats that update on their own schedule ([D-1020-F9](decisions.md#wave-3-lane-rulings-1020)). A new local message is **additive** and does not bump `LOCAL_PROTOCOL_VERSION`, whose own rule is that it is bumped when a message changes shape.

## One ALPN, one connection per vault, one stream per request ([#1025](https://github.com/srikanth235/centraid/issues/1025) S2, S3)

The v1 plane is **one ALPN**, and it is the only one a v1 endpoint advertises: `centraid/v1`. Everything a device does with its gateway rides it — redeeming a pairing code, a page of the log, a write, a bootstrap offer, a blob's bytes. `centraid/v1/byte`, `centraid/v1/peer` and `centraid/v1/pair` are all gone ([D-1025-S2-1](decisions.md#slice-s2--one-protocol-1025), [D-1025-S3-4](decisions.md#slice-s3--bytes-both-ways-one-store-1025)).

| Layer | Rule |
| --- | --- |
| Connection | One per vault. `centraid_net::Endpoint::accept` looks the peer key up in the allowlist **once**, before any stream, and the answer holds for every stream the connection will ever carry. |
| Stream | One per request. **Both sides loop on `accept_bi`** — the accepting side may open streams too, which is what lets a gateway pull a phone's blob on the connection the phone dialled. |
| First frame | A `centraid.core.v1.Request` envelope naming the kind. Nothing else may come first. |

### Two states, and a connection is promoted in place

The accept-time lookup's answer is a **state**, not a refusal:

| State | Who | What it may do |
| --- | --- | --- |
| **promoted** | an enrolled, unrevoked device | every request kind below |
| **provisional** | everyone else — which is every device the first time it knocks | **exactly one stream**, a 2 KiB frame cap, a 5-second deadline, and `pair` is the only kind it may carry |

A provisional connection that asks for anything else is refused `UNAUTHORIZED` **by name** and the **connection** ends, not just the stream: a stranger that asked for a log page has said what it is. A successful redemption **promotes that same connection in place** — no reconnect — so a phone goes `pair` → `blob` → `log` on one dial, in one window.

The enrolment check has not moved and has not weakened: it is the same lookup, in the same place, before any stream, for the connection's whole life. What moved is where its answer is expressed — from a TLS label to a state on the accepted connection.

### The request kinds a stream can open with

| Kind | The stream is | Answer |
| --- | --- | --- |
| `pair` | a ticket redemption. **The only kind a provisional connection may carry** | `PairResponse`; on success the connection is promoted |
| `hello` | the first stream a **promoted** connection opens, the version window | `Hello`, or `UpgradeRequired` and nothing else |
| `log` | a page of the log since a cursor — and, with `tail`, **every page after it too** | `LogPage`, or `RebootstrapRequired`. With `tail`, many `LogPage`s on the one stream |
| `intent` | a write, run on the gateway under the enrolled device's principal | `Outcome`, carrying the **commit position** the effect landed in — or `BYTES_NOT_YET_HELD`, see below |
| `blob` | **handed over**: everything after this frame is iroh-blobs' own get/provide protocol, verbatim | no envelope — the transfer is the answer |

The table names the kinds the sync plane turns on; `Request` in `crates/api-proto/proto/centraid/core/v1/envelope.proto` is the whole list, which also carries `command`, `page`, `content_urls`, `stage` and the admin inputs (`devices_list`, `devices_revoke`, `backup_now`).

#### A `log` stream may stay open ([#1025](https://github.com/srikanth235/centraid/issues/1025) S2, [D-1025-S7-40](decisions.md#slice-s2--the-tail-stream-1025))

`LogRequest.tail` is the one field, and there are **no new message types**: a tail is the same answer, more than once. A gateway answering a tail serves the catch-up pages from `since` exactly as it serves a one-shot request — following `has_more` — and then **keeps the stream open**, writing a further `LogPage` every time that vault's watermark moves past what it last sent. `RebootstrapRequired` ends the stream as it ends any request.

**One page per commit batch, never one per row.** The gateway's own wake carries no payload, so the stream serving a seat asks the log door where the watermark is and writes whatever is there; a batch of four hundred rows is one wake and one page.

**One log per vault, and a seat never subscribes to a table.** Every table's changes are rows in that one log, named by `LogRow.table`. There is no filter on the request and no subscription vocabulary anywhere on this wire, because a seat holds a COPY of the vault and not a view of part of it.

**A seat holds at most one tail per vault**, and a second tail from the same device replaces the first: the second is what that device believes. The gateway can enumerate the devices with a tail open — presence falls out of that registry — and it goes to a log line and nothing else, because what a member may learn about another member's devices is a product decision and not a protocol default.

This is the whole of the freshness mechanism. There is no interval, no poll and no push wake: see [mobile-offline.md](mobile-offline.md#one-stream-three-occasions) for the three occasions a seat opens one.

#### The bootstrap head rides the answers that ask for a copy ([#1025](https://github.com/srikanth235/centraid/issues/1025) S7, [D-1025-S7-5](decisions.md#slice-s7--one-loop-one-file-one-page-one-report-1025))

There is no `snapshot_head` request. `PairOk` and `RebootstrapRequired` each carry `{snapshot_hash, snapshot_seq, snapshot_bytes}`, and those two messages are the **only** occasions on which a device is told to take a copy — so a separate request could only ever be a second round trip for an answer one of them already had, on the connection the redemption had just promoted, with a real state in between: a device that is paired and does not yet know what to fetch.

`snapshot_bytes` is there for the **room check**, which happens before the first byte moves: a first bootstrap needs one copy of the artifact and a re-bootstrap two, because the old file is still there until the new one is renamed over it. It is also the denominator of the progress a "Copying your vault" screen draws.

The one state with no other way to ask is **paired, with no file, and the pairing recovered from the shell's secure store**. It asks for a `log` page from a cursor it does not have and is answered `RebootstrapRequired` carrying the head, which is the conversation every seat under the floor already has.

A `blob` stream carries no hash in its tagging frame. The hash is in iroh-blobs' own request, which follows on the same stream; naming it twice would be two places for a fetcher and a provider to disagree, and the second would be the one nobody checks.

**A malformed first frame costs its stream and nothing else.** `crates/protocol`'s rule — a malformed frame ends the connection, because the stream's position is no longer known — still holds, of the stream. With one stream per request the blast radius is one request: the stream is dropped, the connection lives, and the pages in flight beside it are untouched.

**Deadlines come from the shell.** `SeatNetwork::sync` and the `seat.sync` command take a `SyncWindow` — a relative deadline and an optional byte/item budget — and the core holds no constant of its own. A window the deadline cuts is a **normal end**: the pass reports what it kept, every applied commit is committed, every verified chunk group is durable, and the next pass continues from the cursor they left ([D-1025-S2-3](decisions.md#slice-s2--one-protocol-1025)).

### Bytes commit after rows, and never only on a phone ([#1025](https://github.com/srikanth235/centraid/issues/1025) S3)

A photograph taken on a phone lives in that phone's own content store. The **gateway pulls it** — on a `blob` stream of the connection the seat opened, because the phone is behind the worse NAT and is the side that knows when it is awake — and commits the content row only once it holds the bytes.

An `intent` stream is therefore three steps in this order:

1. the intent's `needs` are read out of it **through the payload-hash gate**. `Intent.needs` carries `{hash, byte_size, media_type}` per blob and is part of the canonical payload (`needs`, sorted by hash, omitted when empty), so a gateway cannot be told to fetch bytes the member did not sign for and a proxy cannot add one in flight;
2. every declared blob this gateway does not already hold is fetched and staged;
3. only then is the intent executed and the row committed.

It is a **declaration** rather than something the gateway derives from the command: deriving it needs a per-command table of "which input property names bytes", which is a second definition of the byte door that drifts silently every time a command is added ([D-1025-S3-5](decisions.md#slice-s3--bytes-both-ways-one-store-1025)).

A pull that does not finish answers `ERROR_CODE_BYTES_NOT_YET_HELD`, which is **retryable**: not executed, not failed. The seat reads an `Error` on an `intent` stream as "this attempt did not land", the write stays in its outbox, and the next window submits it again. Complete or nothing — the intent cannot run against half a photograph, and what landed is kept for the retry ([D-1025-S3-6](decisions.md#slice-s3--bytes-both-ways-one-store-1025)).

## An intent's identity and its answers

**An intent's identity is `(vault_id, intent_id, payload_hash)`, and the device is attribution** ([#1014](https://github.com/srikanth235/centraid/issues/1014) G23/V9). The outbox lives in the seat file, and the seat file outlives the enrolment: a phone restored from a device backup comes back under a new endpoint id and replays an outbox of intents this vault already holds. The id is client-minted and random and the hash covers the app, the action, the input, the base versions, the predecessors and the declared bytes, so a caller who can state both is holding the same intent; a different payload under a known id is a reuse, from any device (`crates/vault/src/intents.rs`).

**Every write states its read-set.** `Intent.base_versions` names the `row_version` the seat observed on each row it depends on — the row's own column, bumped by its touch trigger, never a log position ([#996](https://github.com/srikanth235/centraid/issues/996) R6). A stale base produces a `Conflict` carrying both versions, not a transport failure, and does not run the command; `actual_version = 0` means the row is gone, because `row_version` starts at 1. `depends_on` names predecessor intents in outbox order and is part of the hash, because an intent whose predecessors were rewritten in flight is a different intent. The canonical form sorts object keys by UTF-16 code unit, never by locale collation.

**An answer is the gateway's fact.** `Outcome` carries one of seven statuses (`queued`, `sending`, `parked`, `executed`, `denied`, `failed`, `conflict`); a `parked` answer names who is being waited on (`WaitingOn`: owner, origin, gateway, or a predecessor intent by id). An `executed` outcome carries the commit position its effect landed in, and that is what a seat's pending write waits on ([mobile-offline.md](mobile-offline.md#how-an-intent-settles)). The outcome ledger's window is 30 days, the log's own retention floor: past its edge the answer is `outcome_expired` — "I no longer know" — and never a silent re-execution.

## The member sentence and its detail (#1015 R-NY-10)

Anything a producer hands a seat **to display** travels in two registers, and the seat prints one of them.

| Register | What it is | Who reads it |
| --- | --- | --- |
| The member sentence | A whole sentence about the member's vault, in member words, one error noun, sentence case | Every screen, **verbatim** |
| `detail` | The raw text — exception, database message, path | Logs and support bundles only ([logs.md](logs.md)) |

The producer owes both. On the wire, `centraid.core.v1.Error` carries `sentence` — built from the error `code` alone, with no layer's own text interpolated into it (`sentence_for_code` in `crates/core/src/error.rs`) — beside `detail`, which is for logs only and once carried a SQLite `RAISE(ABORT)` message onto a member's screen. `CommandOutcome.reason` is an owner-facing sentence on the same terms: the author's words for a failed precondition, the access plane's sentence for a denial, with the raw predicate kept for the audit trail. The local channel follows the same split: each local refusal code has its own sentence (`crates/centraid/src/cmd/seat/local.rs`), and the desktop shell passes the seat's sentence through rather than inventing one.

**A seat never repairs a string it was given.** A regex that lowers engine vocabulary after the fact runs on one seat and misses the next shape; a producer that emits engine vocabulary is a bug at the producer.

## Related

- [decisions.md](decisions.md) — C1, R-1020-4, the #1025 slice rulings
- [SECURITY.md](../SECURITY.md) — transport trust boundaries
- [ARCHITECTURE.md](../ARCHITECTURE.md) — the crates and what crosses between the shells
- [`crates/api-proto`](../crates/api-proto/README.md) — the schema tree, and how to add a field
- [`crates/protocol`](../crates/protocol/src/lib.rs) — framing, handshake, version window
- [`desktop/README.md`](../desktop/README.md) — the seat socket's local channel
