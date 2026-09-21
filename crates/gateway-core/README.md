# `crates/gateway-core` — every rule a gateway enforces

The gateway is a **protocol** ([#1029](https://github.com/srikanth235/centraid/issues/1029) §3), and the server a member runs on their own laptop is a deployment of it: _the deployment is not the reference implementation; the protocol and its conformance suite are._ A second, hosted deployment was the other half of this shape until the [scope amendment of 2026-09-21](https://github.com/srikanth235/centraid/issues/1029#issuecomment-5755559795) struck it. This crate is the protocol's rules, written once, with no I/O.

| Half | Where |
| --- | --- |
| The messages | `crates/api-proto` — `gateway.proto`, `backup.proto`, `lease.proto`, in `centraid.core.v1` |
| The rules | here |
| The suite an adapter must pass | `src/conformance.rs`, a **library function**, not a `#[test]` |
| The one SQL schema an adapter applies | `contracts/gateway/schema.sql`, re-exported as `SCHEMA_SQL` |
| The adapter | W4b, `crates/gateway-server` |

## The three invariants this crate exists to hold

### 1. The gateway is blind

It never receives plaintext, a plaintext hash, or a key. Read the fields of `store::StoredObject` and `store::VaultState`, and every column in `contracts/gateway/schema.sql`, and ask what they could tell somebody who stole them: identity keys, generation ids, txid ranges, object kinds, **padded** sizes and timing. Nothing else — because a field is the only way anything else could arrive.

**This is the test a new rule is judged against.** If a rule needs plaintext, a plaintext hash or a key, the rule is wrong. The shrink guard is the worked example: it began as a comparison of _sealed row censuses_, which a blind store cannot read, and became padded base size plus a server-side delete rate limit (F4). The row-census warning moved to the phone, where the census is readable.

`src/conformance.rs`'s canary is what keeps this from being a paragraph: it plants a plaintext, puts a ciphertext derived from it through the whole object path, and asserts that neither the plaintext nor its BLAKE3 appears in any stored byte or anywhere in the state store.

### 2. WASM-clean by construction

W4c compiles this crate to `wasm32-unknown-unknown`. So there are no threads, no filesystem, no sockets, **no ambient clock** and **no ambient randomness**: time is a `ServerTime` argument and anything random is passed in by the adapter.

`SystemTime::now()` is the one that matters, because it _compiles_ for that target and _panics_ when called — it would pass every test here and die inside a Worker. `tests/wasm_clean.rs` scans for it and its relatives; `cargo check -p centraid-gateway-core --target wasm32-unknown-unknown` is the other half.

### 3. No rule branches on which deployment it is in

There is no `GatewayMode` here and there is not going to be one; `tests/wasm_clean.rs` refuses one. What differs between the adapters is behind `ByteStore` and `StateStore`. The one honest difference is `checksum::ChecksumMode`, and it is a property of the **store** the adapter was pointed at — B2 and MinIO attest different headers — not of the adapter, which is why the conformance suite runs both modes.

The repository already carried this rule for v0's `packages/server/`, as the `gateway-engine-mode-agnostic` governance directive: _the "same code, three hosts" property breaks the moment the engine starts checking which host it is living in._ The subject moved here with #1029; the reasoning did not change.

## ONE HASH, and the one exception

An object's **name** is the BLAKE3-256 of its ciphertext, as `crates/media/src/object` computes it. Every id, every digest and the request body digest in `auth.rs` is BLAKE3.

`src/checksum.rs` is the single exception and the only module here that names SHA-256: R2, S3, B2 and MinIO attest SHA-256 and nothing else, and a checksum restated in BLAKE3 would not be their protocol any more. It carries its own entry in `crates/vault/tests/one_hash.rs`'s allowlist with that reason, in the shape `crates/identity` already has (W0.5-R1).

The declaration carries both names of the same bytes, and that binding is what an attest-only store can be held to. What each mode proves — and what attest mode **cannot** prove — is written on `ChecksumMode`.

## The modules

| Module | The rule |
| --- | --- |
| `version` | the protocol range, both directions; a phone outside it writes nothing |
| `auth` | the signed preimage, the replay window, and the 401 that carries server time |
| `lease` | monotonic epochs, and `VAULT_MOVED` as a tombstone rather than a deletion |
| `upload` | refuse to presign a committed name; the 16 MiB cap; the name-to-checksum binding |
| `checksum` | attest and read-and-hash; **no attestation is a rejection** |
| `commit` | the manifest head moves only by compare-and-set (F7) |
| `retention` | the floor over bases, the grace period, the size guard, the delete rate limit |
| `plan` | quota and lapse; a lapsed plan is read-only, never deleted inside its period |
| `scrub` | blind re-hashing |
| `store` | the two ports, and the one schema |
| `engine` | the order the rules run in |
| `memory` | an in-memory adapter, so the suite has something to run against here |
| `conformance` | the suite |

## Running the suite from an adapter

```rust,ignore
let report = centraid_gateway_core::conformance::run(&mut my_harness).await;
assert!(report.is_green(), "{}", report.render());
```

`Harness` is the whole of what an adapter supplies beyond its two ports: reset, register a vault, the `PUT` a phone would make to a presigned target, a way to corrupt one stored object, and two windows for the canary. `crates/gateway-core/tests/conformance.rs` is one caller; W4b and W4c are the other two.

## What this crate does not do

It does not open a socket, touch a disk, presign anything itself, verify a purchase receipt, or decode a device certificate — that last one is `centraid_identity::DeviceCertificate`'s, and an adapter hands the result in as `auth::CertifiedDevice`. `crates/gateway-core` deliberately does **not** depend on `crates/identity`: that crate carries pkarr, which a Worker has no business linking.
