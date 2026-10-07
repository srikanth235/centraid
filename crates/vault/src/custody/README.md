# Sealed values — one layer, the Locker cell

One encryption layer lives in this directory: Locker's secret values, sealed under the Locker key `K`.

| Layer | Module | Wire form | AAD | What it protects |
| --- | --- | --- | --- | --- |
| The Locker key `K` | `locker_key` | `lk1:base64(nonce ‖ ct ‖ tag)` | `<rowId>‖<keyId>` | one row, under the vault's key generation |

AES-256-GCM with a **fresh random 96-bit nonce per value**. The deterministic nonces in this codebase belong to the byte plane and the backup plane (`crates/media`, `crates/vault/src/backup`) and are documented there; the distinction is load-bearing, because a derived nonce over a partial address is a nonce reuse. The backup plane's keys and AADs are its own and are not a cell format: collapsing a cell format into one "encrypt a string" helper shared with them is how a ciphertext becomes movable between rows.

**No key material lives in this crate.** Every seal and unseal takes its key by value, so there is no ambient key for a read path to reach for.

`is_locker_ciphertext` is **structural**, not a `starts_with`: prefix, then a strict-alphabet base64 body, a multiple of four long, decoding to at least `nonce + tag` bytes. A value that merely begins `lk1:` must be _sealed_, not stored verbatim as "already sealed" — a bare prefix test hands a caller a way to write plaintext into a sealed column by choosing its first four characters.

## `locker_key` — the Locker cell format, and the phone's two doors

`K` is the 24 words' own leaf, `seed / vault'(i) / locker'` ([#1047](https://github.com/srikanth235/centraid/issues/1047), [D-6](../../../../docs/decisions.md#the-owners-rulings-of-2026-09-28-1047)), derived by the core at open into its in-memory keyring. It is **never a file**: the vault stores only the generation's id in `locker_key`, and a restore from the 24 words re-derives the same `K` for the same id.

| Question | Answer |
| --- | --- |
| Who holds `K` | the core, in memory, from open to close; a Locker session holds a copy between unlock and relock (D-7) |
| What the vault stores | the generation's **id** only (`locker_key`, one row) |
| What the laptop's gateway stores | sealed backup objects; the `lk1:` cells inside them stay ciphertext under `K` once an object is opened, and the gateway holds neither `K` nor an object key |
| Who can reveal a cell | the core, behind the member's unlock |

The phone's two doors are `Vault::locker_generation` (names the generation, writing the one `locker_key` row on a vault that has none; never inside a commit) and `Vault::locker_sealed_item_cell` (one sealed cell's ciphertext and generation, for a reveal). Neither returns plaintext.

`locker_key(key_id, created_at)` holds **at most one row**: `locker_key_one_generation` is a unique index on a constant, so a second generation is refused by the file (rung seven, `contracts/migrations/007_locker_key_one_generation.sql`). `K` is the seed's single leaf, so nothing ever retires a generation; `retired_at` and the predicate index that let one live row stand beside retired ones are gone ([R-1047-D2](../../../../docs/decisions.md#the-sealedv1-cell-layer-and-the-retired-locker-generation-deleted-1047)).

Only secret **values** are encrypted. Title, url and username stay plaintext, so a locked Locker can list and search — which is the whole reason Locker is usable on a phone in airplane mode.

**The reveal door is absent from the access plane**, not refused: `crates/vault::access::Verb` is `read` and `act`, and there is no reveal judgement at all. A Locker write that carries plaintext is a receipted refusal (`assert_sealed_cell` in `commands/locker.rs`).

## What these modules no longer hold

[#1020](https://github.com/srikanth235/centraid/issues/1020)'s multi-seat file custody is deleted (#1047 slice D1): the `keystore` key-file envelopes (`CENTRAID-KEY-V1`), `member_key`'s seat custody and its `mk1:` transfer envelope, the recovery kit's adopt, founding `K` into a key file, rotation across seats (`rotate_locker_key`, the sweep and the `locker.rotate_key` command) and `tests/member_key_gate.rs`'s structural and binary scans. On a phone that derives `K` from the seed, no path called any of it. The vault DEK's `sealed:v1:` layer — `seal_value`, `open_value`, `is_sealed_value`, the seal-key fingerprint stamped into `core_vault.settings_json` and the restore check's key verdict — is deleted too (#1047 slice D2): the only columns it sealed were the connector credentials rung five dropped, and no production path wrote a cell or stamped a fingerprint. The supersessions are recorded in [docs/decisions.md](../../../../docs/decisions.md#the-multi-seat-locker-custody-plane-deleted-1047) ([R-1047-D1](../../../../docs/decisions.md#the-multi-seat-locker-custody-plane-deleted-1047), [R-1047-D2](../../../../docs/decisions.md#the-sealedv1-cell-layer-and-the-retired-locker-generation-deleted-1047)).

## The tests

- `locker_key::tests::the_vault_file_does_not_reveal_a_cell_without_k` — a sealed cell depends on `K` and on nothing else in the file.
- `crates/vault/tests/locker_plaintext_gate.rs` — every door that returns bytes, the snapshot, the backup base (sealed and opened) and the vault file with its WAL are searched for planted plaintext, with a falsification that proves the search fires.
- `crates/core/src/app_query/locker_tests.rs` — no `keys` directory is ever created, and a restore from the same 24 words reopens sealed secrets.
