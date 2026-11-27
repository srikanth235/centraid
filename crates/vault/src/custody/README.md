# Sealed values — one layer, the Locker cell

One encryption layer lives in this directory: Locker's secret values, sealed under the Locker key `K`.

| Layer | Module | Wire form | AAD | What it protects |
| --- | --- | --- | --- | --- |
| The Locker key `K` | `locker_key` | `lk1:base64(nonce ‖ ct ‖ tag)` | `<rowId>‖<keyId>` | one row, under the vault's key generation |

AES-256-GCM with a **fresh random 96-bit nonce per value**. No nonce in this codebase is derived or counted. The backup plane (`crates/media/src/sealed.rs`, `crates/vault/src/backup`) seals each part with XChaCha20-Poly1305 under a key derived from a fresh random salt, and gives every chunk a fresh random 24-byte nonce; it is documented there, and its keys and AADs are its own. They are not a cell format: collapsing a cell format into one "encrypt a string" helper shared with them is how a ciphertext becomes movable between rows.

**No key material lives in this crate.** Every seal and unseal takes its key by value, so there is no ambient key for a read path to reach for.

`is_locker_ciphertext` is **structural**, not a `starts_with`: prefix, then a strict-alphabet base64 body, a multiple of four long, decoding to at least `nonce + tag` bytes. A value that merely begins `lk1:` must be _sealed_, not stored verbatim as "already sealed" — a bare prefix test hands a caller a way to write plaintext into a sealed column by choosing its first four characters.

## `locker_key` — the Locker cell format

`K` is the 24 words' own leaf, `seed / vault'(i) / locker'` ([#1047](https://github.com/srikanth235/centraid/issues/1047)), derived by the core at open into its in-memory keyring. It is **never a file**: the vault stores only the generation's id in `locker_key`, and a restore from the 24 words re-derives the same `K` for the same id.

The phone names the generation with `Vault::locker_generation` (it writes the one `locker_key` row on a vault that has none; never inside a commit); the doors that return a sealed value's ciphertext are listed under "Who reveals" below. None returns plaintext.

`locker_key(id, key_id, created_at, ..)` holds **at most one row**: its key is the singleton `id = 1` (a `CHECK`, like the `vault` row's), so a second generation is refused by the file (in `contracts/migrations/001_baseline.sql`). `K` is the seed's single leaf, so nothing ever retires a generation; `retired_at` and the predicate index that let one live row stand beside retired ones are gone.

Locker is an app like every other: a Locker item is an entity with the vault's title, trash, tags, links, `[[title]]` and attachments, and the one thing that differs is that sensitive **values** are sealed under `K`. Four tables hold it (`locker_item`, `locker_item_field`, `locker_item_passkey`, `locker_key`). Title and every plain field (a username, an address, a Wi-Fi name, a cardholder, a date) stay plaintext, so a locked Locker can list and search, which is the whole reason Locker is usable on a phone in airplane mode.

What is sealed: a `sealed` field, a one-time-code (`otp`) seed, a `file` field's name and media type and bytes, and a passkey's private key. Each is `lk1:` ciphertext bound to its row's id (a single built-in field's id is `<item id>:<field key>`, so the core can seal before the row exists), never indexed, never turned into derived data, never written in plaintext, and kept sealed in every earlier version. A secret's age is its field's `value_set_at`, which moves only when the value changes (the vault cannot compare two ciphertexts, so the write says whether it did). The file knows a field's shape by `kind` only; which built-in key is which kind is [`crates/vault/src/commands/locker/schema.rs`](../commands/locker/schema.rs), and the plaintext gate plants every built-in secret key.

## Sealed files: `lkf1`

A `file` field's bytes are encrypted under `K` BEFORE they enter the blob store, so `blob.hash` is the hash of the ciphertext. The format is permanent once written (`sealed_file.rs`; vectors in [`crates/vault/tests/vectors/lkf1.json`](../../tests/vectors/lkf1.json)): an 8-byte header (`lkf1` and the plaintext chunk size, big-endian u32), then chunked AES-256-GCM with a fresh random nonce per chunk; each chunk's authenticated data is header ‖ field id ‖ 0x1F ‖ key id ‖ chunk index (big-endian u64) ‖ a final-chunk flag, so a tail cut off or two chunks swapped do not open. A file is sealed and opened as a stream (`SealReader`, `OpenReader`), never as one piece; the same file sealed twice has two hashes; nothing is derived from one and it is always sent with a backup and never freed from the phone. A replaced or removed file stays readable, sealed, through its history slot `field:<id>`.

## Who reveals

| Question | Answer |
| --- | --- |
| Who holds `K` | the core, in memory, from open to close; a Locker session holds a copy between unlock and relock |
| What the vault stores | the generation's **id** only (`locker_key`, one row; rekeying is out of v0) |
| What the laptop's gateway stores | sealed backup objects; the `lk1:` cells and `lkf1` files inside stay ciphertext under `K`, and the gateway holds neither `K` nor an object key |
| Who can reveal a value | the core, behind the member's unlock: the doors `locker_sealed_item_cell`, `locker_sealed_field_cell` (a seed too), `locker_sealed_passkey_cell`, `locker_sealed_file`, `locker_sealed_earlier_cell` return ciphertext only |
| What leaves the phone | an item's contents only through Locker's own export (`locker.export`: confirmed, high-risk, refused on a phone with no passcode); an item has no share and "Export everything" leaves Locker out |

**The reveal door is absent from the app plane's read registry**, not merely refused: `crates/domain`'s SQLite read authorizer (`read::authorizer`, held by [`crates/domain/tests/read_registry.rs`](../../../domain/tests/read_registry.rs), test `a_sealed_column_is_denied_to_every_module`) denies `locker_item_field.value_sealed`, `locker_item_field.value_blob` and `locker_item_passkey.private_key` for **every** registered read, Locker's included, and `crates/vault::access::Verb` has only `read` and `act` with no reveal judgement (`page::withholds_sealed_value`). A Locker write that carries plaintext is a refusal (`assert_sealed_cell` in [`crates/vault/src/commands/locker/custody.rs`](../commands/locker/custody.rs)); an edge's label or anchor never carries ciphertext.

## What these modules no longer hold

[#1020](https://github.com/srikanth235/centraid/issues/1020)'s multi-seat file custody is deleted (#1047 slice D1): the `keystore` key-file envelopes (`CENTRAID-KEY-V1`), `member_key`'s seat custody and its `mk1:` transfer envelope, the recovery kit's adopt, founding `K` into a key file, rotation across seats (`rotate_locker_key`, the sweep and the `locker.rotate_key` command) and the removed member-key structural and binary scans. On a phone that derives `K` from the seed, no path called any of it. The vault DEK's `sealed:v1:` layer — `seal_value`, `open_value`, `is_sealed_value`, the seal-key fingerprint stamped into `core_vault.settings_json` and the restore check's key verdict — is deleted too (#1047 slice D2): the only columns it sealed were the connector credentials rung five dropped, and no production path wrote a cell or stamped a fingerprint.

## The tests

- `locker_key::tests::the_vault_file_does_not_reveal_a_cell_without_k` — a sealed cell depends on `K` and on nothing else in the file.
- `crates/vault/tests/locker_plaintext_gate.rs` — a planted plaintext in every built-in secret key of all fifteen types, a custom sealed and one-time-code field, a passkey's key and a sealed file; every door that returns bytes, the index and its word lists, the history, a notification, the backup (sealed and opened), the vault file with its WAL and the content store are searched for it, with a falsification that proves the search fires.
- `crates/vault/tests/locker_commands.rs`, `locker_files.rs`, `locker_search.rs`, `locker_wall.rs`, `locker_clock.rs` — the commands, the `lkf1` format against committed vectors, search, Locker as an ordinary app and take-out, and the rules the file holds.
- `crates/domain/tests/read_registry.rs` (`a_sealed_column_is_denied_to_every_module`) — every registered read in the room-based app plane is denied `value_sealed`, `value_blob` and `private_key` by the SQLite authorizer.
- `crates/identity/src/derive.rs` (`the_locker_key_is_the_seeds_and_no_other_seeds`) — `K` is derived deterministically from the 24 words' seed, with no key file on disk, so a restore from the same 24 words reopens sealed secrets.
