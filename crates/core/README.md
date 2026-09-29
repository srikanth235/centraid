# `centraid-core`

The message loop: one handle, four entry points, one role ([#1020](https://github.com/srikanth235/centraid/issues/1020), [#1029](https://github.com/srikanth235/centraid/issues/1029)).

Everything a shell can ask for goes through `call` and everything the core volunteers comes back through `next_event`. There is no third surface, and that is the point: a shell that could reach the vault directly would be a second gateway.

## The four entry points

| Function | Contract |
| --- | --- |
| `Core::open(config)` | opens the file, runs migrations, **returns**. The endpoint starts afterwards, on a core thread. |
| `handle.call(request)` | synchronous from the caller's view. **Never from a UI thread** — a debug assertion fires when the shell named one. |
| `handle.next_event(timeout)` | blocks on a **bounded** queue (`EVENT_QUEUE_CAP = 1024`). `Ok(None)` is a timeout, not an error. |
| `handle.close()` | unblocks every waiter with `CoreError::Closed`, then releases. Idempotent. Calls afterwards are typed errors. |

**Dropping a `Handle` closes the byte store it owns** (`impl Drop for Handle`): a store that is dropped rather than closed keeps `<vault>.bytes/blobs.db` locked for the life of the process, and the next open of that vault in the same process hangs inside `centraid_open` — [docs/traps/byte-store-lock.md](../../docs/traps/byte-store-lock.md), proven at the C boundary by `crates/core-ffi/tests/reopen.rs` ([#1047](https://github.com/srikanth235/centraid/issues/1047)).

Plus `handle.cancel(request_id)`: cancels an in-flight **unbounded** operation. A bounded read is refused rather than cancelled, and the refusal is typed — bounded reads hold a SQLite read transaction, and cancelling one leaves it to be rolled back by a dropped future.

## The event queue

Bounded, and **nothing is dropped**. When it fills, sync stalls and a `HealthEvent { stalled: true }` says so. A dropped change event would be a screen that stays wrong until something else happens to touch the same row, which may be never — slow is a state a member can be told about; wrong is not.

Change events **coalesce** per `(table, pk)` set while they wait, and the coalesced event carries the **highest** commit seq it covers, because an overlay clears against a commit seq. Coalescing is lossless: a change event never carried values, only the keys a screen re-reads.

A stall that happens with the queue full of change events is **reported late**, on the first slot a drain frees, rather than by dropping a change event to make room. Without that the shell would learn a stall ended without ever learning it began.

## One role

`Role` is deleted ([#1029](https://github.com/srikanth235/centraid/issues/1029) §1): the phone is the only host that opens a vault, so the `Gateway`, `Seat { Replicated }` and `Seat { Thin }` roles collapsed into one and the enum went with them — see the module docs in `lib.rs`.

## The `VaultApi` verbs

`api.rs` holds eight verbs and the honest state of each. A stub is a **typed refusal**, never an empty answer: an empty page reads as "no data" and the truth is "this build cannot answer yet".

`page` `invoke` `describe` `parked` are live. `search`, `resolve` and `content` are typed `NotYetAvailable` refusals in this module (content addresses are minted by `content_urls` instead). There is no `reveal` verb: a Locker reveal, and a one-time code, run in `locker::phone` behind the unlock, each after `locker.reveal_receipt` or `locker.totp_code` has written its receipt.

## App queries

`Request::AppQuery` runs a registered app query in the core and answers a typed message ([#1046](https://github.com/srikanth235/centraid/issues/1046), [#1047](https://github.com/srikanth235/centraid/issues/1047)). The request and the answer are oneofs in `app_query.proto`, one arm per query at the **same number in both**, each app in its own range; each answer message is in the app's own `<app>.proto`:

| Range | App | Arms | Where |
| --- | --- | --- | --- |
| 1–9 | Agenda | `upcoming`, `day_context`, `parties`, `search`, `event` | `app_query.rs` |
| 10–19 | Tasks | `board`, `task`, `projects`, `search`, `catch_up` | `app_query/tasks.rs` |
| 15 | — | `denied`, in the answer only; no query takes it |  |
| 20–29 | People | `roster`, `touch`, `person`, `search`, `trash` | `app_query/people.rs` |
| 30–39 | Docs | `drive`, `search`, `document`, `activity` | `app_query/docs.rs` |
| 40–49 | Notes | `library`, `notebooks`, `journal`, `search`, `trash`, `history`, `link_targets`, `note` | `app_query/notes.rs` |
| 50–59 | Tally | `dashboard`, `group`, `friend`, `expense`, `settle_up`, `recurring`, `spending`, `search`, `trash`, `export` | `app_query/tally.rs` |
| 60–69 | Locker | `items`, `item`, `search`, `review` — metadata only; a sealed cell answers its presence | `app_query/locker.rs` |

A new query is a new arm inside its app's range, appended ([R-1047-Q1](../../docs/decisions.md#the-app-ports-and-the-shell-kit-1047)).

`Request::Locker` (`locker.proto`, [#1047](https://github.com/srikanth235/centraid/issues/1047), D-5) is Locker's session, `crate::locker::phone`: `unlock` — sent by the shell after the phone's biometric or passcode prompt succeeded — puts `K` in the session — the seed's `locker'` leaf, derived at open into the `Keyring` and never written down, so a restore from the 24 words reopens sealed secrets ([Q-1047-11](../../docs/decisions.md#locker-on-the-phone-1047-d-5)); a core opened without the seed refuses as `Unavailable` — and receipts the unlock; `relock` zeroes the session's copy; `state` answers whether idle has ended it; `reveal` receipts one sealed item cell and answers its plaintext with a thirty-second life, or a typed refusal (`LOCKED` never prompts). `Request::Command` for `locker.add_item` / `locker.edit_item` passes through `seal_command` first: every typed secret is sealed under the live generation against the item's id and `password_rotated` is decided by opening the stored password; a secret-bearing write while locked is refused ([R-1047-L1…L4](../../docs/decisions.md#locker-on-the-phone-1047-d-5)).

`app_query.rs` holds the door (`VaultDoor`, the app kit's `PageDoor` over `Vault::keyset_page` — the page door's own call — plus the kit's grammar), the dispatch, and Agenda's conversion; each other app's module converts its crate's rows to its answer. `app_query/docs.rs` also adds the size phrase, whether the head's bytes are on this device and, when they are and may be drawn inline, the file's path for the media stage (`Vault::content_location`, [R-1047-Q4](../../docs/decisions.md#the-owners-rulings-of-2026-09-25-1047)). Agenda's `search` names each repeating hit's next occurrence and `event` carries the event's calendar row ([R-1047-Q6](../../docs/decisions.md#the-owners-rulings-of-2026-09-25-1047)); Tally's `export` renders its CSV and file name ([R-1047-Q5](../../docs/decisions.md#the-owners-rulings-of-2026-09-25-1047)). A denial is an arm of the answer; a vault failure the door saw is answered as itself and never as a denial; a read that reaches its own stated ceiling is `CoreError::ReadBoundReached` (`ERROR_CODE_READ_BOUND_REACHED`). Search arms reach `crates/search`'s FTS door over `Vault::read`'s connection, so the core writes no SQL for them. Each query answers its civil readings — an occurrence's local wall clock and days, today, now, a row's local day — in the request's `tz`, else the vault's own zone (`Vault::time_zone`), else refuses with `InvalidRequest`; never the host's clock and never UTC by default. Where the readings only decorate the answer (People's search and trash, Notes' search and editor note, Tally's export file name) a request with no zone on a vault that names none answers them EMPTY rather than refusing (`zone_if_any`); an unknown zone is still refused. A page read asks for local days through `PageQuery.local_day_columns` + `tz`, one appended `YYYY-MM-DD` column per named instant after every other computed column ([R-1047-Q3](../../docs/decisions.md#the-owners-rulings-of-2026-09-25-1047)).

## One mutex over the vault (D-1020-D2-9)

`Vault` keeps its commit-guard depth in a `Cell` and is therefore `!Sync`. Real concurrent reads need a pool of read connections, which needs `PRAGMA` statements, which is SQL — and `sql-confinement` confines SQL to five crates this is not one of. So every call is serialised through one mutex, and the reader pool is an owner hand-off to `crates/vault`. See `handle.rs`'s module docs for the three options and what option 3 costs.

## The `call` budget

`cargo test -p centraid-core --test call_budget` measures p95 over 200 calls of one page of 100 rows and fails above `contracts/ledgers/call-budget.json`'s ceiling. `cargo xtask gate --profile pr`'s `call-budget` step runs it.

`cargo test -p centraid-core`.
