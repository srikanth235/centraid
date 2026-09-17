# Key custody — three layers, three AADs

Three encryption layers live in this directory. They look alike and they are not interchangeable, because each one's AAD names a different thing about what a ciphertext is _allowed to be_. Collapsing them into one "encrypt a string" helper is how a ciphertext becomes movable between rows.

| Layer | Module | Wire form | AAD | What it protects |
| --- | --- | --- | --- | --- |
| Named secrets on disk | `keystore` | `CENTRAID-KEY-V1\n{"scheme","payload"}\n` | — (the envelope's own scheme) | the key files themselves |
| The vault DEK (seal key) | `seal` | `sealed:v1:base64(nonce ‖ ct ‖ tag)` | `<physical>.<column>:<rowId>` | one cell |
| The Locker key `K` | `locker_key` (format), `member_key` (custody) | `lk1:base64(nonce ‖ ct ‖ tag)` | `<rowId>‖<keyId>` | one row, under one key generation |
| `K` on its way to a second seat | `member_key` | `mk1:base64(nonce ‖ ct ‖ tag)` | `<vaultId>‖<keyId>‖<deviceId>` | the key itself, in transit through a host that must not open it |

All three are AES-256-GCM with a **fresh random 96-bit nonce per value**. The deterministic nonces in this codebase belong to the byte plane and the backup plane (`crates/media`, `crates/vault/src/backup`) and are documented there; the distinction is load-bearing, because a derived nonce over a partial address is a nonce reuse.

The formats are fixed by files that exist ([#1020](https://github.com/srikanth235/centraid/issues/1020), D-1020-R2), and one property shapes the whole directory: **`K` is not in the gateway's custody**. See [The member key](#the-member-key--the-box-is-closed).

## `keystore` — the envelope, and why adoption is loud rather than refused

A key file is never a bare secret. Two schemes: `file-0600-v1` (unprotected, **adoption only**) and `aes-256-gcm-v1` (`nonce(12) ‖ tag(16) ‖ ciphertext` under a host wrapping key — note the tag is in the middle, which is the byte order the existing files use).

Three behaviours that read like rough edges and are deliberate:

- A pre-envelope raw 32-byte file is adopted and **rewritten before the read returns**, so a successful open never leaves live raw material behind.
- An unprotected envelope found on a host that _has_ custody is adopted, rewrapped, and **warned about**. Refusing outright needs an operator-visible switch and a release note; until then the adoption is a line in the log and not an invisible success. `take_warnings()` is how a caller gets it.
- Loose permissions are **repaired** to 600 with a warning, not refused.

`atomic_write` is the durability rule: a temp file at `O_EXCL` mode 0600, a `before_commit` fault seam, `rename`, `chmod 600`, and the temp removed on every failure path. A half-written key file is the one unrecoverable outcome, so it is the one outcome that cannot happen. `rotate` goes through a `<name>.next` sidecar, which is what makes an interrupted rotation recoverable.

## `seal` — the cell AAD, and the structural predicate

The AAD is the whole security property: a ciphertext lifted out of one cell and dropped into another fails to open. `is_sealed_value` is therefore **structural**, not a `starts_with`: prefix, then a strict-alphabet base64 body of at least 38 characters, a multiple of four long, decoding to at least `nonce + tag` bytes. A member password that merely begins `sealed:v1:` must be _sealed_, not stored verbatim as "already sealed" — a bare prefix test hands an attacker a way to write plaintext into a sealed column by choosing its first ten characters.

`seal_key_fingerprint` is a truncated BLAKE3 prefixed `blake3:` (D-1025-S4-1), safe in a receipt, and `stamp_seal_key_fingerprint` writes it into `core_vault.settings_json` **inside the sealing transaction**. "This vault has secrets" and the secrets commit together, so a crash cannot leave sealed cells whose key nothing names.

## `locker_key` — rotation is an order, not a transaction

`keys/` and `vault.db` share no transaction, so the **order** is the guarantee:

1. write `K′` to the **rotating seat's** key store as a new file (the old one untouched);
2. **one** applied batch — `locker.rotate_key` — which retires the old row, inserts the new one, and rewrites every secret the **seat** re-encrypted, refusing unless the batch covers every cell;
3. each seat adopts `K′` and only then deletes `K`.

A crash between 1 and 2 leaves the DB naming the old key and `K′` an orphan; a crash between 2 and 3 leaves the retired file behind. `sweep_retired_locker_keys` reconciles either on open. At no point is any ciphertext under a key the DB does not name, and at no point are two rows live. Both windows have a test (`a_crash_between_the_new_key_file_and_the_transaction_sweeps_clean`, `a_crash_between_the_transaction_and_the_old_file_delete_sweeps_clean`).

The retire **precedes** the insert inside step 2 because `locker_key_live_idx` is checked per statement, not per transaction. That index is on the _predicate_ (`ON locker_key(retired_at IS NULL) WHERE retired_at IS NULL`), because SQLite treats NULLs as distinct and indexing `retired_at` itself would permit any number of live rows.

Only secret **values** are encrypted. Title, url and username stay plaintext, so a locked seat can list and search offline — which is the whole reason Locker is usable on a phone in airplane mode.

## The member key — the box is closed

The gateway does not hold `K`, and `member_key` is the module that makes that a property rather than a promise (#1020, D-1020-L1, D-1020-L2).

| Question | Answer |
| --- | --- |
| Who mints `K` | **the seat that founds the vault**, into its own key store |
| What the vault stores | an **id only**, for the life of the vault |
| How a second seat gets it | a `mk1:` envelope from a seat that has it, or the recovery kit |
| Who can reveal a cell | **only a seat**, behind the member's unlock |
| What a vault with no seat holds | no key, and therefore no secrets — a secret-bearing write is a receipted refusal |

**The gateway has no reveal door, in three places, and each one is a different kind of absence.**

1. **A value that cannot be built.** `crates/vault::access::Verb` has two arms; there is no `Reveal`. A reveal goes through `evaluate_reveal`, whose subject is a `SealedSubject`, and `SealedSubject::new` refuses the `locker` schema. A policy check would be a line somebody can move.
2. **A path that does not exist.** There is no host-side mapping to a Locker key directory. `MemberKeyCustody::on_seat` is the only constructor, and it takes a **seat's** directory.
3. **A role that answers differently.** `crates/core::api::reveal` returns the typed refusal on the gateway role and unwraps locally on a seat role.

`crates/vault/tests/member_key_gate.rs` asserts all three, plus the behaviour: every door that returns bytes, the seat snapshot, the backup base and the vault file are searched for planted plaintext. Its demonstrated red is in the receipt.

**The envelope, and why it is not a public-key box** (D-1020-L11). `mk1:<base64(nonce ‖ ct ‖ tag)>`, AES-256-GCM under a key derived (BLAKE3 `derive_key`) from a **one-time transfer secret** the member moves out of band, with `AAD = <vaultId>‖<keyId>‖<recipientDeviceId>`. The third AAD component is what makes a relayed envelope useless to any seat but the one it was minted for — and therefore useless to the host that relayed it. Wrapping under the recipient's device public key is the better long-run shape and is an owner hand-off, not an omission: `access_device_secret.public_key` is an ed25519 signing key, a KEM over it needs an ed25519→X25519 conversion the workspace has no primitive for, and adding one is a **re-keying event** under D-1020-R1 rather than routine housekeeping.

**What the gateway does not do** (D-1020-L6). `locker.watchtower` and `locker.totp_code` never unseal inside the gateway. They answer the **addresses** to derive over and write the receipt; the derivations run in `crates/apps/locker::{watchtower, totp}` over plaintext a seat unwrapped. `locker.export` works the same way and keeps its confirm and its `high` risk.

**Rotation is an order, and a distributed one** (D-1020-L4). Step 1 is a key file on a device; step 2 is `locker.rotate_key`, one batch the gateway applies atomically, refused unless it re-encrypts **every** cell under the outgoing generation; step 3 is each seat adopting `K′` and only then forgetting `K`. `crates/sim/tests/rotation_across_seats.rs` runs three seats over every seed in `pr`'s 25, through six interruption windows, asserting that the DB never names a generation nobody holds, that two live rows never appear, that every cell opens, and that a stranded seat has a working repair.

## Where the recovery kit fits — and it is now the only custody path

`keys/` is deliberately outside the directory that export, backup and copy gestures move around. A copied vault carries ciphertext only, and the recovery kit is the one artefact that carries keys — so a missing key file is unambiguous custody loss, and the error message says which artefact would have carried it.

The kit is **the one artefact between a member and total loss**, and two paths say so rather than quietly doing the wrong thing:

- `centraid export` on a **gateway** writes a kit with **no member key**, prints the generation the vault names, and says that the Locker half comes from a seat's own export. The kit's fingerprint deliberately includes which Locker keys it carries, because _a kit that lost one restores a vault whose secrets do not open_ — a real capability difference an owner must be able to notice, and a kit with none has a different fingerprint from a kit with one.
- `centraid recover` on a **gateway** **does not adopt** member key files a kit carries. It counts them, names them, and says which seat gesture adopts them. Importing them would be the door again: a key that was once on the host was on the host.

`custody::member_key::adopt_from_kit` is the seat's half, and it **refuses** a kit that carries none rather than reporting a restore that restored nothing.

## The format-level test, and what it cannot see

`gateway_file_and_keystore_do_not_reveal_a_cell_without_k` proves _a sealed cell depends on `K` and on nothing else that is on disk_. That property is what let the key move between custodians without touching the format.

It is written so that it passes whoever holds `K`, and therefore cannot **detect** where the key lives. `crates/vault/tests/member_key_gate.rs` is the test that does.
