# Key custody — three layers, three AADs

Three encryption layers live in this directory. They look alike and they are not interchangeable, because each one's AAD names a different thing about what a ciphertext is _allowed to be_. Collapsing them into one "encrypt a string" helper is how a ciphertext becomes movable between rows.

| Layer | Module | Wire form | AAD | What it protects |
| --- | --- | --- | --- | --- |
| Named secrets on disk | `keystore` | `CENTRAID-KEY-V1\n{"scheme","payload"}\n` | — (the envelope's own scheme) | the key files themselves |
| The vault DEK (seal key) | `seal` | `sealed:v1:base64(nonce ‖ ct ‖ tag)` | `<physical>.<column>:<rowId>` | one cell |
| The Locker key `K` | `locker_key` | `lk1:base64(nonce ‖ ct ‖ tag)` | `<rowId>‖<keyId>` | one row, under one key generation |

All three are AES-256-GCM with a **fresh random 96-bit nonce per value**. The deterministic nonces in this codebase belong to the byte plane and the backup plane (`crates/media`, `crates/vault/src/backup`) and are documented there; the distinction is load-bearing, because a derived nonce over a partial address is a nonce reuse.

Ported faithfully from v0's `packages/vault/src/schema/{key-store,sealed}.ts` and `packages/vault/src/gateway/locker-key-plane.ts` ([#1020](https://github.com/srikanth235/centraid/issues/1020), D-1020-R2).

## `keystore` — the envelope, and why adoption is loud rather than refused

A key file is never a bare secret. Two schemes: `file-0600-v1` (unprotected, **adoption only**) and `aes-256-gcm-v1` (`nonce(12) ‖ tag(16) ‖ ciphertext` under a host wrapping key — note the tag is in the middle, which is v0's byte order and the files exist).

Three behaviours that read like rough edges and are deliberate:

- A pre-envelope raw 32-byte file is adopted and **rewritten before the read returns**, so a successful open never leaves live raw material behind.
- An unprotected envelope found on a host that _has_ custody is adopted, rewrapped, and **warned about**. Refusing outright needs an operator-visible switch and a release note; until then the adoption is a line in the log and not an invisible success. `take_warnings()` is how a caller gets it.
- Loose permissions are **repaired** to 600 with a warning, not refused.

`atomic_write` is the durability rule: a temp file at `O_EXCL` mode 0600, a `before_commit` fault seam, `rename`, `chmod 600`, and the temp removed on every failure path. A half-written key file is the one unrecoverable outcome, so it is the one outcome that cannot happen. `rotate` goes through a `<name>.next` sidecar, which is what makes an interrupted rotation recoverable.

## `seal` — the cell AAD, and the structural predicate

The AAD is the whole security property: a ciphertext lifted out of one cell and dropped into another fails to open. `is_sealed_value` is therefore **structural**, not a `starts_with`: prefix, then a strict-alphabet base64 body of at least 38 characters, a multiple of four long, decoding to at least `nonce + tag` bytes. A member password that merely begins `sealed:v1:` must be _sealed_, not stored verbatim as "already sealed" — a bare prefix test hands an attacker a way to write plaintext into a sealed column by choosing its first ten characters.

`seal_key_fingerprint` is a truncated SHA-256, safe in a receipt, and `stamp_seal_key_fingerprint` writes it into `core_vault.settings_json` **inside the sealing transaction**. "This vault has secrets" and the secrets commit together, so a crash cannot leave sealed cells whose key nothing names.

## `locker_key` — rotation is an order, not a transaction

`keys/` and `vault.db` share no transaction, so the **order** is the guarantee:

1. write `K′` to `keys/` as a new file (the old one untouched);
2. **one** DB transaction: retire the old row, insert the new row, re-encrypt every secret, bump every `key_id`;
3. delete the old key file.

A crash between 1 and 2 leaves the DB naming the old key and `K′` an orphan; a crash between 2 and 3 leaves the retired file behind. `sweep_retired_locker_keys` reconciles either on open. At no point is any ciphertext under a key the DB does not name, and at no point are two rows live. Both windows have a test (`a_crash_between_the_new_key_file_and_the_transaction_sweeps_clean`, `a_crash_between_the_transaction_and_the_old_file_delete_sweeps_clean`).

The retire **precedes** the insert inside step 2 because `locker_key_live_idx` is checked per statement, not per transaction. That index is on the _predicate_ (`ON locker_key(retired_at IS NULL) WHERE retired_at IS NULL`), because SQLite treats NULLs as distinct and indexing `retired_at` itself would permit any number of live rows.

Only secret **values** are encrypted. Title, url and username stay plaintext, so a locked seat can list and search offline — which is the whole reason Locker is usable on a phone in airplane mode.

## What moves in wave 4

The gateway **holds** `K` today. That is v0's posture, and R-1020's trust premise moves `K` to a member key the gateway never holds; the wave 4 Locker lane owns the member-key half.

What wave 2 landed is the shape that makes it a change of custody rather than a rewrite:

- every seal/unseal function takes the key **by value**, so there is no ambient `K` for a future read path to reach for;
- the only gateway paths that call unseal are the ones that deliberately reveal;
- `gateway_file_and_keystore_do_not_reveal_a_cell_without_k` is the acceptance test in its wave 2 form. It opens the vault file _and_ the whole `keys/` directory with `K` withheld and asserts every `lk1:` cell fails to open, under every byte string the host still offers.

That test does not, and does not claim to, prove the gateway cannot obtain `K`. It proves a sealed cell depends on `K` and on **nothing else that is on disk** — which is exactly the property wave 4 needs in order to move the key without touching the format. When `K` becomes a member key, the assertion in that test is already the right one.

## Where the recovery kit fits

`keys/` is deliberately outside the directory that export, backup and copy gestures move around. A copied vault carries ciphertext only, and the recovery kit (`crates/vault/src/backup/kit.rs`) is the one artefact that carries keys — so a `locker_key` file missing from `keys/` is unambiguous custody loss, and the error message says which artefact would have carried it.
