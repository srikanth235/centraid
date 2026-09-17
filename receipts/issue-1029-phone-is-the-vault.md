# Receipt — the phone is the vault ([#1029](https://github.com/srikanth235/centraid/issues/1029))

One receipt for the umbrella. Each wave appends a section; the state this
produces lives in [docs/decisions.md](../docs/decisions.md) and the docs the
umbrella's doc pass touches, and where the two disagree the doc is what is
current.

## W0.5 — identity (lane A): keys, certificates, HPKE, safety numbers

`crates/identity` is new, and it is the whole of the product's identity model:
one 24-word phrase, a SLIP-0010 hardened tree under it, and the four things
built on the leaves — device certificates, HPKE to a box key, and the safety
number two people read to each other.

### What landed

| Where | What |
| --- | --- |
| `crates/identity/Cargo.toml` (new) | `centraid-identity`, lib `centraid_identity`. Deps: `bip39`, `ed25519-dalek`, `x25519-dalek`, `hpke`, `hmac`, `sha2`, `blake3`, `rand`, `hex`, `subtle`, `base64`, `thiserror`. |
| `crates/identity/src/lib.rs` (new) | `#![forbid(unsafe_code)]`, the module map, and the standing rule that the SHA-2 in this crate is spent on published specifications and nothing else. |
| `crates/identity/src/phrase.rs` (new) | `RecoveryPhrase` — generate from `rand::rngs::OsRng`, parse, the settings re-check, and `Seed`. No BIP39 passphrase, deliberately: a second secret with no recovery path. Both secrets have a redacting `Debug`. |
| `crates/identity/src/derive.rs` (new) | SLIP-0010 hardened derivation. `AccountKey::derive` is `seed / account'`; `VaultMint::mint` is `seed / vault'(i) / {identity', box', root'}`. `VaultMint` carries the account's high-water mark and refuses an index at or below it (F2). `restore_vault_keys` re-derives a known index without moving a mark. |
| `crates/identity/src/certificate.rs` (new) | `DeviceKey` (random, per phone), `DeviceCertificate` ("K certifies D at epoch E", signed by K over all three), `Epoch` (monotonic `u64`, saturating), `DeviceTrust` (holds the highest epoch accepted and refuses an equal or lower one). |
| `crates/identity/src/sealed_box.rs` (new) | HPKE base mode, DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM. `AssociatedData { kind, role }` is length-prefixed and bound into the AEAD. |
| `crates/identity/src/safety_number.rs` (new) | 60 digits in 12 groups of 5, BLAKE3 over the two identity keys **sorted by their bytes**, so both people read the same number. |
| `crates/identity/tests/identity_vectors.rs` (new) | Generates and diffs `contracts/crypto/identity-vectors.json`; `CENTRAID_UPDATE_FIXTURES=1` regenerates and the comparison still runs. |
| `crates/identity/tests/rfc9180.rs` (new) | Replays RFC 9180 Appendix A.1 — the RFC's recipient key, encapsulated key, ciphertexts and exported values. |
| `contracts/crypto/identity-vectors.json` (new) | The account key, three vaults' identity/box/root values, and the rendered safety number, from BIP39's zero-entropy phrase. |
| `contracts/crypto/rfc9180-vectors.json` (new) | RFC 9180 Appendix A.1's base-mode vector, transcribed from the CFRG file `hpke 0.14.1` ships. Nothing in this repository produced these bytes. |
| `Cargo.toml` | Workspace entries for `bip39`, `ed25519-dalek`, `x25519-dalek`, `hpke` and `hmac`, each with the reason its feature set is pared to what one ciphersuite needs; the `sha2` comment widened to name `crates/identity` as `xtask`'s co-tenant of the carve-out. |
| `Cargo.lock` | The resolved graph for the above. |

### Where the vectors come from, and why it matters

Three of the four things this lane pins have a published answer, and this lane
uses it rather than its own output:

- **BIP39** — the zero-entropy English phrase, and its empty-passphrase seed,
  checked against a PBKDF2 implementation outside this workspace before the
  constant was written (`phrase.rs`).
- **SLIP-0010** — ed25519 test vector 1, master node and three hardened
  children, asserted against `Node` directly (`derive.rs`).
- **RFC 9180** — Appendix A.1's ciphertexts, opened with A.1's recipient key
  (`tests/rfc9180.rs`).

`contracts/crypto/identity-vectors.json` is the one fixture this repository
generates, because the paths and the safety-number rendering are ours. Per
Reference A, **D-1020-R1 is dropped pre-release**: nothing has shipped, so these
are regression vectors, freely regenerated until first release. The test's
module header says so and names what has to be deleted to end it.

### Rulings spent

- **W0.5-R1 — standards-mandated hashes are somebody else's protocol.** SHA-512
  (BIP39's PBKDF2, SLIP-0010's HMAC) and SHA-256 (RFC 9180's HKDF) enter the
  workspace, restricted to `crates/identity`, as the same carve-out `xtask`
  already holds for Subresource Integrity and the Actions cache key
  (D-1025-S4-5). `blake3` remains ONE HASH for everything this repository
  defines itself — the safety number is BLAKE3 for exactly that reason. **This
  is a root ruling put to the owner with a recommendation, not a settled
  decision**; the `docs/decisions.md` supersession of D-1025-S4-5 is W9's. If
  the owner refuses it, `phrase.rs`, `derive.rs` and `sealed_box.rs` change
  shape, and the crate leaves the BIP39/SLIP-0010/RFC 9180 standards behind
  with them.
- **W0.5-R2 — the pair ticket is W2's move.** `crates/net/src/ticket.rs` is
  untouched here.
- **F2 — a vault index is never reused.** A typed refusal
  (`DeriveError::VaultIndexReused`), not a comment.
- **F3 — epochs are monotonic; backup generations are random.** Nothing in this
  crate orders anything by a generation.
- **D-1020-R1 dropped pre-release** — see above.

### Decisions this lane made that are not in a ruling

Recorded here because `registry-completeness` says a decision this lane makes
goes in the receipt; the `docs/decisions.md` entries are W9's.

1. **The account key takes `0x7fff_ffff`, the top of the hardened space, and
   vault indices are the plain counting numbers.** The alternative — an offset,
   so vault 0 is `m/1'` — puts arithmetic between the number in the account
   record and the number in the path, and that arithmetic is exactly what F2
   says must never be got wrong. `VaultMint` refuses the reserved index by
   name.
2. **The box key is the leaf at `box'`, a sibling of `identity'` under the same
   vault node.** Reference B forbids converting the Ed25519 key; this is the
   shape that satisfies it with one tree and one master tag.
3. **No BIP39 passphrase.** `RecoveryPhrase::seed` takes no argument. A
   passphrase is a second secret with no recovery path, and a person who
   forgets it cannot tell that from a mistyped word. Adding one later is a new
   method, never a changed default.
4. **`AssociatedData` is length-prefixed.** `kind = "ab", role = "c"` and
   `kind = "a", role = "bc"` must not be one string.
5. **`SealError::Open` is one variant for decapsulation and for the AEAD tag.**
   Telling a caller which half of their guess to keep is an oracle.
6. **A device certificate carries the identity key inside the signed bytes**, so
   relabelling a genuine certificate with a victim's key does not make it
   verify. There is a test for exactly that.

### Found, not fixed — not this lane's slice

- **`cargo fmt --all --check` fails on 18 files that predate this branch**:
  `crates/centraid/src/{allowlist.rs,main.rs,run.rs,tails.rs}`,
  `crates/centraid/src/cmd/native_host/methods.rs`,
  `crates/centraid/tests/{byte_lane.rs,bytes_upward.rs,derive_sweep.rs,seat_bootstrap.rs,seat_identity.rs,seat_lane.rs}`,
  `crates/core/src/handle.rs`, `crates/media/src/renditions.rs`,
  `crates/seat-link/src/{link.rs,seat.rs}`, `crates/seat/src/{bytes.rs,sync.rs}`,
  `crates/vault/tests/derivatives.rs`. `cargo fmt --all` was run once, its
  edits to those files were reverted, and none of them are in this lane's
  commits — another lane owns them and a formatting sweep from here would
  collide.
- **`cargo clippy --workspace --all-targets -- -D warnings` fails on
  `crates/vault/src/log/guard.rs:47`** — `field 'capture' is never read` on
  `CommitTx`. Pre-existing, and `crates/vault` is not this lane's.
- **`hpke`'s deterministic-encapsulation seam is `pub(crate)`**, so the RFC 9180
  replay covers the receiver half only. What that leaves unproven is the
  ephemeral keypair generation, which is `getrandom` and not a format decision;
  decapsulation, the key schedule and the AEAD are shared by both directions.
- **Lane B's surface exists but has no consumer yet.**
  `DeviceCertificate::{to_bytes,from_bytes}` is the fixed-width form the pkarr
  record's `cert=` entry carries, and `SealedBox::{to_bytes,from_bytes}` is
  `enc ‖ ct`. Both are tested here and neither is called outside this crate.
# Issue #1029 — the phone is the vault

Umbrella receipt. One receipt for the whole umbrella; each wave appends its own section below and never edits a section above it.

## Checklist

- [ ] **W0.5 — `crates/identity`**: the phrase, SLIP-0010 derivation, device certificates with epochs, HPKE, safety numbers
- [ ] **W1 — phone authority** (§1): `Role` deleted, the seat out of `crates/core`, the locker and `ChangeSink` into it, the pragma set and connection topology, `log/guard.rs` cut down, change events from an `update_hook`, the principal from the handle
- [ ] **W2 — deletions** (§8): `crates/seat`, `crates/seat-link`, `crates/sim`, `crates/automations`, `crates/assist`, `desktop/electron`, the iroh plane, `crates/centraid`'s gateway role
- [ ] **W3 — capture**: commit-bounded page segments, spooled before checkpoint
- [ ] **W4 — the standalone adapter**
- [ ] **W9 — `docs/decisions.md`**: this umbrella's rulings and its supersession chains
- [ ] **W10 — reminders**: `centraid_vault::time::rrule` over the `update_hook`

## W1 — phone authority (lane A)

Lane A is the Rust half: `crates/core`, `crates/core-ffi`, `crates/vault`. **Four of the six slices landed; W1-1, W1-2 and W1-4 are blocked on wave ordering** — see _What did not land_ below, which is the finding this section exists to file.

Base `62e5c608`. Law digest at brief time `d58a237d3db1`; the law has since moved to `5d92d58fe753` (W0.5 landing at `c48251ac`), and `node .governance/law/run.mjs --brief-digest d58a237d3db1` reports 10 rules and no findings against this branch.

### What landed

| Commit | Slice | Files, by full path |
| --- | --- | --- |
| `8e795dcf` | W1-3, the pragma set and the connection topology | `crates/vault/src/file.rs` |
| `b7cef6f8` | W1-5, the principal from the handle | `crates/core/src/api.rs`, `crates/core/src/handle.rs`, `crates/core/src/convert.rs` |
| `9d82d280` | the commit guard's dead capture handle | `crates/vault/src/log/guard.rs`, `crates/vault/src/commands/mod.rs` |
| `ad4d1a15` | W1-1's locker move | `crates/seat/src/locker/{mod,fill,session,unlock}.rs` → `crates/core/src/locker/{mod,fill,session,unlock}.rs`; `crates/core/Cargo.toml`, `crates/core/src/lib.rs`, `crates/core/src/api.rs`, `crates/seat/Cargo.toml`, `crates/seat/src/lib.rs`, `crates/centraid/src/cmd/seat/{local,locker,server}.rs`, `crates/centraid/src/cmd/native_host/{fold,relay}.rs`, `crates/vault/src/commands/locker.rs`, `crates/apps/locker/{README.md,src/{lib,manifest,queries,totp,watchtower}.rs}`, `docs/mobile-offline.md`, `docs/security/locker-origin-matching.md`, `Cargo.lock` |

**W1-3, the pragma set.** `journal_mode` and `foreign_keys` were the only pragmas ever set, so the vault's durability was a property of whichever SQLite the build linked. Now stated on every connection `crates/vault` opens, in `Vault::apply_pragmas`: `synchronous = FULL` (F11 — under WAL the compiled default is `NORMAL`, which acknowledges a commit before its frames reach the disk and so leaves the spool holding a commit the phone lost), `wal_autocheckpoint = 0`, `journal_size_limit`, and `SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE`. `page_size` is pinned at `PAGE_SIZE = 4096` and `auto_vacuum` is `NONE`, both stated in `Vault::create_with` where a header pragma can actually take. No `secure_delete`. `Vault::wrap` is the funnel, so _one opener, one pragma set, one connection per vault_ is now an invariant with its reason written at the connection.

**W1-5, the principal.** `api::invoke` read `request.principal` and refused a command carrying none. It now takes `&Principal` and `Handle::owner()` supplies it from `OWNER_DEVICE`. `convert::principal_from_wire` is deleted — it was the core's only producer of `Principal::Agent`, and nothing else called it.

**The locker.** `crates/seat/src/locker` → `crates/core/src/locker`, whole (git records three of four files `R100`). D-1020-L3 placed it in `crates/seat` because the boundary was "not the gateway"; that split is gone, so the header now states what the rule protects — `K` becomes plaintext only on a device whose owner has just proved they are present, and only for `REVEAL_WINDOW_MS` — rather than which role it refused. Its one real consumer, `crates/centraid`'s native-host lane, is repointed at `centraid_core::locker`.

### Rulings spent

- **F11** — the durability order. `synchronous = FULL` is the pin and it is explicit, never inherited.
- **§1** — the pragma set, the page size, the connection topology, `api::invoke`'s principal, and the locker's move into `crates/core`.
- **§6** — there is no paired client in v0. The principal has no second caller to authorise; the locker's boundary is a device rather than a role.
- **D-1020-L3** — superseded in its _location_ and its _vocabulary_, preserved in its _numbers and its mechanism_. `docs/decisions.md` is W9's.
- **D-1020-D2-9** — the one-mutex justification is superseded by a stronger one: under capture the single connection is required in both directions, not merely convenient.
- **Doctrine 6** (unsafe lives only in `crates/core-ffi`) — see the `PERSIST_WAL` row below.

### What the conversion exposed

1. **`CommitTx::capture` was dead** (`crates/vault/src/log/guard.rs`). The field was `Option<&'guard RefCell<Capture<'conn>>>`; `Vault::commit` filled it and then decoded the sessions through its own binding, so a handler gained no reach it did not already have — while the field cost the type a lifetime parameter that rippled into `commands::CommandCtx<'tx, 'conn>`. **Fixed in place** (`9d82d280`), removed rather than wired up: the capture hook §2 wants is W3's to place, and a field nothing reads is not a seam, it is a claim every later reader has to disprove.
2. **`wire::Command.principal` is now read by nothing.** Deleting the field is the contracts lane's. `crates/core/src/handle.rs::a_principal_on_the_request_does_not_change_who_the_command_runs_as` pins the behaviour meanwhile: filling it with the strongest claim the old vocabulary had changes no answer.
3. **`SQLITE_FCNTL_PERSIST_WAL` is not set, deliberately.** rusqlite 0.40 exposes no safe `sqlite3_file_control`, and `crates/vault` is `#![forbid(unsafe_code)]` with unsafe confined to `crates/core-ffi` (doctrine 6). `SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE` already keeps the WAL, since SQLite only removes it after the close-time checkpoint it now skips. **Owner question:** accept that as the whole of the requirement, or route `PERSIST_WAL` through a `crates/core-ffi` shim? Recommendation: accept — the two settings overlap on the property #1029 §1 actually names, and a shim would put an unsafe call in the FFI crate for a vault concern.
4. **`Principal::Agent` stays.** The brief's condition was "if nothing else references it". It is referenced: `crates/vault/src/access.rs` (8 sites), `crates/vault/src/commands/people.rs:195`, `crates/vault/src/commands/core_links.rs:310`, `crates/assist/tests/prompt_injection.rs:62`. `grep -rn 'Principal::Agent' crates/ --include=*.rs` → 11 hits outside the deleted `convert.rs` branch. It goes with `crates/assist` in W2.

### What did not land, and why

**W1-1, W1-2 and W1-4 are blocked on wave ordering, not on effort.** The brief's State table counts `crates/core`'s 109 seat imports and stops there. It does not count the consumers of what those imports define:

```
grep -rln 'centraid_core::link\|centraid_core::Role\|SeatNetwork\|CommitBell\|TailStopper\|BootstrapRefusal\|SyncWindow\|SyncBudget\|TransferRule\|PairRefusal\|PairedGateway' \
  crates/centraid crates/seat-link crates/sim --include=*.rs
```

→ 14 files, ~9,500 lines: `crates/seat-link/src/seat.rs` (1,814), `crates/sim/src/world.rs` (953), `crates/centraid/src/run.rs` (942), `crates/centraid/src/seat_lane.rs` (855), `crates/seat-link/src/link.rs` (847), `crates/seat-link/src/bootstrap.rs` (316), `crates/centraid/src/tails.rs` (165), plus ~3,500 lines of `crates/centraid/tests/*`. `crates/seat-link` exists **only** to implement `centraid_core::link::SeatNetwork`, whose method signatures name `centraid_seat` types — so `crates/core` cannot stop naming `centraid_seat` while that trait lives in it and that crate is in the workspace.

The umbrella assigns exactly those crates to W2 (body line 568: "`crates/seat`, `crates/seat-link`, `crates/sim`, `crates/automations`, `crates/assist` and `desktop/electron` are gone"), and W2 runs after W1. So exit items 1 (workspace builds), 5 (no `centraid_seat` in core) and 6 (no `Role::` in `crates/`) cannot all hold at the end of W1 as briefed.

Two further consequences of the same ordering:

- **`ChangeSink` cannot move to `crates/core` before `crates/core` drops `centraid-seat`** — `crates/seat`'s applier consumes the trait, so a trait in core would make `crates/seat` depend on `crates/core`, which depends on `crates/seat`. The brief is right that W1-1 is atomic; the atom is larger than the brief's boundary.
- **W1-3's guard cut and W1-4's `update_hook` sit behind the same wall.** Cutting `log/guard.rs` to `BEGIN IMMEDIATE` → body → `COMMIT` removes `commit_seq`, which removes `write_rows`, which is the only writer of `replica_log` — the whole replica-log plane. Its consumers are `crates/seat` (14 `commit_seq` sites), `crates/centraid` (6), `crates/sim` (3) and `crates/core` (5). W3 owns what replaces it.

**Recommendation to the root:** re-cut W1-1/W1-2/W1-4 to run *after* W2's deletions, or widen W1-1 to carry the `crates/seat-link` + `crates/centraid` seat-lane deletion explicitly. They are one commit either way; they are not two lanes' work done twice.

### Red on the base, not caused by this lane

Each verified by `git stash` on `62e5c608`:

| Failure | Evidence |
| --- | --- |
| `cargo build --workspace` | `crates/sim/src/protocol.rs:90` — missing field `tail` in `LogRequest`. Exit item 1 was never reachable from this base. Everything but `crates/sim` builds. |
| `cargo test -p centraid-vault --test one_hash` | `every_writer_of_a_hash_column_is_declared_with_where_its_value_comes_from` — `vault/src/page.rs` writes a hash column and is not in `HASH_COLUMN_WRITERS` |
| `cargo xtask rules` — `sql-confinement` | `crates/centraid/tests/walking_skeleton.rs`; W2 deletes it |
| `cargo xtask rules` — `abi-five-symbols` | a rule bug, below |
| `cargo clippy --workspace --all-targets -- -D warnings` | `large size difference between variants` in **generated** `centraid.core.v1.rs:1514` (`PairOk` vs `PairError`) |
| `cargo fmt --all --check` | 17 files, none under `crates/core`; they are W2's and W3's crates |
| `cargo test -p centraid --test bytes_upward` | W2 deletes it |
| `node scripts/check-ledgers.mjs --base c48251ac` | one expired row, `tests/quarantine.json#lanes.web-e2e-cross-browser`, expired 2026-09-16 — owner's judgment |

**`abi-five-symbols` is a rule bug, not a symbol problem.** The library exports exactly five symbols:

```
nm -D --defined-only libcentraid_core_ffi.so | grep ' T centraid_'
→ centraid_call, centraid_close, centraid_free, centraid_next_event, centraid_open
```

and `crates/core-ffi/tests/symbols.rs::exactly_five_symbols_are_exported` passes. `rules::exported_c_symbols` (`crates/xtask/src/rules.rs:265`) matches any line *containing the string* `no_mangle`. Above each attribute in `crates/core-ffi/src/lib.rs` sits a comment that reads ``// SAFETY: `no_mangle` exports this under its `centraid_`-prefixed name`` — lines 118, 282, 358, 410 and 437, against attributes on 122, 286, 362, 414 and 441. The look-ahead at `rules.rs:270`–`279` skips lines starting with `//` or `#`, so from the comment it walks to the same signature the attribute finds. Five functions × two matches = ten. **The rule fires on prose.** `rules.rs` is not edited; routing this is the root's.

### Verification

`export CARGO_TARGET_DIR=/home/user/.cargo-target-w1` throughout.

- `cargo build --workspace --exclude centraid-sim` → clean
- `cargo test -p centraid-vault` → 280 lib + all integration green except the pre-existing `one_hash`. New: `file::tests::a_founded_vault_carries_the_whole_pragma_set`, `file::tests::a_second_open_carries_the_same_pragma_set_and_changes_no_header`
- `cargo test -p centraid-core` → 95 lib green (73 before; +22 locker, +2 principal). New: `handle::tests::a_command_with_no_principal_is_answered_rather_than_refused`, `handle::tests::a_principal_on_the_request_does_not_change_who_the_command_runs_as`
- `cargo test -p centraid-seat` → 163 green after the locker left
- `cargo test -p centraid-core-ffi` → green, symbol count included
- `cargo xtask rules` → scanned 235 → 239, allowed 164 → 160, findings unchanged at 1 for `sql-confinement`: **the locker's move across crates trips no SQL allowlist**
- `node .governance/law/run.mjs --brief-digest d58a237d3db1` → 10 rules, no findings
- `node scripts/check-ledgers.mjs --base c48251ac` → only the expired quarantine row (`cargo xtask gate --lane ledgers` cannot run in a worktree: "no merge base found")
- `cargo xtask gate --profile local` → FAIL on fmt, clippy, test, rules, ledgers, every one of them a base failure in the table above. Budget line: `BUDGET cold ok — 207.0s of the 3200s coldLocalProfileSeconds ceiling in contracts/ledgers/compile-time.json`

## W0.5 — discovery (lane B): the record, publish and resolve, the account listing

Lane A made the keys. This lane makes a key **findable**: the signed pkarr
record an identity key publishes, publish and resolve against a configurable
`iroh-dns-server`, the account's own record and the signed vault listing a
fresh phone restores from, and the typed-URL fallback for when resolution
fails. It extends `crates/identity` and re-decides none of lane A's shapes.

### What landed

| Where | What |
| --- | --- |
| `crates/identity/src/record.rs` (new) | `IdentityRecord` — `mailbox=<gateway base URL>` and `cert=<device certificate, base64url>` in one TXT record at `_centraid`, under the vault identity key's own zone. `AccountRecord` — `gateway=` under the account key and nothing else. `GatewayUrl`, an `http`/`https`-only newtype checked once at the edge. `RecordError`, every key-bearing variant naming the key in z-base32. |
| `crates/identity/src/discovery.rs` (new) | `Discovery::{new,with_server}` over a pkarr relay client; `publish_identity`, `publish_account`, `resolve_identity`, `resolve_account`, `locate_account`. `DEFAULT_DNS_SERVER = "https://dns.iroh.link/pkarr"`. `ResolutionSource::{Published,Typed}` and `Located`/`SourceUsed` — one restore path, two sources. `DiscoveryError::Unreachable`, with no variant that could be rendered as "unknown person". |
| `crates/identity/src/account.rs` (new) | `VaultClaim` ("vault V, minted at index i, belongs to account A", signed by A) and `VaultListing`, the document A signs over the whole set. `restore` re-derives every vault from the phrase alone; `resume_mint` carries the high-water mark forward. Fixed-width wire forms for both. |
| `crates/identity/src/lib.rs` | Three rows in the module map and their re-exports. Lane A's hash carve-out paragraph is untouched — nothing new hashes here. |
| `crates/identity/tests/discovery_round_trip.rs` (new) | Four tests against a real `iroh_dns_server::Server` started in-process on a free port. |
| `crates/identity/tests/discovery_vectors.rs` (new) | Generates and diffs `contracts/crypto/discovery-vectors.json`, the same `CENTRAID_UPDATE_FIXTURES=1` shape lane A used, plus two tests that read the pinned bytes back and verify them. |
| `contracts/crypto/discovery-vectors.json` (new) | The signed identity record and the signed account record byte for byte, the `cert=` payload on its own, and the vault listing's wire form. |
| `Cargo.toml` | Workspace entries for `pkarr` (`default-features = false`) and `iroh-dns-server` (dev only), each with its reason. |
| `crates/identity/Cargo.toml` | `pkarr`, `url`; dev: `iroh-dns-server`, `tempfile`, `tokio`. |

36 tests added: 12 in `record.rs`, 12 in `account.rs`, 5 in `discovery.rs`,
4 in `tests/discovery_round_trip.rs`, 3 in `tests/discovery_vectors.rs`. Lane
A's 44 still pass; `cargo test -p centraid-identity` is 80.

### What the local-DNS-server exit actually proved

`tests/discovery_round_trip.rs` starts n0's **own** `iroh-dns-server` in
process — HTTP on `127.0.0.1:0` so the OS picks a free port, HTTPS off, the
metrics server off (it otherwise binds a *fixed* port and two test binaries
would fight over it), the mainline DHT fallback off, its store in a `tempfile`
directory — publishes through the pkarr relay client, resolves back, and shuts
the server down with the test. No stub, no fallback, and nothing was mocked.

What that buys over a round trip through our own encoder and decoder:

1. an `iroh-dns-server` **accepts** our packet — the owner name, the TXT
   entries and the size are all things a server can refuse;
2. what comes back is what went in, byte for byte, through somebody else's
   store and somebody else's parser;
3. the answer is not our own client's cache: every resolve in `discovery.rs`
   is `ResolvePolicy::NetworkOnly`, so a publish cannot satisfy its own
   resolve;
4. **republishing at `epoch + 1` works end to end** — the server serves the
   newer record, and a contact that has seen it refuses the old phone's
   certificate, which is `VAULT_MOVED` proven against a real server rather than
   asserted;
5. the restore path runs whole: the account record resolves to the gateway, the
   listing re-derives vaults 0, 1 and 4, and the mint resumes at 5.

The server is a **dev-dependency**. `cargo tree -p centraid-identity | grep -c
'^iroh '` is `0`, and the normal (non-dev) tree contains no `iroh*` crate at
all; the dev tree gains `iroh-base`, `iroh-dns` and `iroh-metrics` and never
`iroh` proper, so no endpoint, ALPN or QUIC listener reaches even the tests.

### Rulings spent

- **§6 / the umbrella invariant — no listening socket, no iroh endpoint.**
  Spent in the manifest, not in a comment: `pkarr` is
  `default-features = false, features = ["signed_packet", "relays"]`, because
  the default feature set enables `dht`, whose mainline client **binds a UDP
  socket and joins a gossip overlay**. With `dht` off the only backend compiled
  in is the relay client, which is outbound HTTP to the configured server and
  nothing else. This is the one place a dependency's default would have broken
  the invariant silently.
- **F2 — restore must not depend on the lost phone.** The account listing, not
  gap-limit discovery. `account.rs`'s header records why the wallet answer is
  refused: it needs the lost phone's records still standing, and it silently
  truncates a sparse account. `resume_mint` never reuses an index.
- **F3 — the epoch orders, backup generations do not.** The record layer reads
  a superseded certificate back as a valid record and `DeviceTrust` is what
  refuses it; a test in `record.rs` asserts which layer refuses what, so a
  stale record is `VAULT_MOVED` and never corruption.
- **F9 — DNS must not see the social graph.** The vault listing is held by the
  gateway and is deliberately **not** in the account's pkarr record: that
  record is world-readable by anyone holding the account key, so a listing in
  DNS would publish a person's vault set as one linked group. A test asserts
  the account key's bytes and its z-base32 are both absent from a
  contact-facing vault record. The same ruling is why every resolve is
  `NetworkOnly` and the API is shaped around a key rather than around a send —
  a resolve per message would be the wrong shape.
- **W0.5-R1 — the hash carve-out is spent and bounded.** Nothing in this lane
  adds a hash. pkarr's signing is Ed25519 over pkarr's own record encoding,
  which is that specification's choice and not ours; no digest was invented
  here, so `blake3` had nothing to be spent on.
- **D-1020-R1 dropped pre-release** — `discovery-vectors.json` carries the same
  standing lane A gave `identity-vectors.json`: regression vectors, freely
  regenerated until first release, with the paragraph that has to be deleted to
  end it named in the test's header.

### Decisions this lane made that are not in a ruling

1. **The account record's entry is `gateway=`, not `mailbox=`.** An account has
   no mailbox — a mailbox is `/m/{identity_key}` and belongs to one vault. One
   name reused would invite a reader to treat an account key as a vault key.
2. **`RECORD_TTL_SECONDS` is 300.** Records refresh on a timer and on every
   gateway or device change, so this window is how long a superseded `cert=`
   can be believed after a restore. Shorter costs queries on a path that is
   already move-recovery; longer is dead time on the one transition the record
   exists for.
3. **`IdentityRecord` takes its identity key from the certificate** rather than
   storing it alongside, so a record that disagrees with itself cannot be
   built. `sign_at` still refuses a mismatched signing key, for the case where
   the certificate is somebody else's.
4. **A repeated entry is a refusal, not a first-wins.** Two `mailbox=` values
   are a publisher saying two things, and taking the first would make which
   gateway a contact reaches depend on wire order.
5. **Both the claim and the listing are signed.** One claim shows one vault's
   membership without handing over the rest; the document's signature is the
   only thing that notices a gateway serving a **subset**, because every
   surviving claim in a truncated set still verifies on its own. There is a
   test that drops a claim.
6. **The listing is canonical — ascending by index, no repeats.** One account
   has one byte form of its listing, and a repeated index is refused as two
   vaults on one derivation path rather than sorted away.
7. **The golden vectors pin `SignedPacket::as_bytes`, not `serialize`.**
   `serialize` prefixes `last_seen`, which is the reading clock: it is not part
   of the record and is not reproducible.
8. **`SourceUsed::Typed` says nothing was verified.** A typed URL has no
   signature to check because there was no record; the variant's documentation
   says the gateway must still prove itself downstream.

### Found, not this lane's slice

- **`contracts/crypto/` is still unindexed.** Lane A flagged it for W9; this
  lane adds a fourth file (`discovery-vectors.json`) and the directory still
  has no README and no entry in any register.
- **`DeviceCertificate::{to_bytes,from_bytes}` now has its first consumer** —
  `record.rs`. Lane A's "no consumer yet" note is superseded for that pair;
  `SealedBox::{to_bytes,from_bytes}` still has none.
- **Nothing consumes `discovery.rs` yet.** The gateway that serves a vault
  listing over HTTP, and the phone screen that asks for a typed URL, are both
  other waves'. What exists here is the client half and its record format.
- **`pkarr` re-exports `simple_dns` and `ntimestamp` types across this crate's
  public API** (`Timestamp` in `sign_at`). If a later wave wants
  `crates/identity` to have no third-party types on its surface, `sign_at` is
  the one signature to change.
- **Five inherited gate failures on the base `c48251ac`**, none of them this
  lane's and none touched: `fmt` (18 files, listed in lane A's section, none in
  `crates/identity`), `clippy` (`crates/vault/src/log/guard.rs`), `rules`
  (`sql-confinement` on `crates/centraid/tests/walking_skeleton.rs`,
  `abi-five-symbols` on `core-ffi`), `test` (`centraid --test bytes_upward`),
  and `ledgers` (an expired `tests/quarantine.json` row).
## W2 — the seat plane leaves

Branch `claude/1029-w2-deletions`, base `7a618ef4`. Six commits,
**358 files, +1,750 / −154,113**.

W1's worker was right and its finding decided this lane's shape: `crates/seat-link`
exists only to implement `centraid_core::link::SeatNetwork`, whose signatures name
`centraid_seat` types, so core could not stop naming the seat while that trait lived in
core and that crate was in the workspace. The deletion and the seat cut are one act, and
W1-1, W1-2 and W1-4 are folded in here.

| Commit | What |
| --- | --- |
| `d30f32c5` | `abi-five-symbols` counted the SAFETY comment as an attribute — a detector bug, fixed with a regression test |
| `28381e1d` | **the atom**: `crates/{seat,seat-link,sim}`, the iroh half of `crates/net`, `centraid_core::{link,intent}`, `Role`, and `crates/centraid`'s seat lane. −43,342 |
| `132b3170` | the log plane, the ledger, the assistant, the automations, `enrich.*`; the `update_hook` and the census. −28,673 |
| `3fe8faf5` | `desktop/`, `extension/`, their release lanes, eight gate steps, `Principal::{Agent,Automation}`. −79,823 |
| `61c5273e` | `log.proto`, `intent.proto`, thirteen envelope arms, `crates/protocol` cut to three modules |
| `2683e9f2` | the `clippy` lane, red on the base commit in four layers |

### Every deleted path

**Crates, whole:** `crates/seat`, `crates/seat-link`, `crates/sim`, `crates/assist`,
`crates/automations` — with `crates/net` reduced to `src/lib.rs` + `src/ticket.rs`
(`allowlist.rs`, `endpoint.rs`, `error.rs`, `pairing.rs`, `tests/pair_and_stream.rs`) and
`crates/protocol` reduced to `error`, `session`, `version` (`alpn.rs`, `framing.rs`,
`handshake.rs`, `transport.rs`, `wire.rs`, `tests/framing_golden.rs`,
`tests/framing_properties.rs`).

**`crates/core`:** `src/link.rs`, `src/intent.rs`.

**`crates/vault`:** `src/log/{apply,capture,door,store}.rs`, `src/ledger/` in full
(`archive`, `automation_cursor`, `automation_ingress`, `automation_state`, `consent`,
`health`, `mod`, `schema`, `sql_guard`, `store`), `src/converge.rs`,
`src/custody/rotation_scenario.rs`, `src/commands/enrich.rs`;
`tests/{automation_plane,doors,gates,ledger,log_plane,prediction_parity}.rs`.

**`crates/centraid`:** `src/allowlist.rs`, `src/seat_lane.rs`, `src/snapshots.rs`,
`src/tails.rs`, `src/cmd/{assist,automations,capture,mcp}.rs`, `src/cmd/native_host.rs`
+ `src/cmd/native_host/{fold,methods,relay,stage}.rs`, `src/cmd/seat/`
(`blob`, `catalogue`, `core_link`, `local`, `locker`, `mod`, `peer`, `server`, `state`);
`tests/{byte_lane,bytes_upward,mcp_stdio,native_host,no_listener,seat_bootstrap,
seat_identity,seat_lane,seat_offline,seat_queue_write,seat_socket,seat_tail,
walking_skeleton}.rs`.

**Elsewhere:** `crates/blobs/src/lane.rs`, `crates/blobs/tests/windows.rs`,
`crates/xtask/src/smoke.rs`,
`crates/api-proto/proto/centraid/core/v1/{intent,log}.proto`, `desktop/` (53 files),
`extension/` (36 files), `contracts/{applier,assist,automations,desktop,extension}/*`,
`contracts/protocol/framing-golden.json`, `contracts/sim/failing-seeds.json`,
`docs/cron-timezone.md`,
`.github/workflows/{lane-release-desktop,lane-release-extension,oauth-worker}.yml`.

### The greps that proved them dead

| Claim | Command and answer |
| --- | --- |
| core no longer names the seat | `grep -rn 'centraid_seat' crates/core/src crates/core-ffi/src` → **1 hit, a comment** (`events.rs:231`, explaining what `ChangeSink` was) |
| `Role` is gone | `grep -rn 'enum Role\|Role::' crates/ --include=*.rs` → **1 hit, a comment** (`config.rs:9`) |
| `attach_network` is gone | `grep -rn 'attach_network' --include=*.rs crates/` → **1 hit, a comment** (`core-ffi/src/lib.rs:141`) |
| `ChangeSink` had one implementor | `grep -rn 'ChangeSink for'` → `seat/src/sync.rs` (`NoChanges`, a test double) and `core/src/events.rs` (`ChangeFeed`). Every `&dyn ChangeSink` call site was in `seat-link/src/seat.rs`, `sim/src/world.rs`, `core/src/link.rs` or a seat test |
| `crates/protocol`'s transport half is unused | `grep -rn 'protocol::framing\|protocol::wire\|protocol::alpn\|protocol::handshake\|protocol::transport' --include=*.rs crates/` outside the crate → **empty**. `session` and `version` are read by `crates/core`'s call door |
| `core::intent` had two consumers | both deleted: `handle.rs`'s `submit_intent` and `centraid/src/seat_lane.rs:642` |
| `blobs::{fetch,serve_stream}` had two consumers | `seat_lane.rs:331,682` and `centraid/tests/byte_lane.rs` |
| `WalCapture::tick` had one driver | `run::gateway`'s capture task. `backup.rs`'s `pending_tail`/`retire_pending` were the readers, and read a spool nothing would write |
| `api::reveal`, `api::parked`, `Handle::devices_list` | `grep -rn 'api::reveal\|api::parked\|RevealRoute'` outside `api.rs` → **empty** |
| the nine `enrich.*` commands | one caller each, the enrichment worker in `crates/automations` over `crates/assist`; the Photos action `request-enrichment` queued a row for it |
| `standing_answer_id` | its `principal_kind = 'automation'` predicate matched only `Principal::Automation`, whose producer is deleted |

### The three re-judgments (decisions, not deferrals)

**1. `crates/seat/src/bytes.rs` — DELETED.** Its public surface is `needed_blobs`, `holds`,
`knows`, `asset_rows_for`. `grep -rn 'seat::bytes\|asset_rows_for'` outside `crates/seat`
found exactly three hits: `core/src/handle.rs:959,960` (`holds`/`knows`, inside
`seat_bytes_fetch` — the seat-only "fetch this one now" command, deleted) and one comment
in `core/src/events.rs`. `needed_blobs` fed `centraid_blobs::plan` over the seat's window,
which is deleted. Reference A marked it "re-judge in W6"; W6 rewrites blob naming against
the object plane and will write its own query, so keeping a dead one would only be
something to disprove.

**2. `crates/vault/src/devices.rs` and the `access_device*` rows — SPLIT.** The two
SURFACES are deleted here: `Request::DevicesList` and `Request::DevicesRevoke` leave the
wire and `Handle::devices_list` goes with them. `devices.rs` itself STAYS for now, and the
reason is a live consumer rather than deference: `backup/drill.rs:133,368` uses
`enrol_device` to build the drill's corpus, and `backup/base.rs`'s custody test asserts
`access_device_secret` survives a base copy — which is #1029's B1 and the property W3
seals. The rows are on the schema band W2-5 did not land (below), and the honest place to
delete file and rows together is that slice.

**3. `crates/vault/src/commands/enrich.rs` (question 9) — DELETED IN FULL.** By consumer:
`request_enrichment` queued a row for a worker; `record_consent` recorded a harness's
egress consent; `mark_requests_drained` and `record_target_failure` were the worker's
bookkeeping; `upsert_embedding`, `upsert_faces` and `rebuild_face_clusters` were its
writes; `regenerate`/`regenerate_all` re-queued it. The worker is `crates/automations` over
`crates/assist`, both deleted. The Photos action `request-enrichment` — "the only action in
any app that writes to `enrich`" by its own comment — went with it. **This leaves a reader
with no writer, and it is filed below rather than hidden.**

### What was parked, and for whom

- **`crates/net/src/ticket.rs` → W8.** Reference A moves it into `crates/identity`; a
  sibling lane held that crate open for this lane's whole run. It is left where it is with
  its crate reduced to it, documented in `net/src/lib.rs` as a park. `PairTicket` stays in
  `pair.proto` for the same reason — it is the parent of the §7 link ticket.
- **The capture hook seam → W3.** `log/guard.rs` is `BEGIN IMMEDIATE` → body → `COMMIT`
  and no spool is built.
- **The share tables → W8**, per the ruling.

### Rulings spent

- **D-1020-B7** (`attach_network`, "the core is handed a network") — there is no network.
- **D-1020-C1/C8** (the transport trait, the durable allowlist) — no transport, no allowlist.
- **D-1020-D1-5** survives in shape: the commit pair is still a guard whose ordering cannot
  be forgotten; steps 2, 4 and 5 of it are gone.
- **D-1020-D1-7** ("one snapshot, three uses") — one use left, and `backup/base.rs`'s
  contradiction of it resolves by the two builders becoming the same function. W3 merges them.
- **D-1020-D2-4** (the simulation is the primary sync proof) — no sync to prove.
- **D-1020-CL9** (`local` excludes `crates/sim`) — no `crates/sim`.
- **D-1020-AS3/AS6/AS7** (the ledger band, the prompt-injection gate, the harness surface),
  **D-1020-AU5** (the automations client) — assistant and automations deleted.
- **D-1020-F8/F10, D-1020-X11** (the desktop's pure cores, the Companion's programs) — §6.
- **D-1020-G5** (the VPS release smoke) — its container ran `centraid gateway`.
- **D-1020-L2/L3** (the reveal router) — the structural half survives in `SealedSubject`.
- **D-1025-S1-1, S2-2, S2-4, S4-6, S5, S7-9, S7-13, S7-20, S7-40, S7-63** — every one is
  about a seat's identity, window, overlay, tail or fetch.

### Found, and not this lane's slice

1. **`crates/apps/photos`'s face surfaces now read tables nothing writes.**
   `faces.rs` and `photos.people.clusters` read `media_face_region` and
   `media_face_cluster`, whose only writers were `enrich.upsert_faces` and
   `enrich.rebuild_face_clusters`. **Question to the owner:** (a) delete the face surfaces
   too, or (b) re-propose on-device face detection as their writer. **Recommendation: (b)
   as a proposal**; deleting a whole product surface is past a deletion lane's remit.
2. **The phone has no content store over the C ABI.** `SeatLink` opened `<vault>.bytes`
   and handed it to `attach_bytes`; `centraid_open` no longer does, because `ByteStore::open`
   is async and `ContentBytes` holds a tokio runtime handle that must outlive the core.
   A core opened over the ABI holds text and refuses binary bytes, by name. **W6's**, and
   `core-ffi/src/lib.rs` says so where `attach_network` used to be.
3. **`backup/base.rs` and `snapshot.rs` now build the same artefact.** The sanitisation
   that distinguished them existed for a phone ADOPTING a replica. **W3's**, with the seal.
4. **`crates/vault/src/log/` is a stale module name** — it holds the commit guard and
   `PRAGMA table_info` helpers. Renaming it is ~40 call sites of pure churn; **W9's**.
5. **`Principal` is a one-variant enum**; collapsing it to a struct is a rename across every
   `match` in `crates/vault`. **W9's.**
6. **`tests/floors.json` still carries v0 desktop and automation journey floors.** Estate
   file; a separate commit by rule, and not this lane's subject.

### Not landed, and why

- **W2-6's MOBILE HALF.** `TailResume`, `RadioResume`, `SyncWindowPolicy`, `WriteGate`,
  `Replicas`, `GatewayLink`, `CoreRole` and the iOS replica states are untouched. The cut
  reaches `HomeSession.kt`, `CameraRoll.kt`, `HomeBridge.kt`, `ScreenMachine.kt`,
  `ChangeStream.kt`, `ScreenRuntime.kt`, `Shelf.kt`, `Enrolments.kt`, `MainActivity.kt`,
  `ShellModel.swift` and `CentraidCore.kt`, and **this container cannot build the mobile
  tree**: `./gradlew :shared:jvmTest` fails to resolve
  `org.jetbrains.kotlin.multiplatform:2.4.20` and `com.squareup.wire:7.0.1` — Maven Central
  answers `429 Too Many Requests` through the proxy, and `--offline` has no cache. A blind
  Kotlin refactor of eleven files with no compiler is how a tree ends up broken with nobody
  able to tell. `ChangeEvent.commit_seq` is deliberately left on the wire for the same
  reason: the field leaves in the same act as its Kotlin and Swift readers.
  `mobile/maestro/flows/cold-start-and-relaunch.yaml` does not exist on this base.
- **W2-5's SCHEMA BAND.** `contracts/migrations/001_baseline.sql` is 6,914 lines and 139
  tables, frozen, and checked against the v0 golden corpus by `baseline.rs` and
  `baseline_corpus.rs`; the band Reference A names also reaches `contracts/schema/v0-registries.json`
  and every app's readers. The protocol half of W2-5 landed; the schema half is a slice of
  its own and is handed up rather than started. The `locker_item.connection_id` fix and
  `commands/locker.rs:611,958` go with it — they depend on `sync_connection` leaving.

### Verification

`export CARGO_TARGET_DIR=/home/user/.cargo-target-w2` throughout.

| Exit item | Result |
| --- | --- |
| 1 `cargo build --workspace` | **clean** |
| 2 `cargo test -p centraid-core` | **74 + 2 + 1 green.** New: `a_command_that_writes_pushes_a_change_event_naming_the_table` |
| 3 `cargo test -p centraid-vault` | **250 lib + every integration green except `one_hash`** (below). New: `tests/change_census.rs` (3), `log/guard.rs`'s shadow-table test, `log/identifiers.rs`'s two |
| 4 `cargo test -p centraid-core-ffi` | **green**, `exactly_five_symbols_are_exported` included |
| 5 `cargo test -p centraid --tests` | **green** |
| 6 `grep -rn 'centraid_seat' crates/core/src crates/core-ffi/src` | 1 comment |
| 7 `grep -rn 'enum Role\|Role::' crates/ --include=*.rs` | 1 comment |
| 8 `grep -rn 'outbox\|replica_log\|automation\|assistant\|connector'` | only SQL against tables the schema band still carries, `backup/policy.rs`'s retention words, and prose. No Rust plane is left |
| 9 `cargo xtask gate --lane fmt` | **PASS** |
| 10 `cargo xtask gate --lane clippy` | **PASS** (it was red on base; `2683e9f2`) |
| 11 `cargo xtask gate --lane rules` | **PASS**, `abi-five-symbols` clean |
| 12 `cargo xtask gate --profile local` | FAIL on `test` (`one_hash`, below) and `ledgers` (cannot run in a worktree: "no merge base found"). Budget: 152.1 s warm against 120 s, **all of it `test`** at 124.8 s |
| 13 `bun run check:push:static` | **4/4 green** |
| 14 `node scripts/check-ledgers.mjs --base 7a618ef4` | **clean** — 19 sections across 5 ledgers |
| 15 `node .governance/law/run.mjs --brief-digest 1d83dd8ab268` | **10 rules, no findings; the law did not move** |

**`one_hash`'s two remaining failures are red on `7a618ef4`**, verified by `git stash`:
`vault/src/page.rs` writes a hash column and is not in `HASH_COLUMN_WRITERS`, and
`crates/identity` names SHA-256 (RFC 9180's HKDF, in a crate a sibling lane held open all
lane). This lane removed the SEVEN stale entries its own deletions created — six writers
and `xtask/src/smoke.rs`'s exemption — which is what those tests ask for by name.

**The `local` budget is over.** 152.1 s against 120 s, 124.8 s of it `test`. `run_tests`
used to exclude `crates/sim` locally (D-1020-CL9) and now runs one unqualified
`--workspace`; the crate is deleted, so the exclusion could not stay. The ledger row is
`contracts/ledgers/gate-budgets.json` and moving it is the owner's call, not this lane's.
