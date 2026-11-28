# The C ABI contract

Five symbols. Ten clauses. **Each clause has a test** in `tests/contract.rs`, named after the clause, and the test calls through the C symbols — both directly as `extern "C"` functions and, for one, through `libloading` on the built `cdylib`, so the exported names are what a shell links.

This file is normative. A shell author reads it once and then relies on it; nothing here may be relaxed without a shell change, which is why every clause has a reason rather than only a rule.

From [#1020](https://github.com/srikanth235/centraid/issues/1020)'s Execution model, wave 2 lane D2, ruling D-1020-D2-3.

```c
int32_t centraid_open      (const uint8_t *config, size_t len, Handle **out);
int32_t centraid_call      (Handle *h, const uint8_t *req, size_t len,
                            uint8_t **out_buf, size_t *out_len);
int32_t centraid_next_event(Handle *h, uint32_t timeout_ms,
                            uint8_t **out_buf, size_t *out_len);
void    centraid_free      (uint8_t *buf, size_t len);
int32_t centraid_close     (Handle *h);
```

---

## 1. Buffers are callee-allocated and released only through `free`

Every out-buffer this library writes was allocated by this library's allocator. The caller must release it with `centraid_free` and the exact `len` it was given, and **must not** use `free(3)`, `delete`, a Swift `Data(bytesNoCopy:)` deallocator, or a JVM cleaner that calls anything else.

_Why:_ Rust's allocator is not the C one, and on Windows it is not even in the same DLL. Freeing a Rust allocation with `free(3)` corrupts the heap silently.

`len` is a parameter rather than tracked because the allocator needs the layout to deallocate. A length header inside the buffer would offset the bytes the shell reads from the pointer it was handed — a mistake every shell makes once.

**A null `buf` is a no-op**, so a caller need not branch on the timeout case.

Test: `buffers_are_callee_allocated_and_released_only_through_free`

## 2. Inputs are borrowed for the call

`config` and `req` are read during the call and never retained. The caller may free or reuse them the instant the call returns — a Kotlin `ByteArray` may leave its pinned scope, a Swift `withUnsafeBytes` closure may end.

_Why:_ the alternative is a lifetime a shell cannot see. A retained input would make every `call` a hidden allocation the shell has to outlive.

A null pointer with length **zero** is the empty slice; a null pointer with a non-zero length is `BAD_ARGUMENT`.

Test: `inputs_are_borrowed_for_the_call_and_never_retained`

## 3. `call` is reentrant, and two concurrent calls never block on the FFI

`centraid_call` may be entered from any number of threads on one handle. This layer takes **no lock of its own**.

_Why, precisely:_ the honest version of this clause is that the FFI is never the bottleneck. The core's own serialisation is another matter — in wave 2 `crates/core` holds one mutex over the vault (D-1020-D2-9, with the three options and the reason in `crates/core/src/handle.rs`), so two concurrent reads of the vault do serialise _there_. When that becomes a reader pool inside `crates/vault`, no shell changes, because this clause never promised the vault was concurrent — only that this boundary adds nothing.

Test: `call_is_reentrant_across_threads_and_the_ffi_adds_no_lock`

## 4. Every request carries a request id, and `Cancel` names one

The `Envelope`'s `request_id` is the caller's. A non-zero id is used as-is; the core answers under it and does not mint its own. Id **0** is reserved for the handshake and means "mint one for me".

A `Cancel` body cancels the **unbounded** operation its `request_id` names. A `Cancel` naming a bounded read returns `BAD_ARGUMENT` with an `ERROR_CODE_INVALID_REQUEST` body: bounded reads hold a SQLite read transaction, and a cancellation that leaves it to a dropped future breaks the log door's four-statements-in-one-read-transaction rule. A `Cancel` naming an id nobody is waiting for is a **no-op**, because ids are monotonic and never reused. A `Cancel` with id 0 names nothing and is refused rather than read as "cancel everything".

Test: `every_request_carries_a_request_id_and_cancel_names_one`

## 4a. The open configuration is JSON, and one of its keys is a secret

`centraid_open` reads `config`/`len` as UTF-8 JSON:

```json
{
  "path": "/…/vault.db",
  "create": false,
  "uiThreadName": "main",
  "expectedIdentity": "<artifact digest>",
  "vault": { "seed": "<128 lowercase hex characters>", "index": 0 }
}
```

`path` is the only required key. `create` defaults to `true` — a shell that names a path and says nothing else is founding a vault there — and `false` opens only a file that exists, which is what a shell opening the file a restore is about to write passes. `expectedIdentity` is clause 9's stale-core refusal, made before a handle exists. `vault` is the secret, and §4b is about it.

**Three keys a shell may still send are ignored, never refused.** `role` named one of three kinds of core and there is one ([#1029](https://github.com/srikanth235/centraid/issues/1029) §1); `pairing` was the enrolment record an iroh endpoint was checked against at open, and `device` the device key a pair or a restore minted — a gateway now knows a phone by the bearer token its pairing minted, which the device secret store keeps (below) ([#1080](https://github.com/srikanth235/centraid/issues/1080)). An older shell against a newer core is the version-skew case the handshake exists for, and refusing the open over a stale key would turn it into a product that will not start.

Test: `a_configuration_defaults_to_founding_and_an_explicit_choice_wins` (`src/marshal.rs`)

## 4b. The vault's seed crosses the ABI, and this library writes no key down

`centraid_open`'s JSON may carry one more object:

```json
{ "vault": { "seed": "<128 lowercase hex characters>", "index": 0 } }
```

`seed` is the **64-byte BIP-39 seed** the 24 words derive (`centraid_identity::phrase::Seed`), and `index` is the derivation index this vault was minted at. Together they derive every key the backup plane uses ([#1080](https://github.com/srikanth235/centraid/issues/1080)): the backup keys every part is sealed and named under (`K_backup` and `K_name`, from the vault's root key), and the vault's identity key, which signs a claim. Sealing, naming and claiming are impossible without them.

_Why the shell holds it and this library does not:_ a secret belongs in the platform's secure store, and this one most of all. The scrypt-wrapped recovery kit was deleted under [#1029](https://github.com/srikanth235/centraid/issues/1029) §5 with one sentence — "a file that carries keys is a file that can be copied" — and a core that invented a key file beside the vault it protects would put the one unrecoverable secret in a place no shell asked for and no backup excludes. It belongs in the iOS Keychain or the Android Keystore, and it is borrowed for the length of `centraid_open` like every other input (clause 2). The device state beside the vault (`<stem>.state.db`) holds pinned certificates and gateway rows, never a key and never a token.

**A gateway token crosses the same way, through the device secret store, and the core writes it nowhere** (#1191 B15, the [backup skill's phone page](../../.claude/skills/backup/phone.md), "Credentials"). There is no open-configuration key for it: the screens layer (shared by both shells) keeps it in the device store through `SecretBatch` (store `DEVICE` only, never `SYNCED`), under the key `gateway-token.<vault_id hex>.<gateway_id hex>`, value the token as 64 lowercase hex characters (the vault id is 64 hex, the gateway id 32), never empty (an empty set deletes).

- **Pair:** `PairResponse.tokens` carries the minted token. The core has already written the `gateway` row and holds the token in memory; the pairing screen writes the token (`OP_SET`) at once. A write the store refuses leaves the pairing working until the process dies, then `pair_again`.
- **Restore:** `RestoreResponse.tokens` carries one token per claim. Each is written (`OP_SET`) and read back with that vault's key metadata before the vault is opened and brought forward.
- **Open:** the device store is listed whole at launch. After every core open (launch, reopen, restore, switch) the shelf sends `GatewayTokens` with the tokens it holds under the vault's identity (the core's own 64-hex id, `Handle::vault_hex`; never the shelf's id for the vault, which is the owner's person row, and which finds none); the tokens live in the core's memory only. A gateway row with no entry is `pair_again`.
- **Forget a gateway:** `ForgetDestinationResponse.forget_token` names the key and the screen `OP_DELETE`s it. **Forget a vault:** every key with the vault's prefix is deleted.
- iOS keeps it as a Keychain generic password, `AfterFirstUnlockThisDeviceOnly`, not synchronizable, with no biometric access control (an enrolment change does not touch it). Android seals it under a non-exportable Keystore key in preferences Auto Backup and device transfer exclude.

Tests: `BackupTokenStoreTests` (iOS), `BackupTokenStoreSpec` (Android).

**Absent is not an error.** A core opened without it reads and writes its vault perfectly well and refuses every door that seals, names or signs — `drain`, `fetch_original`, `releasable` — with `ERROR_CODE_PEER_UNREACHABLE` and a sentence naming the seed, and `pair_phone` too. That is a state a shell draws ("unlock to back up"), because a member who has not unlocked their phone has not lost anything.

**There is no device secret.** A pair or a restore used to mint a device key and hand its secret over for the shell to pass back here as `{"device": {"secret": …}}`; a gateway now admits a phone by the bearer token its pairing minted, which the shell keeps in the device secret store (#1080, #1191). A `device` key is ignored, like `role`.

**Present and unreadable IS an error** (`BAD_ARGUMENT`): a seed that is not 128 hex characters, or a `vault` object with no `index`. Carrying on would leave a shell believing it had unlocked a core that cannot seal a single byte, and the member would find that out on the day their phone is gone.

Tests: `the_vault_seed_crosses_the_abi_and_a_malformed_one_is_refused`

## 4c. The phone's four flows are request kinds, not symbols

`centraid.core.v1.Request` gained four arms under [#1029](https://github.com/srikanth235/centraid/issues/1029) W15, and `BackupNow` — which answered `NotYetAvailable` for the whole of its life — left with them. Field number 10 is **reserved, not reused**. [#1080](https://github.com/srikanth235/centraid/issues/1080) rebuilt the plane behind them; the fields the old plane needed are **reserved, not reused**: `DrainResponse` 1 (`acked_txid`), `PairResponse` 1–3 (`gateway_endpoint`, `record_published`, `device_secret`), `RestoreRequest` 2–3 (`endpoint`, `direct_addrs`), `RestoreResponse` 3 (`device_secret`), `RestoredVault` 4 (`txid`) and `BackupStatusResponse` 1 and 4 (`acked_txid`, `laptop_paired`); and `ErrorCode` 24 (`ERROR_CODE_IDENTITY_MISMATCH`), which an iroh endpoint that was not the enrolled key produced.

| Kind | Answer | Bounded? |
| --- | --- | --- |
| `drain` (15) | `DrainResponse { pending_bytes, stopped, acked_at_ms?, confirmed_parts, waiting_bytes_parts, need_bytes[], os_bundles[], classes[] }` | **unbounded**, cancellable; also carries its own `deadline_ms` |
| `pair_phone` (16) | `PairResponse { safety_number, destination }` | bounded |
| `restore` (17) | `RestoreResponse { vaults[], gap_scanned, unclaimed[] }` | **unbounded**, cancellable |
| `backup_status` (18) | `BackupStatusResponse { destinations[], acked_at_ms?, last_snapshot_ms?, pending_bytes, content_total, content_confirmed, spool_bytes (staging bytes), waiting[], frozen, classes[] }` | bounded |

**A drain is one pass, and a second while one runs is refused** (`INVALID_REQUEST`, "a drain is already running"), never queued. It takes a snapshot of the vault when one is due (about 30 seconds after the newest head's snapshot, never while the vault is unchanged, at once when `wants_snapshot` or `asked` says so or when a gateway has none of its own), reaches every paired gateway at once (a gateway that answers as an older protocol stops the pass `DRAIN_STOP_TOO_OLD`; one that is paused, moved or unreachable costs only its own pass), then runs the engine's passes in one loop: the records of every gateway before the thumbnails of any before the originals of any, each gateway a full replica, the head set once a gateway holds every record. The member's rule (`rule`, `metered`, `charging`, `exclude_videos`, `asked`) applies per class. `asked` is the member's "Back up now" tap and nothing else (the root's ruling A24): under `TRANSFER_RULE_MANUAL` it is what lets originals be sent, on any rule it lets a video's original be sent off the charger, and on a metered link it sends the records whatever the rule while originals still follow it (R-1080-C38). `wants_snapshot` — which a shell also sends when the app leaves the screen — decides only when the snapshot is taken. The vault is held for the reads a pass makes and for the instant a snapshot's read begins, never across the network. A phone without room for the staging area it needs takes none and says so (`WAIT_REASON_NO_ROOM`); a vault unchanged since a snapshot every gateway holds is not read again. An original only the operating system's library holds is named in `need_bytes` for the shell to stream through the stage door. With `os_uploads` set the answer's `os_bundles` carries up to four bundle files of at most 32 MiB each (a `HandoffPart` is the shape of one whole `POST bundle` request) for the thumbnails and originals the gateways still lack; what the operating system later reports of them only wakes a pass. A gateway that answers `MOVED` with a claim the vault key signed stops its own pass; when every paired gateway has superseded this phone the drain is refused `ERROR_CODE_VAULT_MOVED`, now and on every later pass, and `backup_status.frozen` is true.

**A pair reads a gateway's pairing payload** (`{v: 2, gw, addrs, pin, secret, exp_ms}`), dials it trusting only the pinned certificate, and keeps the gateway in the device state; a gateway that already holds the vault is taken over by a claim. **A restore takes the 24 words or the 64-byte seed, exactly one, and the pairing payload of the gateway to restore from** (`RestoreRequest.payload`, required): it fetches and checks each vault's snapshot under a read-only grant, claims each at the next writer epoch only once every vault checked, and brings every derivative back. Both the words and the seed is `INVALID_REQUEST`, and so is a seed that is not 64 bytes; no refusal quotes a word or a byte. **A restore never touches a vault this phone already holds**, and `RestoreRequest.indices` asks for only the indices an earlier restore answered as `unclaimed` (R-1047-R6): no gap is scanned. Nothing is minted: a restored phone is admitted by the token its claim answered, which the device state keeps.

_Why this is a clause and not a schema note:_ clause 10 says five symbols and means it, and "backing up" is exactly the kind of flow that grows a symbol — it has a background half, a foreground half and a status. All three are arms on `call`. A shell adds a flow by encoding a different message, never by resolving a new name, and `buf breaking` governs the churn.

**A drain and a restore are cancellable; the other two are not**, and that follows from clause 4 rather than from a preference: `Cancel` names an unbounded operation, and a status read is a staging measurement. A drain has _two_ stops — `Cancel` is the member leaving the screen and `deadline_ms` is the operating system taking the window back — and they are different facts, which is why the deadline is not spelled as a cancellation the shell has to schedule.

Test: `the_phones_four_flows_round_trip_through_call`

## 4d. The originals on this phone are a request kind too

`originals` (19) answers `OriginalsResponse { kept_album_ids[], census? }` and is **bounded**. Its three ops are `kept` (read the keep list), `keep { album_id, keep }` (put one album on it or take it off) and `census` (the originals whole on this phone, and the share in kept albums). The keep list is `<stem>.keep-originals.json` beside the vault file, not a vault row: "keep these originals on this phone" is a fact about one device's disk, and a row would be sealed into the backup and restored onto the next phone as a promise about a disk it never had. An absent `census` is "not counted" — a core with no content store — and never zero.

_Where the release op is:_ the backup plane's, because the proof that makes an original releasable is every chunk of it confirmed at a gateway, which the device state records (clause 4g's `releasable` and `released`, #1080's ruling A19, superseding R-1029-PH-1). The keep list is what holds an album back from it.

Test: `the_originals_on_this_phone_round_trip_through_call` (and, below the ABI, `crates/core/src/originals.rs` and `crates/core/src/originals.rs`)

## 4e. An app's own query is a request kind

`app_query` (20) runs a registered query in the core and answers `AppQueryResponse`, and is **bounded**. Its arms are typed per query. The shell-specific arms are `chat_threads`, `chat_thread` and `chat_card` at 70–72; the old per-app ranges are retired and their numbers are never reused. App-plane SQL reads are declared in `crates/domain` and run through its Rust read registry; they are not separate FFI query arms.

**Civil time is answered in the zone the shell states.** `tz` is the device's IANA zone; empty is the vault's own (`vault.zone`).

**A denial is an answer and never an `Error`**: `denied` is an arm of `AppQueryResponse`, because a screen draws the ask. What a read cannot answer at all is the `Error` body: a search `limit` of zero is `BAD_ARGUMENT` with `ERROR_CODE_INVALID_REQUEST` (clause 4's rule for a page with no limit), as is a `tz` the bundled zone database does not know or an empty one on a vault whose settings name none — never an answer in UTC — and a read that reaches its own stated ceiling is `OK` with `ERROR_CODE_READ_BOUND_REACHED` — never a short answer that reads as a whole one.

**A damaged vault is its own code** (#1191): SQLite calling a page malformed, a file that is no database, or `PRAGMA quick_check` at open failing is `VaultError::Damaged` and `ERROR_CODE_VAULT_DAMAGED` (27), never `INTERNAL`. The vault is not opened, written to or backed up; the way back is a restore. Until the Backup screens have their own words for it (lane B), the shell shows the generic sentence.

Test: `the_app_queries_round_trip_through_call` (and, below the ABI, `crates/core/src/app_query.rs`)

## 4f. The 24 words are a request kind, and need no vault

`phrase` (22) answers `PhraseResponse` and is **bounded** (#1047 E1). Its three ops are `mint {}` (24 BIP39 English words from the OS CSPRNG, `centraid_identity::RecoveryPhrase::generate`), `check { words }` (each cell trimmed, lowercased and judged a list word or not, up to four list words suggested for a prefix, and the phrase's verdict — `INCOMPLETE`, `TOO_MANY`, `UNKNOWN_WORD` with `first_unknown`, `BAD_CHECKSUM` or `VALID`, in that order) and `seed { words }` (the 64-byte seed, no passphrase). Like `restore`, it runs on a handle with **no vault** — `create: false` over a path with no file — because a first launch mints the words before any vault exists.

`seed` over words that are not a phrase is `BAD_ARGUMENT` with an `ERROR_CODE_INVALID_REQUEST` body whose detail names a count or bip39's own reason, **never a word**; `phrase` is not a command and writes no receipt. The words and the seed cross only between this library and its own shell on the same device, to be shown once and to be stored in the synchronised secure store (clause 4b).

Test: `the_words_are_minted_judged_and_seeded_over_a_core_with_no_vault` (and, below the ABI, `crates/core/src/phone/phrase.rs`)

**A restore over a vault that failed to open as damaged** (#1191, decision 35). After `centraid_open` answers `VAULT_DAMAGED` (-6) a shell may open the same path again with the additive key `"restoreDamaged": true` (an older core ignores it, clause 4a). The handle it gets holds **no vault**: it neither opens nor reads the file at `path`, which stays byte-for-byte untouched. On that handle the existing `restore` request (the words and a gateway's pairing code) runs unchanged, with one difference: it replaces **only that vault's file** (`<shelf>/<id>/vault.db`), by an atomic rename, and only after that vault's snapshot was fetched and checked; a healthy vault the phone holds is never touched. A restore that is cancelled or fails leaves the damaged file as it was, so the next launch answers `VAULT_DAMAGED` again and the same screen. There is no second shelf directory. Tests: `a_damaged_vault_is_restored_over_through_a_handle_that_holds_no_vault` and `a_restore_that_dies_before_its_claim_leaves_the_damaged_file_as_it_was` (`crates/core/tests/restore_damaged.rs`), and `restore_damaged_opens_no_vault_at_the_path` (`src/marshal.rs`).

## 4g. The backup plane's doors beside the pass are request kinds

[#1080](https://github.com/srikanth235/centraid/issues/1080) adds eight arms beside `drain` (and Q-1080-D3 a ninth, `refresh_destination`), and `phone.proto` states each one's shape:

| Kind | What it does | Bounded? |
| --- | --- | --- |
| `handoff` (23) | **deprecated**: answered with an empty `HandoffResponse` and nothing else. Bundle files for the OS are in `DrainResponse.os_bundles` | bounded |
| `settle` (24) | **deprecated**: answered with an empty `SettleResponse`; an OS report is a wake, sent as a shell fact, and the next pass re-reads each head | bounded |
| `fetch_original` (25) | one file back by its content hash, every part checked and the whole against the hash; already on this phone — the app's store, or the library — is answered without dialling | **unbounded**, cancellable |
| `pins` (26) | every paired gateway's certificate DER, for a shell's own TLS to pin by byte equality | bounded |
| `reconcile` (27) | **deprecated**: answered with an empty `ReconcileResponse`; a pass learns what a gateway holds from its head and `exists` | bounded |
| `forget_destination` (28) | first, best-effort, the gateway is asked to revoke this phone's token, and `revoked` says whether it answered so; then the gateway and its confirmations leave the device state whether or not it was reached; what it stores is left | bounded |
| `refresh_destination` (33) | a paired gateway found again at new addresses (Q-1080-D3): at most eight IP-literal candidates from the shell's foreground browse, each dialled with the certificate pinned at pairing and kept only if `GET /v1/info` answers with that gateway's own id; the kept ones go first in the device state's list, and the token, certificate and confirmations stay; a phone a gateway superseded refuses it `VAULT_MOVED` | bounded |
| `releasable` (29) | originals only the library holds, every chunk confirmed at a gateway (`held_whole`), not in a kept album, never edited in the library, a library item whole or not at all, oldest first | bounded |
| `released` (30) | the library items the member deleted: the device state forgets them in the library and a `media_asset` change event tells the grid they are fetchable | bounded |
| `held_whole` (49) | which paired gateways hold one original whole (`HeldWholeRequest { content_hash }` → `HeldWholeResponse { gateway_ids[], held_whole }`): every chunk of it reachable from that gateway's confirmed original tree, read from the device state with nothing dialled; the warning before deleting a photo no gateway holds whole asks it (R4) | bounded |
| `library_assets` (34) | which live asset each library ref was last backed up as, with the bytes it wraps: the newest item staged under the ref, absent when the vault holds no live asset for it; at most 100 refs, more is `INVALID_REQUEST`; how an edit made in place (Android) names the photograph it is an edit of (#1127, A20) | bounded |

A zero limit — `releasable`'s `limit` — is `INVALID_REQUEST`, never "no limit". **The core never deletes from the operating system's library**: the shell does, behind the system's own confirmation, and reports it through `released`.

**The stage door v2** (`StageRequest`, arm 13): `begin` names where the bytes live. Owned bytes (`STAGE_SOURCE_OWNED`, the default) stream into the content store, and a derivative (`for_hash` and `tier`: `thumb`, `preview` or `poster`) is staged beside its parent, so the command that mints the parent takes the shell's rendition as the tier and the Rust decoder stays idle. A library item (`STAGE_SOURCE_OS_LIBRARY` with `os_ref`, and `os_edited` when the member edited it there) is hashed as it streams and, for the chunks a gateway is owed and only as far as the staging budget allows, sealed into the staging area in the same stream (nothing is sealed at import); no plaintext copy is kept, every chunk ref is recorded so the next snapshot lists the original, and the device state records where its bytes are. An aggregate-export original (`STAGE_SOURCE_EXPORT_ARCHIVE`) is accepted only for the active Rust-minted export job and its next snapshotted photo id/hash/size; it streams to a bounded temporary file, is checked before Rust appends it to the ZIP, and is never stored in the vault or the staging area. A `byte_size` of 0 is "not known" for ordinary stages and the session takes what arrives; export originals require their snapshotted size. A begin that contradicts itself — a library item with no identifier, owned bytes with one, a derivative with half its fields or from the library, or export fields on another source — and a source this build has no name for are `INVALID_REQUEST`. `ContentUrl.source` answers `STORE` beside a path, `OS_LIBRARY` with `os_ref` for an original only the library holds, and `NONE` when the bytes are on this phone nowhere.

`vault_export` (request/response arm 48) is the whole-vault export's resumable lifecycle. `begin` reserves a Rust-owned job id and snapshots the dated filename from the vault clock. `build` then captures rows, names and each photo's original descriptor into one immutable snapshot and starts the ZIP writer off-thread. `next` appends one locally stored photo or returns one OS ref, and the shell supplies that OS original through the stage door before asking for the next. `skip` names the photo and why the library could not supply it; `finish` writes the omission list and ZIP directory and returns Rust's staged file path; `cancel` drops the job and partial ZIP. The shell never chooses archive entries or paths, and an original never enters `ByteStore`.

Test: `the_backup_plane_doors_are_request_kinds_and_answer_an_unpaired_phone` (and, below the ABI, `crates/core/src/handle.rs` and `crates/core/tests/phone_backup.rs`, which drives every door against a real gateway)

## 4h. The app plane's doors: rooms, notifications, the device store, follows and the share-in drain

Six request kinds and two events, all on `centraid_call` and `centraid_next_event`; none adds a symbol. The meaning of each field is in [app-plane](../../.claude/skills/change/app-plane.md); this clause fixes how they behave across the boundary.

**A room is shown by key and answered whole.** `RoomRequest.open{key, tab, root}` pushes the room named by `key` on `tab` (or, with `root`, replaces the tab's stack); `send{instance, event}` is one `RoomEvent` of the room on top. Both answer a `RoomResponse` of `RoomShown`s: the room now on top, its `depth` and how to move to it (`transition`). A scroll report, a stale selector or an edit the field already holds answers none. An unknown key or instance is `INVALID_REQUEST`. When a commit reaches a room's reads, Rust pushes the same `RoomShown` as `Event.room` (transition `RELOAD`); a reload never re-sends `restore`. A shell sends a tap on `header.back.selector_id` for back, and addresses nothing but selectors.

**The notification set is pushed whole.** `ScheduleNotifications` arrives as `Event.notify` when the desired set changes and as `NotifyResponse.schedule` to a `launched`. It is **declarative**: `all` is everything that should be pending (soonest first, within the `pending_cap` the shell stated at launch), and a shell makes the OS hold exactly that and **words nothing**. With `retain_delivered`, a delivered card leaves only when its id is in `cancel_delivered_ids` (its item was trashed, purged, finished or moved), never because time passed. `NotifyRequest.scheduled` reports what the OS did (`permission`, the Android channel states, the delivered inventory). `ask_permission` is true only when the set holds something that would fire and the member asked, or the first set needs it.

**Presses are durable.** A shell writes each press (`NotifyPress{id, verb, entity_id, date_id, field_id, at_ms, key}`, from the notification's own fields) to its outbox before it dismisses the banner, and sends `NotifyRequest.presses` until each `id` is answered `APPLIED`, `ALREADY` or `EXPIRED`; `REFUSED` stays for the next launch. Done runs `task.complete`; Snooze runs `alert.snooze` an hour from `at_ms`. Both are idempotent and run under `key`.

**The device store is the registry's.** `DeviceRequest` reads, writes and deletes a key; a key the registry does not list, or a JSON value without its `"v"`, is `INVALID_REQUEST`. **A follow request** runs `follow.<system>` for one of the eight followed stores, or `follow.stop`, and answers the vault's own sentence when it declines. **The share-in drain** (`ShareInRequest`) files what the extension left and is cancellable.

**The chat model's files are decided here** (`AssistRequest.plan`, `.finished`, `.opened`): the shell transfers, checks the SHA-256 and reports; the core says what to fetch (with the mobile-data rule), what to load, what to delete and when to reload (never under a running turn).

## 5. `next_event` surfaces bounded-queue backpressure as a health event

The event queue is bounded at 1024 and **drops nothing**. When it fills, sync stalls and a `HealthEvent { stalled: true, queue_depth, capacity, behind }` reaches the shell — later, on the first slot a drain frees, if the queue is full of change events, because a change event may not be dropped to make room for the report.

_Why:_ a dropped change event is a screen that stays wrong until something else happens to touch the same row, which may be never. Slow is a state a member can be told about; wrong is not.

`behind` is a distance in **log positions**, not rows and not seconds.

**What pushes.** A successful command offers one `ChangeEvent { table, pk_set }` per table its commit changed, through `crates/core`'s `ChangeFeed`. The commit hook reports table names, so these events carry an empty `pk_set`, meaning **re-read the whole table**. A fetched photograph's bytes offer its photograph ids instead. Coalescing preserves a whole-table invalidation in either arrival order: keyed events cannot narrow it. Backup-state requests also offer a `backup` table invalidation, including requests carrying an explicit caller id and passes that stop partway through.

When the queue is full the producer WAITS and retries rather than dropping, which is the stall this clause names; a closed handle ends the wait, because a core being closed under a running pass is what `centraid_close` does.

Test: `next_event_surfaces_bounded_queue_backpressure_as_a_health_event`; `crates/core/src/events.rs` and `crates/core/src/handle.rs` cover coalescing and command/ledger producers.

## 6. A timeout allocates nothing

`centraid_next_event` returns `TIMEOUT` (-5) with the out-pointers **untouched**. There is nothing to free, and a caller that called `centraid_free` on them would free whatever was in them before the call.

_Why it is a clause and not a note:_ the natural shell wrapper is `defer { centraid_free(buf, len) }` written once, and it is wrong here unless the status is checked first. Clause 1's null no-op is the other half of the answer: a shell that zeroes its locals before the call is then safe either way.

Test: `a_timeout_allocates_nothing`

## 7. `close` unblocks `next_event` with a terminal answer

`centraid_close` releases every thread parked in `centraid_next_event`, which returns `CLOSED` (-3) once the events already accepted have been handed out. A close is **not** a discard: accepted events come out first.

An entered event read keeps its own shared-state owner through waiting and screen callbacks. Releasing the caller's boxed handle does not free state an entered read is still using.

After `close` the handle pointer is **dangling**. A shell must null its own copy; no ABI can make a use-after-free safe. `close` on a null pointer is `BAD_ARGUMENT`, and `close` twice on the same pointer is undefined — that is a statement about C and not a gap in this library.

Tests: `close_unblocks_next_event_with_a_terminal_answer`, `an_entered_event_read_keeps_its_state_after_close_releases_the_box`

## 8. Calls after close return a typed error

Every entry point on a closed handle returns `CLOSED` (-3) — never a hang, never a panic, never a partial answer. (Reached through a handle the shell has not yet dropped; see clause 7 on the pointer itself.)

Test: `calls_after_close_return_a_typed_error`

## 9. A Rust panic never crosses the boundary

Every entry point is wrapped in `catch_unwind`. A caught panic becomes an error response carrying `ERROR_CODE_INTERNAL` and a **diagnostic id**, returns `PANICKED` (-4), and **poisons the handle**: every later call returns `PANICKED` with the same diagnostic id, so the shell restarts the core deliberately rather than carrying on over state nobody can vouch for.

_Why:_ unwinding into C is undefined behaviour. And the poison is not belt-and-braces — a panic means an invariant this library believed did not hold, and the next call would be running on state that violates it.

The **first** panic is the one filed. A later one is a symptom of running on poisoned state, and overwriting would lose the cause.

A panic in `centraid_open` returns `PANICKED` and hands back **no handle**: there is nothing to poison, and a handle the caller never received cannot be restarted.

**A damaged vault is its own status.** `centraid_open` returns `VAULT_DAMAGED` (-6) when the vault file fails its quick check or has a page SQLite cannot read, writes no handle and leaves the file untouched, so a shell can offer a restore instead of dead-ending on `BAD_ARGUMENT` (-1). Only `open` returns it; `call` carries the same fact as `ERROR_CODE_VAULT_DAMAGED`. The table grew by one code at the end and every other code keeps its value. Test: `a_damaged_vault_at_open_is_vault_damaged_through_the_abi`.

**The fault door.** A shell that cannot make this library panic cannot test its own handling of it. The `debug-fault` cargo feature makes an `act` on app `debug`, action `panic` (`DEBUG_FAULT_APP`, `DEBUG_FAULT_ACTION`) panic inside `Handle::call`; it rides an existing request rather than a sixth symbol, because clause 10 says five symbols and means it, and a shell that needed a sixth to test the fifth would have a sixth in production. It is absent from every release profile, exports nothing, and a default build answers that act as one on an app it does not carry ([#1020](https://github.com/srikanth235/centraid/issues/1020) wave 3, lane E finding 4).

Its first run found that `centraid_next_event` did **not** check the poison: the queue was empty, so it answered `TIMEOUT` (-5), which is a normal answer — a shell whose core had panicked would have polled a dead core once a second forever. Fixed in `crates/core`'s `next_event`; a poisoned handle refuses at every entry point, which is what the paragraph above claims.

Tests: `a_rust_panic_never_crosses_the_boundary`, `a_real_panic_inside_call_poisons_the_handle_through_the_abi` (needs `--features debug-fault`), `the_fault_door_is_absent_from_a_default_build`

## 10. Exactly five symbols are exported

`nm -D --defined-only libcentraid_core_ffi.so | grep ' T centraid_'` is 5. The xtask rule `abi-five-symbols` counts the `#[unsafe(no_mangle)] pub extern "C"` declarations in this crate's source on every gate run, and `tests/symbols.rs` counts the **exported** symbols in the built `cdylib` — two different questions, because a symbol can be declared and not exported, or exported by a dependency.

_Why five:_ every symbol is a thing three shells must wrap, three build systems must see, and compatibility must hold for. A per-verb ABI would be forty symbols that change whenever a verb does; one `call` over encoded bytes moves that churn into the protobuf schema, where `buf breaking` already governs it.

Test: `exactly_five_symbols_are_exported`, `the_exported_names_are_what_a_shell_links`

---

## What this contract does not promise

- **That the vault is concurrent.** See clause 3.
- **That a handle survives a fork.** SQLite handles do not.
- **That `close` is safe to race with a `call` on the same handle.** The shell owns the pointer's lifetime; this library owns what is behind it. A shell that closes while another thread is inside `call` has a use-after-free, and the remedy is the shell's own ordering.
- **Unknown protobuf fields survive a round trip.** prost 0.14 does not retain them (`crates/api-proto`'s D-1020-C13). Nothing across this boundary relays a decoded message, which is what makes that unreachable rather than merely unlikely.

## Miri

`cargo miri test -p centraid-core-ffi --test marshal_miri` runs over `src/marshal.rs`'s unsafe surface: the slice reconstruction, the out-pointer writes, the `Vec` → raw → `Vec` round trip `centraid_free` inverts, and the null-pointer refusals. It cannot run the whole crate, because SQLite is a C library and miri does not execute foreign code — so the unsafe surface is _confined_ to that module for exactly this reason.
