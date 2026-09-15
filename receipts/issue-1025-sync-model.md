# Receipt — sync model: one authority, many copies ([#1025](https://github.com/srikanth235/centraid/issues/1025))

One receipt for the umbrella. Each slice appends a section; the state this
produces lives in [docs/decisions.md](../docs/decisions.md) and
[docs/mobile-offline.md](../docs/mobile-offline.md), and where the two disagree
the doc is what is current.

## S1 — Replica lifecycle

Unpaired → pairing → bootstrapping → tailing → behind-the-floor →
bootstrapping again, all through the core, over QUIC, against the shipped
gateway binary.

### What was wrong, stated plainly

A phone could not get a replica. Not "it was slow" or "it needed a flag" —
there was **no creation path through the product**. `Core::open` on a seat path
with no file answered `VaultError::Missing`, so the only way a file appeared was
`mobile/scripts/demo-vault.sh` copying a **gateway-role** artifact into the
container: a vault with every private table, no `seat_state`, no outbox, and the
device's own authority over rows it was supposed to be a copy of.

The fallback that was supposed to make that unnecessary — `bootstrap_from`,
"from the floor": lay the compiled-in baseline schema, set `applied_seq = 0`,
walk the log — could not work on any vault with history, because the log HAS a
floor and seq 0 is a cursor the gateway refuses to serve from. It worked in
exactly one situation: a vault founded seconds earlier, which is the only vault
any test had. #996 R4 had superseded that walk two umbrellas ago.

### What changed

| Where | What |
| --- | --- |
| `crates/seat/src/identity.rs` | `(gateway_id, vault_id)` and `sha256(…)` → `vault_id`, undigested. `intents_database_name` deleted. `hex` dropped from the crate. |
| `crates/seat/src/install.rs` (new) | `prepare_replica`: check the artifact's own `core_vault` row, carry the outbox and the settled journal over with `created_order` verbatim, write `seat_state` — all on the STAGED file, all in the one crate SQL is allowed in. |
| `crates/seat/src/error.rs` | `SeatError::WrongVault`, refused before the destination is touched. |
| `crates/seat-link/src/bootstrap.rs` | the seq-0 schema walk deleted; `install` fetches the blob, expands it, prepares it and renames it into place. |
| `crates/seat-link/src/link.rs` | `GatewayLink::snapshot_offer` — a `SnapshotHeadRequest` **on the stream the seat already has**. |
| `crates/seat-link/src/seat.rs` | `SeatLink::start(replica_path)`: one endpoint, one key, one `<replica>.bytes` store per open replica. `SeatLink::bootstrap`. |
| `crates/centraid/src/snapshots.rs` (new) | the gateway's current bootstrap blob, rebuilt when a seat asks and it is older than the floor. |
| `crates/centraid/src/seat_lane.rs` | serves `SnapshotHeadRequest` beside `LogRequest`; everything else still refused by name. |
| `crates/centraid/src/run.rs` | the snapshot keeper wired in; the `sha256(gateway_id ‖ vault_id)` comment corrected. |
| `crates/core/src/handle.rs` | `vault: Mutex<Option<Vault>>` + the file's path; `CoreError::Unpaired`; `Handle::bootstrap` (close, install, reopen); `pair` takes the first copy; `sync_now` bootstraps when there is none and again on `rebootstrap_required`. |
| `crates/core/src/config.rs` | `Role::Seat` no longer carries a gateway id. |
| `crates/core/src/link.rs` | `SeatNetwork::bootstrap`; `SyncOutcome::rebootstrap_required`. |
| `crates/core-ffi/src/lib.rs` | a network is attached for **seat roles only**, and from the replica path. |
| `crates/blobs/src/store.rs` | `ByteStore::forget`, so a seat does not keep its own vault twice. |
| `crates/api-proto/.../pair.proto` | `PairOk.gateway_id` documented as an ADDRESS. Comment only — see "what I left". |

### The five rulings

Recorded in [docs/decisions.md](../docs/decisions.md#the-sync-model--one-authority-many-copies-1025) as `D-1025-S1-1`…`-5`. Three of them supersede #1020 rulings that were right about the transport and wrong about the model:

- **D-1020-D2B's naming clause.** Its point — a pairing response names the vault's real id — stands and is now load-bearing. The `sha256(gateway_id ‖ vault_id)` it describes is gone.
- **D-1020-B6's closing clause**, "a seat that has never synced bootstraps from the FLOOR". There is no floor bootstrap. There is one path and it is a blob.
- **D-1020-B7's "attached for EVERY role"**, whose reasoning ("a network belongs to the device and not to a vault's authority") reads correctly and attached the wrong thing once a `SeatLink` became the thing that REPLACES its replica file. A gateway-role core with one attached is an endpoint standing by to overwrite the vault this device is the authority for.

Also superseded, from v0's HTTP door: the `bytes=N-` + `If-Range` resume, the `?seq=` pin, the `SeatSnapshotMovedError` retry, and the `<seat>.carry-over.json` sidecar with its `seat_carry_over` token. A content address cannot move underneath a download, and a rename has no window in which the queue is nowhere.

### What the test proves

`crates/centraid/tests/seat_bootstrap.rs`, two tests, **2.4 s**, against
`CARGO_BIN_EXE_centraid` over real QUIC:

1. `a_seat_bootstraps_from_a_blob_tails_falls_under_the_floor_and_keeps_its_queue` — no pre-placed file; pair; bootstrap from the snapshot blob; assert the cursor is **not** zero (which is the deleted walk, caught by assertion); commit three parties on the gateway and tail them; queue an outbox row and record its `created_order`; commit four more; prune the gateway's log ten years forward so the floor passes the seat's cursor; assert the next pass is **refused** with a re-bootstrap; bootstrap again; assert the outbox row **and its `created_order`** survived; assert the replica's `core_party` rows are the gateway's, row for row.
2. `an_unpaired_core_opens_refuses_reads_and_is_paired_into_a_replica` — `Core::open` on a missing seat path answers a handle, `with_vault` refuses `CoreError::Unpaired`, **nothing founded a file**, and a `Request::Pair` through `Handle::call` leaves the seat holding a replica with the founding vault row in it.

The second is the one that matters for the model: the lifecycle runs through
`Handle`, not through a test harness driving `SeatLink` by hand.

The prune step needs a second connection to the running gateway's file, which is
what WAL is for and is the only way a test can move a live gateway's log until a
seat can write (S2).

### What I found

- **The floor walk was unfalsifiable by construction.** Every test that exercised it founded a vault immediately before, so the one case it could not serve was the one case no test had. The assertion `after_bootstrap > 0` in the new test is what makes its absence checkable.
- **`Role::Seat.gateway` was never read.** A `Vec<u8>` threaded through `CoreConfig`, the FFI's JSON and the CLI, and not one consumer. Naming by gateway had already reached the type system without reaching any behaviour.
- **The snapshot builder already existed and already did the right thing** (`crates/vault/src/snapshot.rs`: `VACUUM INTO`, `secure_delete`, private tables dropped by ontology registry, log truncated with the floor kept, numbers read from the COPY). S1 needed a keeper and a wire answer, not a builder. Re-deriving one would have re-derived the credential-canary bug its step 2 exists for.
- **The snapshot directory must not be `snapshot::pre_migration_dir`.** The keeper sweeps everything but the current artifact, and that directory holds the copies a migration rolls back to. `<vault>.snapshots` instead. Caught while writing the sweep, not by a test — there is no test that would have.
- **`crates/blobs/tests/windows.rs` is flaky under load.** It failed once (`window 1 was cut and left no verified chunks`) when four crates' test binaries ran at once, and passed alone every time. Its windows are 120 ms wall-clock. Not mine to fix in this slice; recorded because the next person will see it.

### What I left, and why

- **`PairOk.gateway_id` keeps its field name.** Renaming it regenerates the checked-in KMP/Swift sources under `mobile/`, which S1 does not touch. The proto now says in its own comment that the field is an address and never a name, and nothing on a device keys anything by it. The rename belongs with S5's shell work.
- **`mobile/scripts/demo-vault.sh` is untouched.** Its seat path is dead — a seat creates its own replica now — but deleting it is a `mobile/` change. Named here so it is removed rather than rediscovered.
- **The endpoint keypair is still minted per open and never persisted.** A secret key on disk is the shell's secure store's job (iOS Keychain, Android Keystore), which S5 names as unimplemented. So a relaunched seat is a device its gateway has not enrolled. That was already true before this slice; it is written down now instead of being a surprise.
- **An injected clock does not survive a re-bootstrap.** `Box<dyn Clock>` is not clonable and the core gives its away at `open`, so the reopened vault takes the build's default. No product path injects one; a fixed-clock seat loses determinism across a swap and nothing else.
- **`Unpaired` carries `ERROR_CODE_REBOOTSTRAP_REQUIRED`.** A new wire code means a proto enum value and the generated Swift under `mobile/`. The member's remedy is identical — take a fresh copy — and a shell would branch on the two the same way. If S5 disagrees, the code is one line.
- **Under the floor is not yet bounded.** v0 parked a mount after three drift re-bootstraps in a row, because the phone's retry timer re-entered the repair forever. `sync_now` bootstraps once per pass and a gateway committing faster than a phone can download would loop across passes. The doc still describes the bound; nothing implements it. Worth a slice-level decision in S2, where the pass gets the shell's deadline.

### Commands

| Command | Result |
| --- | --- |
| `cargo fmt --all` | clean |
| `cargo clippy -p centraid-seat -p centraid-seat-link -p centraid-core -p centraid-core-ffi -p centraid-blobs -p centraid --all-targets` | no new warnings (three pre-existing in `bin/seed-demo-vault.rs`) |
| `cargo check --workspace --all-targets` | clean |
| `cargo test -p centraid-seat` | 134 + 3 + 10 + 8 passed |
| `cargo test -p centraid-seat-link` | 7 passed |
| `cargo test -p centraid-core` | 58 + 2 + 1 passed |
| `cargo test -p centraid-core-ffi` | 8 + 11 + 7 + 2 passed |
| `cargo test -p centraid-blobs` | 12 + 2 passed |
| `cargo test -p centraid --test seat_bootstrap` | 2 passed, 2.40 s |
| `cargo test -p centraid --test seat_offline` | 3 passed, 6.65 s |
| `cargo test -p centraid --test {byte_lane,seat_lane,seat_socket,no_listener,native_host,restore_drill}` | all passed |
| `cargo test -p centraid --test gateway_install` | **1 failed, pre-existing** — `a_system_install_refuses_an_instance_name_that_is_not_one`; reproduced identically on a stashed tree. `--system` is systemd and this host is macOS. |

## S2 — One protocol

One ALPN, one connection per vault, one stream per request, a live intent
sink, and deadlines that come from the shell.

### What was wrong, stated plainly

**A phone could read and never write.** `ShutSink` answered every intent
`Unavailable("no stream for writes this window")`, so a member's write stayed in
the outbox forever while the badge honestly said "queued". The comment beside it
defended the shape rather than the outcome: the gateway's seat lane, it said,
has no principal to attribute an intent to.

It has one. `Endpoint::accept` proves the DEVICE; an intent's identity is
`(vault_id, intent_id, payload_hash)` and never the device; `Vault::execute`
already owned the replay ledger, the payload-hash check and the outcome row. The
real cause was one line: `seat_lane::serve` called `accept_bi` **once** and then
looped on that stream, so a seat opening a second one for writes waited for an
accept that never came — no error, no close, no end. `ShutSink` was a
workaround for a hang, and the hang was the gateway accepting one stream.

Everything else in this slice is downstream of the same shape:

- **Two ALPNs** existed because a blob's framing is not an envelope's. It cost a
  phone two QUIC setups per window, put one admission check in one arm matching
  two ALPNs, left the byte arm in `run.rs` unreachable for a while behind an
  `unreachable pattern` warning, and made a gateway-side pull from a seat
  impossible — the seat dialled both lanes and served neither.
- **`PLANE_TIMEOUT = 60 s` per plane** and `Budget::foreground()` on every pass
  `core-ffi` attached. Sixty seconds outlives an iOS refresh window, cuts a
  night shift that had hours, and is unmetered on a cellular link.
- **The under-the-floor repair was unbounded**, which S1 recorded and left.

### What changed

| Where | What |
| --- | --- |
| `crates/protocol/src/alpn.rs` | `BYTE`, `PEER`, `ALL`, `ADVERTISED` deleted. Two constants: `SEAT` and `PAIR`. |
| `crates/net/src/endpoint.rs` | `accept` gates one ALPN; `EndpointConfig` advertises exactly two; `IrohConnection: Clone` (one handle, two tasks); `RawSend`/`RawRecv` aliases so `crates/centraid` need not name iroh. |
| `crates/api-proto` | `BlobRequest` + `Request.blob = 12`; `SyncWindow` + `Command.sync_window = 6`; `PairOk.gateway_id` → `gateway_address`; `content.proto` added to `build.rs`'s `PROTOS` (see "What I found"). |
| `crates/blobs/src/lane.rs` | connection-level `serve` deleted for `serve_stream(store, connection_id, send, recv)` over `provider::handle_stream`; `fetch` opens and tags its own stream and drives `execute_get` over a `get::StreamPair`. |
| `crates/centraid/src/seat_lane.rs` | rewritten: handshake on the connection's first stream, then a symmetric `accept_bi` loop, one task per stream, `log` / `intent` / `snapshot_head` / `blob`, everything else refused by name. |
| `crates/centraid/src/run.rs` | the second accept arm deleted; one `Lane` carrying the handle, the snapshots, the byte store and the enrolled device id. |
| `crates/core/src/intent.rs` (new) | the gateway's intent gates: payload hash in constant time, replay short-circuit, the chain, the declared read-set, then `Command::with_intent`. |
| `crates/core/src/handle.rs` | `submit_intent`; `sync_now(window)`; `seat_sync` marshals `Command.sync_window`; `REPAIRS_BEFORE_PARKING`; the injected clock kept as an `Arc` and handed to the re-bootstrapped file. |
| `crates/core/src/link.rs` | `SyncWindow`; `SyncOutcome::{cut_by_the_deadline, parked}`; `SeatNetwork::sync(connection, window)`. |
| `crates/seat/src/sync.rs` | `pass(…, deadline)`, checked between pages and before each intent; `PassReport::cut_by_the_deadline`. |
| `crates/seat-link/src/link.rs` | `handshake()` split out; `GatewayLink<'a>` holds no stream and opens one per request; the live `IntentSink` and the wire↔seat outcome mapping. |
| `crates/seat-link/src/serve.rs` (new) | the seat's half of the symmetric loop: `blob` streams the gateway opens, everything else refused by name. |
| `crates/seat-link/src/seat.rs` | one connection per pass; `PLANE_TIMEOUT` and `ShutSink` deleted; the budget comes from the window. |
| `crates/apps/kit/src/overlay.rs` (new) | `Overlays`, and the paint `read_page` / `read_pages` / `read_window` / `read_by_id` apply. |
| `mobile/scripts/demo-vault.sh` | the dead seat justification replaced; it seeds a GATEWAY demo vault and says so. |

### The six rulings

`D-1025-S2-1`…`-6` in [docs/decisions.md](../docs/decisions.md#slice-s2--one-protocol-1025). They supersede:

- **D-1020-B1**'s two-lane split (the content-addressing half stands and is load-bearing).
- **D-1020-C7**'s four-ALPN declaration.
- **D-1020-B6**'s one-stream-per-connection clause, with `ShutSink` and `PLANE_TIMEOUT`. That a seat DIALS, always, still stands.
- **D-1020-D2A**'s "this lane has no principal", which was true of a `Command` and never of an `Intent`.
- **D-1020-B5**'s fixed plane ceiling.
- **D-1025-S1-1**'s own deferral of the `PairOk` rename (see below).

### Where I disagreed with the brief, and why

The brief says `crates/protocol/src/alpn.rs` has **one** entry. It has two:
`SEAT` and `PAIR`.

Collapsing `PAIR` into `SEAT` is not a naming change, it is an admission
change. `SEAT`'s entire premise is that `Endpoint::accept` closes an unenrolled
peer **before a stream is accepted**; a redeeming device is unenrolled by
definition, so pairing on `SEAT` would mean admitting every unenrolled peer in
the world onto the plane whose premise is that nobody unenrolled is on it — and
the enrolment check would have to move from the connection to each stream, which
is the "two admission rules" this slice is deleting. The brief's actual target,
`centraid/v1/byte`, is gone, and so is `centraid/v1/peer` (declared for a wave
that has not landed). The file has one DATA PLANE and one admission exception,
and `alpn.rs` carries a test that says so by name.

### What the tests prove

| Test | What it proves |
| --- | --- |
| `centraid/tests/seat_offline.rs::a_write_made_offline_settles_against_the_commit_that_carries_it` | The whole slice, end to end, against `CARGO_BIN_EXE_centraid` over real QUIC. Pair, bootstrap, go offline, queue an intent, pass (it stays queued, not failed), come back, one pass: `intents_submitted == 1`, `blocked` is `None`, the intent id is in `overlays_cleared` — which only the COMMIT path reports — and then **both facts together**: the settled journal holds it and `core_party` holds the row it wrote. Before the pass, neither. There is no state in which one holds and the other does not. |
| `…::a_window_the_deadline_cuts_keeps_its_cursor_and_the_next_window_catches_up` | A zero-length window is reported as CUT, returns in well under the sixty seconds the deleted constant would have spent, moves no cursor, and the next window continues from it and is told it is caught up. |
| `seat/src/sync.rs::a_pass_cut_by_the_deadline_keeps_what_it_applied_and_the_next_one_continues` | The deadline itself, deterministically and with no clock: an already-passed deadline cuts on a page boundary, reports `cut_by_the_deadline` with `stale: None` (a deadline is not an unreachable gateway), applies nothing it did not finish, and the next pass asks from the cursor. |
| `seat/src/sync.rs::a_cut_applies_whole_pages_or_none` | Two rows of one commit apply as one commit: the cut is on a page boundary, never inside a commit. |
| `core/src/handle.rs::three_repairs_in_a_row_park_the_seat_and_wipe_nothing` | Three consecutive under-the-floor passes each take a fresh copy; the fourth PARKS — no download — with `PARKED_SENTENCE`, and the replica still opens and still reads. |
| `centraid/tests/byte_lane.rs` | A blob crosses on a **tagged stream of the one connection**, from the shipped binary's own store — and then that same connection answers a `LogPage`. Asserted after the transfer on purpose: a provider that had taken the whole connection (which the deleted `serve` did) would hang here rather than fail elsewhere. |
| `centraid/tests/seat_lane.rs` | Stream-per-request driven by hand, so a regression to one-stream-per-connection fails on the SECOND request. Plus: a `len == 0` first frame on one stream, and the connection still answers a log page — the refusal costs its stream and nothing else. |
| `blobs/tests/windows.rs` | Unchanged assertions, one ALPN, per-stream serving, and the windows are now cut by **verified progress** rather than by 120 ms of wall clock (see below). |
| `apps/kit/src/overlay.rs` | Seven tests, including one through `read_page` itself: a gateway's door returns the committed value, a seat's door with one queued write returns the pending one, and the mirrored row is untouched. Plus the three refusals — no spliced row, no removed row, no invented column — and the entity spelling, the later-wins order and a cleared field as NULL. |

### What I found

- **`crates/api-proto/tests/tree.rs` was already red on `main`.** `content.proto`
  was in the tree and not in `build.rs`'s `PROTOS`. It compiled anyway, because
  `protox` follows imports — so the list's whole purpose ("a `.proto` not on
  this list is a file nothing generates from") was silently not being served.
  One line, fixed here because this slice edits that file.
- **The `PairOk` rename was deferred to protect files that do not exist.** S1
  left `gateway_id` on the stated grounds that renaming it regenerates
  checked-in KMP and Swift sources. The Kotlin is generated by Wire at build
  time **from `crates/api-proto/proto` read in place** (`mobile/core/build.gradle.kts`),
  and `mobile/iosApp/Sources/Generated/` is in `mobile/.gitignore`. Neither is
  in the repository. The Swift was regenerated locally anyway with the repo's
  own settings — `protoc --swift_opt=Visibility=Public,FileNaming=FullPath`,
  verified byte-identical against the existing output before the rename — so a
  working tree stays consistent.
- **`crates/apps/kit` did not project `Outbox::overlaid()` at all**, and nothing
  else did either. The outbox half was complete — the nine overlay-holding
  states, and `settle_at_commit_seq` clearing the paint inside the transaction
  that lands the commit — and there was no consumer. A queued write was a badge
  and never a value. The overlay now crosses the seam as data and the kit paints
  it; the three things it refuses to invent are in its module header, because
  approximating any of them gives a screen that disagrees with itself.
- **`windows.rs`'s flake was the schedule, not the assertion.** S1 recorded
  `window 1 was cut and left no verified chunks` under parallel load. 120 ms is
  not reliably enough to verify one 16 KiB chunk group on a machine running four
  other test binaries. The windows are now cut by **4 MiB of verified progress**,
  whatever that takes, with a 60 s ceiling as a stall backstop. That is stricter:
  the window count is fixed by the blob size instead of by the machine, every
  window is still cut mid-stream, and not one assertion was loosened.
- **The vault already owned intent idempotency.** `Command::with_intent` runs
  `assert_identity`, the expiry window, the ledger replay and `record_outcome`.
  A first draft of `crates/core/src/intent.rs` re-derived all of it and would
  have written outcome rows under the SEAT's payload spelling — which the
  vault's own `assert_identity` would then have refused as an id reuse on the
  very next retry. The gates that remain are the three the vault does not have:
  the seat's payload hash, the chain, and the declared read-set.

### What I left, and why

Nothing in the brief. Two things adjacent to it, named so they are not
rediscovered:

- **`mobile/shared/.../mount/Mount.kt` still has `MountKey(gatewayId, vaultId)`
  and a `"$gatewayId.$vaultId.replica.db"` file name.** That is hand-written
  shell code naming a replica by a gateway, which D-1025-S1-1 deleted from the
  core. It is S5's, which owns `shared/`'s layout, and this slice's mobile scope
  is generated code and the demo script.
- **The endpoint keypair is still minted per open** (S1's finding, unchanged):
  a relaunched seat is a device its gateway has not enrolled until the shell's
  secure store lands in S5.

### Commands

| Command | Result |
| --- | --- |
| `cargo fmt --all` | clean |
| `cargo clippy -p centraid-protocol -p centraid-net -p centraid-blobs -p centraid-seat -p centraid-core -p centraid-seat-link -p centraid-apps-kit -p centraid-api-proto -p centraid -p centraid-sim --all-targets` | no new warnings (three pre-existing in `bin/seed-demo-vault.rs`) |
| `cargo check --workspace --all-targets` | clean |
| `cargo test -p centraid-api-proto` | 2 passed (`tree.rs` was red before this slice) |
| `cargo test -p centraid-protocol` | 2 + 2 + 4 passed; `contracts/protocol/framing-golden.json` regenerated (the `peer` ALPN row is gone) |
| `cargo test -p centraid-net` | 7 + 11 + 24 + 34 passed |
| `cargo test -p centraid-blobs` | 12 + 2 passed, 1.09 s |
| `cargo test -p centraid-seat` | 136 + 3 + 10 + 8 passed |
| `cargo test -p centraid-core` | 62 + 2 + 1 passed |
| `cargo test -p centraid-core-ffi` | 8 + 11 + 7 + 2 passed |
| `cargo test -p centraid-apps-kit` | 68 + 6 passed |
| `cargo test -p centraid-sim` | 17 + 3 + 2 + 3 passed, longest 10.7 s |
| `cargo test -p centraid --tests --no-fail-fast` | `byte_lane` 1, `seat_bootstrap` 2, `seat_lane` 1, `seat_offline` 5, `seat_socket` 7, `native_host` 6, `no_listener` 9, `restore_drill` 3, `mcp_stdio` 2 — all passed. **`gateway_install` 1 failed and `bin` 1 failed, both pre-existing**: `a_system_install_refuses_an_instance_name_that_is_not_one` and its `tests/` twin are `--system` systemd on a macOS host. |

No test or scenario ran longer than 11 seconds.

## S3 — Bytes both ways, one store

A photograph taken on a phone reaches the gateway, and it reaches it before the
row that names it commits. A device holds one content store. There is one ALPN.

### What was wrong, stated plainly

**Three things, and each one was invisible from inside its own half.**

1. **Bytes only flowed down.** A photograph minted on a phone had no path to the
   gateway at all. There was no verb, no stream and no shape — and the gateway
   would have committed a `core_content_item` naming bytes nobody held if one
   had been invented carelessly.
2. **A device held TWO content stores.** `Vault::with_blobs` wrote a flat
   one-file-per-hash CAS at `<vault>.blobs/` and `content_location` read it;
   every transfer wrote iroh's `<vault>.bytes`. So a photograph a seat FETCHED
   could never be displayed, and one a window MINTED could never be served — on
   the same device, for the same vault. The gateway papered over half of it by
   sweeping the CAS into the byte store on every start
   (`ByteStore::import_content_cas`), which is why nobody noticed: on the one
   machine that ran both halves it looked like it worked.
3. **`blob:sha256-` had a refusal branch, a `HashError` variant, a member-facing
   sentence and a test — and no producer.** v1 has no released predecessor, so
   no vault a member holds was ever written that way. The only thing that ever
   reached the sentence was a unit test constructing the string it then refused.

And the owner's ruling mid-slice added a fourth: **two ALPNs, on an argument
that does not hold.**

### What changed

| Where | What |
| --- | --- |
| `crates/blobs/src/door.rs` (new) | `ContentBytes` — the byte plane's store wearing `centraid_vault::backup::store::BlobStore`. The one place the vault's synchronous door and the store's asynchronous actor meet. |
| `crates/blobs/src/store.rs` | `InlineOptions::NO_INLINE` at open; `data_path`; `sweep` + `Sweep`; `import_content_cas` deleted. |
| `crates/blobs/src/hash.rs` | `SUPERSEDED_URI_PREFIX` and `HashError::SupersededHash` deleted. |
| `crates/vault/src/backup/store.rs` | `Naming` and `open_content` deleted; `FsBlobStore` is backup-only; `BlobStore::path_of` added — a grid asks the store where its own bytes are. |
| `crates/vault/src/file.rs` | `blobs_root_for` deleted. `with_blobs` takes the byte plane's store. |
| `crates/vault/src/content.rs` | the superseded branch deleted; the path comes from `path_of`; `Vault::stage_bytes`, the first v1 producer of `blob_staging`. |
| `crates/vault/src/commands/core.rs` | `staged_or_owned` and `promote_staged_blob` learn a third place bytes can be: **this vault's own content store**, which is where a pulled blob lands. |
| `crates/vault/src/intents.rs` | `NeededBytes`; `IntentPayload.needs`, canonicalised into the payload hash sorted by hash and omitted when empty. |
| `crates/seat/src/intent.rs`, `outbox.rs` | `needs_blobs` gains its element type and its two ends: `pinned_blobs` reads it off every unsettled row. |
| `crates/core/src/handle.rs` | `attach_bytes`; the store held so a re-bootstrap re-attaches the SAME one; `stage_bytes`. |
| `crates/core/src/intent.rs` | `needed_bytes` — the declaration, readable only through the payload-hash gate. |
| `crates/centraid/src/seat_lane.rs` | `pull_declared_bytes` before every intent; `Pairing`, `redeem_in_place`, and the two-state connection. |
| `crates/centraid/src/run.rs` | one accept arm; the byte door attached to the gateway's own core; `--print-qr` takes a count. |
| `crates/protocol/src/alpn.rs` | `SEAT` and `PAIR` → `PLANE`, `centraid/v1`. One entry, and a test that says so. |
| `crates/protocol/src/{framing,wire}.rs` | `read_frame_capped` / `read_envelope_capped`, for a frame read before its peer is trusted with anything. |
| `crates/net/src/endpoint.rs` | `accept` marks rather than closes; `Accepted::is_promoted`. |
| `crates/net/src/pairing.rs` | `redeem` dials the plane and **returns its connection**; `answer_redemption` + `VaultIdentity`. |
| `crates/seat-link/src/seat.rs` | the promoted connection kept and reused; the eviction sweep; the want-list read after the row plane. |
| `crates/centraid/src/bin/seed-demo-vault.rs` | seeds the iroh store directly. There is nothing to import any more. |

### The eight rulings

`D-1025-S3-1`…`-8` in [docs/decisions.md](../docs/decisions.md#slice-s3--bytes-both-ways-one-store-1025). They supersede:

- **D-1020-HOME7's two-store arrangement**, and with it the `blobs_root_for(path).join(sha)` location wording `content.rs` cites D-1020-DC1 for. That the door exists, is optional and is per vault stands; that a drive row's identity is the `core.document` wrapper stands.
- **D-1020-B2's superseded-prefix clause.** The half that stands, and is load-bearing, is that the hash's NAME is in the value.
- **D-1025-S2-1's `PAIR` clause**, and D-1020-C7 entire.

### How an intent declares the bytes it needs, and why that way

The brief offered two shapes and asked for the one that cannot drift.

**Chosen: a field on the envelope, inside the payload hash.** `Intent.needs`
carries `{hash, byte_size, media_type}` per blob;
`IntentPayload::hash` canonicalises it as `needs`, sorted by hash, omitted when
empty.

**Rejected: derived from the command.** That needs a table of "which input
property of which command names bytes" living on the gateway — a second
definition of the byte door, beside `minted_bytes`. It drifts silently: a
command added without its entry commits a content row naming bytes the gateway
does not hold, nothing fails at the time, nothing is red, and the symptom
appears weeks later on a second device as an empty cell.

A declaration cannot drift that way for two reasons and both are mechanical.
It is **in the payload hash**, so it is part of what the member's write was
signed for — a gateway cannot be told to fetch bytes nobody signed for and a
proxy cannot add one in flight, which `needed_bytes` enforces by refusing to
read the field at all until the hash matches. And a seat that declares nothing
is refused **loudly** by `staged_or_owned`, which is an existing precondition
with an owner-facing sentence rather than a new gate somebody has to remember.

A third shape — scanning the payload's JSON for `blob:blake3-` values — was
drafted and dropped. It cannot carry the size or the media type, and those two
cannot be derived: there is no media-type sniffer on a gateway, and a photograph
promoted as `application/octet-stream` is a photograph the grid will not embed.
The hash is the one field that is verified, and bao verifies it absolutely.

### What the tests prove

| Test | What it proves |
| --- | --- |
| `centraid/tests/bytes_upward.rs::a_photograph_minted_on_a_seat_reaches_the_gateway_and_then_a_second_seat` | The whole slice, against the shipped binary over real QUIC. A seat mints 300 KiB into its own store through the vault's byte door, queues `media.add_asset` naming them; ONE pass pulls, stages, executes and commits; the row comes back as `blob:blake3-<hash>`. Then a **second** seat — its own endpoint, its own ticket, its own replica — bootstraps, tails the row, fetches the bytes, and `content_location` on it answers a path that `std::fs::read`s **byte-identical** to what the first seat minted. The same 32 bytes named it on three machines and each found it in the one store it has. The media type survives too, so `embeddable` is true. |
| `…::a_pull_that_cannot_complete_leaves_the_intent_queued_and_a_retry_finishes_it` | The law's other half. An intent declares bytes the seat cannot serve: the pass reaches the gateway, the write is **still in the outbox**, in a state that is neither settled nor never-retried nor owed the member's attention — and **no content row committed**. Then the bytes land in the seat's store and the next pass settles the same intent id and commits the row. |
| `blobs/tests/eviction.rs::a_pinned_blob_survives_a_sweep_that_takes_everything_else` | R25, as code. Budget zero — the hardest case — so every unpinned blob goes and the pinned one stays, readable as a FILE, with `over_budget_by` reporting the pressure rather than resolving it by taking the pin. A sweep that filtered pins at the end instead of subtracting them first would take it on exactly this arithmetic. |
| `…::a_store_inside_its_budget_is_left_entirely_alone` | An LRU that trimmed on every pass would spend a phone's data re-fetching what it had. |
| `net/tests/pair_and_stream.rs::two_endpoints_pair_and_stream_a_commit` | **One accept.** Pairing and streaming a commit cost the gateway exactly one connection: the provisional stream redeems, the connection is promoted in place, and the very next stream on it is the seat's handshake. Two accepts would mean the second ALPN is back. |
| `…::an_unenrolled_peer_is_accepted_provisional_and_enrols_nothing` | `accept` marks rather than closes, and provisional is a state and never a credential — reaching the gateway puts no key in the allowlist. |
| `centraid/tests/seat_lane.rs::an_unenrolled_peer_is_closed_by_name_and_an_enrolled_one_is_untouched` | The gateway-side half, against the shipped binary. A stranger's `log` stream is refused `UNAUTHORIZED` **with a sentence** and its CONNECTION ends; the enrolled seat's connection, open at the same moment on the same ALPN, reads its page afterwards. The second assertion is the one that catches the real regression — a refusal that took the accept loop or a shared lane with it only shows up when two devices are in range, which is every household. |
| `blobs/tests/windows.rs::an_unenrolled_peer_cannot_fetch_a_blob_it_knows_the_hash_of` | The security property survived the pair lane's deletion. Its toy gateway now serves blobs only on `is_promoted()` — one line, and this test is what makes its absence loud. |
| `protocol/src/alpn.rs::there_is_exactly_one_alpn` | `ADVERTISED.len() == 1`. |
| `vault/src/intents.rs::declared_bytes_are_hashed_and_their_order_is_not` + `a_changed_size_or_media_type_is_a_different_payload` | The declaration is inside the preimage and its ORDER is not — both halves, because one without the other is either forgeable or refuses every intent two devices list differently. |
| `core/src/intent.rs::needed_bytes_refuses_an_intent_whose_payload_hash_does_not_match` | A declaration nobody verified is a list of fetches an attacker chose. Also asserts the inverse: dropping the declaration invalidates the hash. |
| `vault/tests/media_commands.rs` (updated) | Reads the minted bytes back through the vault's OWN door and asserts `content_location` returns a file that reads identically. Opening a second store beside the file — which this assertion used to do — is the arrangement this slice deleted. |

### What I found

- **`SeatLink::sync` planned the byte pass over the rows it STARTED with.** The
  want list was read at the top of the pass, before a page was applied, while
  the comment two paragraphs below said rows come before bytes *because a row is
  what tells this seat a blob exists at all*. So a photograph whose row arrived
  in this window was invisible to the plan and waited for the next one — a whole
  window's latency per new cell, which on a phone is a grid of "not on this
  device yet" until the OS hands out another thirty seconds. Found by
  `bytes_upward.rs`, which is the first test where a row and its bytes arrive in
  the same pass; every earlier byte test seeded the store before the row
  existed. Fixed, and recorded as D-1025-S3-8.
- **`needs_blobs` had a column, a field, a JSON key and two ends missing.**
  `IntentRecord.needs_blobs` and `seat_outbox.needs_blobs_json` have existed
  since #1020 with no producer and no consumer, and `ByteStore` had a `forget`
  and no sweep at all — so R25 ("bytes a queued intent needs are not evictable")
  had nothing it could be true of. The shape was there and the behaviour was
  not, which is the same class of thing S2 found in `Outbox::overlaid()`.
- **The blocking bridge cannot use `Handle::block_on`.** `Vault::execute` is
  reached from a gateway's `spawn_blocking`, from a CLI with no runtime at all,
  and from the C ABI. `Handle::block_on` panics when the caller happens to be on
  a runtime worker and `block_in_place` needs a multi-threaded runtime a Swift
  shell does not have — and which of those a caller is in is not something the
  door can know. Each call therefore runs on a thread of its own, where there is
  no runtime context to conflict with. The cost is a thread spawn per verb; the
  alternative is a panic that depends on which platform you are, which is the
  kind of defect that only appears where you cannot debug it.
- **`crates/blobs` depends on `crates/vault`, and the direction was a choice.**
  The door has to see both the trait and the store. Putting it in `crates/vault`
  would give the host-agnostic vault an iroh dependency; putting it in
  `crates/core` would leave `crates/vault`'s own fixtures unable to open a real
  content store. So it is in `crates/blobs`, and `crates/vault` dev-depends on
  `crates/blobs` — a dev-dependency cycle, which cargo allows, and which means
  the vault's tests attach **the real store** rather than a stand-in. A fixture
  attaching a second kind of store would be testing an arrangement no device
  has, which is exactly how the flat CAS went a year with no other reader.
- **The two-ALPN argument was wrong in one clause and the rest of it was
  right.** S2's reasoning — "collapsing them would put every unenrolled peer on
  the plane whose premise is that everybody on it is enrolled" — describes what
  happens if the check is DELETED, not what happens if its answer becomes a
  state. The lookup is still one lookup, in the same function, before any
  stream, for the connection's whole life. What it cost to keep the label was a
  second admission site and a reconnect between the only two things a phone does
  on its first day.

### Where I went past the brief, and why

- **`--print-qr` takes a count.** A ticket is one-shot by design, so a gateway
  that mints one at startup can enrol exactly one device per run — and "a
  photograph reaches a SECOND seat" needs two. `--print-qr` with no value is
  still one, which is every existing invocation. It is a product fact before it
  is a test fact: a member with a phone and a tablet needs two codes.
- **`pre_staged_or_owned` and `promote_staged_blob` learned a third source.**
  A gateway that pulled a seat's blob holds the bytes and has no `blob_staging`
  row, because that band's producer is the upload door and a pull is not an
  upload. Rather than fake an upload, the precondition asks the store the honest
  question and the promotion mints from it. `Vault::stage_bytes` still writes
  the staging row, for the one thing the store cannot answer: the media type.

### What I left, and why

Nothing in the brief. Three things adjacent to it, named so they are not
rediscovered:

- **No product path mints an intent on a seat yet.** `needs_blobs` is written by
  whoever builds the `IntentRecord`, and today that is a test or a shell. S5
  owns `shared/` and the gesture that takes a photograph; what S3 owes it — the
  declaration, the wire field, the pin, the pull and the staging — is complete
  and is exercised end to end by `bytes_upward.rs`.
- **`blob_staging` still has no upload-door producer.** S3 is the first writer
  of that band in v1 and it writes it for exactly one case. The HTTP upload door
  and the extension's capture hand-off (`native_host/stage.rs`'s closing note)
  are still unimplemented, and S4's hash sweep touches the same column.
- **The seat's cache budget is a constant.** 256 MiB, v0's
  `OFFLINE_CONTENT_BUDGET_BYTES`, in `crates/seat-link`. How much of a device's
  disk a vault may use is a custody question and not a window question, so it is
  deliberately not a `SyncWindow` field — but it is also not yet anything a
  member can see or change, which is the storage screen's half and S5's.

### Commands

| Command | Result |
| --- | --- |
| `cargo fmt --all` | clean |
| `cargo clippy --workspace --all-targets` | no new warnings (three pre-existing in `bin/seed-demo-vault.rs`) |
| `cargo check --workspace --all-targets` | clean |
| `cargo test -p centraid-blobs` | 12 + 2 + 2 passed (`eviction.rs` new) |
| `cargo test -p centraid-vault` | 274 passed, **1 pre-existing failure** (`backup::restore::tests::a_live_gateways_data_directory_is_refused_and_a_stale_lock_is_taken_over`); integration 17/3/6/15/9/14/4/18/16/23/13/29/6/25/3 passed, **1 pre-existing failure** in `disk_full` (`a_full_disk_during_a_snapshot_build_leaves_no_partial_artifact` opens `/dev/full`, which macOS does not have) |
| `cargo test -p centraid-protocol` | 34 + 2 + 4 passed; `contracts/protocol/framing-golden.json` regenerated with `CENTRAID_UPDATE_FIXTURES=1` — the ALPN block is one entry now, `plane`, where it was `seat` and `pair` |
| `cargo test -p centraid-net` | all passed |
| `cargo test -p centraid-seat` | 136 + 3 + 10 + 8 passed |
| `cargo test -p centraid-core` | 63 + 2 + 1 passed |
| `cargo test -p centraid-core-ffi` | 8 + 11 + 7 + 2 passed |
| `cargo test -p centraid-seat-link` | 7 passed |
| `cargo test -p centraid-apps-kit` | 68 + 6 passed |
| `cargo test -p centraid-sim` | all passed |
| `cargo test -p centraid --tests` | `byte_lane` 1, `bytes_upward` 2, `mcp_stdio` 2, `native_host` 6, `no_listener` 9, `restore_drill` 3, `seat_bootstrap` 2, `seat_lane` 2, `seat_offline` 5, `seat_socket` 7 — all passed. **`gateway_install` 1 failed and `bin` 1 failed, both pre-existing**: `--system` is systemd and this host is macOS. |
| `cargo test --workspace --no-fail-fast` | Eight failing targets, **all eight pre-existing and none of them this slice's**. Verified by stashing the whole working tree and re-running: `centraid-apps-locker` (lib + parity), `centraid-apps-photos` (parity) and `centraid-media` (lib) fail identically on the S1+S2 tree, reading v0 oracle files under `packages/` that the `claude/1020-retire-v0` merge removed (`No such file or directory`). The other four are the host ones above plus `vault`'s restore-lock and `/dev/full` tests. |

No test ran longer than 6 seconds.

## S4 — One hash

One hash. BLAKE3 for naming, keyed MACs and key derivation wherever the function
is Centraid's own; Argon2id for the passphrase, because stretching a secret is
the one job a fast hash must not do. SHA-256 remains only inside dependencies and
external protocols this repository does not define.

### What was wrong, stated plainly

**This repository ran two hash functions and nothing said which was which.**

[D-1020-B2](../docs/decisions.md#wave-a--home-the-graded-springboard-1020) ruled
the BYTE PLANE onto BLAKE3 — correctly, for reasons that are still the reasons —
and stopped there. Everything else stayed SHA-256: the intent payload hash, the
audit chain, the ontology snapshot digest, an automation's row-dedupe hash, a
webhook secret at rest, a link ticket's secret at rest, a DEK fingerprint, the
backup artefact digest, the model lock's pins, and a staged capture's handle.
Ten sites, one plane apart, with no line drawn anywhere between them.

The cost was not theoretical, and the shape of it is worth stating because it is
the shape every "two answers to one question" defect has:

**`crates/centraid/src/cmd/native_host/stage.rs` computed SHA-256 over a
captured document and answered it as the handle.** Above it, a comment said *the
whole point of answering with a handle is that the handle IS the bytes*. The
handle went to `core.add_document`'s `staged_sha`, whose column
`core_content_item.sha256` is **UNIQUE and holds BLAKE3**. So the Companion's
capture path named a document with a value the vault could never dedupe on, and
nothing was red: the door had tests, the column had a CHECK, the CHECK passes
over either function because both render as 64 lowercase hex, and the two halves
had no test that ran through both.

Three more of the same class were found by sweeping rather than by reading:

- **`crates/apps/kit` carried a hand-rolled fifty-line FIPS 180-4 SHA-256** so
  the kit would depend on no hashing crate — a second implementation of the
  vault's dedupe key, kept honest by exactly one cross-crate test.
- **`MediaLibrary.Asset.sha256` on mobile was documented as "THE identity"** and
  computed with `MessageDigest`. Neither `CryptoKit` nor `MessageDigest` offers
  BLAKE3, so the shell could not have computed the vault's identity even if it
  had wanted to; every asset it enrolled would have been filed under a hash
  nothing else uses.
- **The browser extension declared a `crypto.subtle.digest("SHA-256")` on
  `stage:begin`** and the host checked it. WebCrypto has no BLAKE3 either, so
  after this slice that declaration would have refused *every* capture.

And thirteen columns were named `sha256`, `segment_sha256` or `expected_sha256`:
a column named after a function it does not use is a comment that lies and
cannot be linted.

### What changed

| Where | What |
| --- | --- |
| `Cargo.toml` | `hkdf`, `hmac` and `pbkdf2` deleted from the workspace; `argon2` added; `sha2` kept with a comment naming the one crate allowed to take it. |
| `crates/media/src/format.rs` | `sha256_hex` → `content_hash_hex` (BLAKE3); `hkdf_bytes` → `derive_bytes` (`blake3::derive_key`). |
| `crates/media/src/cbsf.rs` | the body digest and the two-stage frame-nonce MAC → `blake3`; `Algorithm` and `seal_object` added — the SEAL half of the compression this port only ever opened, because the golden's compressed vectors had no producer left. |
| `crates/media/src/models.rs` | `LockFile.sha256` → `hash`, BLAKE3; the v0-oracle test deleted with its reason. |
| `crates/vault/src/backup/store.rs` | `digest` is `content_hash_hex` — the SAME function as `content::content_digest`. |
| `crates/vault/src/backup/keyring.rs` | `derive_bytes`; `chunk_id` is `blake3::keyed_hash` and now REFUSES a key that is not 32 bytes. |
| `crates/vault/src/custody/{member_key,seal}.rs` | the envelope KDF's salt folded into the context; the DEK fingerprint says `blake3:`. |
| `crates/vault/src/{intents,audit,clock}.rs` | payload hash, receipt chain and the seeded-id generator → BLAKE3. |
| `crates/vault/src/content.rs` | `content_digest` unchanged in value, and its doc no longer claims the backup plane is a different function. |
| `crates/ontology/src/snapshot.rs` | `digest_values` → BLAKE3, which moved **every digest in both golden manifests**. |
| `crates/net/src/allowlist.rs` | the ticket secret at rest. |
| `crates/automations/src/{webhook,fire/condition}.rs` | the webhook secret hash and the row-dedupe hash. There is **no external signature check in this crate** — `hash_secret` verifies a secret the MEMBER was shown once — so `sha2` leaves it entirely. |
| `crates/seat/src/locker/{unlock,session}.rs` | **Argon2id**, m = 64 MiB, t = 3, p = 1. `WrappedKey` carries all three costs and the unwrap FLOORS them; the `pbkdf2-sha256` tag is refused like any other unknown one. |
| `crates/apps/kit/src/fixtures.rs` | the hand-rolled SHA-256 deleted for a `blake3` dependency. |
| `crates/centraid/src/cmd/native_host/` | the stage door hashes with `centraid_vault::content::content_digest` and **the sender declares no digest at all**. |
| `crates/core/src/stage.rs` (new) | `StageRequest` begin/chunk/end — the shell streams bytes in, the core names them, and `already_held` says whether this device had them. |
| `crates/api-proto/.../content.proto`, `envelope.proto` | `StageRequest`/`StageResponse` and `Request.stage = 13`. |
| `mobile/shared/.../PlatformServices.kt` (+ android, + its spec) | `MediaLibrary.Asset.sha256` and `sha256Of` deleted. |
| `extension/src/{stage-core,worker}.ts` | `sha256Hex` deleted; the worker uses the handle the host answers. |
| `desktop/renderer/src/apps/tally/fold.ts` | reads `content_hash` off the socket catalogue. |
| `contracts/schema/vault-ddl.sql`, `contracts/migrations/001_baseline.sql`, both `vault.db.gz`, both `manifest.json` | the column rename, carried through the corpora and regenerated. |
| `crates/ontology/src/bin/export-golden-manifest.rs` (new), `crates/xtask/src/photos_sample.rs` (new) | the two generators the v0 retirement deleted, written back. |

### The seven rulings

`D-1025-S4-1`…`-7` in [docs/decisions.md](../docs/decisions.md#slice-s4--one-hash-1025).

- **D-1020-B2 is superseded IN FULL.** Its reasoning — bao, incremental
  verification, the hash's name inside the value — is why BLAKE3 won and is
  carried forward whole. What is superseded is its **scope** (it ruled on one
  plane and left nine sites behind) and its **column clause** ("the column's
  shape does not move, its name stays `sha256`").
- **D-1020-R1's artefact-identity clause is superseded.** "Changing an
  artefact's identity is a re-keying event and not housekeeping" was protecting
  a released predecessor that does not exist. v0 backup artefacts are not
  restorable by v1 — v0-no-legacy — so the re-keying event has no key to
  re-key. It is spent once, here, with every golden regenerated through a
  generator rather than edited.
- D-1020-R1's other half — that the formats were MOVED rather than
  re-implemented, so no constant drifted silently — stands and is what made this
  slice safe to do at all.

### What the tests prove

| Test | What it proves |
| --- | --- |
| `vault/tests/one_hash.rs::every_writer_of_a_hash_column_is_declared_with_where_its_value_comes_from` | A mechanical scan: every `.rs` file under `crates/` whose SQL literal is an `INSERT`/`UPDATE` naming a hash column is on a declared list **with the source of its value written down**. A new writer is red until somebody says where its hash comes from — and a stale entry is red too, so the list cannot become a place to park a reason for nothing. |
| `…::a_writer_computes_no_hash_but_the_one` | The half that would have caught the stage door: no declared writer may name `Sha256`, `Sha512`, `Sha1`, `Md5` or `Hmac<`. And a writer that calls `blake3` directly instead of `content_digest` has to SAY so in its declaration — two do, and both are crates that cannot depend on `crates/vault`. |
| `…::sha256_appears_only_where_an_allowlist_says_why` | `sha256`/`SHA-256`/`SHA256` under `crates/` matches only `xtask/src/{artifact,ci,smoke}.rs`, each with its reason, or a line that CITES `#1025 S4` — a citation a reader can follow, not a silencer. |
| `…::every_allowlisted_file_still_needs_its_exemption` | The inverse: an allowlist entry for a file that stopped needing one is an exemption nobody is looking at. |
| `media/tests/primitives.rs::the_committed_vectors_are_what_this_build_computes` | `contracts/crypto/blake3-vectors.json` pins `derive_key` and `keyed_hash` as BYTES for every real context string — the backup data and dedup keys, the member-key envelope with a vault id folded in, a WAL nonce, the two-stage CBSF frame MAC, the empty message, and one input past BLAKE3's 1 KiB chunk. A round trip cannot see a changed derivation; these can. |
| `…::one_key_and_two_contexts_are_two_independent_keys` | `derive_data_key` and `derive_dedup_key` differ only by context. A KDF that ignored the context would make every chunk id computable from the key that opens the chunk. |
| `seat/src/locker/unlock.rs::a_wrap_round_trips_and_a_wrong_passphrase_is_one_answer` | Argon2id end to end, and the blob names `argon2id` with all three costs. |
| `…::a_rewritten_blob_cannot_make_the_derivation_free` | Every parameter is floored, not just `iterations`: `memory_kib: 8`, `iterations: 0` and `parallelism: 64` are each refused. And **`pbkdf2-sha256` is refused like `md5`** — v0-no-legacy, no dual read. |
| `core/src/stage.rs::a_streamed_original_is_named_by_the_vaults_own_digest` | 3 MiB in six frames, and the handle is `content_digest` over exactly what arrived. Plus the three refusals: overrun at the chunk, a transposed frame named by number, a short close that consumes the session. |
| `centraid/…/stage.rs::the_handle_is_the_hosts_own_digest_and_the_session_is_consumed` | The same property at the native-messaging door, which is where the original defect was. |
| `vault/src/commands/core.rs::the_content_digest_is_the_backup_digest` | **This test used to assert the opposite**, and the assertion was the point: while the two were different, the day they collapsed was the day an artefact's identity silently changed. S4 collapsed them deliberately, so what needs guarding is the inverse, and this is the test that says there is one hash. |
| `vault/src/backup/keyring.rs::the_data_and_dedup_keys_are_different_and_vault_scoped` | Extended: a dedup key BLAKE3 cannot take is refused rather than padded. |
| `media/tests/golden.rs::the_committed_golden_is_what_this_build_seals` | `contracts/golden/format-golden.json` regenerates from its own inputs and diffs — the first time in v1 that anything could produce it. |
| `…::every_compression_algorithm_round_trips_through_the_golden` | Now asserts the SEAL half too, which only exists because the golden needed a producer. |
| `mobile/…/SyncSchedulerSpec.kt` | `MediaLibrary.Asset` has no field whose name contains `sha` or `hash` — asserted reflectively, so re-adding one is red rather than a review catch. |

### What I found

- **The stage door's second hash is the whole slice in one file.** Everything
  about it was correct except which function it called, and no test anywhere ran
  a capture through the door and then into the column. The sweep in `one_hash.rs`
  is written the way it is because reading found it only after grepping for the
  function name — which is exactly the check, so it is a test now.
- **`crates/apps/kit`'s SHA-256 was load-bearing for a reason that had expired.**
  It existed so the kit would depend on no hashing crate; the one test holding it
  honest compared it against `crates/media`. A second implementation of a format
  decision is strictly worse than a dependency, and after the move there is no
  reference implementation of BLAKE3 worth hand-rolling anyway.
- **Three shells could not have computed the vault's identity.** `crypto.subtle`,
  `CryptoKit` and `MessageDigest` all stop at SHA-2. So "the shell declares a
  digest" was never a design that could hold once the vault's hash was BLAKE3 —
  which makes D-1025-S4-6 a correction rather than a preference, and is why the
  field is DELETED rather than renamed.
- **The golden manifests and the Photos sample had no generators.** Both were
  written by v0 tooling the retirement deleted, so they were fixtures nobody
  could reproduce — which is the same thing as fixtures nobody may change, and
  S4 had to change every digest in both. Two generators were written:
  `cargo run -p centraid-ontology --bin export-golden-manifest` and
  `cargo xtask photos-sample`. The second enforces a rule rather than dumping a
  file — *a sample-backed content row is named by the hash of the file it is*,
  matched by declared `byte_size` — and is idempotent, which is what makes it a
  generator and not a migration script.
- **`contracts/apps/photos/rows.json` carried nineteen `blob:sha256-` URIs**, a
  form `crates/blobs` stopped being able to parse when #1025 S3 made
  `blob:blake3-` the only one. So the fixture had been holding values the code
  would have refused, and nothing read them closely enough to notice.
- **The inline video frame's bytes existed nowhere in the repository.** The
  Photos manifest listed a 24-byte `tahoe-pan.mp4` by its SHA-256, and the bytes
  lived in v0's deleted `seed.js`. A digest whose preimage nobody holds cannot be
  re-keyed, so the payload was recovered from git history and is now
  `INLINE_VIDEO_BASE64` in the generator — the frame is checkable again.
- **The `crates/apps/*` parity bundles are evidence, not output.** Their
  `regenerate` commands named `contracts/tools/export-*-parity.ts`, which the v0
  retirement deleted, and two tests asserted those files were committed. That
  assertion is not weaker now, it is FALSE — so the manifests say `frozen` with
  the reason, and the tests assert that they say so, because a bundle silently
  treated as regenerable is one somebody will "regenerate" by hand.

### The four tests that read v0 oracles, and what became of each

S3 left these. All of them compared this port against files
`chore(retire): delete the v0 tree` removed, and none could be made honest.
**Reviving the v0 files under `contracts/` was considered and rejected**: it is
re-importing the tree that retirement deliberately deleted, and a frozen copy of
a deleted source file proves the copy rather than the port.
`contracts/apps/*/rows.json` is a different thing and stays — it is DATA a v1
test builds a vault from, not v0 SOURCE a v1 test greps.

| Test | What became of it |
| --- | --- |
| `media::models::the_committed_v0_manifest_parses_and_names_its_capabilities` | **Deleted.** v1 ships no lock file, so there is nothing under `contracts/` to promote it to. What it asserted about SHAPE is covered by the two refusal tests beside it. |
| `apps-locker::online_only_is_exactly_v0s_five` | **The v0 half deleted**; the list is still asserted against this port's own declaration, which is what every behaviour test below it exercises. Renamed `online_only_is_exactly_the_five`. |
| `apps-locker::the_manifest_differs_from_v0_by_exactly_the_two_dead_fields` | **Replaced** by `the_permit_era_parameter_is_gone_and_locker_is_on_every_seat`, which asserts D-1020-L7's two rulings as properties of the one manifest there is. |
| `apps-locker::the_promoted_spec_is_byte_identical_to_the_extensions` | **Deleted.** There is one copy now; a test that asserts a file equals itself is not a weaker version of the old one. |
| `apps-locker::{every_shelf_declares_the_order_v0_declares, only_the_live_shelf_carries_the_connector_alias_in_v0, the_candidate_list_reports_a_one_time_code_without_carrying_one}` | **The v0-source halves deleted, the claims re-asserted against this port's own statements** — which is stronger, because it is what a member's device runs. The open owner question about the alias asymmetry is unchanged. |
| `apps-locker::locker_has_no_demo_seed_and_the_manifest_says_so` | **Deleted**; it walked `packages/blueprints/apps/*` looking for `seed.js`. |
| `apps-photos::the_contracts_sample_directory_is_the_v0_roll` | **Deleted**, and replaced by something stronger: `cargo xtask photos-sample` regenerates the manifest FROM the files, so a drift is a regeneration diff rather than a lost oracle. |
| `apps-{locker,photos}::the_bundle_is_v0s_own_answers_and_says_how_many` | **Kept**, with the generator assertions replaced by a `frozen` declaration in each manifest. The floors — case counts — are untouched, which is the half that stops a bundle passing by comparing nothing. |

### Where I went past the brief, and why

- **`crates/media::models`' lock pins moved to BLAKE3**, and the brief's
  inventory did not name them. They are a format Centraid defines, checked by
  Centraid's code against a file on a Centraid host — ours, not the model host's
  — so the law applies. The cost is stated in the code: an author can no longer
  copy a SHA-256 off a model host's file listing.
- **The extension and the desktop renderer were touched.** Both are outside this
  slice's stated scope, and both would have been BROKEN by it: the extension's
  declared SHA-256 would have refused every capture at the host, and the
  renderer reads `sha256` off a socket catalogue this slice regenerated. Leaving
  a door that cannot open is not deferring work to S5.
- **`cbsf::seal_object` and `Algorithm` are new product API.** The golden's
  compressed vectors were sealed by v0's Node tool and only opened by the port,
  so regenerating them needed the seal half of a format this crate already
  implements half of. It is a completion, not a fixture helper.
- **Both golden corpora were RE-FROZEN.** `ALTER TABLE … RENAME COLUMN` on
  `contracts/golden/{issue-1020,issue-929}/vault.db.gz`, SQLite rewriting the
  dependent views, indexes, triggers and FK references itself, plus six
  `trg_replica_*` triggers in the #929 corpus whose `json_object('sha256', …)`
  keys are the row's own column names. The DDL and the baseline migration are
  GENERATED from the 1020 corpus, so there was no other place to make the rename
  true. Recorded as D-1025-S4-7.

### What I left, and why

Nothing in the brief. Four things adjacent to it, named so they are not
rediscovered:

- **`contracts/desktop/fixtures/{arriving.json,make-video.mjs}` keep SHA-256.**
  A Node e2e harness checking a webm it just generated against the manifest it
  wrote beside it. Node has no BLAKE3, nothing in a vault is named by the value,
  and adding an npm hash dependency to satisfy a rule about vault content would
  be the inverse of the rule. Documented in place and in
  `contracts/desktop/README.md`.
- **`packages/design/src/elements/{sha256,attachments}.ts` keep theirs.** That is
  the surviving v0 TypeScript package and its `StagedBlob.sha256` is not wired to
  any v1 door. It is S5's, with the rest of the shell.
- **`contracts/apps/locker/manifest.json`'s `canonicalisation` note still says
  "sha256 over the bootstrap's data key".** It is a correct historical statement
  about how a now-FROZEN bundle was produced by a tool that no longer exists.
  Rewriting it would make the note false about the file it describes.
- **The generated JSON under `contracts/` has not been through `bun run format`.**
  `node_modules` is not installed in this working tree, so the formatter could
  not run. Every generator in this repository already says "run `bun run format`
  and commit it" for exactly this reason; the files are generator-shaped and need
  that pass before the PR.

### Commands

| Command | Result |
| --- | --- |
| `cargo fmt --all` | clean |
| `cargo clippy --workspace --all-targets` | **no new warnings** — the only three are the pre-existing ones in `bin/seed-demo-vault.rs` (one `too_many_arguments`, two `type_complexity`) |
| `cargo check --workspace --all-targets` | clean |
| `sqlite3` `ALTER TABLE … RENAME COLUMN` ×13 on both corpora, then `gzip -9 -n` | `PRAGMA integrity_check` ok on both; `user_version` 11 and 7 preserved |
| `cargo run -p centraid-ontology --bin export-golden-manifest -- contracts/golden/issue-{1020,929}` | both manifests regenerated (every digest moved: `digest_values` is BLAKE3) |
| `cargo run -p centraid-ontology --bin export-ddl -- contracts/golden/issue-1020/vault.db.gz` | `contracts/schema/vault-ddl.sql`, 20 `content_hash`, 0 `sha256` |
| `cargo run -p centraid-vault --bin export-baseline -- contracts/golden/issue-1020/vault.db.gz` | `contracts/migrations/001_baseline.sql`, same |
| `cargo run -p xtask -- photos-sample` | manifest + rows regenerated; **run twice, second run changed nothing** |
| `centraid seat --print-catalogue > contracts/desktop/socket-catalogue.json` | regenerated |
| `CENTRAID_UPDATE_FIXTURES=1 cargo test -p centraid-media --test golden` | `contracts/golden/format-golden.json` regenerated, then green without the variable |
| `CENTRAID_UPDATE_FIXTURES=1 cargo test -p centraid-media --test primitives` | `contracts/crypto/blake3-vectors.json` written, then green without it |
| `CENTRAID_UPDATE_FIXTURES=1 cargo test -p centraid-vault --lib backup::kit` | `contracts/custody/recovery-kit.json` re-sealed, then 11 passed |
| `cargo test -p centraid-vault --test one_hash` | 4 passed |
| `cargo test -p centraid-media` | 31 + 5 + 2 passed |
| `cargo test -p centraid-vault` | 274 passed, **1 pre-existing failure** (`backup::restore::tests::a_live_gateways_data_directory_is_refused_and_a_stale_lock_is_taken_over`); integration all passed except the pre-existing `disk_full` `/dev/full` test |
| `cargo test -p centraid-seat -p centraid-core -p centraid-net -p centraid-ontology -p centraid-automations -p centraid-blobs -p centraid-apps-kit` | all passed |
| `cargo test -p centraid-apps-locker -p centraid-apps-photos` | all passed — **the four v0-oracle targets S3 recorded are green**, by the table above rather than by being skipped |
| `cargo test -p centraid --tests` | all passed |
| `cargo test --workspace --no-fail-fast` | **green except the four pre-existing failures**: the two `gateway_install` `--system` systemd tests on macOS, `vault`'s restore-lock test, and `vault`'s `/dev/full` test |

No test ran longer than 13 seconds.

## S5 — The shell's half

A phone pairs with a gateway, bootstraps a replica it did not have, and shows
what arrives — with no relaunch and no gesture. One shell over many apps, one
consumer of the change stream, the OS's own deadline, and credentials that
survive a launch.

### What was wrong, stated plainly

**A phone could not get a vault, and if it had one it could not be told a row
had changed.** Four things, and three of them were invisible from inside their
own half:

1. **Nothing read the change stream.** Every piece of the path existed and no
   two of them were joined. `crates/core`'s event queue coalesces, stalls and
   never drops, with nine tests over it, and **nothing had ever pushed into
   it**. `CentraidCore.startReader` runs the `next_event` loop and publishes a
   flow, and **nothing in `mobile/shared` called it**.
   `TallyListEvent.RowsChanged` has existed since #1020 and `TallyListMachine`
   already reduces it correctly — re-read the first page, because a patched row
   in the wrong position is a list that disagrees with its own sort — and **no
   producer ever sent one**. This is the same shape S2 found in
   `Outbox::overlaid()` and S3 found in `needs_blobs`, three times in one
   umbrella.
2. **The shell opened whatever had been PLACED in its container, as a
   `GATEWAY`.** `mobile/scripts/demo-vault.sh` copied a gateway-role artifact
   in — every private table, and the device's own authority over rows it was
   supposed to be a copy of — and `HomeSession` said `CoreRole.GATEWAY`
   honestly, because there was no other path. S1 built the real one two slices
   ago and no shell used it.
3. **`MountKey(gatewayId, vaultId)`** named `"$gatewayId.$vaultId.replica.db"`,
   which D-1025-S1-1 had deleted from the core. The shell was the last place in
   the product where one vault reached through two addresses would be two files,
   each with its own cursor and its own outbox.
4. **`LifecycleState.BUDGET_MS = 20_000`**, a constant standing in for a number
   only the OS knows — and one that discarded a third of Apple's window as
   "teardown headroom" the expiration handler already provides for free.

### What changed

| Where | What |
| --- | --- |
| `mobile/shared/.../shared/` | Re-laid out: `shell/` (Home, springboard, band, first moves, roster, gateway link, mount, replicas, endpoint keys), `screen/` (the CONTRACT and nothing else), `apps/{tally,photos,notes}/`, `nav/`, `sync/`, `platform/`. |
| `…/jvmTest/PerAppLayoutSpec.kt` (new) | The two Konsist rules, plus a third that holds `screen` to the contract's two files. |
| `…/shell/Mount.kt` | `MountKey(vaultId)`; `fileName` is `"$vaultId.replica.db"`; `Waiting.Reason.RESOLVING_ENDPOINT` → `BOOTSTRAPPING`. No `gatewayId` anywhere in `mobile/`. |
| `…/shell/Replicas.kt` (new) | The directory is the roster. `pairing.replica.db` before there is a vault id, and `settle` re-files it — with its byte store and SQLite's sidecars — the moment the gateway names one. |
| `…/shell/EndpointKeys.kt` (new) | 32 bytes from the platform CSPRNG, per vault, in the secure store; settled alongside the replica. |
| `…/shell/HomeSession.kt` | Opens `SEAT_REPLICATED` at a replica path that may not exist; `pair` settles; `attach` starts the runtime AND the change stream; `syncNow(wake)` carries a `SyncWindow`. |
| `…/sync/ChangeStream.kt` (new) | The one consumer. Routing is the machine's decision. |
| `…/screen/ScreenMachine.kt` | `rowsChanged(table, keys, commitSeq): E?` — one declaration, not a `tables` set beside a translator. |
| `…/sync/Lifecycle.kt`, `SyncWindowPolicy.kt` (new) | `BUDGET_MS` deleted; the deadline and the budget selector come from the platform and the radio. |
| `…/platform/PlatformServices.{kt,ios,android,jvm}` | `IosSecureStore` over the Keychain, `IosNetworkStatus` over `NWPathMonitor`, `AndroidSecureStore` over EncryptedSharedPreferences, a `SecureRandom` seam, `BackgroundTasks.window(wake)` and the expiration seam. |
| `crates/core`, `crates/seat`, `crates/blobs`, `crates/seat-link`, `crates/core-ffi` | The change-event producer; `SyncWindow.budget`/`.metered` and `Budget.originals`; `endpointSecretKey` at the FFI door; `Vault::apply_replica`. |
| `mobile/iosApp/Sources/ShellModel.swift` | Opens a replica DIRECTORY; names its wake. |

### The six rulings

`D-1025-S5-1`…`-6` in [docs/decisions.md](../docs/decisions.md#slice-s5--the-shells-half-1025).

### What the tests prove

| Test | What it proves |
| --- | --- |
| `mobile/…/ChangeStreamSpec.kt` (8) | **A row that arrives from sync moves the screen, with no relaunch and no gesture.** A list holding `exp-1` is handed a `ChangeEvent{tally_expense, [exp-1]}` and asks for its page again — not "the state changed", because the state cannot change until rows are read and the re-read IS the deliverable. Plus the half that makes a first sync survivable: a row the list is NOT showing moves nothing, because a tailing pass applies thousands of rows and a page read per row is what makes a first sync unusable. Plus: a table a screen does not read is not that screen's event, asserted on the MACHINE; every table Home counts is a table Home redraws on, derived from `HomeReads.READS` so a tile whose query moves cannot silently stop refreshing; **a change from the gateway never takes a member's typing** — a dirty editor ignores it and a clean one re-reads, which is the sharp case and why the decision is in the reducer; a grid re-reads its first page rather than patching a cell whose position in a capture-time sort may have moved; one change reaches every screen that cares and no others; and a stall is a state the shell can render, with `behind` as a distance in log positions rather than a time. |
| `mobile/…/ReplicasSpec.kt` (5) | **A replica and its byte store move together**, with the store's name spelled the way `crates/seat-link` spells it — the last extension REPLACED, not appended. This is the simulator defect, pinned: the first draft appended, the settled replica opened a fresh empty store beside itself, every bootstrapped photograph was orphaned, and **nothing failed** — a library of rows pointing at nothing renders as placeholders. Plus: the roster is the directory and it is only replicas (a pairing file has no id to switch BY; a `-wal` is not a vault); a directory that does not exist is an empty roster rather than a throw, because that is the ordinary first run; and settling onto a vault this device already holds keeps the one it has, because the existing replica is carrying the member's unsent writes. |
| `mobile/…/PerAppLayoutSpec.kt` (3) | The two layout rules, plus the third that holds `screen` to exactly `ScreenMachine` and `ScreenHost` — a screen that moved back into the contract package is one the second rule can no longer say anything about. The layout assertion names the eight packages, so a flattening is red rather than a review catch. |
| `mobile/…/NavigationAndMountSpec.kt` (updated) | A replica is named by its vault and by nothing else, asserted twice: reflectively on `MountKey`, and **over the whole of `mobile/`'s source** for the identifier spellings `gatewayId`, `gatewayHex` and `gateway_id`. The second is the one that matters — losing the field is necessary and not sufficient, because the name could come back as a config parameter, a file name built in a shell, or a Swift property. |
| `mobile/…/SyncSchedulerSpec.kt` (fixed + extended) | S4's reflective "no digest crosses this seam" assertion **was red against its own interface** and had never been run: it forbade any member whose name contains `hash`, and `MediaLibrary.Asset.perceptualHash` is a deliberate duplicates HINT. The rule now names its two exemptions, asserts they still EXIST (an exemption for a member that has gone is one nobody is looking at), and adds `digest` to what it forbids. |
| `mobile/…/SecureStoreLawSpec.kt` (6) | The two `SecureStore` rules as mechanics rather than comments: an empty write DELETES rather than storing `""` (a credential the app wrongly believes it has), `clear()` leaves nothing readable and nothing enumerable, every key is namespaced under `PREFIX` — which is what makes `clear()` one scoped delete on both platforms rather than an enumeration. Falsified by loosening the fake: two go red. |
| `mobile/…/SyncWindowPolicySpec.kt` | Every wake/charging/metered combination lands on the budget it should; `platformRefused` spends like metered AND denies the night shift; the member's transfer preference overrides the radio; the deadline is the platform's number verbatim; and `budget_bytes`/`budget_items` stay absent, because the selector is the decision and `crates/blobs` owns the sizes. |
| `crates/centraid/tests/seat_bootstrap.rs` (new) | Against the shipped binary over real QUIC: a row applied by a pass comes out of `next_event` naming its key; and a seat reopened with the same endpoint key is still the device its gateway enrolled — with a third seat carrying no key getting a different identity, which is the defect reproduced rather than described. |
| `crates/blobs`, `crates/seat-link` | Each budget selector plans a different window; an explicit ceiling overrides the selector; and a metered window plans **no originals** — asserted on the PLAN and not on the flag, because a flag that reached no planner is what a ceiling-only design would have shipped. |

### What I found

- **The change-stream path was three complete halves and no joins.** This is the
  third time in one umbrella: S2 found `Outbox::overlaid()` with no consumer, S3
  found `needs_blobs` with no producer and no consumer, and S5 found a bounded
  event queue with no producer, a reader nobody started, and a `RowsChanged`
  event nobody sent. Each piece had tests and each set of tests passed. **A test
  of a reducer or of a queue cannot see this**; only a test that joins them can,
  which is what `ChangeStreamSpec` is and why it is written over
  `ChangeStream.deliver` rather than over either end.
- **Every apply through the core had always applied zero rows.** `Handle::sync_now`
  ran the pass inside `Vault::read`, which sets `PRAGMA query_only = ON`. The
  applier's error landed in `PassReport::stale`, `SyncOutcome` has no field for
  `stale` — so the answer was *reached the gateway, zero rows, no error*, on
  every window since S1. Invisible because every test that had ever seen a row
  arrive drove `SeatLink` over its own connection. The simulator said it out
  loud first (`rows=0` in the gateway's log after a successful bootstrap offer)
  and the change-event test failed on it.
- **The pairing record was never persisted, and `adopt` had one caller: a test.**
  `SeatLink::adopt`'s own doc says "Re-adopt a gateway the shell persisted.
  Pairing is one-shot; this is how a seat comes back after a restart without
  burning another ticket" — and no shell persisted one, because there was
  nowhere in the replica that held it. So the durable endpoint key S5 added was
  a durable identity for a seat that no longer knew what address to present it
  to. **Both halves are needed and neither is enough**, which is the same shape
  as the v0 lease defect S1's own header describes. Found by the simulator: pair
  succeeded, the bootstrap blob was served, and the very next "Sync now" made no
  connection at all.
- **The iOS Keychain never needed a cinterop, and nobody had checked.**
  `IosSecureStore` threw with a comment saying `Security.framework` needs "a
  cinterop of its own, which no machine here can build or verify".
  `platform.Security` ships as a DEFAULT Kotlin/Native platform library; the
  same compiler that was already compiling that file compiled `SecItemAdd` on
  the first attempt. The same paragraph, about `platform.Network`, was guarding
  `IosNetworkStatus` — which hard-coded `platformRefused = true`, and
  **`WriteGate` treats an unknown answer as not-reachable, so every write on iOS
  was refused, always.** One compile falsified two paragraphs that had stood a
  whole wave.
- **`AndroidSecureStore` was a cleartext XML file.** Its doc comment said
  "Keystore-wrapped"; the code was `getSharedPreferences(…, MODE_PRIVATE)`. It
  is the Android twin of the `NSUserDefaults` stand-in the iOS half loudly
  refused to write, except this one had shipped with a comment saying it had
  not. Now `EncryptedSharedPreferences` over a Keystore `MasterKey` — and
  **unverified**, because there is no Android SDK here and the file is on no
  compilation's source path.
- **S4's own reflective rule was red against its own interface.**
  `MediaLibrary.Asset` "has no field whose name contains `sha` or `hash`" — and
  `perceptualHash` is a deliberate duplicates hint. The assertion had never been
  run; S4's receipt lists it as proving something. It now names its two
  exemptions, asserts they still exist, and forbids `digest` as well.
- **The byte store's name is `with_extension("bytes")` and not `+ ".bytes"`.**
  The first draft of `Replicas.settle` appended. The settled replica opened a
  fresh empty store beside itself and every bootstrapped photograph was
  orphaned — **with nothing failing anywhere**, because a library of rows
  pointing at nothing renders as placeholders. Found by looking at the
  simulator's container after a run that had reported success.
- **The shell had invented a second spelling of the replica file name.**
  `centraid_seat::identity::database_name` says `centraid-replica-<vaultId>.sqlite3`
  and `MountKey` was going to say `<vaultId>.replica.db`. Two spellings of one
  name is the defect the mount rules are about, one level up. The Kotlin now
  uses the Rust's spelling verbatim and says where it comes from.
- **`seed-demo-vault` re-founds a vault it is pointed at, silently.**
  `vault.found(&vault_name, "Owner")` runs unconditionally on whatever file it
  opened, so pointing it at a gateway's own vault directory — the obvious place
  to point it, and what `--file` invites — replaces that vault's identity while
  the gateway is serving it. `replica_log`'s `MAX(seq)` went **backwards**,
  1101 → 146, and `core_party` 8 → 5. It cost two scenario runs: a seat
  bootstrapped, reported success, and drew the founding state while the
  gateway's file held a thousand commits, and every piece of the sync path
  looked broken when none of it was.
- **A gateway does not notice commits another process makes to its vault.**
  Discovered while chasing the above. It is not a defect — a gateway is the
  authority for its file — but it is a harness hazard worth writing down,
  because `crates/centraid/tests/seat_bootstrap.rs` DOES commit from a second
  connection and does see them tail, which makes the opposite look true. The
  difference is that the test's gateway is started after the commits it serves.
- **`WriteGate` has no caller in production.** A fourth complete half with no
  join, and the member-facing one: it decides send-now / enqueue / refuse, it
  has tests, and nothing calls it — because there was nothing to call it FROM.
  `Handle::submit_intent` refuses on a seat with "only the gateway runs intents;
  this core holds a copy", and `Request::Intent` is the only write verb on the
  five-symbol ABI. So **a seat's shell could not queue a write at all**, and
  everything downstream of the outbox — `IntentRecord`, `seat_outbox`,
  `pinned_blobs`, S2's live `IntentSink`, `Outbox::overlaid()`'s paint,
  `settle_at_commit_seq` — operated on a row nothing in the product ever wrote.
  S3's receipt half-said it ("`needs_blobs` is written by whoever builds the
  `IntentRecord`, and today that is a test or a shell") and there was no shell
  that could. Found by pressing Save on a device with the gateway stopped: the
  screen said "Saving" and stayed there, and `seat_outbox` held zero rows.
- **The notes editor rendered a note it could not change.** Both fields were
  bound to `.constant`, and `StateViews.titleEvent` re-asserted the title the
  machine already held — with a comment saying so plainly. The first wiring then
  produced the opposite defect: seeding the field from the draft fired
  `onChange`, so every note opened already claiming **"Unsaved changes"** before
  the member had touched it. An edit is a DIFFERENCE from the draft, not an
  assignment to the field; comparing against the draft is exact, and typing the
  original text back is correctly not an edit either.
- **Nothing in the iOS shell ever pushed a route.** `CentraidApp` declared
  `.navigationDestination` for all three screens and no tile, band tab or row
  appended to `shell.path`. Every screen but Home was reachable only by
  constructing it in a preview. Invisible because Home is the root, and Home is
  what every screenshot showed.

### The simulator scenario, step by step

iPhone 17 Pro (iOS 26.5), Xcode 26.6, against the shipped `centraid gateway`
over real QUIC on the LAN (`--no-relay`). Screenshots under
`receipts/screens/issue-1025-s5/`.

The gateway's vault is founded, stopped, seeded through the real command plane
(`seed-demo-vault`, which writes through `Vault::execute` and never SQL), and
restarted — the order matters, and finding out why cost two runs (see "What I
found": the seeder deletes what it seeds, and a gateway does not notice another
process's commits).

| # | Step | What I saw |
| --- | --- | --- |
| 1 | Launch, nothing placed on the device | **"No vault yet / not connected to a gateway"**, Home drawn, Locker's tile and the three first moves. The core opened UNPAIRED at `centraid-pairing.sqlite3`, its reads refused `Unpaired`, and nothing crashed. `01-first-run-no-vault.png` |
| 2 | Settings → Gateway → paste the ticket → Pair this device | **"Paired with Centraid."** Gateway: `a device paired and its connection was promoted in place device=dev_… label=iPhone 17 Pro` — ONE connection, promoted in place, which is D-1025-S3-6's whole point. |
| 3 | The pairing takes the first copy | Gateway: `a seat was offered the bootstrap blob vault=… seq=1101 bytes=839641`. On disk: `centraid-replica-<vaultId>.sqlite3` **and** `centraid-replica-<vaultId>.bytes` beside it, the pairing file gone, `seat_state.applied_seq = 1101` against a gateway log head of 1101, and `seat_gateway` holding the endpoint id. |
| 4 | Home renders from synced rows | Vault lockup **"Tahoe"**; Photos 19, Docs 3 with their real titles ("Renters insurance policy (sample)", "Cabin rental agreement (sample)", "Tahoe packing list"), Notes 5, Agenda 5, Tasks 11. Photos says **"These photographs are not on this device yet."** — honest: the rows arrived, the bytes have not. `02-home-from-synced-rows.png` |
| 5 | `simctl terminate`, relaunch, **no pairing code entered** | "Sync now" → **"Synced: 0 changes, 0 files"** — reached, not refused. Gateway logs the SAME `device=dev_7c74b2483af508a1` it enrolled a minute earlier. **This is the defect the slice exists to fix**, and it needed both halves: the endpoint key out of the Keychain, and the pairing record out of `seat_gateway`. `03-relaunch-still-paired.png` |
| 6 | Tap the Notes tile → the editor | The note opens and reads from the replica: "Scratch — books people keep recommending", state **"Saved"**. Two defects on the way here: nothing in the shell ever pushed a route, and the first wiring of the editor opened every note already claiming "Unsaved changes". |
- **Saving a note would have blanked it.** A note's body is not a column — it
  lives in the content item `body_content_id` names and is read through the byte
  door, which a seat's page read does not reach — so `NotesReads` answered a
  draft with `body = ""`. `knowledge.save_note` takes the WHOLE draft, so that
  empty string is an instruction to blank the note. Found by reading the input
  of the intent the device had just queued: `"body":""` over a note that has
  one. `NoteDraft` now carries `body_unavailable`, the reducer REFUSES the save
  with a sentence rather than sending it, and the member's words stay on the
  screen. The refusal is reversible and the destruction would not have been.
- **`SeatState` on iOS is real now, and it was the thing refusing every write.**
  Incidentally confirmed from the device log during this run:
  `nw_path_evaluator_start … path: satisfied … uses wifi` and
  `(Security) SecItemCopyMatching_ios` — `NWPathMonitor` and the Keychain are
  both genuinely running on the simulator, not stubs.
- **A pass could not say why it moved nothing, and that cost two debugging
  sessions in one slice.** `PassReport` carries `stale` (the applier refused) and
  `blocked` (the intent sink was unreachable); `SyncOutcome` carried neither, so
  the shell drew **"Synced: 0 changes, 0 files"** over a queued write whose
  attempt count was climbing, and a caught-up seat was indistinguishable from a
  blocked one. It is the same shape as the `query_only` defect — which hid for
  three slices behind that exact sentence — and it hid a second, different bug
  the same way. Both fields now cross on the `seat.sync` JSON, added BESIDE the
  existing keys so a positional reader does not break, and the iOS shell renders
  them. The very first pass after wiring it named the bug: *"That request does
  not make sense to this build, and nothing was changed."* — the gateway
  refusing the seat's intent as `INVALID_REQUEST`.
- **Nothing in the product ever sent a `SeatChanged`, so the write gate was a
  rubber stamp.** Every screen's event has the case, every machine reduces it,
  and no producer existed on either shell — so `SeatState` was null on every
  screen for its whole life. `WriteGate` reads the seat off the screen and a
  null seat is not reachable, which means **an `onlineOnly` write was refused on
  every device, always**, and an ordinary write queued with a healthy gateway in
  the same room. Tally's `recurring_materialisation_withheld` was true for ever
  for the same reason: a verb a member could never reach, under a sentence
  explaining an outage that was not happening. A gate handed a constant is not a
  gate. The session now composes the seat from the two things the shell honestly
  knows — the platform's connectivity answer and whether the pass it just ran
  reached the gateway — and `ChangeStream.publishSeat` fans it out, because it is
  ONE fact about the device: two screens disagreeing about whether this seat can
  reach its gateway is not a state the product has.
  `centraid.core.v1.ConnectivityEvent` would be the better source and **has no
  producer in `crates/core`**, so sourcing it there would be sourcing it from
  nothing; when it gains one, one function changes and no screen does.
- **`knowledge.save_note` is not a command.** `NotesEditorMachine.SAVE_COMMAND`
  named it; the registry has `create_note`, `edit_note`, `move_note`,
  `delete_note`, `restore_note` and the notebook verbs. `Vault::execute`
  answered `UnknownCommand`, `crates/core` mapped it to `INVALID_REQUEST`, and a
  member read *"That request does not make sense to this build"* **on every
  window for ever**, because the seat retried a write that could never succeed.
  Nothing caught it because nothing in the product had ever submitted a write:
  the machine's only exercise was a unit test asserting the effect it emitted,
  and an effect naming a command nobody runs looks exactly like one naming a
  command that exists. Two more errors were in the same input and would each
  have refused the write on their own — `body` where the schema says `body_text`,
  and `base_revision_id` sent as an input to a command whose schema is
  `additionalProperties: false`. `ShellCommandsExistSpec` is the gate; its first
  draft pointed at `contracts/apps/*/commands.json` and failed an honest caller,
  because those bundles are SCENARIOS and not the registry — an oracle that is a
  sample of the surface is worse than none.

---

## S7 — One loop, one file, one page, one report

**The gate is green.** `crates/centraid/tests/walking_skeleton.rs` passes all
eight steps against the shipped gateway binary over real QUIC, and it stayed
green through every item after the one that turned it. What is written below is
what is on the branch.

### The walking-skeleton test

`crates/centraid/tests/walking_skeleton.rs` (new). It lives in `crates/centraid`
and not in `crates/core-ffi` for one reason: it needs the shipped gateway
binary, and `CARGO_BIN_EXE_centraid` is only set for that package's tests.
`centraid-core-ffi` is a new dev-dependency there.

Every request is protobuf BYTES through `centraid_call` — the same five-symbol
door a Swift or Kotlin shell has — against `centraid gateway` over real QUIC.
The gateway's vault is seeded first by the shipped `seed-demo-vault` and the
gateway is started second, because a gateway does not notice another process's
commits and the seeder founds what it is pointed at (S5 paid two scenario runs
for that ordering).

| Step | What it is the only proof of | State |
| --- | --- | --- |
| 1 Unpaired | `centraid_open` on a path with no file answers a handle and creates nothing | green |
| 2 Pair | `Request::Pair` bytes redeem the ticket and **the pairing takes the first copy** | green |
| 3 Home-style read | `Request::Page` over `knowledge_note` answers the gateway's rows, compared row for row against the gateway's own file | green |
| 4 Offline write | gateway `SIGSTOP`ped, `Request::Intent` answers `QUEUED` with no commit seq | green |
| 5 The overlay | the member's own pending write is on the member's own screen | **RED — item 4** |
| 6 Settle | `SIGCONT`, one `seat.sync` with the shell's deadline; `blocked` and `stale` both null, the canonical row carries the edit, and the replica equals the gateway | green |
| 7 Live commit | a `knowledge.create_note` on the gateway reaches the seat on the next pass (`rowsApplied` 15) and `centraid_next_event` yields a `ChangeEvent` naming the table | green |
| 8 Bytes | 19 blobs, 651 587 bytes across the windows; no window refuses, withholds or puts transport words on a member's screen; `content_urls` answers paths that open | green |

`SIGSTOP` and not `kill`: a killed gateway refuses the connection at once, which
is the one offline shape a phone almost never has. A stopped one takes the
packets and answers nothing, which is a lift, a tunnel and a sleeping laptop.

### The two byte-plane defects it found, and what each was

Neither was the payload-hash mismatch S5's section theorised. That theory was
falsified before this test was written, by driving a realistic `knowledge.edit_note`
payload through `queue_write` → the outbox → `wire_intent`'s canonicalisation →
`centraid_core::intent`'s gate: the round trip is exact, and step 6 above proves
it against the real gateway. **The queued write settles.**

1. **The byte plane stopped for ever on the first blob a gateway would not
   serve.** `byte_pass` broke out of its fetch loop on every `Err`, under a
   comment saying one dead connection would otherwise make the rest each pay a
   timeout — true of a dead connection and false of everything else. The plan is
   ordered deterministically, so the same blob came first in the next window and
   the next: **one unservable row and no photograph ever arrives again**, under
   `blobsCompleted: 0` and a sentence promising the device would keep trying.
   The connection is now the test — a connection with a close reason is a window
   that is over, a live one is one blob that did not work — and a refused blob is
   counted (`BytePassReport::refused` → `SyncOutcome::blobs_refused` →
   `blobsRefused` on the `seat.sync` JSON) while the window carries on. That
   number is the one that tells a stuck plane from a caught-up one; without it
   the symptom is a zero with nothing to look at.
2. **`seed-demo-vault` left a byte store no gateway could serve from.** It
   opened the store, leaked its runtime with the process and never shut it down,
   so iroh-blobs never flushed its index: `.data` files on disk the store's own
   index did not know were whole. The gateway opened that directory and RESET
   the `blob` stream (`ERR_INTERNAL`, QUIC code 3) for those blobs. Nothing
   failed at seed time, nothing was red, and combined with defect 1 it was a
   phone whose whole library stayed placeholders. The seeder now keeps a clone
   of the store and closes it after `handle.close()`.

Both were invisible from inside either half, which is the shape this whole
umbrella keeps finding, and neither is reachable by any test that does not drive
the loop end to end.

### What a member reads

`bytesStalled` already carried `BYTES_STALLED_SENTENCE` by the time this slice
touched it; the walking skeleton now asserts the rule rather than trusting it —
every window's `bytesStalled`, if present, must carry no colon and no "error",
which is what "io: stream reset by peer: error 3" had on a Photos screen.

### Item 2 — one exhaustive `PassReport`

`crates/seat/src/sync.rs` is one state machine over **rows, intents and bytes**,
and every stage answers exactly one of three things: `Moved(what)`, `Cut(what it
kept)` or `Skipped(reason)` with the reason a **code** from a closed set
([`SkipReason`], twelve values).

The byte plane moved into it behind a third trait, `ByteMover`, beside
`LogSource` and `IntentSink`. It was a second loop the caller sequenced
afterwards with a report of its own that `SeatLink::sync` stitched on — which is
exactly how it came to have booleans of its own.

| Where | What |
| --- | --- |
| `crates/seat/src/sync.rs` | `Stage<M>`, `SkipReason`, `BootstrapMoved`/`RowsMoved`/`IntentsMoved`/`BytesMoved`, `ByteMover`/`NoBytes`, `Window{deadline, budget, network}`, `PassReport::stopped(reason)`. `pass` → `sync`. |
| `crates/seat-link/src/seat.rs` | `GatewayBytes` implements `ByteMover`; the eviction sweep moved inside it (a sweep the report could not mention was a number that died between two loops); `SeatPassReport` deleted. |
| `crates/core/src/link.rs` | `SyncOutcome` is `{report, parked, sentence}` and every number on it is a method over the report. `unreachable`, `stale`, `blocked`, `bytes_stalled`, `blobs_refused`, `originals_withheld`, `rebootstrap_required`, `cut_by_the_deadline` are all derived. |
| `crates/core/src/error.rs` | `skip_sentence(reason)` — a table keyed by code, like every other sentence this core makes. |
| `crates/core/src/handle.rs` | The `seat.sync` JSON gains `stages.{bootstrap,rows,intents,bytes}`, each `{state, reason?, sentence?, …}`; `stale`/`blocked`/`bytesStalled`/`blobsRefused` are gone from it. |
| `mobile/.../GatewayLink.kt` | `StageReport` and `SyncOutcome.{bootstrap,rows,intents,bytes}`; `stale`/`blocked`/`bytesStalled` survive as renames of a stage's sentence so a status line still draws. `objectField`/`stageField` — the payload stopped being flat, and a scanner that took the first `"reason"` would answer the bootstrap stage's to a question about the bytes. |

**And the join the coordinator named.** A completed blob emitted no change
event, so nineteen photographs landed on a device and every cell still read "not
on this device yet" until something else made the screen re-read. The byte pass
now reports the hashes it completed, `centraid_seat::bytes::content_rows_for`
joins them back to `core_content_item` rows, `ChangeSink::blobs_arrived` carries
them, and `PhotosGridMachine` answers `core_content_item` with its own
`BytesArrived` case — its own case and not a `RowsChanged`, because the grid is
keyed by ASSET id and this carries CONTENT ids, so a grid handed them as asset
ids would compare, find no match and redraw nothing, which is the defect.
Asserted in walking-skeleton step 8 (`stages.bytes.arrived` is non-empty across
the windows) and in `PendingWriteSpec`.

### Item 3 — bootstrap by adoption

The blob IS the replica. `centraid_vault::build_replica_snapshot` runs the same
sanitisation pipeline with a `Shape::Replica` — **no gzip**, and
`centraid_seat::seat_own_ddl()` executed on the copy before the compaction — so
the artifact a phone fetches is already a file it can open.

`crates/seat-link/src/bootstrap.rs` then: room-checks against
`PairOk.snapshot_bytes` (**≥1× for a first bootstrap, ≥2× for a re-bootstrap**,
refused as `BootstrapRefusal::NoRoom{needed, free}`), fetches, **hard-links the
store's data file to `<replica>.incoming`**, and calls
`centraid_seat::adopt_replica`, which in ONE transaction carries the seat-own
tables off the old file, writes the pairing record and writes the cursor. Then
one rename, then `forget`.

What went: `crates/seat/src/install.rs`, `prepare_replica`, `Landing`,
`sync::carry_over`, `sync::restore_carried_over`, the gzip inflate, the staged
`.incoming.gz`, and `centraid-pairing.sqlite3` as a concept — the shell's
pairing file is still where a device with no vault id opens, and the pairing
RECORD is no longer in it.

`crates/seat/src/schema.rs` is new and is the list the gateway shapes the blob
from and a re-bootstrap copies: `seat_outbox`, `seat_outbox_settled`,
`seat_pending_rows`, `seat_gateway`, `seat_state`. A constant beside the DDL
that creates them rather than a `seat_` prefix match, because a prefix match
would also carry a table some future app happened to name that way.

**Foreground and background.** `sync(deadline, budget, network)` adopts only
when `budget == Foreground`; a background window fetches and stops, and the
report says `Cut` with the bytes it kept. Adoption closes the vault, renames and
reopens; a thirty-second refresh cut halfway through that is a member watching
their device go blank and come back.

**Paired, no file yet.** `PairOk` now carries the gateway's `relay_url` and
`direct_addrs` as well as the head, the shell keeps the record in its secure
store (`Pairings`, beside `EndpointKeys`), and hands it back through
`CoreConfiguration.pairing` → `CoreConfig.pairing`. `Handle::readopt_gateway`
asks the replica first and that record second. The member reads "Copying your
vault — 25%" off `stages.bootstrap`, not "Synced: 0 changes, 0 files".

**Re-prediction after a re-bootstrap.** The adoption carries the outbox and the
pairing record and nothing else — the predicted rows were applied to a file that
is gone — so `Handle::re_predict` runs every queued write's handler again
against the fresh copy, in `created_order`. The handlers are deterministic,
which is the whole reason a prediction is the handler's own output.

### Item 4 — the predicted write is applied, not composed

**The owner reshaped this mid-slice and the second shape is much better.** The
first draft built a read-side composition in `crates/apps/kit`; the ruling is to
apply the predicted page in place, through the same applier the gateway's pages
use, and keep reads plain.

`Request::Intent` on a seat now:

1. names the command `<app>.<action>` through `crate::intent::command_name` —
   the same function the gateway names it with, because two spellings of one
   command is how `knowledge.save_note` was queued and retried for a whole wave
   against a registry that never had it;
2. `Vault::predict` — gate 3 (the registry) and gate 2 (the schema) run and
   their failure is a **refusal**, never a queued row; gates 4, 6 and 7
   (preconditions, handler, postconditions) run because they are what produces
   the rows; the audit trail does not, authority does not, and the ledger does
   not;
3. `Vault::dry_run` captures the changeset and **rolls back**;
4. `centraid_seat::pending::apply_prediction` writes the rows through
   `centraid_vault::log::apply`'s own renderer and journals each touched row's
   PRIOR image in `seat_pending_rows`, in one transaction with the outbox row;
5. a `ChangeEvent` names the touched rows, so the member's own write moves their
   screen through the one consumer every other change moves it through.

`crates/apps/kit/src/overlay.rs` is **deleted**, with `PageDoor::overlays`,
`TestDoor::with_overlays` and every composition call site.

Three things consume the journal:

| When | What happens |
| --- | --- |
| the answering commit lands | the applier upserts the canonical row and `forget_rows` drops the entry, in that transaction (R24) |
| any other commit touches the row first | the same call — **truth wins**: a prior image from before a commit the gateway has since made is not a state this device may return to |
| the write is denied, expired or fails | `restore` puts the prior images back, newest first, and drops the entries |

A row a LATER intent also wrote is not restored; that intent's journalled prior
is rewritten to this one's, which is the only answer that is right for both
orders.

**The invariant**, asserted in the walking skeleton after settlement: an empty
outbox ⇒ an empty `seat_pending_rows` ⇒ the replica's notes are the gateway's,
row for row.

### The property test, and the two things it found

`crates/vault/tests/prediction_parity.rs`: **98 fixture commands** from
`contracts/apps/*/commands.json`, `$from` chains resolved from each command's
real output. For each: `predict`, then `execute` on the same vault — the
prediction rolls back, so the execution starts from exactly the state it saw —
then the predicted rows against the rows that commit actually logged.

The comparison is a masked multiset per `(table, op)`, not positional within a
group: the two runs mint different ids, so a table's changeset decodes them in a
different order and a positional zip compares a note against its neighbour and
reports every column as wrong. What is masked is enumerated two ways —
`GATEWAY_MINTED` (twelve names: the clock's, the id sequence's, `row_version`,
and `notation`, which is a minted id wearing another name) and the **minted-id
rule**: an `_id` column may differ only when neither value appears anywhere in
the command's input. An id the member named must match exactly.

It found two things:

1. **A handler can write its own audit row.** `locker.watchtower` files an
   `access_receipt`. `Vault::predict` now drops
   `centraid_vault::audit::TRAIL_TABLES` from its output — those rows are the
   record that a command RAN, and on a seat it has not; a predicted receipt
   would carry an invocation id the gateway never minted and the answering
   commit inserts its OWN row rather than replacing it, so the fabricated one
   would simply stay, for ever.
2. **A prediction needs foreign keys off.** It does not write the invocation, and
   handlers reference it — `locker.watchtower` failed on `FOREIGN KEY constraint
   failed`. This is rule 4 of the seat applier one step earlier: a mirror does
   not re-decide what the writer committed, and a prediction that enforced
   constraints against a copy missing the rows it is not allowed to write would
   refuse writes the gateway accepts. The pragma is set outside the transaction,
   because SQLite ignores it inside one.

### Item 5 — the head rides the answers that ask for a copy

`PairOk` gains `{snapshot_hash, snapshot_seq, snapshot_bytes, relay_url,
direct_addrs}`; `RebootstrapRequired` gains the first three. `SnapshotHeadRequest`,
`SnapshotHead` and `snapshot.proto` are deleted, and field numbers 3 and 6 on
`Request`/`Response` are **retired rather than reused** — a number that comes
back meaning something else is how an old build reads a new message as a shape
it recognises. `crates/core` leaves the three empty on `RebootstrapRequired` and
`crates/centraid`'s seat lane fills them, because the artifact belongs to the
gateway PROCESS and a core that invented a hash would be naming a blob nobody
serves.

The one state with no other way to ask — paired, no file, pairing recovered from
the secure store — asks for a log page from a cursor it does not have
(`SeatLink::ask_for_an_offer`) and is answered `RebootstrapRequired` carrying the
head. That is the conversation every seat under the floor already has; it is not
`snapshot_head` under another name.

### What the walking skeleton found that was not in any item

Both are in [`docs/traps/first-dial-readiness.md`](../docs/traps/first-dial-readiness.md),
because both cost real time and both read as "the gateway did not answer the
pairing request" on a gateway that was answering fine.

1. **`READY` was printed before the gateway could accept.** The line went out,
   with the ticket behind it, and only then did the process open the vault, open
   the byte store and spawn the accept loop. Every script that waits on that
   line — which is what the line is for — got it during a window long enough for
   a seat to dial, wait out its whole pairing timeout and be told the gateway
   did not answer. A gateway that says it is ready and then refuses connections
   is lying to the one caller that believes it.
2. **A seat kept a relay-mode endpoint whatever its gateway was.**
   `centraid gateway --no-relay` is a LAN-only deployment and had only half of
   itself: a relay-mode seat waits on iroh's `net_report` before its first dial,
   and on a network with no route to those relays that probe runs to its own
   timeout while the ten-second connect bound expires behind it. `"relays":
   false` at `centraid_open` is the other half, and the shell decides because
   the shell is what read the ticket.

A third is an environment fact and is written down as one: a freshly bound
endpoint is still discovering its own addresses, and a dial issued in the middle
of that is slower than one issued after it. On a phone a member fills that gap;
the test waits `ENDPOINT_WARMUP` and asserts nothing about the duration, because
it is a property of the host's networking and not of this product.

### Where I went past the brief, and why

- **`Vault::dry_run` and `Vault::predict` are in `crates/vault`**, not in the
  seat. The seat cannot run a command — the registry, the gate order and the
  changeset capture are the vault's — and a second implementation of any of them
  is the drift this whole item is about.
- **`output_name` stayed in `crates/core`.** I briefly moved it to
  `crates/apps/kit` so the composition and the read would agree on a column's
  name; with the composition deleted there is nothing to agree with, so the move
  and the `centraid-apps-kit` dependency it needed went back.
- **`fs4` is a new workspace dependency**, for the room check's free-space probe.
  The alternative was an `unsafe` `statvfs` block in `crates/seat-link`, which is
  `#![forbid(unsafe_code)]` and stays that way: the only crate in this workspace
  with an unsafe surface is `crates/core-ffi`, where the C ABI is.

### What I left, and why

- **A prediction runs no authority gate.** `evaluate_access` reads private
  tables a replica does not have, and the decision is not a seat's to make: the
  gateway refuses what it refuses and its answer then replaces the prediction. A
  seat that guessed at authority would be a seat that could grant it.
- **A prediction this copy cannot make does not stop the write.** A handler
  whose preconditions do not hold against a replica that is behind is a handler
  the gateway may still accept, so the write queues with nothing applied and the
  member gets the badge without the value. Only the registry and the schema
  refuse, because those two are facts about the BUILD.
- **`seat.sync`'s JSON keeps its flat counts beside `stages`.** They are
  projections computed in Rust, not a second source: the rule is that the shell
  computes nothing, not that it reads one field.


## The lockup's second line (D-1025-S7-8)

Found by running the scenario against a seeded throwaway gateway rather than by
reading: a phone that had paired, adopted its copy, synced nineteen photographs
and was drawing them on Home said **"not connected to a gateway"** in the header
above them.

`VaultLockup.gateway_name` had **no writer on any layer** — `grep -rn
gateway_name crates` answered nothing — and could not have had one: nothing in
the pairing exchange names a gateway. `PairOk` answers a vault id, a vault name
and an address, because a device pairs with a VAULT. So the field was replaced,
not filled: `VaultLockup.Link`, five cases, written only by `HomeSession`, which
is the only object holding both halves of the answer (`Pairings` says paired, a
pass says reached).

Proven on the iPhone 17 Pro simulator against
`centraid gateway --no-relay` over a `seed-demo-vault` corpus (people 12, notes
7, docs 5, photos 19, agenda 5, tasks 9, tally 10):

| State | Header | How it was reached |
| --- | --- | --- |
| `LINK_UNPAIRED` | "No vault yet / not paired yet" | clean install, no pairing record |
| `LINK_PAIRED` | "Tahoe Demo / paired" | relaunch after pairing, before any pass |
| `LINK_SYNCED` | "Tahoe Demo / synced" | `Sync now` against the live gateway |
| `LINK_OFFLINE` | "Tahoe Demo / offline" | gateway killed, `Sync now` times out |

The tiles survived every transition, which is `HomeMachine`'s existing
`sameVaultAs` branch doing its job: a lockup re-sent after each pass moves the
line and is not a switch.

`LINK_UNSPECIFIED` is the one silence — a Home nobody has told anything yet —
and it draws no line rather than a claim. The empty lockup a core that cannot
identify its vault sends now CARRIES the link, because "paired, no file yet"
(D-1025-S7-6) is exactly the shape with no vault to name, and it is the moment a
member most needs to be told the copy is on its way.

### What this did not touch

- **`jvmTest` was not run.** This host has only JDK 17 and `:shared:jvmTest`
  needs 21, so `HomeMachineSpec`'s four updated lockups compiled nowhere locally;
  `commonMain` is proven by the Kotlin/Native link and the Swift build. CI's lane
  is the gate.
- **The Android header was edited and not run.** Same `Link` mapping, same
  exhaustive `when` with no `else`, but no Android device was driven here.


## The shelf, and the pairing that destroyed a vault (D-1025-S7-9 … S7-12)

Found by running the scenario rather than by reading it, and it is the worst
class of defect this product can have: **pairing a second gateway onto a phone
that already held a vault DESTROYED the first vault's copy.**

The chain, end to end:

1. `HomeSession.pair` sent `Request::Pair` down the **live** core — the one open
   on vault A's replica.
2. `Handle::pair` called `self.bootstrap(offer, true)` into that same file, with
   no guard of any kind.
3. Vault A's rows were replaced by vault B's. Nothing errored.
4. `Replicas.settle` then looked for a `centraid-pairing.sqlite3` that had never
   been created, answered `null`, the session fell back to a path with no file
   and opened it `create = false` —
5. and a member who had held a vault one second earlier read **"No vault yet"**.

Underneath it, a structural gap: **three objects each held one true fact and
nothing held the set.** `Replicas` knew which files existed, `Pairings` which
vaults had a record, `EndpointKeys` which had an identity — and
`VaultRoster.survey` read all three ONCE, at launch, before the active core
opened. A vault admitted after that moment did not exist to any screen until the
app was relaunched, and each roster row's second line was a GUESS about a pass
the survey had never run.

### What changed

| | |
| --- | --- |
| `Shelf` (new, `commonMain`) | The set of holdings. A holding is a vault id, its replica path, its name, the last `SyncOutcome` and whether a pass is in flight. `admit` and `forget` are the only things that add or remove one. |
| `Shelf.admit` | **Always** opens a fresh core at `Replicas.PAIRING_FILE` and redeems there. First vault and Nth take the identical path — no branch on "does this device already hold one", which is what stops the Nth being the case nobody tested. |
| `Handle::pair` | Refuses to bootstrap into a replica already holding a vault, by `ERROR_CODE_VAULT_ALREADY_HELD`, **before the ticket is redeemed** so a refusal burns nothing. `seed-demo-vault`'s guard with the `--force` taken off. |
| `VaultLockup.Link` → `State` | Three cases, all derived. See below. |
| `HomeEvent.VaultsListed` → `RosterChanged` | A stream, republished on every membership or state change. The switcher's rows and the header's second line are now one value rendered twice. |
| `Shelf.forget` | The exact inverse of admit: core, holding, replica, byte store, sidecars, pairing record, endpoint key. **Local only** — the gateway keeps the device enrolled until someone with the vault revokes it there, because a phone that could revoke itself could lock a member out. |
| `HomeSession` | A view over the shelf's foreground holding. A switch is a `rebind`, not a teardown. `syncNow` is a ROUND: one pass per holding, foreground first, under one shared window. |
| `crates/centraid/src/run.rs` | A pairing answers the vault's own `core_vault.display_name`, not `--vault-name`. Ticket minting untouched. |

### Pairing is an ACTION, not a state

`Link` was one wave old and had the shape of the field it replaced: two of its
five cases could never be true of the thing it described. `LINK_UNPAIRED` is a
state of the **device** — zero vaults held, show the pair flow — and a vault
that is HELD has by definition been admitted, so that case only ever fired as a
guess. `LINK_PAIRED` meant "admitted, nothing has reported yet", which to a
member is the same sentence as "the copy is still coming".

Three values remain, each a different thing to do, and every one **derived**
from the last pass rather than stored — the stored version went wrong exactly as
a stored derivation does, with `survey` writing it at launch and `syncNow`
writing it afterwards and the two disagreeing. `ShelfSpec` pins the table.

The wording is past tense on purpose: nothing here probes a gateway, so a header
saying "connected" would promise a live link no code in this product checks.
"synced", "offline", "syncing" — and a percent while a copy is landing.

### One open core, and why the cap is exactly one

The design called for the shelf to hold open cores with a cap. **R-1020-24 is
one core per process**, enforced by `SingleHandleGuard`, and it is not a
capacity limit that could be raised — it exists so app extensions sharing the
process can never open the vault. So the cap is **1**, stated as
`Shelf.OPEN_CORES` with the reason beside it, and non-foreground cores are
reopened on demand.

What that costs, stated plainly: a switch is a SQLite close-and-open of a local
file, not a pointer move. What stays seamless is everything else — the session
is not torn down, the app screens stay attached (they read the core through a
supplier), the roster is not re-surveyed, nothing is re-identified. **This is a
deviation from the brief's "a rebind, not a reopen"** and the law is why.

### Proven on the iPhone 17 Pro simulator

Two `centraid gateway --no-relay` LAN gateways over `seed-demo-vault` corpora:
`Tahoe Demo` (`01a0a367-…`, photos 19, docs 3, notes 5, agenda 5, tasks 11) and
`Second Vault` (`01a0a382-…`). Screenshots in the session scratchpad under
`proof-1025-s79/`.

| What | Evidence |
| --- | --- |
| The ticket's name is not the vault's | Ticket A carries `Q2VudHJhaWQ` — "Centraid", the `--vault-name` default — and the sheet said **"Paired with Tahoe Demo."** |
| Pairing a SECOND vault leaves the first intact | After admitting `Second Vault`, the container held **two** replicas and two byte stores; `sqlite3 … 'SELECT display_name FROM core_vault'` answered `Tahoe Demo` and `Second Vault`. Before this change the first file was gone. |
| The roster is a stream | The switcher listed both vaults, each with its own state line, **with no relaunch** — the one-shot survey could not have done this. |
| A switch re-points the whole app | Tapping `Tahoe Demo` drew that vault's own tiles (19 photographs, "Tahoe packing list"). |
| Relaunch restores the last foreground | Terminate and launch came back on `Tahoe Demo`, not on whichever file sorted first. |
| The round walks every holding | One `Sync now` produced a dial on **both** gateways, 84 ms apart, foreground first. |

### A defect this run found and this slice did NOT fix

**A seat's sync dial is refused by its own gateway as an unenrolled peer.**
Reproduced at its smallest: clean install, one vault, pair, `Sync now`
immediately, no switch and no relaunch. The gateway logs the pairing
(`a device paired and its connection was promoted in place`, then
`a seat's window closed streams=1 rows=0` — the bootstrap on the promoted
connection) and then, on the next dial, `an unenrolled peer did not pair
why=it asked for something other than a pairing`. The seat renders the
handshake's `ProtocolError::VersionWindow` sentence, "This app and that gateway
are too far apart in version to talk", which is the wrong sentence for what
happened and is a second finding in its own right.

The dial therefore presents a public key the gateway has not enrolled, which
means `EndpointKeys`' secret is not reaching `attach_network` on the reopen —
`crates/core-ffi/src/lib.rs` mints a fresh identity when `secret` is `None`, and
a fresh identity is a stranger. It is the same shape as D-1025-S5-5, one step
later in the lifecycle. **I could not root-cause it inside this slice and I have
not proven it pre-existed**: the baseline is uncommitted, so there is no build
to compare against. It is not multi-vault specific — one vault reproduces it —
but it lives in the path this change rewrote, so it must not be assumed
innocent. It is why no row above claims a completed sync.

Related and visible beside it: **nothing in the mobile shell ever passes
`relays: false`**, which D-1025-S7-7 says is the shell's to decide and which
these `--no-relay` gateways are exactly the deployment for. `CoreConfiguration.relays`
defaults to `true` and has no writer on this side.

### And a defect this run found and this slice DID fix

`rebind()` tore down and restarted the change reader unconditionally, and
`CentraidCore.startReader` refuses a second reader on one core — by throwing.
It is reachable on the ordinary path: a round walks the shelf and returns to the
vault it started on, so the closing rebind is almost always a rebind onto the
same core. The app aborted with
`kotlin.IllegalStateException: the core's reader is already running; there is
exactly one`. Rebinding to the core already bound is not a rebind and is now a
no-op but for the lockup.

### What was not run, and why

- **`:shared:jvmTest`.** This host has only JDK 17 and the task needs 21
  (`Cannot find a Java installation … languageVersion=21`). `HomeMachineSpec`'s
  ported lockups and the new `ShelfSpec` compiled nowhere locally; `commonMain`
  is proven by the Kotlin/Native link, the XCFramework and the Swift build. CI's
  lane is the gate. **No toolchain or Gradle config was changed to get around
  it.**
- **The Android app was edited and not compiled.** `-Pcentraid.android=true`
  refuses before the JDK check: neither `ANDROID_HOME` nor `ANDROID_SDK_ROOT` is
  set and `~/Library/Android/sdk` does not exist. The header's `State` mapping
  and the switcher's forget action were checked by reading against the generated
  Wire types; no Android device was driven.
- **The full gate loop.** Not run, by standing instruction. `cargo test -p
  centraid-core` is green (71 tests, including the new guard);
  `-p centraid-vault` is green. `-p centraid` has **one** failure,
  `gateway_install::a_system_install_refuses_an_instance_name_that_is_not_one`,
  which is a host-environment assertion about systemd on macOS and predates this
  change.

### The trap this cost an hour to re-learn

`docs/traps/stale-core-slice.md` describes it exactly and I walked into it
anyway: the seat was running a `libcentraid_core_ffi.a` built before the proto
change, and the symptom was the version-window sentence — indistinguishable, at
a glance, from the enrolment defect above. **Build the Rust slice first, every
time.** The trap file now also carries the layer above it: `iosApp/project.yml`
consumes `shared/build/XCFrameworks/debug/CentraidShared.xcframework`, which
`:shared:linkDebugFrameworkIosSimulatorArm64` does not write —
`:shared:assembleCentraidSharedDebugXCFramework` does. `mobile/README.md`'s
hand-off named the wrong task and now names the right one.

## S7-13 — the vault is the unit on every axis, and a device proves who it is

Seven rulings, settled with the owner and implemented as stated. What follows is
what changed, what the open defect actually was, and what was not run.

### A. Granularity is the vault, on every axis

Identity key, endpoint, core, replica, byte store, enrolment record, state: all
per vault. **"Gateway" is not a noun this device has.** `D-1025-S7-13` states
the rule; the correlation property people cite for per-vault keys is a
consequence and not the reason, and `D-1025-S5-5`'s revocation rationale — which
was never the real reason, because enrolment rows are per gateway and a shared
device key would already have been two rows to revoke — is superseded.

### B. One `Enrolments` record per vault, in one secure-store entry

`EndpointKeys` and `Pairings` are **deleted**. One record —
`{secret, gatewayAddress, vaultId, vaultName, relayUrl, directAddrs,
enrolledPublicKey}` — under one name, `enrolment.<vaultId>`, and `settle` is
**one rename** that carries the minted secret across. The FFI's `pairing` object
gains `secret` and `enrolledPublicKey`; `endpointSecretKey` and
`endpointSecretKeyPath` are gone, spelling and docs (v0, no legacy).

`EndpointKeys.settle` had a second defect worth naming: it **refused to
overwrite its destination**, reasoning that re-pairing must not replace the key
a device is already enrolled under. By the time settle runs the ticket is burned
and the gateway has enrolled the NEW key, so that branch filed a credential the
gateway no longer knows and threw away the one it does. `Enrolments.settle`
overwrites, and `Shelf.admit` refuses an already-held vault before any of it,
which is where that concern belongs.

### C. The core proves who it is at open

`PairOk` gains `enrolled_public_key`, filled by the gateway from `proved` — the
key iroh's TLS established on the connection, never `asked.device_public_key`,
or a redeeming device could make this device check against its own claim. The
shell keeps it in the record; `crates/core-ffi`'s `attach_network` compares the
endpoint that came up against it and returns `CoreError::IdentityMismatch`
(`ERROR_CODE_IDENTITY_MISMATCH`) rather than attaching a network and dialling.

`crates/centraid/tests/seat_identity.rs` holds both cases against a real
`centraid gateway` over real QUIC with **no shell involved**: pair → close →
reopen on the same record → dial, which passes; and reopen with a different
secret, which is refused at the door.

### THE ROOT CAUSE OF THE STRANGER DIAL

**It was `Shelf.admit` closing the vault's core and never opening one on the
settled path with the settled enrolment.** The chain, in order:

1. `admit` opened the pairing core under the name `pairing`, redeemed the
   ticket, and the gateway enrolled the public half of THAT key.
2. `EndpointKeys.settle` / `Pairings.settle` re-filed the two entries under the
   vault id, and `Replicas.settle` renamed the file.
3. `openForeground()` then reopened — but it is the SAME single `openCore` slot,
   and the whole design had exactly one. Every later touch of that vault reopened
   from the one slot, and every reopen read the store again.

That much would have worked. What did not is that there was **no way to tell a
reopen that got its key from one that did not**: `openCore` answered `null` on
any failure, `EndpointKeys.of` minted silently when the store answered nothing,
and `IosSecureStore.write` **discarded the `OSStatus` of `SecItemAdd`**. Three
silent falls in a row, and the observable end of it was a dial the gateway
refused as an unenrolled peer, rendered on the phone as "this app and that
gateway are too far apart in version to talk".

So the honest finding is two-part, and both halves are fixed:

- **The mechanism that hid it**: a credential write whose failure was thrown
  away. `IosSecureStore.write` now logs the `OSStatus`, and the core refuses the
  open outright when the endpoint is not the enrolled one — a device that cannot
  be itself says so at the door instead of earning a refusal from a peer that
  describes something else.
- **The mechanism that caused it on this host**: the one-core slot. With the cap
  gone, each holding's core is opened once, on its own settled record, and kept
  — there is no reopen path to lose a key on. On the run below, pairing, the
  first `Sync now`, the relaunch and every later round all presented
  `dev_74717dc433a32451`, the device the gateway enrolled.

**What it was NOT**: the Keychain. The simulator run below writes and reads the
enrolment entry with no `OSStatus` failure logged, which is why the new log line
matters — it is the difference between knowing that and assuming it.

### D. The `relays` flag is deleted

`CoreConfig.relays`, `CoreConfiguration.relays`, the FFI's `"relays"` key and
`SeatLink::start_with_key`'s `bool` are gone. `relay_url` decides, and it is
**three-valued**: a url is a relayed deployment, `""` is a deployment that
STATED it has none (`RelayMode::Disabled`), and ABSENT is "not told" and keeps
relays on. The third is the transient record a device holds while redeeming a
ticket — collapsing it into `""` would mean no device could pair over the
internet. `D-1025-S7-7`'s relay half is superseded; its `READY` half stands.

### E. The guard is per replica path

`SingleHandleGuard` is keyed on the replica path. R-1020-24 stands as written for
the case it exists for — app extensions never open the vault, whose hazard is two
handles on ONE file — and its "one core per process" reading is retired with
`D-1020-HOME8`'s survey-before-open dance.

**Deviation, with its reason**: the brief asked for a Rust test that two handles
on two paths coexist and two on one path are refused. **The guard is not in
Rust** — it is `mobile/core`'s `SingleHandleGuard`, and `crates/core` has no
process guard at all (every seat test in `crates/centraid` already opens several
cores in one process, which is the "two paths coexist" property holding
trivially). Adding a Rust guard to write the test against would change behaviour
for those suites to satisfy a test. The table is in `AbiRoundTripSpec` instead,
in the same test body as the round trip, where the existing refusal case already
lived — and it did not run here (see below).

### F. No cap. A held vault's core is open

`Shelf.OPEN_CORES` and the close-and-reopen are gone. A switch is
`HomeSession.rebind` onto a core that is already open. The sync round calls the
new `Shelf.awaken` rather than `bringToFront`, so a round no longer walks the
foreground across every vault and back. The only two things that close a
background core are `forget` and **`Shelf.rest()`**, wired from iOS's
`UIApplication.didReceiveMemoryWarningNotification` and Android's
`onTrimMemory`; `Holding.resting` is the per-vault state and there is no global
number. No idle timeout, and the doc comment says the shape would be a per-vault
timer if one is ever wanted.

### G. One tokio runtime

`shared_runtime()` is a `OnceLock` in `crates/seat-link`; each `SeatLink` holds a
`Handle`. Endpoints stay per vault.

**It cost one obligation and finding it cost a hang.** A dropped link used to
take its runtime with it, and with it the byte store's actor; a shared runtime
does not, so the dropped store kept its lock on `<replica>.bytes` and the next
open of that replica blocked forever inside `ByteStore::open`.
`tests/seat_identity.rs` reproduced it on its second open. `impl Drop for
SeatLink` now closes the endpoint and flushes the store — which is worth having
on its own, since a store that vanished with a runtime never flushed.

Worker count is the host's, clamped to 2–8. Two — what one link had — starved
the parallel scenario suites.

### H. The roster is read off open cores

`Shelf.load` opens each replica as the seat it is, asks `VaultRoster.identify`,
and keeps it. The `GATEWAY`-role probe that opened and closed each file in turn
is deleted.

### A crash this run found, and what it was

**Moving back to a vault the member had been in before crashed the app.**
`CentraidCore.startReader` documented itself as idempotent and `check`ed
instead — it threw on a second call. That was unreachable while every switch
produced a fresh handle; with cores that survive a switch, the first move back
onto a previously-bound core threw on the main path. The reader is now one per
CORE, kept and handed back, and it lives on the core's own scope — which is also
the right lifetime, because the core's event queue is bounded and drops nothing,
so a background vault whose reader stopped would fill it and report a stall.

### Proven on the iPhone 17 Pro simulator

Clean install (`simctl uninstall` first), two `centraid gateway --no-relay` LAN
gateways restarted on the NEW binary over the existing seeded corpora: `Tahoe
Demo` (`01a0a367-…`) and `Second Vault` (`01a0a382-…`). Screenshots in
`proof-1025-s713/`.

| What | Evidence |
| --- | --- |
| Pairing names the vault, not the ticket | `ticket …Q2VudHJhaWQ…` ("Centraid"); the sheet said **"Paired with Tahoe Demo."** |
| **`Sync now` COMPLETES** — the row missing last time | **"Synced: 0 changes, 19 files. [foreground]"**, and the gateway logged `a seat's window closed device=dev_74717dc433a32451 streams=20`. The previous pass got `an unenrolled peer did not pair`. `0 changes` is honest: the bootstrap inside the pairing had already applied the log to seq 1101. `01-…` |
| Relaunch keeps the identity | After terminate + launch, `Sync now` completed again and the gateway logged **the same `dev_74717dc433a32451`**. `03-…` |
| A second vault, with the first intact | Both replicas and both byte stores in the container; the gateway for vault 2 enrolled `dev_4b1238ab99ee4e86`. Vault 1's core stayed open throughout. |
| The switcher is a stream, with per-vault state | "Second Vault — syncing" and "Tahoe Demo — synced", together, with no relaunch. `04-…` |
| **A switch reopens nothing** | `lsof` on the app process before and after tapping a row: **identical descriptors**, `4u` and `23u`, on both replicas. Two cores open in one process at once is itself the proof that the cap is gone. `06-…` |
| One round dials both, foreground first | One `Sync now` produced `dev_4b1238ab99ee4e86` on gateway B at `08:13:31.8255` and `dev_74717dc433a32451` on gateway A at `08:13:31.8340` — **each vault as its own enrolled device**, 9 ms apart, foreground first. `07-…` |
| Forget is local and per vault | "Forget Tahoe Demo?" → the replica, its sidecars and its `.bytes` store gone, only vault 2's files still open, "This device holds one vault." `08-…` |
| Relaunch restores the last foreground | Terminate + launch came back on **Second Vault**, not on whichever file sorted first. `09-…` |

### What was not run, and why

- **`:shared:jvmTest` and `:core:jvmTest`.** This host has only JDK 17 and the
  task needs 21 (`Cannot find a Java installation … languageVersion=21`).
  `ShelfSpec`, `PendingWriteSpec` and `AbiRoundTripSpec` were updated and
  compiled nowhere locally; `commonMain` is proven by the Kotlin/Native link,
  the XCFramework and the Swift build, and by the simulator run above. CI's lane
  is the gate. **No toolchain or Gradle config was changed to get around it.**
- **The Android app was edited and not compiled.** Neither `ANDROID_HOME` nor
  `ANDROID_SDK_ROOT` is set and `~/Library/Android/sdk` does not exist.
  `MainActivity.onTrimMemory` and the off-main-thread `close` were checked by
  reading.
- **The full gate loop**, by standing instruction.
- **`cargo test -p centraid`'s integration suites are RED on this host and were
  red before this change.** `seat_bootstrap` and `seat_offline` time out their
  pairing dials — `SeatLink::start` followed immediately by `pair`, with no
  warmup, which is the first-dial-readiness race `docs/traps/first-dial-readiness.md`
  describes. **A/B'd twice against this slice's two suspects**: with a per-link
  runtime restored, and with `Drop for SeatLink` disabled, the same tests fail
  the same way — so the shared runtime is not the cause. Serially, `seat_bootstrap`
  passes 3 of 4 and `seat_offline` 4 of 8. `cargo test -p centraid` stops at the
  bin target's known macOS `gateway_install` failure and never reaches these, which
  is why they had not been noticed. **Left as found, and filed here rather than
  papered over.**

### Green

`cargo test -p centraid-core -p centraid-seat-link -p centraid-core-ffi
-p centraid-vault -p centraid-net`. `crates/centraid`'s
`walking_skeleton` and the new `seat_identity` both pass. The cbindgen header
was regenerated (`CENTRAID_WRITE_HEADER=1`).

---

## Slice 2 — the tail stream (#1025, D-1025-S7-40, D-1025-S7-41)

**There is one mechanism for a seat to become current: connect, tail the log
from the durable cursor, stay open as long as the OS allows.** Polling and
foreground timers are deleted concepts and nothing in the tree holds an
interval. Decision rows are numbered from **D-1025-S7-40** because the byte-plane
slice running beside this one holds S7-20 upwards.

### What the wire gained, and what it did not

`LogRequest.tail` — one bool, and **no new message types**. A gateway answering a
tail serves the catch-up pages from `since` exactly as the one-shot door does
(following `has_more`), then keeps the stream open and writes a further
`LogPage` every time the vault's watermark moves past what it last sent.
`RebootstrapRequired` ends it as it ends any request: a tail is the same answer,
more than once.

`log.proto`'s header now states the two facts a reader of this wire has to know
and could not have derived: **one log per vault**, and **every table's changes
are rows in it** named by `LogRow.table` — a seat never subscribes to a table,
because a seat holds a COPY and not a view of part of one.

`SyncWindow.tail` carries the same decision from the shell to the core.

### The gateway

`crates/centraid/src/tails.rs` is new and holds both halves:

- **`Commits`** — the wake, a `tokio::sync::watch` rather than a `Notify`
  because a receiver remembers whether it has seen the current value, so a
  commit landing between a reader's page and its wait is not lost. It carries
  **no payload**: what a reader does with a wake is ask the log door where the
  watermark is, and a seq handed across would be a second opinion about the same
  fact. **One page per COMMIT BATCH, never one per row**, falls straight out of
  that.
- **`Tails`** — who is holding one, by device. A second tail from the same
  device replaces the first (the second is what that device believes); the
  registration guard unregisters only its own entry, because the ordinary race
  is the replaced tail noticing moments after the replacement. **Presence falls
  out of the registry** and goes to `tracing` and nowhere else.

`Handle::watch_commits` registers a bell; `Handle` rings it after every request
that **may** have written — `Command`, `Intent`, `Stage`, plus `submit_intent`
and `stage_bytes` directly. **A ring is allowed to be spurious and never allowed
to be missed**: the cost of the first is one indexed read and a page that is not
written, and the cost of the second is a row a member is waiting for. The bell
is a trait in `crates/core::link` and not a channel, because `crates/core` has
no tokio and should not grow one to be told that something happened.

`seat_lane::serve_tail` is the loop. It reads pages through the same
`handle.call` the one-shot door uses, off the reactor, writing each; only the
FIRST page is written unconditionally — it is what tells the seat its tail is
open — and after that a page with no rows is not written at all. It ends on a
re-bootstrap, a refusal, a write that fails because the seat went away, the
connection closing, or a second tail from the same device.

### The seat

A tail is **a pass whose row stage does not end**. `crates/seat::sync` grew
`Window.tail`, three defaulted methods on `LogSource` (`open_tail`,
`next_tail_page`, `tail_is_open`) and one new function, `live`. The defaults
matter: a source that has not learned to tail is a source whose tail is one page
long, so `crates/sim` keeps working and a simulation cannot silently block
forever on a stream nobody holds open.

The catch-up half is the existing `drain`, with one branch: a tailing pass asks
`open_tail` for its first page and reads every page after it off the stream that
answered. Steps 1–5 of the pass are unchanged — rows, intents, rows again,
bytes — and **then** `live` runs: apply each page as it arrives, settle it, push
it to the change sink (Slice 1's emission code is called, not changed), and run
the byte stage after each page so a photograph is on the screen with the row
that names it. `merge_bytes` folds the repeated byte stages into the one field
the report has, adding counts and taking the worst-case state.

**The deadline is enforced inside the source, not by the loop.** A tail is quiet
most of the time — that is the point of it — so a check between pages cannot end
one; `next_tail_page` takes the window's deadline and selects on it, on the
shell's stop, and on the stream. All three return `None`, deliberately one
answer: the cursor is durable at every page boundary, so nothing a seat does
next depends on which it was.

`TailStop` (a flag AND a wake) lives on `SeatLink`, one per link, armed at the
start of each tailing pass. It reaches the core as
`SeatNetwork::tail_stopper() -> Arc<dyn TailStopper>`, taken out at
`attach_network` and kept on `Handle` **under its own lock** — because
`sync_now` holds the network lock for the length of a pass and a tail IS a pass
that lasts as long as the member is looking at the app. A stop that took that
lock could only be answered after the thing it was stopping had already ended.
`seat.tail.stop` is the command that pulls it, riding `Command` for the same
reason `seat.sync` does: clause 10 of the C ABI says five symbols and means it.

`PassReport::tailing()` and `SyncOutcome.tailOpen` are the shell-facing fact.
**A tail that is open IS a gateway that is reached** — a caught-up device on a
quiet vault moves nothing for hours and is not offline for a second of it.

### The shell

`HomeSession.foreground()` runs the round it always ran and then opens a tail on
the **foreground holding only** (a tail is a stream; a phone holding four vaults
would hold four). The other holdings get the bounded catch-up they already had,
which is what "a tail with an immediate close" is. `background()` closes the
tail first — a stream parked on a quiet gateway would spend the whole platform
window waiting for a commit nobody is making — and then runs one bounded round.
`stopTail()` is what lock, suspend and foreground-lost do, and it is a COMMAND
rather than a coroutine cancellation: the job is blocked inside the core, and
cancelling from outside would abandon a page half applied.

`syncNow` is **"reconnect the tail"**: a no-op with a sentence when one is open,
and otherwise a round followed by a tail.

`Shelf.Holding.tailing` decides the state ahead of everything else, so
`STATE_ONLINE` is what a member reads while a tail is open. It is marked when
the stream is asked for, which is **after** the round reported — there is no
window in which the header claims ONLINE over a device that has not spoken to
its gateway.

iOS wires it to `scenePhase` in `CentraidApp` (`active` opens, `inactive` and
`background` close) and Android to `onResume`/`onPause`. **No timer was added and
none exists.** Android's persistent foreground service is Slice 7's and is
deliberately not here.

### Deliberately not in this slice

- **Push wakes** — recorded as a non-goal with its three options in
  [D-1025-S7-41](../docs/decisions.md#slice-s2--the-tail-stream-1025). The
  `WakeReason.PUSH` slot stays.
- **Android's persistent foreground service** (Slice 7).
- **Any change to bytes planning** (Slices 3–5). The byte stage is CALLED after
  a live page; nothing about what it plans moved.

## Rust-core umbrella (#1025), Slice 1 — bytes are rows

### The defect, and why it was three defects

A freshly paired device that had synced nineteen photographs showed an **empty
photo grid**. The sync plane was not at fault — it had moved every byte:

1. `PhotosReads` never resolved `thumbnail_path`. A path was a
   `ContentUrlRequest` through the byte door, `HomeRuntime.thumbnails` was the
   **one** place in the product that made the trip, and it made it for four
   cells. The only surface that ever drew a vault's own bytes was a launcher
   tile.
2. `PhotosGridView.swift` drew `Image(systemName: "photo")` **even when a path
   was present** — an SF Symbol where a photograph was — and the Android grid
   drew a `Text` label. This is why the first report was "the grid is empty"
   rather than "the grid is not drawing": a screen of identical glyphs reads as
   a screen of nothing.
3. "Is this blob here?" lived in the byte store's **actor** and in no table, so
   a blob landing was not a row change and a page read could not ask the
   question at all.

### A landed byte is a row

`crates/seat/src/held.rs` is new: `seat_blob_held(content_hash PK, path,
byte_size, drawable, landed_at)`, a seat-own table beside the outbox and the
cursor. Written in the window a blob completes, released in the window the
eviction sweep forgets one, carried across a re-bootstrap with the rest of
`SEAT_OWN_TABLES`, and **rebuilt in full from `ByteStore::complete_hashes` at
every core open and after every adoption** — `Handle::rebuild_held_blobs`, from
`attach_network` and from `bootstrap`. A projection only ever written
incrementally drifts, and drift here is invisible: a missing row renders exactly
like a photograph that has not arrived.

| Where | What |
| --- | --- |
| `crates/seat/src/held.rs` | The table, `record`, `release`, `rebuild`, and `drawable`. |
| `crates/seat/src/schema.rs` | `seat_blob_held` joins `SEAT_OWN_TABLES` and `seat_own_ddl()`. |
| `crates/seat/src/bytes.rs` | `content_rows_for` → **`asset_rows_for`**: hashes → `media_asset.asset_id`, both sides of the join. |
| `crates/seat/src/sync.rs` | `ByteOutcome.arrived` is `Vec<HeldBlob>` and gains `evicted`; `move_bytes` writes the table before it names the rows. |
| `crates/blobs/src/store.rs` | `held_files()`; `sweep` answers **which** blobs it took, not only how many. |
| `crates/seat-link/src/{bytes,seat}.rs` | `BytePassReport.completed_hashes` → `landed: Vec<HeldBlob>` (the path travels with the hash); `SeatNetwork::held_blobs`. |
| `crates/vault/src/page.rs` | `KeysetPage.held_thumbnail` and `HELD_THUMBNAIL_COLUMN`. |
| `crates/core/src/{api,handle,link,events}.rs` | `PageQuery.with_held_thumbnail` through to the appended row value; the rebuild hook; `blobs_arrived` emits `media_asset`. |

**The read is one statement.** `with_held_thumbnail` makes the door append a
`thumbnail_path` resolved against the row's content — `thumb`, then `poster`,
**falling back to the original's hash**, which is the case every vault seeded
from originals is in. A **correlated subquery and not a `LEFT JOIN`**: a join
through `core_content_derivative` multiplies a row by its derivatives, and a
keyset cursor read off a duplicated row is a grid that pages over itself.
`crates/seat/tests/held_thumbnail.rs` asserts the tier, the fallback, and that a
second derivative does not duplicate a cell.

**The byte door's refusal moved without becoming a caller's predicate.**
`content_urls` will not call `image/svg+xml` embeddable and a video's ORIGINAL
is not a frame; `crates/seat` decides both where the path is produced and stores
the answer as `drawable`, and the read filters on that one column. A media-type
predicate written into a Kotlin statement would be a security rule living in a
shell. **No type is not permission**: bytes no representation states a type for
are not drawable.

`HomeRuntime.thumbnails` and its `ContentUrlRequest` trip are deleted.
`content_urls` itself stands, for the viewer and the doc surfaces that ask for
one item at a time.

### `BytesArrived` is deleted

The old reasoning — "its own case and not a `RowsChanged`, because it carries
CONTENT ids and the grid is keyed by ASSET ids" — was sound about the ids it had
and wrong about which ids to have. `asset_rows_for` does the join, `ChangeFeed`
emits one `ChangeEvent` on `media_asset` with `commit_seq: 0` (still the honest
number), field 13 of `PhotosGridEvent` is `reserved`, and the `bytes_arrived`
branch is gone from `PhotosGridMachine`. v0, no legacy.

### One image renderer per cell

`PhotosGridView` and `PhotosGridScreen` both draw `ContentImage(path)`, the view
Home's mosaic already drew. On iOS the cell is a `Color.clear` square with the
image as an overlay and a clip: `ContentImage` fills and deliberately overflows,
so an image asked for its own size grows the row — the first simulator run drew
correct photographs in cells the height of the screen.

### Decision rows

[D-1025-S7-20](../docs/decisions.md), D-1025-S7-21 and D-1025-S7-22.
Docs: `docs/photos/README.md` gains "Where a grid cell's photograph comes from";
`docs/mobile-offline.md`'s byte section gains the table and the change join.

### Evidence

`/private/tmp/claude-502/-Users-srikanth-gitspace-centraid/52a09717-5dd8-486e-8df2-7d9115df07e1/scratchpad/proof-1025-slice1/`,
on the booted iPhone 17 Pro against a `--no-relay` gateway over a freshly seeded
"Tahoe Demo" (19 photographs), app uninstalled and paired from a fresh ticket.

| What | Evidence |
| --- | --- |
| Rows land first, bytes have not | `a-…`: 19 grid cells, every one "Preview no longer on this device"; Home's mosaic empty with "These photographs are not on this device yet." |
| **The byte stage fills Home with no relaunch** | `c-…`: 20 streams on the gateway, then the mosaic draws real photographs — through the ordinary `RowsChanged` over `media_asset`, with no `content_urls` trip in the product at all. |
| The grid draws photographs | `b-…` (before the clip fix) and `d-…` (after): 18 photographs and one honest empty cell. |
| **The table is rebuilt at open** | `d-…` is after a terminate + launch **with the gateway dead**; `e-held-table-after-relaunch.txt` — 20 held, 18 drawable, which is exactly what the grid draws. |

### What was not run, and why

- **`:shared:jvmTest`.** JDK 17 on this host, the task needs 21.
  `PendingWriteSpec` ("files landing are a row change on the assets that own
  them") and `AppReadsSpec` were updated and compiled nowhere locally;
  `commonMain` is proven by the Kotlin/Native link, the XCFramework
  (`:shared:assembleCentraidSharedDebugXCFramework`, green) and the Swift build.
  **No toolchain or Gradle config was changed to get around it.**
- **The Android app was edited and not compiled**: no `ANDROID_HOME` and no SDK
  on this host. `PhotosGridScreen` was checked by reading.
- **The full gate loop**, by standing instruction.
- **The grid filling WITHOUT a relaunch could not be shown**, and the reason is
  not this slice — see below.

### Two things found that this slice did not cause

- **An open log tail wedges every page read.** After
  `centraid::tails: a seat opened a tail on this vault`, every `Request::Page`
  through the core hung forever: the Photos grid sat on its spinner, and killing
  the gateway did not release it. Home had read correctly seconds earlier,
  before the tail opened, and a relaunch with no gateway running read instantly.
  The grid statement itself is fine — run by hand against the same replica it
  returns all 19 rows with their paths. This is the in-flight stay-open tail
  (D-1025-S7-40); it is why proof (b) is after a relaunch rather than before one.
- **`crates/api-proto`'s generated code was stale in the working tree.**
  `LogRequest.tail` existed in the `.proto` and no caller set it; nothing had
  regenerated since, so the first proto edit in this slice turned four call
  sites red. They are set to `tail: false` — the one-shot page, which is what
  they were already asking for — and nothing else about them changed.
- `centraid-vault`'s `backup::restore::tests::a_live_gateways_data_directory_is_refused_and_a_stale_lock_is_taken_over`
  and `centraid-blobs`'s `windows::a_blob_crosses_in_many_short_windows…` are
  **red on this host and untouched by this slice** (a lock-liveness assertion
  and a 10 s dial timeout). Left as found.

### Green

`cargo test -p centraid-seat -p centraid-seat-link -p centraid-core
-p centraid-core-ffi -p centraid-vault` — every suite but the one named above.
`mobile/` `:shared:assembleCentraidSharedDebugXCFramework` and the
`iphonesimulator` app build.

## Rust-core umbrella (#1025), Slice 3 — derivatives at the gateway

Every layer that consumes a thumbnail was already correct. Nothing in v1 ever
made one.

### The defect, and why nothing was red

`core_content_derivative` has held `thumb`, `preview` and `poster` since the
baseline DDL. `centraid_blobs::plan::Tier` orders every thumbnail before every
preview before any original. `centraid_seat::needed_blobs` asks for derivatives
first and by name. `PageQuery::with_held_thumbnail` resolves `thumb` → `poster`
→ the original (D-1025-S7-20). Four layers, each one right, each one reading an
**empty table** — so "thumbnails always" fetched nothing, and the first
foreground window on a freshly paired phone looking at a roll of multi-megabyte
originals moved whole originals or moved nothing.

Nothing was red because nothing was wrong anywhere a test looks. The read falls
back to the original by design, so a vault with no tiers renders exactly like a
vault with them — only slower, and only on a link that is not a loopback. **The
demo seeder hid the rest**: its photographs are already ≤ 360 px, so the tier
and the original are the same bytes and every screenshot in the tree looked
right.

### What changed

| Where | What |
| --- | --- |
| `crates/media/src/renditions.rs` (new) | The pure half: bytes in, bytes out. `is_derivable`, `renditions_of`, `decode_upright`, `encode_jpeg`, and the three constants (`THUMB_EDGE` 360, `PREVIEW_EDGE` 2048, `JPEG_QUALITY` 80). No store, no database, no filesystem. |
| `crates/vault/src/commands/core.rs` | `derive_image_tiers`, hung on **`minted_bytes`** — the one choke point every committing door reaches — and `derive_missing`, the sweep's selection. |
| `crates/vault/src/commands/media.rs` | `media.derive_missing`, registered and `RetrySafe`; `DERIVE_SWEEP_LIMIT = 200`. |
| `crates/core/src/handle.rs` | `derive_missing_tiers(limit)`, refused on a replica, attributed to `Principal::owner("this-gateway")`. |
| `crates/centraid/src/run.rs` | the sweep at start, after `attach_bytes` (it has bytes to read) and non-fatal like every other start step. |
| `Cargo.toml`, `crates/{media,vault}/Cargo.toml` | `image` 0.25.10, `default-features = false`, decode `jpeg`/`png`/`gif`/`webp` + the JPEG encoder. MIT OR Apache-2.0, no C library, no rayon. |
| `docs/photos/README.md`, `docs/decisions.md` | the state, and `D-1025-S7-50`…`-54`. |

**At the mint and not at a handler.** `minted_bytes` is what
`media.add_asset`, `core.add_document`, the link doors, the seeder and a desktop
import all pass through, so a door added later gets tiers without anyone
remembering. **In the same commit**: the applier has no queue of its own, and a
follow-up commit would be a second thing to make crash-safe for a latency
nobody waits on. Each derivative is a blob in the same content-addressed store
under its own blake3 name plus a row — so it reaches every replica as **ordinary
log rows**, and not one line of the seat changed.

### Three refusals that are the design

- **A file that will not decode gets no rows, a `warn`, and its original still
  commits.** `renditions_of` returns an empty vector and never an error. An
  unsupported format, a truncated upload or a corrupt byte must not cost a
  member the photograph they took; the read's fallback already covers the cell.
- **The orientation tag is applied before scaling**, read off the decoder
  (EXIF for JPEG, `eXIf` for PNG/WebP), so the stored derivative needs no tag of
  its own. This is the defect a test most easily misses: a sideways thumbnail is
  still the right number of bytes and still decodes.
- **Nothing else survives the re-encode.** EXIF, XMP and ICC are gone by
  construction rather than by a strip pass someone can forget. A privacy
  property, not a size one — `thumb` is the rendition that travels first, to
  every admitted device, ahead of any rule a member set about originals.

### What the tests prove

`crates/vault/tests/derivatives.rs` builds its fixtures rather than shipping
them (a 4000×3000 JPEG with an EXIF orientation tag written by hand), so the
assertions are about pixels and not about a checked-in file.

| Test | What it proves |
| --- | --- |
| `an_exif_rotated_original_derives_upright_tiers_with_no_metadata` | One commit, two rows. A 4000×3000 original tagged orientation 6 comes back **3000×4000-shaped** — 270×360 and not 360×270, which is the assertion a deriver that ignored the tag fails and a byte-count assertion would pass. Both tiers are `image/jpeg`, both blobs are in the store under their own hash, and **neither contains an EXIF marker**. |
| `a_png_original_derives_jpeg_tiers` | The decode set is wider than the encode set on purpose. |
| `an_original_that_does_not_decode_commits_with_no_derivative_rows` | The refusal, from the outside: `CommandStatus::Executed`, the original's row present, zero tiers. A commit that failed on a bad thumbnail would be the worst possible trade. |
| `a_video_original_derives_nothing_in_this_build` | The deferral is asserted rather than assumed, so a future poster pass fails this test loudly instead of landing silently. |
| `the_backfill_sweep_derives_once_and_then_nothing` | A vault founded before this slice, made by deleting the tiers out from under two committed items: the sweep reports `considered: 2, derived: 2` and the rows come back; the **second** sweep reports `0, 0` and writes nothing. Idempotence and resumability are the same assertion. |
| `a_second_commit_of_known_bytes_re_derives_nothing` | `UNIQUE (content_id, variant)` is the rule; the existence check is what stops the decode from running at all. A dedupe that re-decoded would pay a full decode per duplicate upload. |
| `renditions.rs`'s own two | A non-image media type and undecodable bytes each derive nothing **and do not error** — the pure half's whole contract, without a vault. |

### What I found

- **Aspect fit, not crop, and no skip when the source is small.** `resize` fits
  inside the box, so a portrait original gives a portrait tier. A source already
  under the edge is **re-encoded at its own size** rather than skipped: a `thumb`
  row missing because the camera happened to be small would make the planner's
  first tier depend on the camera, which is exactly the bug the demo seeder was
  hiding.
- **RGB8 and not RGBA at the encoder.** JPEG has no alpha and `image`'s encoder
  answers an RGBA input with an *error*, not a flatten — so a PNG with one
  transparent corner would have had no thumbnail at all, silently. The flatten
  is this module's decision and `to_rgb8` makes it.
- **A refused store write must not leave a row.** The rendition loop writes the
  blob first and only then the row; a store that refuses one tier costs that
  tier and not the other, and never leaves a `core_content_derivative` row
  pointing at bytes nothing holds.
- **The sweep's selection reads the item's OWN representation** (`#996` R20(b))
  rather than guessing from a filename. An item nothing has ever declared a
  media type for is not an image as far as this vault is concerned, which is the
  same reading every other surface takes.
- **`image` 0.25 decodes WebP and cannot encode it.** The ruling allowed WebP
  "if a dependency already in the workspace supports it"; it half does, so WebP
  would cost a second dependency for a format-level win. JPEG is the free option.

### What I left, and why

- **A video gets no `poster` in this build**, and **HEIC/HEIF decodes nowhere.**
  Both are named deferrals with an owner question on the umbrella
  (D-1025-S7-52), not omissions: a frame extractor is ffmpeg-shaped and
  HEIC is either a `libheif` binding on the gateway or — the recommendation —
  the phone transcoding to JPEG at upload, where the hardware decoder already
  is. `needed_blobs` and `held_thumbnail` handle a missing poster already, so
  the cost is a grey cell and a video badge rather than a broken screen.
- **No dimensions on the row.** `renditions_of` knows the width and height it
  produced and the row does not store them (D-1025-S7-54). Nothing reads them,
  and adding two columns to carry a number every reader ignores is the invented
  value that later gets trusted. The DDL is unchanged, so
  `docs/vault-ontology.md`'s drift register is untouched.
- **The iOS live proof.** Both booted simulators belong to Slice 2's run; this
  slice's behaviour is gateway-side and fully covered by
  `derivatives.rs`. **Owed**, and the shape of it is one line: seed a vault from
  full-size originals, pair a phone, and the grid fills on the first foreground
  window instead of after an unmetered one.

### Commands

| Command | Result |
| --- | --- |
| `cargo fmt --all` | clean |
| `cargo test -p centraid-media -p centraid-vault -p centraid-blobs -p centraid-apps-photos -p centraid-seat` | **not completed on this host — OWED.** Started twice. The first run compiled through and then wedged: `centraid_apps_photos`'s lib binary sat at `dyld` for twenty minutes at **zero CPU time**, never reaching a test. The second is still queued behind another agent's full from-scratch dependency rebuild holding the shared artifact lock (`Blocking waiting for file lock on artifact directory`, over an hour). Both are host contention on a shared `target/`, not this slice: nothing here is a compile error and the second run never got as far as running a test. **No test was relaxed, skipped or marked ignored to get past either.** Output left at `scratchpad/sweep-s3{,b}.txt`; the second run is still going and its result is the thing to read. |
| Known red on this host, from earlier slices and untouched here | `centraid-vault`'s `backup::restore::tests::a_live_gateways_data_directory_is_refused_and_a_stale_lock_is_taken_over` and its `disk_full` case (`/dev/full`, which macOS has not), `centraid-blobs`'s `windows::a_blob_crosses_in_many_short_windows…` (a 10 s dial timeout), and `centraid-apps-photos`'s parity test (v0 oracle files the `claude/1020-retire-v0` merge removed). |

### THE DEFECT THIS SLICE ALMOST SHIPPED, AND WHAT IT CHANGED

**With a tail open, every `Request::Page` on that core hung for ever.** Slice 1's
agent found it on the phone: the photo grid sat on a spinner, killing the
gateway did not release it, and a relaunch with no gateway read instantly. The
cause was one mutex and it was the whole design: `Handle::with_vault` is the
lock every read takes, `sync_now` holds it for the length of a pass, and the
first shape of this slice made a tail **a pass that lasts as long as the member
has the app open**. So the tail held the vault while it waited for somebody else
to commit something.

The fix is that **the waiting and the applying are two different things on two
different threads**, and the seam is now in the trait:

| Step | Where | What it holds |
| --- | --- | --- |
| read the stream | a task in `crates/seat-link` (`read_tail`) | nothing |
| wait for a page | `SeatNetwork::await_tail_page`, called by `Handle::tail` | **nothing — outside the vault mutex** |
| apply what is in hand | `SeatNetwork::apply_tail`, inside `with_vault` | the vault, for the length of the pages already delivered |

`TailPages` is the queue between them, two pages deep, and the reader's
`deliver` waits for room — so a gateway committing faster than this device can
apply is slowed by QUIC rather than by this phone's memory. `QueuedTail` is the
`LogSource` the in-vault pass reads: **every one of its methods answers from
memory and none can wait**, which is the property that makes the defect
unrepeatable rather than fixed.

`crates/core`'s `a_read_answers_while_a_tail_is_open_and_quiet` is the
assertion, and it is written as the phone experienced it: a tail open on a vault
nobody is writing to, and an ordinary `Request::Log` on the same core, on
another thread, which must answer in well under the wait.

### The evidence, on an iPhone 17 simulator

The `Tahoe Slice2` corpus (`seed-demo-vault`), a `centraid gateway --no-relay`
on this build, a clean install of the app, and a throwaway CLI writer in the
scratchpad that pairs as its own device and submits one `core/add_party` intent
— because **there is no CLI path today that writes into a running gateway's
vault**, and reaching around the gateway to its SQLite file is the one thing
this product's model forbids. Screenshots in `proof-1025-slice2/`.

| What | Evidence |
| --- | --- |
| The tail opens on its own, with no tap | `a device paired … promoted in place device=dev_74da8e8c01c30b9a` at `11:40:29`, then **`a seat opened a tail on this vault device=dev_74da8e8c01c30b9a open=1`** at `11:40:31.448`. `10-tail-open-header-online.png` |
| The header says so | "Centraid — **synced**", which is `STATE_ONLINE`, for the whole of the run |
| **A commit reaches the device with no request** | CLI commit at `11:40:44.245`; `a commit rang the tail bell receivers=1` at **`11:40:44.245729`**, `a tail woke ok=true` at **`.245742`** — 13 µs — and `a tailing seat was served a page rows=5 next=42` at **`.246280`**. **No `LogRequest` in between**: the stream had been open and waiting since `11:40:31`. |
| The row is on the screen | People went **2 → 3** with the new "TB" (*Tailed Into Being*) lockup, **with no tap and no `Sync now`**. `11-row-arrived-no-tap.png` |
| Leaving the foreground closes it | app backgrounded at `11:41:01`; `a seat's tail closed device=dev_74da8e8c01c30b9a` at `11:40:56.657` |
| Two commits while away, both there on return | committed at `11:41:02` (commit_seq 8 and 10); foregrounded at `11:41:13`; `a seat opened a tail … next=54` at `11:41:14.174` — **the catch-up pass had already applied both before the tail reopened**, which is exactly the round's order. People **3 → 6**, with "While Away One" and "While Away Two" drawn. `13-foreground-catch-up.png` |

**"A tail is waiting for the next commit" is a `DEBUG` trace and not the
product's `parked`.** They are different words for different things and the log
line was renamed to stop them reading as one: `SyncOutcome.parked` is
[D-1025-S2-4](../docs/decisions.md#slice-s2--one-protocol-1025)'s state — three
re-bootstraps in a row, the repair stopped, the member told — and it is a
FAILURE MODE. A tail waiting is the healthy steady state of a device that is up
to date, and it is what the gateway prints between pages.

### What was not run, and why

- **`:shared:jvmTest`.** JDK 17 on this host, task needs 21 — unchanged from
  S7-13's note. `:shared:assembleCentraidSharedDebugXCFramework` is green and
  the Swift build links it, which is what proves `commonMain` compiles here.
  **No toolchain or Gradle config was changed to get around it.**
- **The Android app was edited and not compiled.** No `ANDROID_HOME`, no SDK.
  `MainActivity.onResume`/`onPause` were checked by reading.
- **`cargo build --target x86_64-apple-ios` fails in `iroh-blobs`** on this host
  and is unrelated to this slice; the XCFramework's x86 slice therefore carries
  an older core. The simulator used is arm64 and links the slice built here.
- **`cargo test -p centraid`'s suites are flaky on this host in exactly the way
  `docs/traps/first-dial-readiness.md` describes.** `seat_tail`'s three tests
  pass together and `a_rebootstrap_ends_the_tail` times out its PAIRING DIAL
  when run alone under load — before any tail exists. `seat_lane`'s
  `an_unenrolled_peer…` fails the same way and was failing before this change.
  **Left as found and named rather than papered over.**
- **The full gate loop**, by standing instruction.

## Slice S6 — the camera roll goes up (#1025)

Decision rows [D-1025-S7-70 … S7-77](../docs/decisions.md#slice-s6--the-camera-roll-goes-up-1025).

### The defect, and how much of it was missing

`IosMediaLibrary.page` threw `"not implemented"`, so a phone never uploaded a
photograph and the product was read-only on iPhone. That was the reported
defect, and it was the smaller half. **Nothing joined any of the parts.**
`MediaLibrary` could describe a roll and had no byte door at all; `Staging` —
the door the core hashes behind, added by S4 — had **no caller on any
platform**; `ScreenEffect.Backup` and `ScreenEffect.RequestMediaPermission` were
emitted into a `SharedFlow` **no runner collected**; and `BackupState` was drawn
by both shells with nothing but a permission change able to move it. Android's
enumerator worked and led nowhere either.

### What was built

- **`IosMediaLibrary`** — `PHAsset` enumeration keyset on `creationDate`, a
  streamed `PHAssetResource` byte door, a real `requestAuthorization`, and a
  `PHPhotoLibraryChangeObserver`.
- **`MediaLibrary.open` / `Original` / `Kind`** on the shared seam, with
  Android and the JVM fake brought to parity.
- **`CameraRoll`** — one bounded pass: enumerate from a durable per-vault
  cursor, stream each original into the core, queue `media.add_asset` naming the
  core's own hash and declaring `needs`.
- **`CameraRollRunner`** — the runner for the three effects nobody served.
- **`BackupStatus.swift`** and the Android banner's missing half.

### Four defects the simulator found that nothing else could

Each compiled, passed every unit test, and was wrong.

1. **`requestPermission` never asked.** It returned the CURRENT status behind a
   comment claiming the prompt belonged to the app. A member could press "Allow
   photo access" for ever and never see the system sheet. (D-1025-S7-72.)
2. **`close()` threw, and killed the app.** The first byte door piped Photos'
   push API into a rendezvous `Channel` and closed it with `cancel()`, which
   CONSTRUCTS AND THROWS a `CancellationException`. `close()` is called from the
   `finally` of `CameraRoll.offer`, so the throw escaped the pass, escaped the
   coroutine, and aborted the process the first time "Back up now" was pressed.
3. **A zero declared size refused every photograph.** `PHAssetResource`
   publishes no size, so the door declared `byteSize = 0` — and `Staging`'s
   declared length is "the allocation AND the BOUND", so `crates/core`'s
   `stage.rs` refused the first chunk of every original with *the chunks carry
   more bytes than the 0 declared*. The screen read "Centraid could not read its
   own request". The door now writes the resource to a temporary file with the
   documented `writeData(for:toFile:)`, states its exact length, and streams it
   with an `NSFileHandle` — which also deletes the backpressure problem instead
   of solving it.
4. **The screen never learned the grant it already had.** Only the ASK sent a
   `PermissionChanged`, so a member who had granted access on an earlier launch
   came back to "Allow photo access" over a library the app could already read.

### THE BLOCKER: a seat cannot queue `media.add_asset` at all

**This is not fixed here and is not this slice's to fix.** With everything above
working — permission granted, pass running, bytes staged, the core's hash in
hand — the intent is refused with:

```
no such table: blob_staging
```

`Handle::queue_write` runs `self.predict(&queueing)` before queueing: the seat
executes the REAL handler against its own replica to produce the optimistic
overlay. `media.add_asset`'s handler reads `blob_staging` (`staged_meta`), and
**`blob_staging` is a gateway-private table that is not in any replica** — the
gateway's `vault.db` has it, a seat's copy does not. `queue_write`'s own comment
says a prediction that cannot be made must not stop the write and that "only the
registry and the schema refuse, because those two are facts about the BUILD" — a
missing table is exactly that case, so the refusal is by design and the write
never reaches the outbox. `crates/centraid/tests/bytes_upward.rs` is green
because it writes the `IntentRecord` into `Outbox` **directly in Rust**, past
this door; no test in the tree sends `Request::Intent` for `media.add_asset`
from a seat.

So the upload path is complete on the phone's side and dead one layer below it.
The two shapes an owner can choose between:

- **`predict` skips a handler whose refusal is a missing PRIVATE table**, which
  keeps the badge-without-value behaviour the comment already sanctions for a
  copy that is behind; or
- **`media.add_asset`'s staged-metadata read tolerates an absent
  `blob_staging`** (a seat has no staging band and never will — the staging row
  is the GATEWAY's record of a byte door it ran).

Owner question on [#1025](https://github.com/srikanth235/centraid/issues/1025).
It touches `crates/core/src/handle.rs` and `crates/vault/src/commands/media.rs`,
both outside this slice's brief and one of them another slice's this wave.

### Two more findings, filed rather than fixed

- **`Error.detail` reaches a member's screen.**
  `mobile/core/.../CentraidCore.kt:368` builds the member-facing sentence as
  `error.detail.ifBlank { … }`, so a raw SQLite `no such table: blob_staging`
  was rendered on the Photos screen. That is the logs-only rule broken at the
  binding, and it is the same shape as #1020 wave 3 lane E finding 2. It is in
  `mobile/core`, which no slice in this wave was given; left so this slice's own
  evidence stayed readable, and named here.
- **The Photos screen does not inset its own content.** `PhotosGridView` is a
  `NavigationStack` destination whose body is a plain `VStack`, so its band row
  and the backup row both render under the Dynamic Island and the navigation
  bar — and the bar does not merely cover the buttons, it **takes their taps**.
  Three taps on a fully visible "Back up now" reached nothing. `BackupStatus`
  carries a `safeAreaPadding(.top)` plus a 44 pt compensation so this surface is
  usable; the screen should inset once, for the bands and this alike. That file
  is another slice's this wave.
- **The four permission sentences are duplicated** between
  `PhotosGridMachine.pausedReason` and `CameraRoll.permissionSentence`.
  `CameraRollSpec` pins the literals so a one-sided rewording fails; folding both
  into `dev.centraid.design.Copy` is the right end state and is a doc-pass item.

### PHAsset edge cases the ruling did not anticipate

- **`NSPredicate` over `PHAsset` cannot express `localIdentifier`.** Photos
  supports a small fixed key set and raises otherwise, so the keyset's tiebreak
  cannot reach the fetch. The predicate is `creationDate >= cursor` and the
  overlap is dropped in Kotlin. (D-1025-S7-70.)
- **`PHAsset` publishes no capture time zone**, at any deployment target. The
  offset is EXIF, inside the bytes, on the gateway's side of the door. Every
  upload carries `tz_offset_min = 0` rather than the reader's zone, which would
  re-date a library by where it was uploaded. (D-1025-S7-77.)
- **`PHAssetResource` publishes no size.** See defect 3 above.
- **`presentLimitedLibraryPicker` is declared in PhotosUI**, not Photos, though
  it hangs off `PHPhotoLibrary`.
- **The phone's own id for a photograph has nowhere to go.**
  `media.add_asset`'s `source_asset_id` is an FK to `media_asset(asset_id)` and
  means EDIT LINEAGE (#711); `camera_device_id` is an FK to `access_device`, not
  a camera NAME. So the ruling's "camera device name if exposed" is not carried:
  there is no column for it and `additionalProperties: false` would refuse it.
  The absence of any device-id column is also why the durable cursor and the
  content-hash intent id both have to live on the phone. (D-1025-S7-73.)
- **Kotlin default arguments do not cross into Swift.** `PhotosBridge.attach`
  needed two overloads; the single defaulted parameter compiled and then failed
  the app build with "missing argument for parameter 'services'".

### Evidence

`/private/tmp/claude-502/-Users-srikanth-gitspace-centraid/52a09717-5dd8-486e-8df2-7d9115df07e1/scratchpad/proof-1025-slice6/`

| Shot | What it shows |
| --- | --- |
| `01-permission-prompt.png` | the system sheet, with this repo's own purpose string — the thing the old `requestPermission` could never reach |
| `02-permission-granted.png` | the grant taken |
| `03-paired.png` | "Slice 6 vault / synced", 19 seeded photographs, gateway log showing bootstrap and an open tail |
| `05-blob-staging-refusal.png` | the blocker on the screen: the pass ran, the bytes staged, the intent refused |

The gateway is a throwaway seeded with `seed-demo-vault` into
`<data-dir>/vault/v1/vault.db` and started `--no-relay`; its log is beside it.
Reads of it were against a **copy**, never the live file.

### What was not run, and why

- **The end-to-end upload proof** — blob pulled, content row committed, thumb
  and preview derivative rows, the photograph appearing in the grid,
  re-enumeration queueing nothing. **Blocked by `blob_staging` above**, not by
  anything on the phone. Everything up to and including the core naming the
  bytes is proved; the step after it cannot run on any seat in this tree.
- **`:shared:jvmTest` runs here after all**, on the Homebrew JDK 21 that
  `/usr/libexec/java_home` does not register: `JAVA_HOME=…/openjdk@21/… ./gradlew
  :shared:jvmTest`. No Gradle or toolchain file was changed; the JDK was pointed
  at for the invocation. On the first full run with this slice's code in place it
  was **224 tests, 0 failures**, `CameraRollSpec`'s 13 included. A later run is
  **234 tests, 5 failures** — ten tests APPEARED between the two runs and all
  five failures are in the slice running beside this one (`AppReadsSpec`'s new
  `PhotoCell.Held`, `SyncWindowPolicySpec`'s night shift, `ShellCommandsExistSpec`
  on a seat command name, `PerAppLayoutSpec` on `HomeSession` importing
  `PhotosReads`, and `NativeAccessibilityLintSpec` on `Image(systemName:)` in
  `VaultHeader.swift` and `PhotosGridView.swift`). **None is in a file this slice
  wrote**, and `CameraRollSpec` is 13/0 in that run too. Left as found.
- **`:shared:iosSimulatorArm64Test`** is green, including
  `IosMediaLibrarySpec`'s 7. The `iosTest` source set is new and brings only
  `kotlin("test")`, which Kotlin/Native already ships.
- **The Android app was edited and not compiled.** No `ANDROID_HOME`, no SDK.
- **`crates/core` was broken mid-run by another slice** (`api.rs` against
  `centraid_vault::page`); no Rust file was touched here and the seed was retried
  once it built.
- **The full gate loop**, by standing instruction.

## Slices S4 + S5 — the member's transfer rule, and fetch this one now (#1025)

Decision rows **D-1025-S7-60 … D-1025-S7-63** (the rule, the header line, the
cell's closed enum, `seat.bytes.fetch`), plus **D-1025-S7-64** and
**D-1025-S7-65** written by this pass.

### Where this was picked up

The slice was largely built and left uncommitted when the host restarted. The
Rust half was complete and green — `Budget::{under, just, admits_original}` and
its table tests in `crates/blobs/src/plan.rs`, `TransferRule` and
`originals_withheld` on `crates/core/src/link.rs`, `seat_bytes_fetch` with its
three refusals in `crates/core/src/handle.rs`, `bytes::{holds, knows}` in
`crates/seat` — and so were both docs sections and all four decision rows. **The
Kotlin half did not compile**: `HomeSession.attachScreen` passed `fetches` to a
`ScreenRuntime` that had no such parameter, so `ScreenFetches` and
`PhotosFetches` were an interface and an implementation with nothing between
them — the download arrow emitted `ScreenEffect.FetchOriginal` and **nothing
served it**. That runner arm is what this pass wrote, plus the four Kotlin
reds the slice beside it had already reported.

### The tap's runner, and the window it rides

`ScreenRuntime` now collects `FetchOriginal` for its own screen and sends
`seat.bytes.fetch` down the same door every command uses, launched rather than
awaited — a fetch is a whole foreground window over a multi-megabyte file and a
collector that waited would stop serving that screen's reads for the length of a
download. The window is the SHELL's, from `SyncWindowPolicy.current`, carried so
the core's echo is honest; it cannot change the outcome, because the one-item
narrowing is checked before the rule (D-1025-S7-63). Every path sends a settle
event, the failures included.

### Four reds, and what each one was

| Red | What it actually was |
| --- | --- |
| `ShellCommandsExistSpec` | The oracle searched for the LITERAL `= "$command";`: the spec escaped its own interpolation (`${'$'}command`), so the check passed over a string no source contains and would have gone green on a typo'd command name. Fixed to interpolate. |
| `SyncWindowPolicySpec` | The spec asserted `MANUAL` + charging + unmetered is a SHORT REFRESH. The code says night shift, and the code is right — see D-1025-S7-64. The assertion moved, with the reason written next to it. |
| `AppReadsSpec` | A six-column fixture against a door that now appends three (`thumbnail_path`, `original_hash`, `original_held`). Updated, and the cell's `held` is now asserted rather than defaulted. |
| `PerAppLayoutSpec` | `HomeSession` imported `PhotosReads` to write the rule and the metered bit onto it — the shell naming an app's type. `LinkConditions` in `sync` is where both may look (D-1025-S7-65). |
| `NativeAccessibilityLintSpec` | The download arrow and the rules sheet's radio dot each drew an `Image(systemName:)` with no label. Both are now `accessibilityHidden(true)` under a labelled button, and the radio row gained `.isSelected` so VoiceOver says "selected" rather than "filled circle". |

### The first-copy ordering question, answered

**Yes — the pass right after a bootstrap adoption runs the byte stage in the
same foreground window, thumbnails first.** `Handle::sync_now` adopts and then
calls `pass(network)` inside the same call rather than returning for the next
window (`crates/core/src/handle.rs`, the `!self.holds_a_replica()` arm), and
`centraid_seat::sync` runs its byte stage as step 5 of that pass, after the rows
that name the blobs. The order inside it is `Tier`'s: every thumbnail before
every preview before any original. So a freshly paired phone fills its grid in
the window it paired in, and does not wait for a second one.

### Green

| Command | Result |
| --- | --- |
| `cargo test --no-fail-fast -p centraid-blobs -p centraid-seat -p centraid-core -p centraid-core-ffi` | green but for the known host red `blobs::windows::a_blob_crosses_in_many_short_windows_and_no_byte_is_moved_twice` (`the seat dials the one plane: Timeout(10s)`) |
| `:shared:jvmTest` (Homebrew JDK 21, `JAVA_HOME` pointed at it for the one command; no config changed) | **234 tests, 0 failures** |
| `:shared:assembleCentraidSharedDebugXCFramework` | green |
| `xcodebuild -scheme Centraid -sdk iphonesimulator` | **BUILD SUCCEEDED**, installed and launched on a fresh iOS 26.5 simulator |

### What was not run, and why

- **The live fetch proof did not reach the grid this pass.** A throwaway gateway
  was seeded (`seed-demo-vault`: people 12, notes 7, docs 5, photos 19, agenda 5,
  tasks 9, tally 10) and started `--no-relay`, the app was built and installed on
  a NEW simulator, and the Gateway sheet took the ticket — but the pairing was
  refused (`an unenrolled peer did not pair — its pairing code was refused`)
  because the simulator's text injection does not reproduce a base64url ticket
  character for character, and the pasteboard route needs an edit menu that
  would not open. The screens themselves are unchanged from the run that
  photographed them (`proof-1025-slice45/10..13`: rule `MANUAL`, the header
  reading "19 originals waiting for Wi-Fi", every cell carrying the arrow, and a
  tapped cell in `HELD_FETCHING`); what this pass has NOT re-proved on a device
  is the tap's runner it wrote. **That is the one thing left to demonstrate.**
- **The Android app was edited and not compiled.** No `ANDROID_HOME`, no SDK.
- **The full gate loop**, by standing instruction.

## The five defects the review left open (#1025)

Picked up from a killed run, whose edits were on disk and uncommitted. Each
heading says **where the state was found** before anything was changed.

### 1. The gateway's allowlist did not survive the gateway

**Found:** `crates/centraid/src/run.rs:115` still built a `MemoryAllowlist` and
line 160 still printed "the device allowlist is still IN MEMORY (D-1020-C8)".
`crates/vault/src/devices.rs` had been started — `device_by_public_key` was
added and documented — and nothing consumed it.

**Root cause, and it has TWO halves.** Enrolment was in memory, so a restarted
gateway refused a device it had enrolled. And `run.rs` built its endpoint from
`EndpointConfig::default()`, whose `secret_key` field is `None` — a FRESH
identity every start — so the gateway was also unreachable at the only address
its seats had, before admission was ever asked. Fixing the allowlist alone would
have gone green on a gateway no seat could dial.

**Change.** `crate::allowlist::GatewayAllowlist` (new, `crates/centraid/src/
allowlist.rs`) is `Memory | Durable`; the durable arm reads and writes the
vault's own `access_device` / `access_device_secret` rows through `Handle::
with_vault`, so it holds no SQL and the `sql-confinement` invariant is kept by
moving the design rather than widening the rule. `crates/vault/src/devices.rs`
gains `live_devices_with_keys` — the member's list deliberately carries no
credential, so the gateway asks by a different name. The warning is deleted; a
gateway that took a `--data-dir` and could not open a core says THAT instead.
The endpoint secret is 32 bytes under `gateway.endpoint.key` in `<data-dir>/
keys`, through the `KeyStore` that already holds the export and backup masters.
`EndpointSecretKey` is re-exported from `crates/net` so a caller can keep a key
without depending on `iroh`.

**Tests.** `allowlist::tests` — three, and they are the proof: an enrolment made
through one `Handle` is admitted by a SECOND `Handle` opened over the same file
after the first is closed; a revocation is still a refusal after that reopen;
and a ticket burns once and does not survive the restart. `tests/seat_identity.
rs::a_gateway_restart_keeps_the_devices_it_enrolled_and_the_one_it_revoked`
holds the same three facts end to end over real QUIC — three gateway processes
over one data directory — and is **red on this host for the host's own reason**
(see below). `tests/no_listener.rs`'s durability warning test is INVERTED rather
than deleted: it asserted the product said it forgets its pairings, which is no
longer true.

**Docs.** D-1025-S7-80 and D-1025-S7-81 in [decisions.md](../docs/decisions.md),
superseding D-1020-C8's placeholder; [enrollment.md](../docs/enrollment.md)
gains where a v1 gateway keeps an enrolment and the two operational
consequences of a restart; [SECURITY.md](../SECURITY.md)'s trust-anchor rows for
the gateway identity and the paired device key name the v1 locations.

### 2. `blob_staging` — a seat could not queue an upload

**Found:** already fixed on disk in `crates/vault/src/commands/core.rs`.
`promote_staged_blob` now falls back to the bytes the vault's OWN store holds
when no staging row names them, so a seat's `predict()` no longer earns the
`InvalidInput` refusal that `Handle::predict` classifies as "this build cannot
run that write" and refuses at the door. Verified by reading the seam and by
`tests/seat_queue_write.rs` / `tests/bytes_upward.rs`. Nothing further changed.

### 3. The backfill sweep never ran

**Found:** already fixed. `Handle::derive_missing_tiers` guards on
`!self.is_gateway() || !self.holds_a_replica()`; the old predicate's second
clause was true of a gateway too, so the sweep answered `Ok(0)` at every start.
`tests/derive_sweep.rs` drives it through the `Handle` on a gateway core with
derivative rows deleted.

### 4. The test reds

**Found:** `crates/vault/tests/one_hash.rs` already carries `seat/src/held.rs`
in its writers registry; the two command-count tests and the
`crates/seat/src/bytes.rs` unit fixtures already declare
`core_content_representation`. One red was left and it was NOT in the brief:
`crates/net/tests/pair_and_stream.rs` would not compile — `LogRequest` gained
`tail` from the slice running beside this one. Fixed with the one field the call
already meant (`tail: false`).

### 5. `Error.detail` reaching members

**Found:** already fixed in `mobile/core/.../CentraidCore.kt` — the member's
sentence is `error.sentence.ifBlank { … }` and never the detail — with
`AbiContractSpec`'s two cases asserting it, including the literal
`no such table: blob_staging` that reached the Photos screen. The detail is not
logged by the binding itself; it rides `CoreFailure.Refused.detail`, which is
where the shell's own logging reads it. Left as found.

### Green, and every red named

`cargo test --no-fail-fast -p centraid -p centraid-core -p centraid-core-ffi
-p centraid-seat -p centraid-vault -p centraid-net`. The three fixes that have
deterministic tests are green: `allowlist::tests` 3/3, `tests/seat_queue_write.
rs` 2/2, `tests/derive_sweep.rs` 2/2, and `tests/no_listener.rs`'s inverted
durability test. Thirteen test binaries report a failure and every one is
accounted for:

- **The QUIC dial family, and it is this HOST.** `seat_bootstrap`,
  `seat_offline`, `seat_lane`, `seat_tail`, `seat_identity`, `bytes_upward`,
  `walking_skeleton`, `no_listener`'s ABI loop, and `centraid-net`'s
  `pair_and_stream` / `an_unroutable_peer_fails_typed_inside_the_timeout` all
  fail at the pairing dial — `GatewayUnreachable`, `Timeout(10s)`, or "the
  gateway printed no ticket within 30s". `a_seat_survives_losing_the_network…`
  was re-run **alone on an idle machine** and fails the same way, so it is not
  contention; the shipped binary starts, founds its vault, prints its ready line
  and its ticket in seconds when run by hand. This is the known `--no-relay`
  LAN-dial red of this machine, named in the brief.
- **`tests/seat_identity.rs::a_gateway_restart_keeps_the_devices_it_enrolled…`
  is in that family**, which is why the durability proof does not rest on it:
  the three `allowlist::tests` hold the same three facts through two `Handle`s
  over one file, with no network in the way.
- **`cmd::gateway_install`** — macOS, `--system` is systemd. Known.
- **`backup::restore::tests::a_live_gateways_data_directory_is_refused…`** and
  **`a_full_disk_during_a_snapshot_build…`** — the vault live-data-dir and
  disk_full reds. Known.

Kotlin, on the unregistered Homebrew JDK 21 (`JAVA_HOME=/opt/homebrew/opt/
openjdk@21/libexec/openjdk.jdk/Contents/Home ./gradlew …`, no config change):
`:core:jvmTest` green, `:shared:jvmTest` green,
`:shared:assembleCentraidSharedDebugXCFramework` green.

**Not done:** [mobile-offline.md](../docs/mobile-offline.md) describes no
in-memory allowlist, so there was nothing there to correct; the allowlist's
current state is stated in [enrollment.md](../docs/enrollment.md) and
[SECURITY.md](../SECURITY.md) instead.
