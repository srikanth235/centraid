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
  "role": "gateway" | "seat-replicated" | "seat-thin",
  "create": false,
  "uiThreadName": "main",
  "expectedIdentity": "<artifact digest>",
  "pairing": {
    "secret": "<64 lowercase hex characters>",
    "gatewayAddress": "<64 lowercase hex characters>",
    "vaultId": "…",
    "vaultName": "…",
    "relayUrl": "",
    "directAddrs": ["10.0.0.2:41234"],
    "enrolledPublicKey": "<64 lowercase hex characters>"
  }
}
```

`path` is the only required key. `expectedIdentity` is clause 9's stale-core refusal, made before a handle exists.

**`pairing` is THE ENROLMENT RECORD the shell kept for this vault** ([#1025](https://github.com/srikanth235/centraid/issues/1025) S7-13, D-1025-S7-14). One object, because it is one fact: this device's relationship with one vault. It was three keys and three secure-store entries — `endpointSecretKey`, `endpointSecretKeyPath` and a `pairing` without a secret in it — settled one at a time under three names, which is three chances to settle by halves. **Those spellings are deleted** (v0, no legacy).

**`secret` is this device's endpoint identity FOR THIS VAULT**: 32 bytes as 64 lowercase hex characters, the private half of the key the gateway enrolled when this seat paired.

_Why the shell holds it and this library does not:_ a secret key belongs in the platform's secure store — the iOS Keychain, the Android Keystore — and a core that invented a file would put the one unrecoverable secret on the device next to the vault it protects, in a place no shell asked for and no backup excludes.

**`enrolledPublicKey` is what the GATEWAY said it enrolled**, off the `PairOk` and derived there from the connection iroh's TLS proved. At open, the endpoint that comes up is compared against it, and a mismatch is refused (`BAD_ARGUMENT`, and `ERROR_CODE_IDENTITY_MISMATCH` wherever the condition reaches a `call`): the network is not attached and nothing is dialled. A seat whose secret is gone would otherwise dial as a stranger, be closed by its own gateway as an unenrolled peer, and render a version-window sentence over a lost credential.

**`relayUrl` decides the relay mode, and it has three states.** A url is a relayed deployment; `""` is a deployment that STATED it has none, and the endpoint comes up in `RelayMode::Disabled`; the key being ABSENT is "not told", and relays stay on. The third is the transient record a device holds while it is redeeming a ticket — a device that read absent as "no relay" could not pair over the internet at all. There is no `relays` flag (D-1025-S7-16).

**The pairing's ADDRESS half is also durable in the replica** (`seat_gateway`, `crates/seat/src/gateway.rs`) and is re-adopted by `centraid_open` the moment the network is attached; the replica is asked first. What is never in the file is the SECRET, which is why the record exists at all — and why a device that paired and could not take its copy still has something to dial.

**Absent (or empty) `secret` is not an error**: the endpoint mints a fresh keypair, which is every first launch. **Present and unreadable IS an error** (`BAD_ARGUMENT`), because carrying on with a fresh key would silently un-enrol a device whose shell believed it had persisted one. Per vault: a device holding two vaults is two cores, two endpoints and two records (D-1025-S7-13).

Tests: `the_endpoint_secret_crosses_the_abi_inside_the_enrolment_record`, `the_enrolment_record_carries_the_address_the_relay_and_the_enrolled_key`, `a_malformed_endpoint_secret_key_is_refused_rather_than_replaced`, and `crates/centraid/tests/seat_identity.rs`

## 4b. The vault's seed crosses the ABI, and this library writes no key down

`centraid_open`'s JSON may carry one more object:

```json
{ "vault": { "seed": "<128 lowercase hex characters>", "index": 0 } }
```

`seed` is the **64-byte BIP-39 seed** the 24 words derive (`centraid_identity::phrase::Seed`), and `index` is the derivation index this vault was minted at. Together they are what [`centraid_vault::backup::ObjectKeys`] is built from, and sealing a generation is impossible without them.

_Why the shell holds it and this library does not:_ the same answer clause 4a gives about the endpoint secret, with more force. `crates/vault/src/backup/mod.rs` deleted the scrypt-wrapped recovery kit under [#1029](https://github.com/srikanth235/centraid/issues/1029) §5 with one sentence — "a file that carries keys is a file that can be copied" — and a core that invented a key file beside the vault it protects would put the one unrecoverable secret in a place no shell asked for and no backup excludes. It belongs in the iOS Keychain or the Android Keystore, and it is borrowed for the length of `centraid_open` like every other input (clause 2).

**Absent is not an error.** A core opened without it reads and writes its vault perfectly well and refuses to drain, with `ERROR_CODE_PEER_UNREACHABLE` and a sentence naming the seed. That is a state a shell draws ("unlock to back up"), because a member who has not unlocked their phone has not lost anything.

**Present and unreadable IS an error** (`BAD_ARGUMENT`): a seed that is not 128 hex characters, or a `vault` object with no `index`. Carrying on would leave a shell believing it had unlocked a core that cannot seal a single byte, and the member would find that out on the day their phone is gone.

Tests: `the_vault_seed_crosses_the_abi_and_a_malformed_one_is_refused`

## 4c. The phone's four flows are request kinds, not symbols

`centraid.core.v1.Request` gained four arms under [#1029](https://github.com/srikanth235/centraid/issues/1029) W15, and `BackupNow` — which answered `NotYetAvailable` for the whole of its life — left with them. Field number 10 is **reserved, not reused**.

| Kind | Answer | Bounded? |
| --- | --- | --- |
| `drain` (15) | `DrainResponse { acked_txid, pending_bytes, stopped, acked_at_ms? }` | **unbounded**, cancellable; also carries its own `deadline_ms` |
| `pair_phone` (16) | `PairResponse { gateway_endpoint, record_published }` | bounded |
| `restore` (17) | `RestoreResponse { vaults[], gap_scanned }` | **unbounded**, cancellable |
| `backup_status` (18) | `BackupStatusResponse { acked_txid?, acked_at_ms?, pending_bytes, laptop_paired }` | bounded |

_Why this is a clause and not a schema note:_ clause 10 says five symbols and means it, and "backing up" is exactly the kind of flow that grows a symbol — it has a background half, a foreground half and a status. All three are arms on `call`. A shell adds a flow by encoding a different message, never by resolving a new name, and `buf breaking` governs the churn.

**A drain and a restore are cancellable; the other two are not**, and that follows from clause 4 rather than from a preference: `Cancel` names an unbounded operation, and a status read is a spool measurement. A drain has _two_ stops — `Cancel` is the member leaving the screen and `deadline_ms` is the operating system taking the window back — and they are different facts, which is why the deadline is not spelled as a cancellation the shell has to schedule.

Test: `the_phones_four_flows_round_trip_through_call`

## 4d. The originals on this phone are a request kind too

`originals` (19) answers `OriginalsResponse { kept_album_ids[], census? }` and is **bounded**. Its three ops are `kept` (read the keep list), `keep { album_id, keep }` (put one album on it or take it off) and `census` (the originals whole on this phone, and the share in kept albums). The keep list is `<stem>.keep-originals.json` beside the vault file, not a vault row: "keep these originals on this phone" is a fact about one device's disk, and a row would be sealed into the backup and restored onto the next phone as a promise about a disk it never had. An absent `census` is "not counted" — a core with no content store — and never zero.

_Why there is no release op:_ the backup carries the vault's pages and never an original's bytes, so no original can be proved held by the gateway, and a verb that released one would release the only copy. It arrives with the plane that uploads originals ([`docs/decisions.md`](../../docs/decisions.md) R-1029-PH-1).

Test: `the_originals_on_this_phone_round_trip_through_call` (and, below the ABI, `crates/core/src/originals.rs` and `crates/vault/tests/originals.rs`)

## 4e. An app's own query is a request kind

`app_query` (20) runs a registered app query in the core and answers `AppQueryResponse`, and is **bounded**. Its arms are typed per query — `agenda_upcoming { from, to, tz }`, `agenda_day_context { from, to, tz }`, `agenda_parties {}`, `agenda_search { term, limit, tz }` ([#1046](https://github.com/srikanth235/centraid/issues/1046)) and `agenda_event { event_id, instance_key, original_start_local, tz }` at 5 ([#1029](https://github.com/srikanth235/centraid/issues/1029)) — and each answer is the matching message in `agenda.proto`, at the query's own number in the answer's oneof. A shell adds a query by encoding a different arm, never by resolving a new name.

**Civil time is answered in the zone the shell states.** `tz` is the device's IANA zone; empty is the vault's own (`core_vault.settings_json`'s `timeZone`). Every occurrence carries `local_start`, `local_end`, `local_days` and `all_day` in that zone, and `upcoming`, `day-context` and `event` carry `today` and `now_local`, so a shell's shared layer — which has no calendar — groups, labels and draws the now line from strings.

`agenda_event` is the detail screen's read: the series row by id, or — named by `original_start_local`, else by the occurrence tail of `instance_key` — the one occurrence the one recurrence engine expands at that wall clock, decorated as `upcoming` decorates it. Its `event` is ABSENT for an unknown or trashed id, a key that is not an occurrence, and a skipped occurrence — a state, not an error; a cancelled event is answered. Every `AgendaEvent` carries `location_name`, the name of its `location_place_id`'s place.

_Why this is a clause:_ a page read is one table, and Agenda's `upcoming` joins six-plus and expands every repeating series through the one recurrence engine. The alternative to running it here is that engine rebuilt in Kotlin and Swift, which D-1020-S1 rules out. The query runs over the same page door `page` (6) reaches, so it reads nothing a shell's own page read could not.

**Notes answers eight queries at 40–47** (`notes.proto`, #1046): `notes_library { window, sort, pinned_only, notebook_id, unfiled_only, tag_concept_ids, tz }`, `notes_notebooks {}`, `notes_journal { window, tz }`, `notes_search { term }`, `notes_trash { tz }`, `notes_history { note_id, tz }`, `notes_link_targets { term }` and `notes_note { note_id }`. A People-journal entry is absent from the library, the trash, the tag chips, search and the powerbox, is the whole of `journal`, and still opens through `note` (D-1020-N3). The library's sort and filters narrow the recent window the vault returned, pinned notes first under every sort, and `truncated` says the window filled. `journal` groups entries by the local day of their `created_at` in `tz` and carries `today`, under the zone rule above. Library and trash rows carry `created_local_day`, `updated_local_day`, `deleted_local_day` and `purge_local_day`, and a history version `asserted_local_day`, in `tz` — with one softening of the zone rule: an empty `tz` on a vault that names no zone answers those days empty rather than refusing, because they decorate the shelf; an unknown name is still refused. `note` is the editor's pull: the whole body plus `current_revision_id`, which moves only when the body changes, and `row_version`, which every write bumps — the two bases an autosaving editor compares against, since `knowledge.edit_note` takes no base of its own. A malformed revision chain answers `notes_history` as `denied` with the chain's sentence (D-1020-N2), never a short list. `notes_notebooks` lists every `core_collection` of kind `notebook` — Photos' albums are the other kind and never appear — with each one's live `note_count`.

**People answers five queries at 20–24** (`people.proto`, #1046): `people_roster { limit, filter, sort, tz }`, `people_touch { tz }`, `people_person { party_id, tz }`, `people_search { term, limit }` and `people_trash {}`. The roster is the live `people_profile` window, newest-added first or by name, narrowed by the chip (`ALL`, `STARRED`, `DUE`), with the chips' counts over the whole window before the filter and `truncated` when older people exist beyond it; a party with no profile — the owner, a `core.add_party` face-review party — is no People row. Each row carries `due` and `days_since_contact`, read against the vault clock (last contact, or added when never, strictly more than `cadence_days` ago; 0 is no cadence). `touch` is Reconnect (most overdue first, each card's `days_over`), Upcoming (active reminders nearest first) and Recent (the latest 30 touches), with the headline counts. Every annual date carries `in_days` from the answer's `today` in `tz` under the zone rule above, so a 2 January birthday is 2 days away on 31 December; every touch carries `occurred_local_day` and every note `created_local_day` in the same zone. `person` answers no `sheet` for an id with no live profile — not a denial — and `touches_known` is false when the activity plane was refused, leaving the rest of the sheet standing. A trashed person is on `trash` and nowhere else. There is no sharing field anywhere: v1 has no share plane (#1029).

**Tally answers ten queries at 50–59** (`tally.proto`, #1046): `tally_dashboard { tz }`, `tally_group { group_id }`, `tally_friend { party_id }`, `tally_expense { expense_id, tz }`, `tally_settle_up { group_id }`, `tally_recurring {}`, `tally_spending { tz, month }`, `tally_search { term, limit }`, `tally_trash { tz }` and `tally_export { group_id, since, limit }`. Each folds the ledger once (`load_tally`, the 2,000 live expenses) through the one balance engine, and a shell derives no balance: the dashboard is Balances (each friend's position per currency, the owed/owe hero as two valuations that stay unvalued with their components when they span currencies), Groups (the owner's net in each group's own money, archived groups on their own list) and Activity (newest date first, with `today` and `yesterday` in `tz` for its day buckets). **Every figure is a `TallyMoney { minor, currency, exponent }`, the exponent from `centraid_apps_kit::money::minor_units`** — JPY 0, BHD 3 — and nothing sums across currencies; the dashboard also states `base_exponent`, and each rate suggestion its `from_exponent`, so an entry form scales a typed amount without a table of its own. Positive is owed to you. A group or friend that does not exist answers an absent `group`/`friend`, never an error; `tally_expense` opens a live or a trashed expense, with its memo and revisions (`undoable` against the vault clock, `recorded_local` in `tz`). `tally_settle_up` is each open pairwise debt per group, the minimal payment set once the group opts in to simplification, then — with no group named — the group-less position with each friend. A trashed expense is on `tally_trash` (dates read in `tz`) and in no balance, list or search. A `tally_search` with limit 0 and a `tally_spending` month that is not `YYYY-MM` are `ERROR_CODE_INVALID_REQUEST`; a recurring template's `schedule` is `rrule::describe`'s sentence, absent when the rule has none. No Waiting, queued or share field exists: v1 has no share plane (#1029).

**Docs answers four queries at 30–33** (`docs.proto`, #1046): `docs_drive { shelf, folder_id, type, modified, label, sort, ascending, limit, tz }`, `docs_search { term, limit, tz }`, `docs_document { document_id, tz }` and `docs_activity { document_id, tz }`. The drive is one shelf — `ALL`, `FOLDER` (a folder's direct children; empty `folder_id` is the top level), `STARRED`, `RECENT` (the fifty newest-added) or `TRASH` — cut from the one filed window (20…2,000, default 200), with v0's Type, Modified and label filters composed, the sort the request's, the whole folder rail with each folder's direct live count, the label options and the rail's counts; `truncated` says every shelf and count is of that window only. A trashed document is on `TRASH` and nowhere else, and search never matches one. Every row carries its `kind`, the `surface` that opens it (reader, stage or facts), its size as a phrase (empty with no byte row, never "0 bytes"), and its instants beside their `*_local` readings in `tz`; a trash row carries `purge_local_day` and `purge_in_days` from the answer's `today`. `document` answers no `document` for an unknown id — a state, not a denial — and otherwise its folder `path`, its versions newest first numbered from the oldest, its `body` (unset when the vault holds no decoded text, set and empty for an empty text document) and `bytes_held` from the byte store. **Nothing destroys a trashed document in this build**: `purge_*` is when the grace window ends, not when anything is deleted, and no shell may say "deleted forever". There is no Shared shelf and no sharing field: v1 has no share plane (#1029).

**Tasks answers five queries at 10–14** (`tasks.proto`, #1046): `tasks_board { tz, limit, view, project_id }`, `tasks_task { task_id, tz }`, `tasks_projects { tz }`, `tasks_search { term, limit, tz }` and `tasks_catch_up { tz }`. The board is one read — the newest open window (20…500, zero is the default 500) plus the fifty most recently closed, families nested and an unfinished child of a closed parent promoted — grouped for the place asked: `TODAY` (overdue first, then due today), `UPCOMING` (one group per local day), `INBOX`, `ANYTIME`, `ALL`, `LOGBOOK` (done, then won't do), `REMINDERS` or `PROJECT` (unsectioned work, then every section in order, empty ones included; a `PROJECT` board naming no `project_id` is `ERROR_CODE_INVALID_REQUEST`). `UNSPECIFIED` answers no groups — the counts and the chrome only. Every task carries its effective due (`next_due`, else `due_at`) read in `tz` — `due_day`, `due_local`, `due_time` (empty for a date-only due), `days_from_today`, `overdue`, `lands_today` — plus `remind_at_local` (empty for a date-only due, which has no moment), `completed_day` and `age_days`, so no shell does civil arithmetic; a repeating task carries `repeats`, `recurrence_summary` (the one summariser's sentence), `missed` and `next_due`, and its stored `rrule` verbatim — for the editor's repeat picker to pre-select and send back, never for a shell to expand or date from. `priority` is 0 unset, higher more urgent (D-1020-S5), not RFC 5545's 1-highest. `truncated` is the open page's own cursor. A trashed task is on no place, in no search and opens no detail: `task` answers no `task` for an unknown, purged or trashed id — a state, not a denial. `catch_up` is three disjoint piles — one-off work past due, repeating work that is behind, undated work that has sat 90 days — with `away_days` and `absent` (a week away with something overdue). There is no assignee or share field: v1 has no share plane (#1029).

**A denial is an answer and never an `Error`**: `denied` is an arm of `AppQueryResponse`, because a screen draws the ask. What a read cannot answer at all is the `Error` body: a search `limit` of zero is `BAD_ARGUMENT` with `ERROR_CODE_INVALID_REQUEST` (clause 4's rule for a page with no limit), as is a `tz` the bundled zone database does not know or an empty one on a vault whose settings name none — never an answer in UTC — and a read that reaches its own stated ceiling is `OK` with `ERROR_CODE_READ_BOUND_REACHED` — never a short answer that reads as a whole one.

Test: `the_app_queries_round_trip_through_call` (and, below the ABI, `crates/core/src/app_query.rs`)

## 5. `next_event` surfaces bounded-queue backpressure as a health event

The event queue is bounded at 1024 and **drops nothing**. When it fills, sync stalls and a `HealthEvent { stalled: true, queue_depth, capacity, behind }` reaches the shell — later, on the first slot a drain frees, if the queue is full of change events, because a change event may not be dropped to make room for the report.

_Why:_ a dropped change event is a screen that stays wrong until something else happens to touch the same row, which may be never. Slow is a state a member can be told about; wrong is not.

`behind` is a distance in **log positions**, not rows and not seconds.

**What pushes.** A sync pass that applies a page of rows to this replica pushes one `ChangeEvent { table, pk_set, commit_seq }` per table it wrote, as it writes it — `crates/core`'s `ChangeFeed` over the seam `centraid_seat::sync::ChangeSink` declares. Until [#1025](https://github.com/srikanth235/centraid/issues/1025) S5 **nothing in the repository pushed one at all**: the queue was built, bounded, coalescing and tested to its cap, and a shell that waited for a row to arrive waited forever. `commit_seq` is a COMMIT position and never a `LogRow.seq`, because a seat's overlay clears against a commit. A page that applied nothing — a duplicate delivery — pushes nothing, because a change event with an empty key set is a redraw of nothing.

When the queue is full the producer WAITS and retries rather than dropping, which is the stall this clause names; a closed handle ends the wait, because a core being closed under a running pass is what `centraid_close` does.

Test: `next_event_surfaces_bounded_queue_backpressure_as_a_health_event`, and `crates/centraid/tests/seat_bootstrap.rs`'s `a_row_applied_by_a_pass_comes_out_of_next_event_naming_its_key` over real QUIC against the shipped gateway

## 6. A timeout allocates nothing

`centraid_next_event` returns `TIMEOUT` (-5) with the out-pointers **untouched**. There is nothing to free, and a caller that called `centraid_free` on them would free whatever was in them before the call.

_Why it is a clause and not a note:_ the natural shell wrapper is `defer { centraid_free(buf, len) }` written once, and it is wrong here unless the status is checked first. Clause 1's null no-op is the other half of the answer: a shell that zeroes its locals before the call is then safe either way.

Test: `a_timeout_allocates_nothing`

## 7. `close` unblocks `next_event` with a terminal answer

`centraid_close` releases every thread parked in `centraid_next_event`, which returns `CLOSED` (-3) once the events already accepted have been handed out. A close is **not** a discard: accepted events come out first.

After `close` the handle pointer is **dangling**. A shell must null its own copy; no ABI can make a use-after-free safe. `close` on a null pointer is `BAD_ARGUMENT`, and `close` twice on the same pointer is undefined — that is a statement about C and not a gap in this library.

Test: `close_unblocks_next_event_with_a_terminal_answer`

## 8. Calls after close return a typed error

Every entry point on a closed handle returns `CLOSED` (-3) — never a hang, never a panic, never a partial answer. (Reached through a handle the shell has not yet dropped; see clause 7 on the pointer itself.)

Test: `calls_after_close_return_a_typed_error`

## 9. A Rust panic never crosses the boundary

Every entry point is wrapped in `catch_unwind`. A caught panic becomes an error response carrying `ERROR_CODE_INTERNAL` and a **diagnostic id**, returns `PANICKED` (-4), and **poisons the handle**: every later call returns `PANICKED` with the same diagnostic id, so the shell restarts the core deliberately rather than carrying on over state nobody can vouch for.

_Why:_ unwinding into C is undefined behaviour. And the poison is not belt-and-braces — a panic means an invariant this library believed did not hold, and the next call would be running on state that violates it.

The **first** panic is the one filed. A later one is a symptom of running on poisoned state, and overwriting would lose the cause.

A panic in `centraid_open` returns `PANICKED` and hands back **no handle**: there is nothing to poison, and a handle the caller never received cannot be restarted.

**The fault door.** A shell that cannot make this library panic cannot test its own handling of it. The `debug-fault` cargo feature makes a `Command` named `debug.panic` panic inside `Handle::call`; it rides an existing request rather than a sixth symbol, because clause 10 says five symbols and means it, and a shell that needed a sixth to test the fifth would have a sixth in production. It is absent from every release profile, exports nothing, and a default build answers `debug.panic` as an unregistered command ([#1020](https://github.com/srikanth235/centraid/issues/1020) wave 3, lane E finding 4).

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
