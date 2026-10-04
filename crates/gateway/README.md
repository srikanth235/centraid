# `crates/gateway` — the gateway, protocol v2

A Centraid gateway is a **blind store a phone backs its vault up to, directly** ([#1080](https://github.com/srikanth235/centraid/issues/1080)). The phone is the vault and the only writer; the gateway is a laptop, a NAS or a small VPS that keeps sealed objects it cannot open, under names it cannot invert, and answers a handful of HTTPS routes. This crate is the whole of it: the protocol's rules, the gateway a member runs, and the client a phone links.

| Module | Feature | What it is |
| --- | --- | --- |
| `rules` | always | The protocol as pure functions over a `State` trait: no clock, no file, no socket, no randomness — time and fresh tokens are arguments. The wire types, the refusal codes, the claim preimage, the bundle framing, the pairing payload, and the conformance suite. |
| `client` | `client` | The phone's pinned HTTPS client: every route as a method. |
| `server` | `server` (implies `client`) | The gateway: the certificate, SQLite state, objects as files, the routes, the sweeps, Bonjour, the CLI's pieces, and a test harness any crate can spawn. |

The default is both features, so the workspace gate runs the suite over the wire. A phone depends on `centraid-gateway = { default-features = false, features = ["client"] }` and links no listener, no SQLite and no certificate minting.

## The protocol

HTTPS with HTTP/1.1, straight from the phone to the gateway. JSON for small bodies, raw bytes for objects. The certificate is self-signed and minted at the first `serve`; a phone trusts it by its **pin**, `blake3(certificate DER)`, which the pairing QR carries, and after the first contact by its exact bytes. The key is ECDSA P-256, because Apple's TLS stack — which drives the iPhone's background uploads — refuses an Ed25519 server certificate; TLS 1.3 and 1.2 are both served.

| Route | Auth | What |
| --- | --- | --- |
| `GET /v2/info` | none | `{gateway_id, protocol: 2, time_ms}` |
| `POST /v2/pair` | none | `{vault_id, label, kind, secret?, claim?, read?}` → `{token, epoch, gateway_id}` (see [Pairing](#pairing)) |
| `GET /v2/v/{vault}/head` | bearer | `{name, taken_at_ms, epoch, set_at_ms}`, or `NO_HEAD` carrying the writer epoch |
| `PUT /v2/v/{vault}/head` | bearer, write | `{name, prev, taken_at_ms}`: compare-and-set on `prev`; registers the snapshot; `HEAD_CONFLICT` carries the head as it stands; the manifest must be held (`NOT_FOUND`); setting the head that already stands answers it again |
| `GET /v2/v/{vault}/snapshots` | bearer | `[{name, taken_at_ms, registered_at_ms}]` |
| `POST /v2/v/{vault}/exists` | bearer | `{names}` (at most 1000) → `{missing}`: the names not held |
| `PUT /v2/v/{vault}/o/{name}` | bearer, write | raw body with `Content-Length` and `Content-Digest: blake3=<hex>` → `201` stored or `200` already held with this digest, as `{name, size, digest, stored_at_ms}` |
| `GET` and `HEAD /v2/v/{vault}/o/{name}` | bearer | the bytes, or one `Range` of them (`206`); a whole answer and a `HEAD` carry the size and `Content-Digest` |
| `POST /v2/v/{vault}/bundle` | bearer, write | frames `name (64 hex) ‖ digest (64 hex) ‖ u64be len ‖ bytes`, at most 256 MiB → `{stored, already, refused: [{name, code}]}`, each frame answered as its own `PUT` would be |
| `POST /v2/v/{vault}/fetch` | bearer | `{names}` → the held objects in the same framing, in the order asked |
| `GET /v2/v/{vault}/objects?after=&limit=` | bearer | `[{name, size, digest, stored_at_ms}]` sorted by name, at most 1000 a page |
| `POST /v2/v/{vault}/delete` | bearer, write | `{names}` → `{deleted, refused}`: tombstones with a 7-day grace; the head's manifest is refused `HEAD_IN_USE` |
| `POST /v2/v/{vault}/revoke` | bearer | no body → `{revoked: true}`: the calling token is forgotten and is `UNAUTHORIZED` on every route after; any token of the vault may revoke itself |

**Auth.** `Authorization: Bearer <token>`: 32 random bytes in hex, minted at `pair`; the gateway keeps only their BLAKE3. The vault in the path must be the token's. A stranger, a token for another vault and an unknown vault get the same `UNAUTHORIZED`, so none is an oracle. A write with a token below the vault's writer epoch is refused `MOVED` with the epoch that superseded it; reads still answer, so a superseded phone can freeze read-only.

**Refusals.** Every refusal is `{"code", "time_ms", ...companions}` with the code also in a `centraid-code` header (a `HEAD` has no body). A code is never a sentence, and each has exactly one status; the client treats a refusal under any other status as a broken answer.

| Code | Status | Companions | When |
| --- | --- | --- | --- |
| `BAD_REQUEST` | 400 |  | a malformed body, header, name or parameter |
| `DIGEST_MISMATCH` | 400 | `digest` (what the bytes hash to) | the bytes are not the declared digest |
| `UNAUTHORIZED` | 401 |  | no token or the wrong one; a bad signature; a spent, expired or unknown pairing secret |
| `NOT_FOUND` | 404 | `name` | no such object or route; a head naming a manifest not held |
| `NO_HEAD` | 404 | `epoch` | the vault has no head yet |
| `MOVED` | 409 | `epoch` | a write by a superseded phone |
| `VAULT_KNOWN` | 409 |  | a pairing secret offered for a vault already here |
| `EPOCH_CONFLICT` | 409 | `epoch`, `head` | a claim whose epoch is not the writer epoch plus one |
| `HEAD_CONFLICT` | 409 | `epoch`, `head` | a compare-and-set that lost, or a claim's `head_seen` that is not the head |
| `NAME_TAKEN` | 409 | `digest` (the one held) | the name is held under another digest |
| `HEAD_IN_USE` | 409 | `name` | deleting the head's manifest |
| `TOO_LARGE` | 413 | `limit` | an object over 80 MiB or a bundle over 256 MiB |
| `TOO_MANY` | 413 | `limit` | more than 1000 names |
| `BAD_RANGE` | 416 | `size` | a `Range` the object cannot satisfy |
| `DISK_FULL` | 507 |  | the gateway's disk refused the write |
| `INTERNAL` | 500 |  | the gateway's store failed; **not a refusal**, the phone retries |

### Pairing

`centraid-gateway pair` prints a payload, as JSON and as a terminal QR: `{v: 2, gw, addrs, pin, secret, exp_ms}`. The secret is 16 random bytes, good for one new vault, once, for a day; the gateway keeps only its BLAKE3. The phone parses the payload (`rules::payload::PairPayload::parse`), dials the addresses trusting the pin, and pairs with one of three kinds:

- **`secret`** admits a vault this gateway has never seen, at writer epoch 1. A known vault is refused `VAULT_KNOWN` and the secret is not spent.
- **`claim`** is a restore or a takeover by a phone holding the vault identity key. It signs, with Ed25519, the length-prefixed preimage `"centraid-gateway-claim-v2" ‖ gateway_id ‖ vault_id ‖ u64be(epoch) ‖ head_seen` (`rules::claim::claim_preimage`, which the phone calls too). `epoch` must be the writer epoch plus one and `head_seen` the current head, or nothing moves. The old phone's next write is `MOVED`.
- **`read`** is the same signature at epoch 0: a token that reads and never writes, so a restoring phone can read the head before it claims.

When a pairing lands, `serve` prints the pairing **safety number** — `centraid_identity::safety_number_of_bytes` over the vault identity key and the pin, the digits the phone shows — and `pairings` prints it beside each vault. The function reads both as 32 bytes and decodes neither, so every pin has a number (the root's ruling A17). Nothing about it is on the wire.

### What a phone's store relies on

The `store/` cases of the suite hold these, and the vault's `MemoryStore` models them in memory ([#1080](https://github.com/srikanth235/centraid/issues/1080), the root's ruling A15):

- **Write-once by name and digest.** A name held with the same digest is `AlreadyStored` and nothing moves. A name held with another digest is `NAME_TAKEN` — and the client counts it as an acknowledgement, because a name is a function of the plaintext and sealing is salted: another digest under the name is the same bytes sealed again. `client::Put` has the three answers, every one an acknowledgement; `BundleAnswer::acknowledged` is the same for a bundle.
- **A tombstone is not held.** `exists` lists it missing, the listing leaves it out, and a `PUT` stores the name again and clears the tombstone, so the purge leaves it alone. Until the purge, `GET` and `fetch` still serve its bytes: a restore that began from a snapshot keeps reading it while retention drops that snapshot.
- **Deleting is idempotent.** A name never stored, already tombstoned or already purged is `deleted`.
- **A head names a held manifest**, never one absent or tombstoned.
- **A damaged object is not served.** The scrub marks what no longer hashes to its digest; `exists` lists it missing so the phone sends it again, `GET` answers `NOT_FOUND`, and `fetch` leaves it out. A name whose file is gone from `objects/` is marked the same way the moment an `exists`, a `PUT` or a bundle frame meets it, without waiting for the scrub, so the `PUT` that brings it back stores it.

### Bodies stream at both ends

A snapshot is thousands of 64 KiB ranges sent through `bundle` and restored through `fetch`, in bodies of up to 256 MiB (the root's ruling A14). The gateway stages each arriving frame to its own file while hashing it, and serves `fetch` and `GET` from the files. The client sends `bundle_parts` from memory or straight from spool files and hands a `fetch_each` answer over one verified frame at a time. `tests/store_client.rs` sends 252 MiB up and back while the process grows by a few MiB.

## The data directory

Everything a gateway has is one directory of plain files. Copying it anywhere copies the gateway.

| Path | What |
| --- | --- |
| `tls.key`, `tls.crt`, `gateway.id` | the identity, minted together at the first `serve`, mode 0600 |
| `state.db` (and its `-wal`, `-shm`) | SQLite: vaults, BLAKE3 of tokens and pairing secrets, heads, snapshot history, the object index |
| `objects/<vault>/<nn>/<name>` | one sealed object per file |
| `incoming/` | uploads being staged; emptied when `serve` starts |
| `serve.json` | the address `serve` last bound, which `pair` and `health` read |
| `sweeps.json` | when the purge and the scrub last finished |
| `logs/` | macOS only: the launchd agent's output |

**What a stolen copy yields.** Ciphertext; object names, which are keyed hashes nobody can invert; digests of the ciphertext; sizes; times — paired, stored, deleted, heads set, snapshots taken; device labels; the vault identity **public** keys and writer epochs. No plaintext, no plaintext hash and no key that opens anything has a column or a file to arrive in, and the suite's canary scans every byte of the directory, file names included, for each. Tokens and pairing secrets are there only as BLAKE3 of 32 and 16 random bytes, so none can be replayed. The directory does hold **the gateway's TLS key**: a thief who can also answer at the gateway's address can impersonate it to its phones — and receive more ciphertext, or lose what they send. After a theft, mint a new identity (move the three identity files aside and `serve`) and pair each phone again.

## The sweeps

- **Purge, hourly**: every tombstone past its 7-day grace loses its file and its row.
- **Scrub, quarterly**, and on demand with the `scrub` verb: every stored object is read and re-hashed against its digest — no key involved — and what fails is marked damaged.

Each is due one interval after it last finished, by the gateway's clock, as `sweeps.json` records: a restart or a night asleep does not reset the quarter, a gateway off for a month sweeps once when it wakes, and a failed sweep is tried again an hour later. Both log counts only, never a name.

## The CLI

```text
centraid-gateway serve    --data-dir DIR [--bind 0.0.0.0:8443] [--no-mdns]
centraid-gateway pair     --data-dir DIR [--port 8443]
centraid-gateway pairings --data-dir DIR [revoke <token id>]
centraid-gateway scrub    --data-dir DIR
centraid-gateway health   [--data-dir DIR] [--addr HOST:PORT] [--pin HEX]
centraid-gateway install  --data-dir DIR [--bind 0.0.0.0:8443] [--dry-run] [--label dev.centraid.gateway]
```

`--data-dir` and `--bind` also read `CENTRAID_GATEWAY_DATA_DIR` and `CENTRAID_GATEWAY_BIND`.

- **`serve`** runs with no vault. On an empty directory it mints the identity, listens, and prints the gateway id, the pin and the first pairing QR; nothing is stored until a phone pairs. It advertises `_centraid-gateway._tcp` on the LAN (TXT `gw`, `v=2`) unless told `--no-mdns`, runs the sweeps, and stops on Ctrl-C or `SIGTERM`.
- **`pair`** prints a fresh payload and QR beside a running `serve`, listing this machine's addresses on the port `serve` bound.
- **`pairings`** lists each vault: its writer epoch, safety number, head and tokens — each with its id, the first 12 hex characters of its BLAKE3 — and how many pairing secrets wait, were spent or expired. **`pairings revoke <token id>`** forgets one token, for a phone that is lost and cannot revoke itself.
- **`scrub`** runs the scrub now.
- **`health`** asks a running gateway for `GET /v2/info`, trusting the certificate in the data directory and dialling where its `serve` listens, or another gateway's `--addr` and `--pin`. It exits non-zero when the gateway is down or not the pinned one.
- **`install`** writes a **user** systemd unit or a launchd agent and never enables it; `--dry-run` prints it and touches nothing. The systemd unit hides the home directory and binds back only the data directory and the binary, so a data directory under `~` works; `install` creates a missing data directory, mode 0700, first.

The container image is [`deploy/gateway/Dockerfile`](../../deploy/gateway/Dockerfile); run it with `--network host`, so the QR names addresses a phone can dial and Bonjour reaches the LAN.

## For the crates that talk to a gateway

- **`client::Client`**: `first_contact(addrs, pin)` from a scanned payload, then `pair`, then `destination()` — the addresses, the certificate's DER and the token, which is what a phone's ledger keeps — and `Client::new(&destination)` for every later contact. One kept connection; addresses are tried in order from the one that answered last; `Unreachable` is a phone away from home, `Untrusted` is a different machine where the gateway should be, and `Damaged` is bytes that do not hash to the digest they came with. `presign_put` prepares a `PUT` for the platform's background uploader to perform. The client never says something is backed up; it returns what the gateway acknowledged.
- **`server::harness::spawn(dir)`** starts a real gateway on `127.0.0.1:0` on the caller's tokio runtime, for tests in any crate: mint a pairing secret or a payload, get a client, move the gateway's clock, run a sweep now, flip a stored bit. Nothing below the socket is faked.
- **`rules::conformance::run(&mut target)`** is the suite every gateway must pass: 31 named cases over a `Target`, run in memory by `tests/conformance.rs` and over the wire through the real client by `tests/conformance_wire.rs`. The canary cases scan everything at rest for planted plaintexts, their BLAKE3, the keys that would open them, every token and every pairing secret.

## The tests

| File | What it holds |
| --- | --- |
| `tests/conformance.rs` | the suite over the in-memory rules, and that the suite catches a careless target |
| `tests/conformance_wire.rs` | the suite over the real gateway through the real client |
| `tests/pure_rules.rs` | that `rules` reaches for no clock, file, socket, runtime or randomness |
| `tests/tls.rs` | a P-256 certificate naming the gateway; TLS 1.2 and 1.3; the pin trusted and any other refused; the pinned certificate without its key refused |
| `tests/pair_from_payload.rs` | a phone pairing from the text of a QR and handing an upload to a client that is not ours; the safety line printed when a pairing lands |
| `tests/store_client.rs` | `Put`'s three acknowledgements; a bundle frame held before its body ends; a quarter-gibibyte up and back in a few MiB |
| `tests/revoke.rs` | a phone revoking its own token, and the operator revoking a lost phone's by the id `pairings` prints: the token's `PUT` and `GET` are refused `UNAUTHORIZED` after |
