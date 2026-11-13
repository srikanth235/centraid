# `crates/gateway` — the gateway, protocol v3

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
| `GET /v3/info` | none | `{gateway_id, protocol: 3, time_ms}` |
| `POST /v3/nonce` | none | no body → `{nonce: 32 hex, ttl_ms: 300000}`: a single-use nonce for one pair request. Names no vault. At 4096 live nonces: `BUSY` |
| `POST /v3/pair` | none | `{vault_id, label, kind, nonce, secret? \| claim? \| read?}` → `{token, epoch, gateway_id}` (see [Pairing](#pairing)) |
| `GET /v3/v/{vault}/head` | bearer | the head **as the phone signed it**: `{name, prev, taken_at_ms, epoch, generation, writes, set_at_ms, signature, claim}`, or `NO_HEAD` carrying the writer epoch and the `claim`. `epoch` is what the phone signed; `claim` is the vault's standing claim (`{epoch, head_seen, nonce, signature}`, null before any claim), the same shape `MOVED` carries: the phone takes the writer epoch as the greater of the verified head's and the verified claim's epoch, and acts on no unsigned number |
| `PUT /v3/v/{vault}/head` | bearer, write | `{name, prev, taken_at_ms, generation, writes, signature}`: the vault key's signature over the head ([`signing`](src/rules/signing.rs)). Judged in order: signature, clock (`CLOCK_AHEAD`), generation (`OUT_OF_ORDER`), writes (`OUT_OF_ORDER`), compare-and-set on `prev` (`HEAD_CONFLICT`), manifest held (`NOT_FOUND`). The same head with the same signature answers itself again |
| `GET /v3/v/{vault}/snapshots?after=&limit=` | bearer | `[{name, taken_at_ms, registered_at_ms, held_at_ms?, purge_after_ms?}]` by name, at most 1000 a page; a snapshot whose manifest is held for deletion stays listed, with its dates |
| `POST /v3/v/{vault}/exists` | bearer | `{names}` (at most 1000) → `{missing}`: the names not live (absent, held for deletion, or damaged) |
| `PUT /v3/v/{vault}/o/{name}` | bearer, write | raw body with `Content-Length` and `Content-Digest: blake3=<hex>` → `201` stored or `200` already live with this digest, as `{name, size, digest, stored_at_ms}`. A `PUT` of a name held for deletion **replaces the held bytes and lifts the hold** |
| `GET` and `HEAD /v3/v/{vault}/o/{name}` | bearer | the bytes, or one `Range` of them (`206`); a whole answer and a `HEAD` carry the size and `Content-Digest`. A held object is still served |
| `POST /v3/v/{vault}/bundle` | bearer, write | frames `name (64 hex) ‖ digest (64 hex) ‖ u64be len ‖ bytes`, at most 256 MiB → `{stored, already, refused: [{name, code}]}`, each frame answered as its own `PUT` would be. **The frames are staged as they arrive and their rows commit in one transaction** |
| `POST /v3/v/{vault}/fetch` | bearer | `{names}` → the held-or-live objects in the same framing, in the order asked |
| `GET /v3/v/{vault}/objects?after=&limit=` | bearer | `[{name, size, digest, stored_at_ms}]` of what is live, sorted by name, at most 1000 a page |
| `GET /v3/v/{vault}/held?after=&limit=` | bearer | `[{name, size, digest, kind: "object" \| "snapshot", held_at_ms, purge_after_ms}]` by name: what the vault key asked to delete and the gateway is holding for seven days |
| `POST /v3/v/{vault}/delete` | bearer, write | `{names, generation, signature}` → `{deleted, refused}`. **Signed by the vault key**; nothing is removed: each name is held for seven days by the gateway's clock. The head's manifest is refused `HEAD_IN_USE` |
| `POST /v3/v/{vault}/undo` | bearer, write | `{names \| null, generation, signature}` → `{undone}`: lifts the holds of the names, or every hold when null. Signed; never moves the head |
| `POST /v3/v/{vault}/revoke` | bearer | no body → `{revoked: true}`: the calling token is forgotten and is `UNAUTHORIZED` on every route after, with **no tombstone**; any token of the vault may revoke itself |

**Auth.** `Authorization: Bearer <token>`: 32 random bytes in hex, minted at `pair`; the gateway keeps only their BLAKE3. The vault in the path must be the token's. A stranger, a token for another vault and an unknown vault get the same `UNAUTHORIZED`, so none is an oracle. **A takeover leaves no live older token**: a claim deletes every token of the vault, reads included, and leaves a tombstone (the token's hash, its vault and epoch) for a year, at most 64 a vault; a revoked token answers `MOVED` carrying the signed claim on **every** route, reads included, until its tombstone is pruned, and `UNAUTHORIZED` after. A read grant never writes and a write by one is `UNAUTHORIZED`. A write to a vault the operator froze is `FROZEN`.

**One counter.** Heads, deletes and undos share a `generation` per vault. A signed record is accepted only if its signature verifies, its `generation` is above the standing one by at most 256 (else `OUT_OF_ORDER`, carrying the standing epoch, generation and writes), and, for a head, its `writes` has not fallen. A claim resets the counters; the first record of the new epoch is at generation 1 to 256.

**Refusals.** Every refusal is `{"code", "time_ms", ...companions}` with the code also in a `centraid-code` header (a `HEAD` has no body, so a `HEAD` that is `MOVED` is asked again as `GET head` by the client to hear the claim). A code is never a sentence, and each has exactly one status; the client treats a refusal under any other status as a broken answer.

| Code | Status | Companions | When |
| --- | --- | --- | --- |
| `BAD_REQUEST` | 400 |  | a malformed body, header, name or parameter |
| `DIGEST_MISMATCH` | 400 | `digest` (what the bytes hash to) | the bytes are not the declared digest |
| `CLOCK_AHEAD` | 400 | `skew_ms` | a head dated more than 300,000 ms ahead of the gateway's clock |
| `UNAUTHORIZED` | 401 |  | no token or the wrong one; a bad, missing or replayed signature; a spent, expired or unknown nonce or pairing secret |
| `NOT_FOUND` | 404 | `name` | no such object or route; a head naming a manifest not live |
| `NO_HEAD` | 404 | `epoch` | the vault has no head yet |
| `MOVED` | 409 | `epoch`, `claim: {epoch, head_seen, nonce, signature}` | another phone has taken over: a token a claim revoked. The phone verifies the claim against its own vault key |
| `VAULT_KNOWN` | 409 |  | a pairing secret offered for a vault already here |
| `EPOCH_CONFLICT` | 409 | `epoch`, `head` | a claim whose epoch is not the writer epoch plus one |
| `HEAD_CONFLICT` | 409 | `epoch`, `head` | a compare-and-set that lost, or a claim's `head_seen` that is not the head |
| `OUT_OF_ORDER` | 409 | `epoch`, `generation`, `writes` | a signed record not newer than the standing one, or more than 256 ahead, or whose writes fell |
| `NAME_TAKEN` | 409 | `digest` (the one held) | the name is live under another digest |
| `HEAD_IN_USE` | 409 | `name` | deleting the head's manifest |
| `TOO_LARGE` | 413 | `limit` | an object over 80 MiB or a bundle over 256 MiB |
| `TOO_MANY` | 413 | `limit` | more than 1000 names |
| `BAD_RANGE` | 416 | `size` | a `Range` the object cannot satisfy |
| `FROZEN` | 423 | `since_ms` | the operator froze the vault: every state-changing route, a claim and a pairing by secret are refused; reads, `nonce` and read grants answer |
| `INTERNAL` | 500 |  | the gateway's store failed; **not a refusal**, the phone retries |
| `BUSY` | 503 | `retry_after_ms` | 4096 live nonces; ask again later |
| `DISK_FULL` | 507 |  | the gateway's disk refused the write |

### Pairing

`centraid-gateway pair` prints a payload, as JSON and as a terminal QR: `{v: 2, gw, addrs, pin, secret, exp_ms}`. The secret is 16 random bytes, good for one new vault, once, for a day; the gateway keeps only its BLAKE3, and at most 64 unused ones are live (minting another drops the oldest; a used or expired one is pruned a week later). The phone parses the payload (`rules::payload::PairPayload::parse`), dials the addresses trusting the pin, asks `POST nonce` for a single-use nonce, and pairs with one of three kinds. **Every kind signs the nonce, and the request spends it whatever the outcome**, so a recorded request cannot be replayed:

- **`secret`** admits a vault this gateway has never seen, at writer epoch 1, **to a phone that holds the vault key**: `{secret, signature}` where the signature is over `"centraid-gateway-pair-v3" ‖ gateway_id ‖ vault_id ‖ blake3(secret) ‖ nonce`. The nonce, then the secret, then the signature are checked, and any failure is `UNAUTHORIZED` and spends nothing. A known vault is refused `VAULT_KNOWN` (`FROZEN` if frozen) and the secret is not spent. **What this stops and what it does not:** someone with the QR cannot squat the member's vault id on this gateway. A photographer who pairs *their own* vault with the secret first still spends the member's code; the member sees `UNAUTHORIZED`, prints another code, and the console printed the stranger's safety number as it landed (decision 25: accepted).
- **`claim`** is a restore or a takeover by a phone holding the vault identity key. It signs, with Ed25519, `"centraid-gateway-claim-v3" ‖ gateway_id ‖ vault_id ‖ u64be(epoch) ‖ head_seen ‖ nonce` (`rules::signing::claim_preimage`, which the phone calls too). `epoch` must be the writer epoch plus one and `head_seen` the current head, or nothing moves. In one step the gateway deletes **every** older token (reads included) leaving tombstones, lifts every held delete, stores the claim to be carried by `MOVED`, and resets the generation and writes. There is no delay on a takeover.
- **`read`** is the same signature at epoch 0: a token that reads and never writes, so a restoring phone can read the head before it claims.

Every record the vault key signs — claim, read grant, head, delete, undo, pairing — has its own context string and is built in one module, [`rules::signing`](src/rules/signing.rs); the known-answer vectors are [`contracts/crypto/gateway-signing-vectors.json`](../../contracts/crypto/gateway-signing-vectors.json).

When a pairing lands, `serve` prints the pairing **safety number** — `centraid_identity::safety_number_of_bytes` over the vault identity key and the pin, the digits the phone shows — and `pairings` prints it beside each vault. The function reads both as 32 bytes and decodes neither, so every pin has a number (the root's ruling A17). Nothing about it is on the wire.

### What a phone's store relies on

The `store/` cases of the suite hold these, and the vault's `MemoryStore` models them in memory ([#1080](https://github.com/srikanth235/centraid/issues/1080), the root's ruling A15):

- **Write-once by name and digest.** A name held with the same digest is `AlreadyStored` and nothing moves. A name held with another digest is `NAME_TAKEN` — and the client counts it as an acknowledgement, because a name is a function of the plaintext and sealing is salted: another digest under the name is the same bytes sealed again. `client::Put` has the three answers, every one an acknowledgement; `BundleAnswer::acknowledged` is the same for a bundle.
- **A held delete is not live.** `exists` lists it missing, the live listing leaves it out, `held` lists it, and a `PUT` stores the name again — replacing the held bytes, which is how a damaged copy heals without waiting out the week — and lifts the hold, so the purge leaves it alone. Until the purge, `GET` and `fetch` still serve its bytes: a restore that began from a snapshot keeps reading it while retention drops that snapshot.
- **Deleting is idempotent.** A name never stored, already held or already purged is `deleted`; a name already held keeps its date.
- **A head names a live manifest**, never one absent, held or damaged.
- **A damaged object is not served.** The scrub marks what no longer hashes to its digest; `exists` lists it missing so the phone sends it again, `GET` answers `NOT_FOUND`, and `fetch` leaves it out. A name whose file is gone from `objects/` is marked the same way the moment an `exists`, a `PUT` or a bundle frame meets it, without waiting for the scrub, so the `PUT` that brings it back stores it.

### Bodies stream at both ends

A snapshot is thousands of 64 KiB ranges sent through `bundle` and restored through `fetch`, in bodies of up to 256 MiB (the root's ruling A14). The gateway stages each arriving frame to its own file while hashing it, and serves `fetch` and `GET` from the files. The client sends `bundle_parts` from memory or straight from spool files and hands a `fetch_each` answer over one verified frame at a time. `tests/store_client.rs` sends 252 MiB up and back while the process grows by a few MiB.

## The data directory

Everything a gateway has is one directory of plain files. Copying it anywhere copies the gateway.

| Path | What |
| --- | --- |
| `tls.key`, `tls.crt`, `gateway.id` | the identity, minted together at the first `serve`, mode 0600 |
| `state.db` (and its `-wal`, `-shm`) | SQLite: vaults, BLAKE3 of tokens and pairing secrets, heads, snapshot history, the object index. `application_id` `CGW3`, `user_version` = the number of ladder rungs (`src/server/sql/ladder/`). An older gateway's folder, or another program's file, is refused with the sentence below, exit code 2, the file untouched; a newer rung is refused too. Nothing is migrated |
| `objects/<vault>/<nn>/<name>` | one sealed object per file |
| `incoming/` | uploads being staged; emptied when `serve` starts |
| `serve.json` | the address `serve` last bound, which `pair` and `health` read |
| `sweeps.json` | when the purge and the scrub last finished |
| `logs/` | macOS only: the launchd agent's output |

**What a stolen copy yields.** Ciphertext; object names, which are keyed hashes nobody can invert; digests of the ciphertext; sizes; times — paired, stored, held for deletion, heads set, snapshots taken; device labels; the vault identity **public** keys, writer epochs and the **signatures** the vault key made (heads, the last claim); the BLAKE3 of revoked tokens. No nonce row names a vault. No plaintext, no plaintext hash and no key that opens anything has a column or a file to arrive in, and the suite's canary scans every byte of the directory, file names included, for each. Tokens and pairing secrets are there only as BLAKE3 of 32 and 16 random bytes, so none can be replayed. The directory does hold **the gateway's TLS key**: a thief who can also answer at the gateway's address can impersonate it to its phones — and receive more ciphertext, or lose what they send. After a theft, mint a new identity (move the three identity files aside and `serve`) and pair each phone again.

**An older data folder.** `serve` and `pairings` print "This data folder was made by an earlier version of the gateway, and this version cannot open it. Nothing was changed. Move the folder aside and start again; every phone will need to pair again." and exit with code 2. A phone whose gateway answers below protocol 3 gets `GatewayTooOld` and the member is told to update the gateway; there is no v2 fallback.

## The sweeps

- **Purge, hourly**: every held delete past its seven days loses its file and its row (a frozen vault's are skipped), then the housekeeping prunes expired nonces, pairing secrets a week after they were used or expired, and revoked-token tombstones a year after their claim, and removes **orphan** files: one listing of `objects/`, and a file with no row that is also over an hour old goes (what a crash between a bundle's renames and its commit leaves). **A gap of more than fourteen days since the last purge sweep re-bases every hold to a full week from now** before anything is purged, so a gateway that slept for a month, or whose clock jumped a year, never ends a hold early.
- **Scrub, quarterly**, and on demand with the `scrub` verb: every stored object is read and re-hashed against its digest — no key involved — and what fails is marked damaged.

Each is due one interval after it last finished, by the gateway's clock, as `sweeps.json` records: a restart or a night asleep does not reset the quarter, a gateway off for a month sweeps once when it wakes, and a failed sweep is tried again an hour later. Both log counts only, never a name. Every listing a sweep or a route runs is a seek by key, never an offset (`tests/plans.rs`).

## The CLI

```text
centraid-gateway serve    --data-dir DIR [--bind 0.0.0.0:8443] [--no-mdns]
centraid-gateway pair     --data-dir DIR [--port 8443]
centraid-gateway pairings --data-dir DIR [revoke <token id>]
centraid-gateway vault    <id8> freeze|unfreeze|undo|purge-now [--yes]|delete-vault [--yes] --data-dir DIR
centraid-gateway scrub    --data-dir DIR
centraid-gateway health   [--data-dir DIR] [--addr HOST:PORT] [--pin HEX]
centraid-gateway install  --data-dir DIR [--bind 0.0.0.0:8443] [--dry-run] [--label dev.centraid.gateway]
```

`--data-dir` and `--bind` also read `CENTRAID_GATEWAY_DATA_DIR` and `CENTRAID_GATEWAY_BIND`.

- **`serve`** runs with no vault. On an empty directory it mints the identity, listens, and prints the gateway id, the pin and the first pairing QR; nothing is stored until a phone pairs. It advertises `_centraid-gateway._tcp` on the LAN (TXT `gw`, `v=3`) unless told `--no-mdns`, runs the sweeps, and stops on Ctrl-C or `SIGTERM`.
- **`pair`** prints a fresh payload and QR beside a running `serve`, listing this machine's addresses on the port `serve` bound.
- **`pairings`** lists each vault: its writer epoch, safety number, head and tokens — each with its id, the first 12 hex characters of its BLAKE3 — and how many pairing secrets wait, were spent or expired. **`pairings revoke <token id>`** forgets one token, for a phone that is lost and cannot revoke itself.
- **`vault <id8> <verb>`** is the member's last word over one vault, `id8` the first 8 hex that `pairings` prints (refused when it names more than one). Local and unsigned, through the same rules a phone's request goes through; each prints counts, never a name; a refusal exits 3. **`freeze`** refuses every state-changing route (`FROZEN`) and skips the vault in the purge; reads, nonces and read grants still answer. **`unfreeze`** lifts it and adds the time it lasted to every hold, so freezing does not burn the week. **`undo`** lifts every hold, no signature, frozen or not. **`purge-now --yes`** makes every hold of an unfrozen vault due and runs the purge once. **`delete-vault --yes`** removes a **frozen** vault: tokens, tombstones, head, snapshots, claim, then every object in pages by name; not held.
- **`scrub`** runs the scrub now.
- **`health`** asks a running gateway for `GET /v3/info`, trusting the certificate in the data directory and dialling where its `serve` listens, or another gateway's `--addr` and `--pin`. It exits non-zero when the gateway is down or not the pinned one.
- **`install`** writes a **user** systemd unit or a launchd agent and never enables it; `--dry-run` prints it and touches nothing. The systemd unit hides the home directory and binds back only the data directory and the binary, so a data directory under `~` works; `install` creates a missing data directory, mode 0700, first.

The container image is [`deploy/gateway/Dockerfile`](../../deploy/gateway/Dockerfile); run it with `--network host`, so the QR names addresses a phone can dial and Bonjour reaches the LAN.

## For the crates that talk to a gateway

- **`client::Client`**: `first_contact(addrs, pin)` from a scanned payload, then `pair`, then `destination()` — the addresses, the certificate's DER and the token, which is what a phone's ledger keeps — and `Client::new(&destination)` for every later contact. One kept connection; addresses are tried in order from the one that answered last; `Unreachable` is a phone away from home, `Untrusted` is a different machine where the gateway should be, and `Damaged` is bytes that do not hash to the digest they came with. `presign_put` prepares a `PUT` for the platform's background uploader to perform. Once connected every wait is bounded: no answer's headers within `HEADER_TIMEOUT`, no byte of a body within `IDLE_TIMEOUT` (progress on an upload counts), TCP keepalive on the dial, and a stop given with `set_stop` is looked at every `Limits::poll` while a call waits, ending it with an interrupted `Io` error. `sibling()` gives a second client its own token over the same connection, which a restore's scan uses to handshake once. The client never says something is backed up; it returns what the gateway acknowledged.
- **`server::harness::spawn(dir)`**, behind the `test-harness` cargo feature (off by default; `cargo xtask rules` fails if anything but a dev-dependency turns it on, so the release gateway cannot link it), starts a real gateway on `127.0.0.1:0` on the caller's tokio runtime, for tests in any crate: mint a pairing secret or a payload, get a client, move the gateway's clock (it is the test's: it starts at the wall clock and moves only when told, so every edge is exact), run a sweep now, flip a stored bit, and cut the `Cable` every connection runs through — at once, after a budget of bytes either way, or `stall()` it so connections stay open and silent (a sleeping laptop) — to take the gateway away part-way through a pass or a restore. `spawn_on(dir, addr)` starts it again where it was. Nothing below the socket is faked, and the cut is in `serve.rs`, the one file that accepts: a relay in front of the gateway would be a second listener.
- **`rules::conformance::run(&mut target)`** is the suite every gateway must pass: 58 named cases over a `Target`, run in memory by `tests/conformance.rs` and over the wire through the real client by `tests/conformance_wire.rs`. Each attacker test of `contracts/backup/tests.md` is a `#[test]` of the same name in both files, running its case (`conformance::NAMED`). The canary cases scan everything at rest for planted plaintexts, their BLAKE3, the keys that would open them, every token and every pairing secret.

## The tests

| File | What it holds |
| --- | --- |
| `tests/conformance.rs` | the suite over the in-memory rules, and that the suite catches a careless target |
| `tests/conformance_wire.rs` | the suite over the real gateway through the real client |
| `tests/pure_rules.rs` | that `rules` reaches for no clock, file, socket, runtime or randomness |
| `tests/tls.rs` | a P-256 certificate naming the gateway; TLS 1.2 and 1.3; the pin trusted and any other refused; the pinned certificate without its key refused |
| `tests/pair_from_payload.rs` | a phone pairing from the text of a QR and handing an upload to a client that is not ours; the safety line printed when a pairing lands |
| `tests/store_client.rs` | `Put`'s three acknowledgements; a bundle frame staged as it arrives and admitted with the rest; a quarter-gibibyte up and back in a few MiB |
| `tests/revoke.rs` | a phone revoking its own token, and the operator revoking a lost phone's by the id `pairings` prints: the token's `PUT` and `GET` are refused `UNAUTHORIZED` after, with no tombstone |
| `tests/data_dir.rs` | an earlier gateway's folder refused with the sentence and exit code 2, its bytes unchanged; a newer rung refused; a new folder founded at `CGW3` rung 1 |
| `tests/operator.rs` | `purge-now` needs `--yes` and an unfrozen vault; `delete-vault` needs a frozen one and removes everything; the binary's exit codes |
| `tests/plans.rs` | every listing seeks an index, and the test sees a planted scan, sort and offset |
| `tests/bundle_commit.rs` | a bundle is one transaction; a child process killed with SIGKILL between a bundle's renames and its commit leaves files and no row, and the orphan sweep takes them once the clock says they are old; a sweep during an open bundle removes nothing |
| `tests/older_gateway.rs` | a stub playing a protocol-2 gateway: the real client returns `GatewayTooOld` |
| `tests/signing_vectors.rs` | the vectors in `contracts/crypto/gateway-signing-vectors.json` |
