# The gateway

[`crates/gateway`](../../../crates/gateway/README.md) is the protocol's rules, the gateway a member runs and the client a phone links. Its README holds the routes, refusal codes, CLI and data directory. This page is what to keep true when you change it. What a member is told about it: [product.md](./product.md).

## What it stores

- One data directory of plain files. Copying it copies the gateway.
- `state.db` (SQLite, `synchronous = FULL`, `application_id` `CGW3`, a `user_version` ladder) holds vault ids (public keys), writer epochs, BLAKE3 of tokens and pairing secrets, device labels, the signed head and one signed row per snapshot, the last signed claim, revoked-token tombstones, single-use nonces, and per object a name, digest of the ciphertext, size and times.
- `objects/<vault>/<nn>/<name>` holds one sealed object per file. Uploads stage in `incoming/` and are renamed into place only after the digest is checked.
- Identity is `tls.key`, `tls.crt` and `gateway.id`, minted together at the first `serve`. The phone trusts the certificate by pin.
- Every phone-facing decision is in `src/rules`, with no clock, file, socket or randomness. `src/server` adapts it (SQLite, files, axum, sweeps) and decides nothing. `tests/pure_rules.rs` scans the rules for any reach.

## What it must never be able to do

- Read an object, recognise a known file, or hold a key. Object names are keyed hashes it cannot invert. The crate has no sealed-format code and depends on no `centraid-media`.
- Hold a plaintext, a plaintext hash or a key in a column or file. The `state.rs` records are the whole of what it knows, and a conformance canary plants all three and scans every byte it keeps.
- Overwrite an object. Storage is write-once by name and digest.
- Delete the head's manifest, take a write from a token below the vault's writer epoch, or accept a head, delete or undo the vault key did not sign. It cannot forge one either: it holds no key.
- Remove anything the vault key deleted before seven days of the gateway's clock have passed (a long gap re-bases the week), or at all while the operator has frozen the vault.
- Leave an older token alive after a takeover.
- Tell a stranger, another vault's token and an unknown vault apart. All answer `UNAUTHORIZED`.
- Say "backed up". It returns acknowledgements and the client passes them on.

## What its operator sees

- Only a terminal. `serve` prints the gateway id, the pin, the bound address and a pairing QR, and when a phone pairs, its safety number. A data folder an earlier gateway made is refused with a sentence and exit code 2.
- `pairings` lists each vault by the first 8 hex of its id: epoch, safety number, head, tokens by the first 12 hex of their BLAKE3, and counts of waiting, spent and expired secrets. The operator can revoke a token, run `scrub`, or `install` a unit file, and has the last word over a vault: `vault <id8> freeze | unfreeze | undo | purge-now --yes | delete-vault --yes`.
- The purge and scrub sweeps log counts, never names. A stolen copy yields ciphertext, names, digests, sizes, times, labels, public keys and epochs. It also holds the gateway's TLS key.

## Changing the protocol

0. A change to what the vault key signs is a change to `rules::signing` and to `contracts/crypto/gateway-signing-vectors.json` (`CENTRAID_UPDATE_FIXTURES=1 cargo test -p centraid-gateway --test signing_vectors`), and the phone calls the same builders.
1. Put the decision in `rules::engine`. Add request and answer shapes to `rules::wire` and every shared number to `rules::limits`, which both ends import. A new refusal is a closed code in `rules::code` with exactly one status and its companions.
2. Add the adapter side: `src/server/http.rs` renders and decides nothing. SQL lives in `src/server/sql/*.sql`; every listing is a seek by key (add it to `sql::LISTINGS` so `tests/plans.rs` sees it); and the schema is a ladder (`sql/ladder/NNN_*.sql`, one transaction per rung, `user_version` counts them); a change is a new rung once released.
3. Add the client method in `src/client/mod.rs`.
4. Add a named case to `rules::conformance::CASES` (58 now), and a row in `conformance::NAMED` with a test of that name in both conformance files if `tests.md` names one. It runs over the in-memory rules and over the wire, and the two must agree. Add a case in the same change as any new rule.
5. Mirror it in the phone's `Store` trait and `MemoryStore` in [`store.rs`](../../../crates/vault/src/backup/store.rs). The vault crate does not depend on the gateway, so it restates `MAX_NAMES`, `MAX_BUNDLE_BYTES` and `GRACE_MS` of `limits.rs` by hand as `NAMES_PER_CALL`, `BUNDLE_BYTES` and `TOMBSTONE_GRACE_MS`. Keep them equal.
6. Check how the phone hears it. [`link.rs`](../../../crates/core/src/phone/link.rs) turns refusals into `StoreError`, and `refused_by` and `heard_of` in `drain.rs` turn a code into a wait reason. An unknown code reads as "refused for another reason".
7. Update the README tables in the same change.

## Tests

`conformance`, `conformance_wire`, `tls`, `pair_from_payload`, `store_client`, `revoke`, `lost_bytes`, `stalled`, `data_dir`, `operator`, `plans`, `bundle_commit` and `signing_vectors` live in `crates/gateway/tests`. `server::harness::spawn` (behind the `test-harness` feature, never in the release gateway) starts a real gateway on `127.0.0.1:0` for tests in any crate, and can cut or stall its connection. Assert on counts, never on seconds.
