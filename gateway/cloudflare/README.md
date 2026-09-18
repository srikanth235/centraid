# `gateway/cloudflare` — the hosted adapter

The paid hosted deployment of the Centraid gateway, as a `workers-rs` Worker over [`crates/gateway-core`](../../crates/gateway-core) (#1029 §3).

**One protocol, two deployments.** This is one of them; [`crates/gateway-server`](../../crates/gateway-server) is the standalone server anyone can run. _Neither is the reference implementation: the protocol and its conformance suite are._ A phone cannot tell which of the two it is talking to, and that is the property everything below exists to keep.

## There are no rules in this crate

Every refusal, floor, checksum comparison, quota, scope check and TTL threshold is `centraid-gateway-core`'s. What is here is a router, three Durable Objects, a bucket and a certificate.

`tests/no_rules_here.rs` is the grep that says so — it is the same file `gateway-server` carries, asked of this adapter — and it checks six things: no deployment discriminator, no rule's number restated as a literal, the store's own checksum named in exactly two modules, the rules actually reached, the SQL included from `contracts/` rather than restated, and no price or licence text compiled in.

**If a change here would make this Worker answer differently from the standalone server, the change belongs in `gateway-core`.**

## The shape

| Piece | What it is |
| --- | --- |
| `VaultObject` | one Durable Object per vault. Its single-request execution **is** the lease fence and the manifest compare-and-set's atomicity (F7) |
| `MailboxObject` | one per mailbox, keyed by the recipient's identity key, with an alarm for the TTL |
| `AccountObject` | one per account: the vault listing a restored phone reads, and the purchase map |
| `src/vault.rs` | `StateStore` over the Durable Object's SQLite, running `contracts/gateway/queries/`'s statements **unchanged** |
| `src/r2.rs` | `ByteStore` over R2 |
| `src/sigv4.rs` | presigning, and the one module here that computes a store's own checksum |
| `src/accounts.rs` | admission by key and purchase — the one place the deployments differ |
| `src/wire.rs` | headers, statuses, and the error body with its companions |
| `src/conformance.rs` | the shared suite, driven inside a real Durable Object |

## Why a Durable Object

It **runs one request at a time**. One object per vault means every request for that vault is serialised by the runtime, so `compare_and_set_head` needs no transaction and no lock — the property the standalone adapter buys with `BEGIN IMMEDIATE`. Three mechanisms, one rule: `commit::compare_and_set`.

Its SQLite caps at **10 GB**, which is why the per-object index lives there and per-item rows do not. An object row is under 200 bytes, so ten million objects is about 2 GB — and a vault with ten million objects holds 160 TB of bytes at the 16 MiB cap. The item ledger is on the phone, where it is readable.

## The two R2 APIs, and why there are two

The R2 **binding** can `put`, `get`, `head` and `delete`, and it cannot presign. But §3 says bytes never pass through gateway code here — a phone `PUT`s straight to R2 through a background `URLSession` — so a URL a phone can use has to be produced, and producing one means signing an S3 request in `src/sigv4.rs`.

**R2 records its attested checksum only if the client sent it.** The binding says so in its own types: the field is an `Option`. So an unattested upload answers `ChecksumEvidence::None`, and a commit fails on _no checksum_ and not merely on _wrong checksum_. Read-and-hash is the stronger check **over an attested object**, never a substitute for the attestation.

## Building and deploying

```sh
cargo check --target wasm32-unknown-unknown   # the Worker builds
cargo test                                    # the pure halves, on the host
npx wrangler deploy                           # needs a Cloudflare account
```

It is **its own cargo workspace**: `worker` is `wasm-bindgen` all the way down and does not build for a host target, so a member of the repository's workspace would break `cargo build --workspace` for everybody. The repository gate reaches it through its own step.

`cargo test` runs on the host because everything that touches a Durable Object, a bucket or a `Response` is behind `cfg(target_arch = "wasm32")`. The halves that are pure — the presigner, the receipt interpretation, the error body, the status table — are tested there, because a test that cannot run is not a test.

Secrets (`wrangler secret put`), never in `wrangler.toml`: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.

## The conformance suite

`POST /__conformance`, and **only** where `CONFORMANCE` is set — which `wrangler.toml` does in `[env.dev]` and nowhere else, because the route resets a vault's storage. It runs `conformance::run` against a harness built over this object's real SQLite and the real bucket, and answers one line per case plus `GREEN` or `RED`.

`scripts/conformance.mjs` is the runner: it starts `wrangler dev --env dev`, posts, prints the report and exits non-zero on `RED`.

## Pricing and licensing are not decided here

Q15 (pricing) and Q16 (licensing) are open with the owner. What is built is the **mechanism**: a receipt maps to an account and an account carries a quota in bytes. What a product id is worth is `PRODUCT_QUOTAS` in the Worker's environment, which the owner sets without a deploy of this code. `tests/no_rules_here.rs` fails if a price or a licence string appears.

## Known gaps, stated rather than left to be found

1. **No staging run.** This container has no Cloudflare account, so nothing here has been deployed, and `wrangler dev` under Miniflare is the furthest the suite has been driven. What a real account would still prove: that R2's `checksums.sha256` arrives through the binding as the docs say, that a presigned URL this crate signs is one R2 accepts, and that a Durable Object alarm fires when nothing has touched the object for a month.
2. **The store verification endpoints are configuration.** The response fields this crate reads are the documented ones and the parser is tested against recorded shapes, but no request has been made to a real App Store or Play endpoint from here.
3. **SigV4 is written twice.** `crates/gateway-server/src/bytes/sigv4.rs` signs headers for requests that server makes; `src/sigv4.rs` signs a query string for a request this one never makes. They overlap in the string-to-sign and the signing key. Extracting a `centraid-sigv4` crate is the obvious fix and was not done in this lane because that crate would have to be WASM-clean and would move a one-hash allowlist entry with it — a change worth its own review rather than a footnote in this one. Filed in the receipt.
4. **`account_vault` is never written by a route.** The listing table and its reads are here; the route that adds a vault to an account lands with the phone's own registration flow (W5 owns the client). A restored phone reads an empty list until then, which is a gap and not a failure.
