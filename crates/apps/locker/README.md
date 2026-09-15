# `crates/apps/locker` — Locker, and the app that holds no key

Locker is 15,908 lines of v0 TypeScript: 8 queries, 16 actions, 37 scopes over three schemas, and **the only three `reveal` verbs in the product** ([#1020](https://github.com/srikanth235/centraid/issues/1020), wave 4 census §A8, §F). This crate is its read side and its action table. It is also the app whose custody changed in this wave, and almost everything here follows from one sentence: **the gateway is trusted for data and blind for secrets**.

## What this crate does not contain, and what stops it

| Not here | What stops it |
| --- | --- |
| SQL, in any form | `cargo xtask rules`' `sql-confinement`. A statement here is a `PageQuery` — a projection, a `from`, a predicate and an order, as data |
| A hash, a codec, or a crypto primitive | nothing in the dependency set is one. `watchtower::derive` takes a digest function; `totp` takes an HMAC. The RFC 6238 parts a port gets wrong — base32, the counter, the dynamic truncation — are here and under test against RFC 4226's own vectors; the primitive is the seat's |
| The member key `K` | `centraid-vault` is not a dependency. A reveal arrives as a value with a thirty-second life and a receipt id |
| A denial turned into an error | `Denial` and `commands::Outcome::Denied` are states a surface renders |
| A failed decoration folded into "all clear" | `Decorated::watch` is an `Option` and `watchtower::summarise` **refuses to build a summary** without being told the derivation ran |

## The four facts every query is written around

1. **`ITEM_COLUMNS` is the browsable half, and no sealed cell is on it.** `password`, `otp_seed`, `card_number`, `cvv`, `content`, `value_sealed` and `private_key` are absent **by construction rather than stripped afterwards**, and every shelf projects exactly that list — so there is one place to read to know what a Locker list can carry.
2. **Listing is not unlocking.** These statements run on a seat's own rows under the app grant alone. That is why title, url and username are plaintext at rest at all: a locked seat still lists and searches, which is the whole reason Locker works on a phone in airplane mode.
3. **A stated window is walked, not clamped.** `MAX_PAGE_ROWS` clamps a page at 500, so v0's four 2,000-row shelves each read a quarter of their window and discarded the cursor that said so — _"Watchtower audited a quarter of the vault and reported it as all of it"_. Every shelf here walks, and reports whether the window filled.
4. **`access` is online-only with two walls.** `access.receipt` is in the audit band, not the replica. The manifest's `rowFilter` on `object_type` is the outer wall; the statement's own predicate is the inner one, so the page is filtered **before** the window rather than after — without it a busy vault's newest 200 receipts could be entirely someone else's.

## The manifest, and the two fields deleted from it (D-1020-L7)

`manifest.json` is v0's `app.json` with exactly two deletions, and `manifest::tests` applies both to the oracle and asserts the result is byte-identical — so a third change, in either direction, is a red:

- **`auth_session` on the `items` query.** A permit-era parameter on a live query: the permit, the `authenticate` op and the permit screens were deleted by #996 R13, and v0's own handler never reads it. A schema-first port turns a dead field into a required one.
- **`disabledOn: ["viewer"]`.** #996 R13 enables Locker on **every** seat including the PWA; the exclusion is two rulings old.

## Where the secret is, at each step

| Step | Where the plaintext is |
| --- | --- |
| a list, a search, the trash, the item pane | nowhere. The sealed cells are ciphertext at rest and the payload carries their **shape** |
| a reveal | on the seat, for thirty seconds, after the gateway wrote the receipt — `crates/seat::locker` |
| Watchtower, a one-time code | on the seat, inside the reveal window, folded by `watchtower` and `totp` here |
| a fill into a page | on the seat, matched against the row's own stored policy by `origin`, then handed to the extension with a thirty-second life |
| a plaintext export | on the seat, under a confirmed `locker.export` and its one receipt |

## `online_only` is exactly v0's five

`add-item`, `edit-item`, `set-field`, `set-passkey`, `export` — asserted against `packages/blueprints/apps/locker/writes.ts` itself rather than against a copy of it. The eleven metadata actions queue, because a member on a train must be able to trash a login.

## Origin matching, and the one dependency this crate adds

`contracts/origin-matching-v1.json` is the extension's spec, promoted byte-identical; all 24 vectors pass here, and while the v0 tree exists the same file runs through v0's two implementations. "Registrable domain" is not a string operation, so the Public Suffix List is embedded and pinned (`psl`, whose version number _is_ the list's date — the same shape `tldts` has on the TypeScript side). A suffix added to the list after the pin is a domain whose boundary this build computes one label too wide, so **the pin is a refresh obligation**; the receipt names the cadence.
