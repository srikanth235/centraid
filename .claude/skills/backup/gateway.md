# The gateway

[`crates/gateway`](../../../crates/gateway/README.md) is the protocol's rules, the gateway a member runs and the client a phone links. Its README holds the routes, refusal codes, CLI and data directory. This page is what to keep true when you change it. What a member is told about it: [product.md](./product.md).

## What it stores

- One data directory of plain files. Copying it copies the gateway.
- `state.db` (SQLite, `synchronous = FULL`, `application_id` `CGW3`, a `user_version` ladder) holds vault ids (public keys), writer epochs, BLAKE3 of tokens and pairing secrets, device labels, the signed head and one signed row per snapshot, the last signed claim, revoked-token tombstones, single-use nonces, and per object a name, digest of the ciphertext, size and times.
- `objects/<vault>/<nn>/<name>` holds one sealed object per file. A bundle frame stages in `incoming/` as it arrives and is renamed into place only after its digest is checked; each frame commits on its own (stage, fsync, rename, then its row), so a connection that drops leaves every finished frame committed and a frame cut off mid-way is discarded.
- Identity is `tls.key`, `tls.crt` and `gateway.id`, minted together at the first `serve`. The phone trusts the certificate by pin.
- Every phone-facing decision is in `src/rules`, with no clock, file, socket or randomness. `src/server` adapts it (SQLite, files, axum, sweeps) and decides nothing. `tests/pure_rules.rs` scans the rules for any reach.

## What it must never be able to do

- Read an object, recognise a known file, or hold a key. Object names are keyed hashes it cannot invert. The crate has no sealed-format code and depends on no `centraid-media`.
- Hold a plaintext, a plaintext hash or a key in a column or file. The `state.rs` records are the whole of what it knows, and a conformance canary plants all three and scans every byte it keeps.
- Overwrite an object. Storage is write-once by name and digest.
- Delete the head's manifest, take a write from a token below the vault's writer epoch, or accept a head, delete or undo the vault key did not sign. It cannot forge one either: it holds no key.
- Take a delete computed under any head but its current one. The delete's signed preimage carries the head's root name after `generation`, and the gateway refuses (`HEAD_CONFLICT`, carrying the head it has) when that is not its head, so a gateway whose data directory was rolled back never applies a keep set computed from a head it does not have.
- Remove anything the vault key deleted before seven days of the gateway's clock have passed (a gap of more than three sweep intervals is added to every hold, so unwatched time is never counted), or at all while the operator has frozen the vault.
- Leave an older token alive after a takeover.
- Tell a stranger, another vault's token and an unknown vault apart. All answer `UNAUTHORIZED`.
- Say "backed up". It returns acknowledgements and the client passes them on.

## What its operator sees

- Only a terminal. `serve` prints the gateway id, the pin, the bound address and a pairing QR, and when a phone pairs, its safety number. A data folder an earlier gateway made is refused with a sentence and exit code 2.
- `pairings` lists each vault by the first 8 hex of its id: epoch, safety number, head, tokens by the first 12 hex of their BLAKE3, and counts of waiting, spent and expired secrets. The operator can revoke a token, run `scrub`, or `install` a unit file, and has the last word over a vault: `vault <id8> freeze | unfreeze | undo | purge-now --yes | delete-vault --yes`.
- Holds count only watched time: after a gap of more than three sweep intervals every hold shifts by the whole gap before the purge, so a sleeping gateway or a jumped clock never ends one early. The nonce route writes nothing (a MAC-keyed stateless nonce; the spent table is written only after a valid signature). A bundle frame over a held or damaged name is accepted only with the recorded digest (`taken` carries it and the name's state; a held name with the right digest is answered `held` and its hold lifted); only a signed delete frees a damaged name, at once, reported in `freed`. Objects arrive only through `POST bundle`; a method no route takes (an upload straight to an object's path) is `NOT_FOUND`. Handlers do their rules and file work on the blocking pool, never on a tokio worker.
- Amendments for `contracts/backup/decisions.md` (fold these in when the backup skill absorbs it): E5 the nonce is stateless and spent only after a valid signature (R2); E6 the 14-day re-base is replaced by the watched-time gap rule (R1), and a delete is bound to the head it was computed under; A15 a frame over a held or damaged name must match the recorded digest, and `taken` there is not an acknowledgement; a signed delete frees a damaged name at once, in `freed` (R3, decision 30); the takeover tombstone trim drops read-grant tombstones first (R6); a refused `state.db` leaves the folder byte-identical (R7).
- The purge and scrub sweeps log counts, never names. A stolen copy yields ciphertext, names, digests, sizes, times, labels, public keys and epochs. It also holds the gateway's TLS key.
- **Check this name** (decision 34): `POST /v1/v/{vault}/check` is the phone's way to ask the gateway to hash one stored object against its recorded digest between scrubs (the scrub is quarterly, 90 days from the last finish). Signed by the vault key under its own context and ordered by the delete counter, so a token alone, a replay or a delete's signature is refused; a frozen vault refuses it; 64 names per vault per hour, then `BUSY`. A mismatch marks the name damaged (a signed delete then frees it at once); a match changes nothing.

## Changing the protocol

0. A change to what the vault key signs is a change to `rules::signing` and to `contracts/crypto/gateway-signing-vectors.json` (`CENTRAID_UPDATE_FIXTURES=1 cargo test -p centraid-gateway --test signing_vectors`, once, then without the variable), and the phone calls the same builders. A delete signs `epoch`, `generation`, the head's root name (`head_root`, empty for no head) and `names_digest`; its `DeleteRequest` carries `head_root` too.
1. Put the decision in `rules::engine`. Add request and answer shapes to `rules::wire` and every shared number to `rules::limits`, which both ends import. A new refusal is a closed code in `rules::code` with exactly one status and its companions.
2. Add the adapter side: `src/server/http.rs` renders and decides nothing. SQL lives in `src/server/sql/*.sql`; every listing is a seek by key (add it to `sql::LISTINGS` so `tests/plans.rs` sees it); and the schema is a ladder (`sql/ladder/NNN_*.sql`, one transaction per rung, `user_version` counts them); a change is a new rung once released.
3. Add the client method in `src/client/mod.rs`, and decide whether it is idempotent: only an idempotent call goes through `retrying` (at most `MAX_RETRIES` repeats after a dropped connection or a `BUSY`). The client dials every address in parallel and speaks HTTP/2 or HTTP/1.1 by ALPN; a method must work over both (`tests/transport.rs`).
4. Add a named case to `rules::conformance::CASES` (67 now), and a row in `conformance::NAMED` with a test of that name in both conformance files if `tests.md` names one. It runs over the in-memory rules and over the wire, and the two must agree. Add a case in the same change as any new rule.
5. Mirror it in the phone's `Store` trait in the vault's backup store. `centraid-vault` depends on `centraid-gateway` with `default-features = false` (pure rules only, zero I/O), so limits, refusal codes, wire enums and `MemoryStore` (`Gateway<MemoryState>`) all come straight from `centraid_gateway::rules` rather than being restated.
6. Check how the phone hears it: the client's `ClientError::reach()` and `Reach` give the typed outcome (`ok`, `unreachable`, `untrusted`, `too_old`, `pair_again`, `moved`, `frozen`, `busy`); a new refusal code must land in one of them or read as `ok` (the gateway answered). An unknown code reads as "refused for another reason".
7. Update the README tables in the same change.

## Tests

`conformance`, `conformance_wire`, `tls`, `transport`, `frames`, `delete_rollback`, `pair_from_payload`, `store_client`, `revoke`, `lost_bytes`, `stalled`, `data_dir`, `operator`, `plans`, `bundle_commit` and `signing_vectors` live in `crates/gateway/tests`. `server::harness::spawn` (behind the `test-harness` feature, never in the release gateway) starts a real gateway on `127.0.0.1:0` for tests in any crate, and can cut or stall its connection; `spawn_http1_only` offers `http/1.1` alone; `harness::put` sends one frame; `knobs().on_committed` says when a frame is committed. Assert on counts, never on seconds.
