# `crates/apps/locker` — Locker, and the app that holds no key

Locker is 8 v0 queries, 17 actions and 38 scopes over three schemas, holds **the only three `reveal` verbs in the product**, and answers the phone's four app queries ([#1047](https://github.com/srikanth235/centraid/issues/1047)). This crate is its read side and its action table. Almost everything here follows from one sentence: **the list is metadata; the secret is not.**

## On the phone (#1047, D-5)

The phone is the vault ([#1029](https://github.com/srikanth235/centraid/issues/1029)), so every read here runs on the phone's own rows through the core's page door. [`phone`](src/phone.rs) is what the core's `app_query` arms (`locker_items` 60, `locker_item` 61, `locker_search` 62, `locker_review` 63 in [`locker.proto`](../../api-proto/proto/centraid/core/v1/locker.proto)) ask:

| Loader | What it answers |
| --- | --- |
| `load_items` | one shelf (live or archived), newest first, with stars, tags, the vault's own counts and whether the window filled |
| `load_item` | one item — trashed too — with its sidecars and, for each sealed cell its type carries, **whether it holds a value** |
| `load_search` | title, username and address, case-insensitively; never a note, never a secret, never the trash |
| `load_review` | what metadata can show: compromised, `http://` addresses, expired and expiring cards against the device's day |

A sealed cell reaches a loader only as its **presence** (`<cell> IS NOT NULL AS …`, the grammar's one sealed operand, which the page door now projects as an expression — `crates/vault/src/page.rs`). `no_phone_statement_projects_a_sealed_cell_except_as_its_presence` holds every phone statement to that.

The secret is not this crate's. `K` is derived from the member's 24 words (`seed / vault'(i) / locker'`) and held in the core's memory, so a restore from the words reopens it, a secret the member typed is sealed by the core before the vault sees the command, and a reveal is receipted before its value exists — `crates/core/src/locker/phone.rs` ([R-1047-L3, L4, Q-1047-11](../../../docs/decisions.md#locker-on-the-phone-1047-d-5)). The lock itself — the biometric, the passcode fallback, the relock on leaving the foreground — is the shared machine's and the shell's ([R-1047-L1](../../../docs/decisions.md#locker-on-the-phone-1047-d-5)).

## What this crate does not contain, and what stops it

| Not here | What stops it |
| --- | --- |
| SQL, in any form | `cargo xtask rules`' `sql-confinement`. A statement here is a `PageQuery` — a projection, a `from`, a predicate and an order, as data |
| A hash, a codec, or a crypto primitive | nothing in the dependency set is one. `totp` takes an HMAC. The RFC 6238 parts an implementation gets wrong — base32, the counter, the dynamic truncation, reading an `otpauth://` link (`seed_of`) — are here and under test against RFC 4226's own vectors; HMAC-SHA-1 is the core's, which proves the chain against RFC 6238 Appendix B ([R-1047-D6](../../../docs/decisions.md#the-owners-rulings-on-the-locker-leftovers-1047)) |
| The member key `K` | `centraid-vault` is not a dependency |
| A denial turned into an error | `Denial` and `commands::Outcome::Denied` are states a surface renders |
| A weak/reused score | nothing: the Watchtower fold is deleted, and Review is metadata only ([R-1047-D6](../../../docs/decisions.md#the-owners-rulings-on-the-locker-leftovers-1047)) |

## The facts every query is written around

1. **`ITEM_COLUMNS` is the browsable half, and no sealed cell is on it.** `password`, `otp_seed`, `card_number`, `cvv`, `content`, `value_sealed` and `private_key` are absent **by construction rather than stripped afterwards**.
2. **Listing is not unlocking — in the vault.** Title, url and username are plaintext at rest so the list and search work. On the phone the shared machine still reads nothing while Locker is locked ([R-1047-L2](../../../docs/decisions.md#locker-on-the-phone-1047-d-5)); the core refuses only what needs `K`.
3. **A stated window is walked, not clamped.** `MAX_PAGE_ROWS` clamps a page at 500, so every shelf walks with `read_window` and reports whether the window filled; a count that reached its ceiling is answered as unknown, never as the ceiling.

## The manifest

`manifest::tests` asserts the properties that matter: no permit-era `auth_session` on `items`, `seats.disabledOn` empty, the two confirmed actions (`purge-item`, `export`), and one command per action. `set-memo` (#1047) exposes `locker.set_memo`, the memo command no action reached (the handoff's README §8 paper cut).

## No match policy, and no matcher

An address is a URL. The stored match policy (`url_match_policy`, and `match_policy` per extra address) is dropped by rung eight with its editor control ([R-1047-D5](../../../docs/decisions.md#the-owners-rulings-on-the-locker-leftovers-1047)); the origin matcher, its spec and `psl` went with the extension-fill plane ([R-1047-D3](../../../docs/decisions.md#the-extension-fill-plane-deleted-1047)).
