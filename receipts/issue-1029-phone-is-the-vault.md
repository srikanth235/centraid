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

## W3 — the object format (lane A)

`centraid-object/1` is one format for every object the vault writes — base page
ranges, spool segments, manifests, originals, thumbnails and packs — replacing
the v0-derived sealed-frame module, which was wrong at the byte level. The
capture side that seals with it is lane B's and is not in this section.

### What landed

| Where | What |
| --- | --- |
| `crates/media/src/object/mod.rs` (new) | The format. `seal`/`open` over a `Custody` (`Wrapped` under the vault root, or `FileKey` from the vault's blob-custody row), the AEAD key wrap whose AAD is length-prefixed `(format, kind, role)`, the chunked XChaCha20-Poly1305 body, the Padmé frame, `ObjectName` (BLAKE3 of the **ciphertext**), `verify_read_back` (F11), `seal_list`/`open_list` and the 16 MiB cap (F6). `random_bytes` is the one entropy door and it is `rand::rngs::OsRng`. |
| `crates/media/src/object/header.rs` (new) | The typed header: magic, version, kind, role, flags, **a 16-byte per-object salt**, the dictionary id, the wrapped key. Every refusal is checked before a key is touched. `no_field_of_the_header_is_a_plaintext_commitment` is the regression that names the defect. |
| `crates/media/src/object/dict.rs` (new) | `Dictionary` — trained by `zstd::dict::from_continuous`, identified by **BLAKE3** of its bytes, compressing at level 3 and decompressing under a caller-supplied bound. |
| `crates/media/src/object/pad.rs` (new) | `padme`, and the paragraph that says it **bounds** the compression size-class leak and does not remove it. |
| `crates/media/src/object/pack.rs` (new) | Packs: items concatenated as whole objects, a sealed trailing item table, `open_range` (the read path that never touches the table), `should_repack` at the 5% threshold, and `repack`, which copies live items verbatim. `LiveShareIndex` is F8's seam and `NoLiveShares` is the honest placeholder. |
| `crates/media/tests/object.rs` (new) | The four adversarial tests: `no_nonce_repeats_across_retries_or_restarts`, `the_cap_holds_for_the_worst_case_input`, `an_oversized_input_becomes_a_list_of_objects`, `a_pack_is_addressable_by_range_and_its_headers_do_not_transplant`, `padme_collapses_neighbouring_sizes_onto_one_object_size`. |
| `crates/media/tests/object_vectors.rs` + `contracts/crypto/object-vectors.json` (new) | The vectors. Deterministic fields are recomputed and compared; the committed ciphertext is **opened**, not compared, because sealing is deliberately not reproducible. |
| `crates/media/src/cbsf.rs` (**deleted**) | The v0 frame format. |
| `crates/media/src/lib.rs`, `crates/media/Cargo.toml` | `#![forbid(unsafe_code)]` (it had none), the module map, `+chacha20poly1305`, `+rand`, `-flate2` (deflate was a frame algorithm and nothing else in the crate wrote one). |
| `Cargo.toml`, `Cargo.lock` | `chacha20poly1305 = "0.11"`, declared beside `aes-gcm` with why: the 24-byte nonce is what makes "draw it at random" a design rather than a budget. |
| `crates/media/tests/golden.rs`, `crates/media/tests/primitives.rs`, `contracts/golden/format-golden.json`, `contracts/crypto/blake3-vectors.json` | The frame vectors are gone; the frame-nonce vector is replaced by `centraid-object/1`'s key-wrap context, since a vector with no site is decoration. |
| `crates/vault/tests/one_hash.rs` | W3-0 — three declarations, each with its reason. |
| `crates/vault/src/custody/mod.rs` | One stale comment: the derived-nonce exception is now named as the defect this format closes. |

### The four defects it closes, and the fifth a test found

1. **The plaintext hash is not in the header.** The old header wrote BLAKE3 of the plaintext in the clear at bytes 5..37 — a confirmable commitment on the outside of the envelope. An object's name is now the BLAKE3 of its own **ciphertext**; the plaintext hash lives in the vault, where the phone deduplicates on it.
2. **B9 — every nonce is random.** The old nonce was a keyed MAC over the object's *address*, safe only if one address always maps to one set of bytes. It did not. `no_nonce_repeats_across_retries_or_restarts` seals the same plaintext 256 times in-process and then **re-runs the test binary as a child process** and asserts the two nonce sets are disjoint — a generator seeded once per process passes the first half and fails the second.
3. **A header cannot be transplanted.** The wrap AAD carries kind and role, length-prefixed exactly as `centraid_identity::sealed_box` does it.
4. **Sizes are bounded.** zstd against a dictionary the header names by its BLAKE3, then Padmé, then a 16 MiB cap with a larger input becoming an ordered list of ordinary objects.
5. **THE FIFTH, WHICH READING DID NOT FIND.** Kind and role stop a header moving between objects of *different* kinds and do nothing about two of the same kind — and a `blob` or `thumbnail` header carries no wrapped key at all, so two same-kind file-key headers were byte-identical and their chunk AAD with them. The adversarial pack test glued one item's header onto another's body and it **opened**. §4's fresh per-blob file key would also have defeated it, but the property would then rest on a caller's key discipline rather than on the format. Every header now carries 16 random bytes of salt.

### Rulings spent

- **B9** — random nonces, asserted across retries and restarts.
- **F6** — 16 MiB, one upload path; `the_cap_holds_for_the_worst_case_input` proves the headroom with incompressible bytes rather than arithmetic.
- **F8** — `repack` asks `LiveShareIndex` **before copying a byte** and refuses; W8 fills the seam.
- **D-1020-R1 dropped pre-release** — said beside the fixture, which is why the frame vectors could be deleted rather than migrated.
- **W0.5-R1 does not extend here** — `crates/media`'s names, commitments and dictionary ids are BLAKE3, and `one_hash`'s allowlist entry says so at the boundary.

### What the deletion exposed

1. **Nothing outside `crates/media` ever called the frame format.** Its only consumers were the crate's own tests and two golden fixtures. The comment at `crates/vault/src/custody/mod.rs:68` that cited it as a derived-nonce exception was the last reference, and it was stale.
2. **`flate2` was in `crates/media` for deflate frames alone.** Dropped from the crate; three other crates still declare it.
3. **`crates/media/src/lib.rs` had no `#![forbid(unsafe_code)]`**, unlike every other crate in the workspace. Added.
4. **The two remaining v0 seals have no lane.** `format.rs`'s `seal_wal_segment` and `seal_snapshot_manifest` are the other two seals this format replaces and they carry the same derived-nonce defect (`derive_nonce` over a WAL address, and a nonce derived from a manifest's own content hash). Their only callers are `crates/vault/src/backup/{wal,manifest}.rs`, which is lane B's by this brief's §6, so deleting them would either edit that lane's files or break `cargo build --workspace`. **They are marked superseded in prose at both ends and must not acquire a new caller.** They go with lane B's rewrite.

### Found, not this lane's

1. **`crates/vault/tests/snapshot_faults.rs::an_interrupted_build_leaves_no_artifact_and_the_next_one_succeeds` is RED on the base.** Verified by checking `2985cf4d` out over `crates/` and `contracts/` and re-running: it fails identically there. It is deterministic, not flaky, and the assertion is `"the retry after eight faults produced an unsanitised artifact"` — a snapshot-builder fault, nothing to do with this lane. **Nobody owns it yet.**
2. **`tests/floors.json:54` carries `"blob-format-cbsf-properties": 6` and `tests/claims.json:3909` a claim owned by `packages/core/src/blob/cbsf-properties.test.ts`** — a v0 TypeScript file deleted waves ago. Estate files, tighten-only, and a separate commit by `estate-separation`. Not started.
3. **The `local` profile's `test` step is still over budget** — 152.7 s against 120 s here, unchanged in character from W2's 152.1 s. Owner item.
4. **`crates/media/README.md` is stale** and describes the deleted module. W9's, per this brief's doctrine 10.

### Verification

`export CARGO_TARGET_DIR=/home/user/.cargo-target-w3` throughout. Local store only; no network.

| Exit item | Result |
| --- | --- |
| 1 `cargo build --workspace` | **clean** |
| 2 `cargo test -p centraid-media` | **71 green** — 59 unit, 6 `object.rs`, 3 `golden.rs`, 2 `primitives.rs`, 1 `object_vectors.rs` |
| 3 `cargo test -p centraid-vault --test one_hash` | **4/4 PASS** (it was red on base) |
| 4 `cargo test --workspace` | green **except** `snapshot_faults`, proven inherited above |
| 5 `grep -rn 'cbsf\|CBSF' crates/ --include=*.rs` | **empty** |
| 6 `cargo xtask gate --lane fmt` | **PASS** |
| 7 `cargo xtask gate --lane clippy` | **PASS** |
| 8 `cargo xtask gate --lane rules` | **PASS**, 4 rules clean |
| 9 `cargo xtask gate --profile local` | FAIL on `test` (the inherited `snapshot_faults`) and `ledgers` (cannot run in this worktree: "no merge base found (tried origin/main, main, …)" — `git merge-base origin/main HEAD` is empty here). Budget line: **"the `local` profile took 182.6s against a 120s budget"**, `test` 152.7 s of it |
| 10 `bun run check:push:static` | **4/4 green** (needed `bun install`; the worktree had no `node_modules`) |
| 11 `node scripts/check-ledgers.mjs --base 2985cf4d` | **clean** — 19 sections across 5 ledgers |
| 12 `node .governance/law/run.mjs --brief-digest 1d83dd8ab268` | **10 rules, no findings; the law did not move** |

## W3 — capture, the spool and restore (lane B)

Base `44e35f22`. Branch `claude/1029-w3b-capture-spool`. Local object store throughout; no network, no gateway.

**The claim, in one line: a committed transaction survives losing the vault and comes back byte-exact.** `crates/vault/tests/restore_drill.rs::a_lost_vault_comes_back_byte_exact_from_its_generation` is where that is asserted, and the `release` profile's `restore-drill` step runs it.

### The order the design turns on (F11)

The WAL is durable first (`synchronous=FULL`, W1's). A segment is sealed, written, fsynced — file **and** directory — then read back **from the file** and opened (§4). Only then is `(salt1, salt2, frame index, last_txid)` recorded. Only then may a checkpoint run, and only while the log holds nothing capture has not cut. A spool entry is dropped only after the store acks it. Every crash window falls on the re-capture side, because re-capturing is free and losing is not.

### B1–B13, each with its test

| # | What it was | Test |
| --- | --- | --- |
| B1 | The base was a gzipped copy carrying `locker_key` and `access_device_secret` in the clear | `backup::base::tests::the_base_is_sealed_and_carries_no_readable_locker_key` — every range is a `centraid-object/1` object; the scan reads the sealed bytes. Also `member_key_gate`, which now scans the sealed range **and** the opened one |
| B2 | `backup now` failed whenever there was a WAL tail: already-sealed bytes were sealed again and the length check rejected the result | `backup_crash_matrix::a_generation_over_a_live_log_succeeds_and_a_retry_re_sends_rather_than_reseals` |
| B3 | Restore decrypted each segment, discarded it and reported "replayed" | `segment::tests::applying_a_segment_writes_its_pages_and_sets_the_database_size`; end to end in the drill, whose `segments_applied > 0` assertion is written to fail if the discard comes back |
| B4 | `VACUUM INTO` renumbers pages, so frames could never replay onto the base | `base::tests::the_copy_is_page_identical_and_a_vacuum_copy_is_not` — reproduces the renumbering beside the page-for-page copy |
| B5 | The tail was collected before the base, pairing a newer base with older frames | `backup_crash_matrix::a_generation_over_a_live_log_…`, which asserts the segments are the tail collected **after** the base |
| B6 | A WAL restart was seen only when the file shrank, so a restart in place lost frames; capture took no lock | `wal::tests::a_restart_in_place_at_the_same_length_is_a_break_not_a_continuation` (same length, new salts, different bytes) and `…::a_restart_with_nothing_captured_behind_it_is_normal`; the race in `backup_crash_matrix::a_foreign_checkpoint_between_ticks_breaks_into_a_new_generation` |
| B7 | Segments were byte ranges cut at the file's length, so they ended mid-frame or mid-transaction; the header, salts and checksums were never read | `wal::tests::a_read_stops_at_the_last_commit_frame_and_never_mid_transaction`, `…::a_torn_tail_is_ignored_exactly_as_sqlite_ignores_it`, `…::both_checksum_byte_orders_are_read` |
| B8 | The generation was `pending_tail().len()+1` and `manifests+1`, so concurrent backups forked | `segment::tests::generation_ids_are_random_and_never_a_counter` — 64 mints, 64 distinct ids |
| B9 | The derived nonce was reused, because B6 and B8 broke "one address, one set of bytes" | The v0 seals are **deleted** with their last callers; `object.rs::no_nonce_repeats_across_retries_or_restarts` (lane A's) holds the positive claim, and `backup_crash_matrix::…_a_retry_re_sends_rather_than_reseals` holds the vault-side half |
| B10 | `DataDirLock` was never taken, and `process_is_live` read `/proc`, which does not exist on macOS or iOS | `restore::tests::a_held_data_directory_is_refused_and_the_refusal_needs_no_proc` — an OS file lock; no pid is written, so none can be wrong |
| B11 | Two master keys, both rebuilt `active: 1` every run | Deleted with `keyring.rs`. One root key, in `objects::ObjectKeys`; `objects::tests::another_vaults_keys_do_not_open_this_vaults_segment`. **See finding 1: cheap rotation is not possible in the format as it stands, and that is written down rather than claimed** |
| B12 | Discovery JSON-parsed every blob, and "newest" could belong to another vault | `manifest::tests::a_chain_is_walked_by_name_and_a_gap_is_named_rather_than_skipped` and `…::a_manifest_from_another_vault_does_not_open` — a tag failure, not a field comparison, because §4 binds the identity key into the AAD |
| B13 | `FsBlobStore::put` never fsynced; its temp name was `{id}.{pid}.tmp` | `store::tests::a_put_is_durable_and_its_temp_name_cannot_collide`, `spool::tests::a_temp_name_cannot_collide_between_two_writers` |

### The crash matrix

`crates/vault/tests/backup_crash_matrix.rs`, nine cases. Each stops the sequence at one step and asks the next tick to carry on from what is on disk; each ends with the same question, **does a restore land on the last spooled commit?**

After a commit and before the tick; after the spool write and before the cursor record; a checkpoint while the log holds an uncaptured commit; during a base build; the disk full; a foreign checkpoint between ticks; a generation over a live log; and a run of ticks, checkpoints and generations end to end. The replay fuzz is in the same file: random inserts, deletes and checkpoints from five fixed seeds, then restore and compare the **file bytes** and the **census**.

Writing them found two real bugs, both fixed in `777352ad`:

1. **`PRAGMA optimize` writes `sqlite_stat1`, so it is a commit** — and `checkpoint` was running it *after* capture, folding an uncaptured commit into the database file. Restores landed one commit behind, intermittently, since whether `optimize` writes anything depends on what came before. Reference B states the order and it is now the code's: run it, capture, then checkpoint.
2. **`checkpoint` measured coverage from the spool's own bookkeeping**, which only knows what capture told it, so a commit made after the last tick was invisible to it. It now reads the log, which is the only honest witness.

### What was deleted, and with what

- `backup/kit.rs` and the recovery-kit file (§5). The written 24 words replace it; a file that carries keys is a file that can be copied.
- `backup/keyring.rs` (B11). One root key.
- `crates/media/src/format.rs`'s WAL-segment and manifest seals, their `WalAddress`, and the `derive_nonce`/`seal_aes_gcm`/`open_aes_gcm` primitives — the last callers were this lane's, which is why lane A could not reach them. `contracts/golden/format-golden.json` and its two golden tests went with the formats they pinned.
- `crates/centraid/src/cmd/{backup,export,recover}.rs` as gateway commands, per Reference A's deletion inventory, with `tests/restore_drill.rs` and the CLI's date parser (whose only consumer was `recover --at`). The drill moved to `crates/vault/tests/restore_drill.rs` and the gate step points there.

### New

`contracts/migrations/003_backup_index.sql` — rung three, §4's "the vault is the index": `backup_object_range` (plaintext hash → the object already holding those bytes) and `backup_base_range` (one generation's base as an ordered list). A daily base is then one new range and ninety-nine reused ones (F10), and a restored phone does not re-upload a whole file for its first base.

`backup/wal.rs` (the log reader), `backup/segment.rs` (the format W4 and W5 read), `backup/capture.rs` (the debounced tick and the checkpoint it owns), `backup/spool.rs`, `backup/objects.rs` (sealing and verify-before-upload). `backup/base.rs` and `backup/manifest.rs` rewritten.

### Findings

1. **Rotating the vault root key costs a full re-upload, and it should not.** The obvious rotation is to re-wrap each object's header under the new root and leave the bodies alone. `centraid-object/1`'s per-chunk AAD is the **whole header, the wrapped key included**, so changing the wrap invalidates every body tag. Excluding the wrap from the chunk AAD would make the cheap rotation possible and costs nothing in strength — a substituted wrap yields a different content key, so the body already fails to open — but that is a change to the format, not to its caller. Written down at `backup/objects.rs`'s header. **Owner question: make that change, or accept that rotation is a re-upload and say so in `SECURITY.md`?** Recommend the former, in whichever wave next opens `crates/media/src/object`.
2. **`SQLITE_FCNTL_PERSIST_WAL` is still unset, and it costs a base on every restart.** SQLite checkpoints and removes the `-wal` when the last connection closes. Capture reads that as a restart with new salts under a live cursor — correctly, since it cannot tell a clean close from a foreign checkpoint that dropped frames — so it breaks into a new generation and owes it a full base. **Nothing is lost**: the frames went into the main file and the new base carries them, which `a_foreign_checkpoint_between_ticks_breaks_into_a_new_generation` asserts. What it costs is a base per app launch. The file-control needs C, `crates/vault` is `#![forbid(unsafe_code)]`, and W1 left it unset for exactly this reason — so this is a `core-ffi` shim and a root decision, and this lane stopped rather than reaching for an unsafe block.
3. **The census is exact but it is a scan.** §2 asks for a running per-table count the `update_hook` maintains, so every txid carries a census with no scan. What is implemented is `Vault::census()` at the commit boundary capture cuts at — **exact**, because capture holds the write mutex and the walk stopped at the last commit, but 249 `count(*)`s per tick. The running version needs a counter table written inside the same transaction (the hook cannot write) and is a schema rung plus a guard change. Deferred, not done.
4. **`restored-blob-coverage` has no store to ask any more.** The drill passes `None`: the only store it holds is the backup object store, whose names are ciphertext hashes, and a member's own bytes live in `centraid_blobs::ByteStore` (W6's). Handing it the backup store would compare a plaintext hash against a set of ciphertext names and report every row missing — a check that always fails rather than one that says something. The check is still right and wants W6's store.
5. **`crates/centraid` has no backup verb at all now.** The phone is the writer and capture runs inside the core; what a CLI would have driven is W4's and W5's. `centraid` keeps `doctor`, `gateway install` and `units`, and it links no Locker custody symbol at all — `member_key_gate` asserts that absence rather than assuming it.

### Verification (lane B)

`export CARGO_TARGET_DIR=/home/user/.cargo-target-w3b` throughout. Local object store only; no network, no gateway.

| Exit item | Result |
| --- | --- |
| 1 `cargo build --workspace` | **clean** |
| 2 `cargo test -p centraid-vault` | **461 green**, including the nine-case crash matrix, the replay fuzz over five seeds, and the restore drill |
| 3 `cargo test -p centraid-media` | **green** (vectors regenerated by W3B-0, and reformatted by oxfmt in `78387477`) |
| 4 `cargo test --workspace` | **green, 1452 tests, exit 0** — no inherited failure left to name: `snapshot_faults`'s red test is fixed with its reason in `777352ad` |
| 5 `grep -rn 'seal_wal_segment\|seal_snapshot_manifest\|kit.rs' crates/ --include=*.rs` | **empty** |
| 6 B1–B13 | **all thirteen**, table above; each named test passes |
| 7 `gate --lane fmt` / `--lane clippy` / `--lane rules` | **PASS**, **PASS**, **PASS** (4 rules, 0 pending) |
| 8 `gate --profile local` | `fmt` `clippy` `test` `rules` all **ok**; **BUDGET ok — 78.8s of 120s**, `test` 76.7 s of it, so the overrun the brief carried forward (182.6 s, `test` 152.7 s) is not reproduced here on a warm cache. Only `ledgers` fails, and not on its subject: **"no merge base found (tried origin/main, main, origin/master, master)"** — a worktree with no default branch fetched, the same limitation W3 lane A recorded |
| 9 `bun run check:push:static` | **4/4 green** (`bun install` first; the worktree had no `node_modules`) |
| 10 `node scripts/check-ledgers.mjs --base 44e35f22` | **ok — 19 sections across 5 ledgers hold**. It refused the bare removal first, correctly: see `6d9f8bb1`, where the retired floor is carried onto its successor at a higher number rather than waived |
| 11 `node .governance/law/run.mjs --brief-digest 1d83dd8ab268` | **10 rules, no findings; the law did not move** |

## W4 — the protocol and gateway-core (lane A)

The gateway is a **protocol with two deployments**, and *neither deployment is
the reference implementation: the protocol and its conformance suite are*
(§3). This lane is the protocol and the suite. No adapter, no server binary,
no network: W4b owns the standalone server and W4c the Worker, and both must
pass what is here without reimplementing a rule.

### What landed

| Where | What |
| --- | --- |
| `crates/api-proto/proto/centraid/core/v1/gateway.proto` (new) | `ProtocolRange`, `SignedRequest` (the preimage as a message, so two adapters cannot assemble different bytes), `ClockSkew`, `VersionRefusal` |
| `crates/api-proto/proto/centraid/core/v1/backup.proto` (new) | `ObjectKind`, `ObjectDeclaration` (name **and** attested checksum), uploads, `CommitRequest` with `optional prev_head`, generations, `DeleteRequest`/`DeleteRefusalReason`, `ScrubReport` |
| `crates/api-proto/proto/centraid/core/v1/lease.proto` (new) | `LeaseClaim`, `Lease`, `VaultMoved`, `VaultRegistration`, `VaultsResponse`, `AdmissionRequest` (invite or purchase), `Plan` |
| `crates/api-proto/proto/centraid/core/v1/mailbox.proto` (new) | `DepositCapability`, deposits, `DrainResponse`, `AckRequest`, `ShareCapability`, `PackRange`, `Feed` |
| `crates/api-proto/proto/centraid/core/v1/error.proto` | `ERROR_CODE_VAULT_MOVED = 25` in the 20s as §3 asks, and the gateway block at 80–94 |
| `crates/api-proto/{build.rs,README.md,tests/roundtrip.rs}` | the four files listed; the README's `log.proto` and `intent.proto` rows dropped (W2 deleted both files); five round-trip tests for the shapes that carry rules |
| `contracts/gateway/schema.sql` (new) | the one SQL schema both adapters apply |
| `crates/gateway-core/**` (new) | 18 modules, two ports, the in-memory adapter and the conformance suite |
| `crates/vault/tests/one_hash.rs` | one allowlist entry: `gateway-core/src/checksum.rs` |
| `crates/core/src/error.rs` | owner-facing sentences for the sixteen new codes |

### The decisions this lane spent

**The messages live in `centraid.core.v1`, not a third package.** `core.v1`'s
`buf breaking` promise *is* this promise — "a gateway's commitment to seats that
update on their own schedule" — and `api-proto/tests/tree.rs` already refuses a
third package that would have to restate it in `buf.yaml`.

**The object NAME stays BLAKE3; the ATTESTED CHECKSUM is SHA-256.** §3 says "the
gateway confirms that its SHA-256 equals its name", and W3 landed the name as
BLAKE3 of the ciphertext (`crates/media/src/object`). Both cannot be true, and
ONE HASH settles which: the name is ours and stays BLAKE3; the checksum is the
store's, because R2, S3, B2 and MinIO attest SHA-256 and nothing else, and R2
records it only when the client sent it. So `ObjectDeclaration` carries **both
names of the same bytes**, and the declaration is the binding a gateway can hold
an attest-only store to. `crates/gateway-core/src/checksum.rs` is the only module
that names SHA-256 and carries the allowlist entry, in W0.5-R1's shape.

**The SQL schema is a contract file, not a Rust string.** `cargo xtask rules`'
sql-confinement scans Rust string literals; §3 says `gateway-core` joins its
allowlist. Putting the DDL in `contracts/gateway/schema.sql` and reaching it with
`include_str!` makes the question moot — the crate holds no SQL, `rules.rs` was
not touched, and the schema is where a contract between two adapters belongs.
**The allowlist edit §3 anticipated is therefore not needed.**

**The ports are `async fn` in trait with no `Send` bound.** A Durable Object's
futures are `!Send`; a `Send` bound would make this crate unimplementable in half
of what it exists for. One `StoreFault` rather than two associated error types,
because no rule branches on which store failed.

**`crates/gateway-core` does not depend on `crates/identity`.** The certificate's
byte layout belongs to the crate that mints it, and `centraid-identity` carries
pkarr, which a Worker has no business linking. An adapter decodes and verifies
the certificate there and hands `auth::CertifiedDevice` in; every *policy* over it
— the epoch order, the replay window, the request signature — is here.

### What the conformance suite proves

It is a **library function**, not a `#[test]`: `cargo test` cannot reach inside a
Worker under Miniflare, so W4b and W4c call `conformance::run` with their own
`Harness`. `crates/gateway-core/tests/conformance.rs` is one of the three callers,
over the in-memory adapter, and it also drives a harness that stores nothing —
so a suite that could not fail would be caught.

Fifteen cases: both checksum modes; no attestation is a rejection;
read-and-hash catching bytes that do not hash to their name; refusing to presign
a committed name and refusing to re-bind one; the two-device manifest-CAS race
and the fresh-writer claim; version skew both ways; the retention-abuse run and
the base-tombstone rate limit; `VAULT_MOVED` versus a stale epoch; quota and
lapse; the blind scrub; the grace period; and the canary.

**What it cannot prove, named rather than left to be found:**

1. **That an adapter's compare-and-set is atomic.** The race case drives two
   writers in sequence. The *rule* refusing the loser is what is under test;
   that the adapter applies it under something that serialises is
   `StateStore::compare_and_set_head`'s contract and the adapter's own tests.
2. **That attest mode catches a name that lies about its bytes.** It cannot —
   that is a property of attest-only stores, not a gap. The suite asserts the
   *difference* between the modes instead of papering over it.
3. **That the ciphertext is ciphertext.** The canary proves nothing on the
   gateway path copies a plaintext or a plaintext hash into the store; that the
   phone sealed properly is `crates/media`'s vectors.

### Findings

1. **The size guard as §3 words it does not hold, and the abuse run found it.**
   "A base whose total padded size is under half its **predecessor's**" checks
   the newest pair only — so a stolen phone uploads one tiny base (the guard
   trips), then a *second* tiny base, at which point the newest pair is
   tiny-against-tiny, the ratio is 1.0 and the guard goes quiet with fifty empty
   generations sitting in the history. Every delete after that sails through.
   The guard is now a property of the **live history**: any consecutive pair
   under the threshold trips it, and it stays tripped until the shrunken bases
   are gone or the member confirms. The release is `member_confirmed_shrink` on
   `DeleteRequest`, which is §3's own "until the member confirms on the phone" —
   the warning is computed there because the row census is readable only there
   (F4). Reading alone would not have found this; writing the fifty-generation
   run did.
2. **`centraid-identity` is very likely not WASM-clean, and W4c needs it.** This
   crate deliberately avoids depending on it, but an adapter must decode a
   device certificate somewhere, and `centraid-identity` carries `pkarr`,
   `url` and `iroh-dns-server` in dev. **Owner question for W4c:** split the
   certificate/HPKE half of `crates/identity` from the pkarr half, or have the
   Worker decode the 136-byte certificate against `identity`'s published layout?
   Recommend the split, in the wave that opens `gateway/cloudflare`.
3. **The `gateway-engine-mode-agnostic` governance directive has no subject.**
   It scans `packages/server/src/engine/**/*.ts`, which v1 does not have; its
   principle — *the "same code, three hosts" property breaks the moment the
   engine starts checking which host it is living in* — now belongs to
   `crates/gateway-core`, where `tests/wasm_clean.rs` enforces it against a
   `GatewayMode`. Repointing the directive is an estate change and was not made
   here. **Owner question:** repoint it at `crates/gateway-core/src/**`, or
   retire it and let the crate test carry it?
4. **`crates/api-proto/README.md` was stale before this lane.** Its file table
   still listed `log.proto` and `intent.proto`, both deleted in W2. The two rows
   are dropped with this lane's additions.
5. **Anti-replay inside the window is not implemented and is not a rule here.**
   The replay window bounds *how long* a captured request is usable, not whether
   it can be replayed inside it. For writes this is mostly moot — a replayed
   commit either fails the compare-and-set or is idempotent — but a replayed
   *delete* is not. A seen-nonce set is storage, so it would be a third port.
   **Owner question for W4b/W4c:** add one, or accept the window as the bound
   and say so in `SECURITY.md`?

### Verification (lane A)

`export CARGO_TARGET_DIR=/home/user/.cargo-target-w4a` throughout. No network,
no adapter, no server.

| Exit item | Result |
| --- | --- |
| 1 `cargo build --workspace` | **clean** |
| 2 `cargo test -p centraid-gateway-core` | **73 green** — 68 unit, 2 conformance, 3 wasm-clean. The named cases: `commit/two-devices-racing-leave-exactly-one-winner`, `retention/fifty-empty-generations-cannot-push-a-real-base-out` and `retention/one-client-base-tombstone-per-vault-per-day`, `checksum/attest-mode-…` and `checksum/read-and-hash-mode-…` and `checksum/no-attestation-is-a-rejection`, `canary/no-plaintext-or-plaintext-hash-is-anywhere-in-the-store` |
| 3 `cargo test -p centraid-api-proto` | **12 green** |
| 4 `cargo test --workspace` | **green, 1530 tests, exit 0** (1452 on the base; +78) |
| 5 `cargo check -p centraid-gateway-core --target wasm32-unknown-unknown` | **clean**, after `rustup target add`. Run once, at the end |
| 6 `gate --lane fmt` / `--lane clippy` / `--lane rules` | **PASS**, **PASS**, **PASS** (4 rules, 0 pending; sql-confinement clean over 184 files) |
| 7 `gate --profile local` | `fmt` `clippy` `test` `rules` all **ok**; **BUDGET ok — 73.3s of 120s** (`test` 71.4s). An earlier run of the same tree measured 161.8s with `test` 159.8s while the sibling mobile lane was building — a 2.2x spread on one contended 4-vCPU container, the same variance W3 recorded. Nothing in the ledger was touched. Only `ledgers` fails, and not on its subject: **"no merge base found"**, the worktree limitation both W3 lanes recorded |
| 8 `bun run check:push:static` | **4/4 green** (`bun install` first) |
| 9 `node scripts/check-ledgers.mjs --base 2a0a1f0a` | **ok — 19 sections across 5 ledgers hold** |
| 10 `node .governance/law/run.mjs --brief-digest 1d83dd8ab268` | **10 rules, no findings; the law did not move** |
## W2 — the mobile half (lane M)

Branch `claude/1029-w2m-mobile`, base `2a0a1f0a`. **Nothing was deleted. The lane is
blocked on the same wall W2 hit, re-confirmed with fresh evidence, and this section is
the hand-up.** One commit, this section.

The lane was dispatched on the premise that Maven Central had recovered — a re-probe of
`kotlin-stdlib-2.1.0.pom` answered `200`. **That probe was not representative.** Maven
Central is rate-limiting this container's egress *intermittently and per-request*, and a
single serial `curl` is the one shape of request that gets through.

### The blocker, measured

`./gradlew :shared:jvmTest :core:jvmTest` was run three times from
`/home/user/centraid-w2m/mobile`. All three failed in configuration, before a single
line of Kotlin was compiled:

| Run | Shape | Result |
| --- | --- | --- |
| 1 | default | `BUILD FAILED` — `Could not resolve com.squareup.wire:wire-kotlin-generator:7.0.1`, `429 Too Many Requests`, "23 more failures with identical causes" |
| 2 | default, retry (the brief's one permitted retry) | `BUILD FAILED` — same, on `wire-swift-generator` and `com.charleskorn.kaml:kaml:0.104.0`, "16 more failures" |
| 3 | `--max-workers=1 --no-parallel` | `BUILD FAILED` — same. Serializing the resolve does not clear it |

The failing requests are all `Could not HEAD 'https://repo.maven.apache.org/...'`.
Probing that exact distinction is what named the cause:

```
HEAD=200 GET=200  .../com/charleskorn/kaml/kaml/0.104.0/kaml-0.104.0.pom
HEAD=429 GET=200  .../com/squareup/wire/wire-swift-generator/7.0.1/wire-swift-generator-7.0.1.pom
```

**The same URL answers `429` to `HEAD` and `200` to `GET` in the same second.** This is a
flapping upstream limiter, not an outage and not a proxy fault —
`$HTTPS_PROXY/__agentproxy/status` reports `enabled: true`,
`bundleCoversEveryHost: true`, and one stale `plugins.gradle.org` relay drop already
named in the brief. Gradle's resolver does not retry a `429`, and it needs ~24
consecutive successes to configure the root project.

Gradle caches what does resolve, so repeated runs converge in principle. They do not
converge in practice here: after three runs `/root/.gradle/caches/modules-2` is **2.3 MB**
and holds **no wire artefact at all** (`find … -path '*wire*' -name '*.jar'` → empty).
The tree needs the whole Kotlin 2.4.0 and Wire 7.0.1 toolchains.

**So the compiler never ran, and the lane stopped.** Deleting `Replicas`, `GatewayLink`,
`CoreRole` and the sync surface reaches ten files that reference those symbols by name
(`grep -rln 'SEAT_REPLICATED\|SeatKind\|Replicas\|GatewayLink' mobile/` → `Replicas.kt`,
`Shelf.kt`, `HomeSession.kt`, `HomeBridge.kt`, `Enrolments.kt`, `ReplicasSpec.kt`,
`ShellModel.swift`, `MainActivity.kt`, `README.md`, `CentraidCore.kt`) — W2's estimate of
eleven, confirmed. `Shelf` alone takes its entire file layer from `Replicas`
(`list`, `pathOf`, `vaultIdOf`, `pairingPath`, `settle`), so the deletion is a rewrite of
`Shelf`, not an import removal. **A blind refactor of ten interdependent Kotlin and Swift
files with no compiler is how a tree ends up broken with nobody able to tell**, which is
the judgement W2 made and this lane re-makes on the same evidence.

The worktree is unmodified apart from this section: `git status --short` shows only the
untracked brief.

### Two defects in the brief, which the next attempt must resolve before it starts

1. **W2M-3 cannot be obeyed as written.** It orders `ChangeEvent.commit_seq` removed
   "from the proto **and** from its Kotlin readers, in one commit". That field lives in
   `crates/api-proto/proto/centraid/core/v1/change.proto:28` — and the brief's own header
   says **"never touch `crates/api-proto`"**, with a sibling lane live in it. The two
   instructions are not reconcilable by a worker. Worse, the field is *produced* on the
   Rust side by `crates/core/src/events.rs` (`:312`, `:349`, `:398`, `:446`) and
   `crates/apps/kit/src/changes.rs` (its own `ChangeEvent.commit_seq`, `:33`), and asserted
   by `crates/api-proto/tests/roundtrip.rs:122` and `crates/core-ffi/tests/{spike,contract}.rs`.
   Removing wire field 3 is a multi-crate Rust change inside the area this lane was told to
   stay out of. **Owner question: does W2M-3 belong to the mobile lane at all, or to
   whichever lane owns `crates/api-proto`?** Recommend the latter, with the Kotlin readers
   handed to it as a dependency, since the atomicity the slice demands is only achievable
   from inside that crate.
2. **Exit item 4 is unsatisfiable and always was.**
   `grep -rn 'commit_seq' … crates/ --include=*.rs` cannot go empty: `crates/vault/src/intents.rs`
   carries `commit_seq` as a **column on the intents ledger** (`:272`, `:291`, `:407`,
   `:427`, `:439`) — a different thing from `ChangeEvent.commit_seq`, with its own writers,
   untouched by W1 and W2 and not this lane's subject. `crates/vault/src/{log/mod,log/guard,error,intents}.rs`
   and `crates/ontology/src/{snapshot,registries}.rs` also name it in prose about why the
   log plane left. The exit item needs narrowing to `ChangeEvent`'s field, or it will read
   as a red on a lane that did its job.

### Found, and not this lane's slice

1. **W2M-1's designed-states trim is a Rust change, not a mobile one.** The brief points
   at "the kit `manifest.rs:44`" to keep `offline` and drop `pending`, `stale`, `conflict`,
   `parked`. That is `crates/apps/kit/src/manifest.rs:42`,
   `CANONICAL_DESIGNED_STATES: [&str; 7]` — and `manifest.rs:450` requires **every**
   canonical state to be declared by every app, so the array's consumers are
   `crates/apps/{agenda,tasks,notes,…}/src/manifest.rs`, each asserting
   `states.designed.len() == CANONICAL_DESIGNED_STATES.len()`. Trimming it is a change
   across every app crate and its manifest tests, inside `crates/`. It does not belong in a
   Kotlin lane.
2. **`mobile/maestro/flows/cold-start-and-relaunch.yaml` still does not exist**, as W2
   recorded. `mobile/maestro/flows/` holds `home.yaml` only. Reference A's inventory is
   stale on this row for the second wave running.
3. **The stale comments W2M-2 names are real and were left in place**, because touching
   them means touching files this lane could not compile: `CentraidAbi.kt:68` documents a
   removed open key, and `HomeSession.kt:123` says "one core per process" where `Shelf`
   holds one core per *vault* (`Shelf.kt:60-96` describes the cap's removal in full). They
   are a two-line doc fix for whoever next opens the tree with a working compiler.

### What a successor needs

The Gradle cache is **cold** for this tree (170 MB total, 2.3 MB of modules, no Wire). The
first thing to establish is whether Maven answers `HEAD` reliably — not `GET`, and not
`kotlin-stdlib-2.1.0`, which is cached and proves nothing. If it does not, the options are
an internal mirror, a pre-seeded `~/.gradle` from a host that can reach Maven, or a vendored
dependency set; none is a worker's call. **Nothing on this lane should be attempted without
a compiler**, and that includes the parts that look like pure deletions: `Shelf` is the
counter-example.

## W2 — the mobile half (lane M), second attempt: the cut lands

Branch `claude/1029-w2m-mobile`, base `2a0a1f0a` + the blocked-lane receipt `e44f859e`.
Five commits, **55 files, +1,763 / −5,048** over the receipt commit.

The blocker above is lifted by a **container-local** Gradle init script at
`~/.gradle/init.gradle.kts` that puts Google's Maven Central mirror first on every
resolution path. It is not a repository change and is not committed. The measurement in
the section above stands: Maven Central answers `429` to `HEAD` and `200` to `GET` for the
same URL in the same second, and Gradle uses `HEAD`.

| Commit | What |
| --- | --- |
| `f88ba062` | a write is a COMMAND, not an intent queued for a gateway — the Kotlin readers of the deleted `intent.proto` follow it |
| `a53e15b9` | **the cut**: the sync plane, the replica plane and the seat roles leave the shell. −4,297 |
| `a43268ed` | the shell stops reading `ChangeEvent`'s commit seq |
| `ea998a80` | `VAULT_MOVED` freezes a vault read-only and keeps its spool |
| `471a702d` | `mobile/README.md` stops describing the pairing plane it no longer has |

### Every deleted path, with the grep

| Path | Nothing reads it |
| --- | --- |
| `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/sync/TailResume.kt` | `grep -rn 'TailResume' mobile/` → empty |
| `.../sync/RadioResume.kt` | `grep -rn 'RadioResume' mobile/` → empty |
| `.../sync/SyncWindowPolicy.kt` | `grep -rn 'SyncWindowPolicy' mobile/` → empty |
| `.../sync/WriteGate.kt` | `grep -rn 'WriteGate\|onlineOnly' mobile/ --include=*.kt` → 4 prose lines, no code |
| `.../sync/Lifecycle.kt` | `WakeReason`, `SyncScheduler`, `LifecycleState`, `PassReport`, `SyncEffect`, `Stage` → all empty |
| `.../shell/GatewayLink.kt` | `SyncOutcome`, `StageReport`, `PairOutcome`, `SEAT_{SYNC,TAIL_STOP,BYTES_FETCH}_COMMAND` → all empty. The three command names name nothing in Rust either: `grep -rn 'seat\.sync\|seat\.tail\.stop\|seat\.bytes\.fetch' crates/` → one doc sentence |
| `.../shell/Replicas.kt` | `grep -rn 'Replicas' mobile/` → 3 prose lines in `Shelf.kt` naming what replaced it |
| `.../shell/Enrolments.kt` | `grep -rn 'Enrolments\|PairingRecord' mobile/ --include=*.kt` → 2 prose lines, no code |
| `mobile/androidApp/.../kit/GatewaySheet.kt`, `mobile/iosApp/Sources/GatewaySheet.swift` | became `MakeVaultSheet`; `grep -rn 'GatewaySheet' mobile/` → 2 supersession lines |
| `.../jvmTest/{TailResumeSpec,RadioResumeSpec,SyncWindowPolicySpec,SyncSchedulerSpec,ReplicasSpec}.kt` | subject deleted above |

**Trimmed, not deleted, and which case went where.** `WriteRunnerSpec` lost its six
`WriteGate` cases (the gate is gone) and kept every case about the editor rendering an
answer. `PendingWriteSpec` lost "an enrolment is kept before there is a replica" and "a
pass that is still copying says so" (both halves of a pairing) and kept "files landing are
a row change". `ShelfSpec` lost eleven state-derivation cases whose inputs were the pass,
the tail, the bootstrap and reachability, and gained three over the derivation that is
left. `ShellCommandsExistSpec` lost the seat-command block only. Each is said in the
file's own header with its grep. **No test was deleted to go green.**

### The three things that changed shape rather than left

1. **One way to open a vault.** `CoreConfiguration` is now a path, a `create` flag and an
   expected digest — exactly what `crates/core-ffi`'s `config_from_json` reads, which also
   *ignores* a `role` an older shell sends rather than refusing the open. `CoreRole` and
   `PairingRecord` are deleted. `Shelf.openCore(path, create)` is the only open.
2. **The vault id left the file name.** `centraid-replica-<vaultId>.sqlite3` existed so the
   shelf could fetch an enrolment record *before* opening the file and file a just-paired
   copy under the id a gateway named. Neither exists, so a phone founding its own vault
   would have had to write under a provisional name and rename — `Replicas.settle` again,
   the rename that can half-happen. `Shelf` lists every `.sqlite3`, asks each which vault
   it is, and names a new one `centraid-vault-<16 random bytes>.sqlite3`. **Files under the
   old spelling still open**, because the listing matches no prefix.
3. **`VAULT_MOVED` is cooperation.** `Shelf.freeze` refuses writes with one sentence, shows
   the unacked spool as "N changes since `<date>`", and keeps everything. No `thaw`;
   `VaultMovedSpec` asserts the surface offers none.

### Verification, item by item

| Exit item | Result |
| --- | --- |
| 1 `./gradlew :shared:jvmTest` | **191 tests, 0 failed** |
| 2 `./gradlew :core:jvmTest` | 16 tests, **1 failure, pre-existing and proved so** — see below |
| 3 `cargo xtask gate --profile mobile-jvm` | **FAIL, on the same `:core:jvmTest` case and nothing else.** `314.7s of 420s — BUDGET ok`, on a cold tree. `cargo build -p centraid-core-ffi`, `:shared:jvmTest` and `:shared:koverXmlReport` all green inside it |
| 3a the gate's drift check | the gate exits on the Gradle failure and never reaches it, so it was run by hand: `bun contracts/tools/export-native-theme.ts` + `bun run format` + `git diff --exit-code -- design copy mobile contracts/screens` → **clean**. `contracts/tools/build-screen-fixtures.ts` **cannot run in this container** — it shells out to `buf`, which is not installed (`ENOENT`). Environmental, and the screen fixtures were not touched by this lane |
| 4 `grep -rn 'commit_seq' mobile/ --include=*.kt --include=*.swift` | **empty** |
| 5 `grep -rn 'SEAT_REPLICATED\|SeatKind\|Replicas\|GatewayLink' mobile/` | **no code**; 7 prose lines, each a supersession marker naming what replaced the symbol |
| 6 `cargo build --workspace` | not run whole. `git diff --stat 2a0a1f0a HEAD -- crates/ contracts/` is **empty** — this lane touched no Rust — and the gate's own `cargo build -p centraid-core-ffi` compiled from cold and succeeded, which is 22 of the 23 members' dependency closure |
| 7 `cargo test --workspace` | same — no Rust delta from a base lane B already verified at 1,452 green |
| 8 `bun run check:push:static` | **4/4 green** (`bun install` first) |
| 9 `node scripts/check-ledgers.mjs --base 2a0a1f0a` | **ok — 19 sections across 5 ledgers** |
| 10 `node .governance/law/run.mjs --brief-digest 1d83dd8ab268` | **10 rules, no findings; the law did not move** |

**The `:core:jvmTest` failure is not this lane's.** `AbiRoundTripSpec` > "open, call,
next_event, free and close, against the real library" asserts `buffersHandedOver` does not
move over a 150 ms drain of a quiet core, and it moves 3 → 8: the core now *emits* change
events on an idle handle (W1's `update_hook`). Proved by `git checkout HEAD --
mobile/core/src` and re-running — identical failure with none of this lane's edits
present. It has never been run in a container that could resolve Maven, which is why it
was not caught when it landed. One environmental note for whoever runs the gate:
`:core:abiFixture` builds the fixture **binary** and not the cdylib the spec dlopens, so
`cargo build -p centraid-core-ffi` is needed once.

### What could not be verified, and why

- **Neither shell was compiled.** The Android SDK is absent from this container
  (`./gradlew :shared:tasks` lists no Android compile target), and a Kotlin/Native link for
  iOS downloads a toolchain this lane was told not to spend disk on. `MainActivity.kt`,
  `HomeScreen.kt`, `ShellModel.swift`, `HomeView.swift`, `CentraidApp.swift` and both
  `MakeVaultSheet`s were changed **by hand against the compiled shared API** and checked by
  grepping every bridge method each shell calls against `HomeBridge`'s surface. That is the
  weakest evidence in this section and it is the first thing a device lane should re-run.
- **`androidMain` and `iosMain`** of `shared` are in the same position, for the same
  reason. Both were edited (the `BackgroundTasks.window` cut, the secure-store comment).

### Two things fixed that were not this lane's subject

1. **`ShellModel.masked` had no writer.** `grep -n 'masked' mobile/iosApp/Sources/` on the
   commit before the cut finds one line — the declaration — so the app-switcher privacy
   mask (`docs/mobile-offline.md:253`) could never paint and a member's rows went into
   every snapshot iOS took. It was reachable only through the scene phase, and the scene
   phase spent both its cases opening and closing the gateway tail. Deleting the tail left
   it as the only thing scenePhase does, so it is wired rather than left as a flag nothing
   sets.
2. **`CameraRoll.pass` read the core before the freeze**, so a frozen *and resting* vault
   would have answered "No vault is open on this device" over a vault the member was
   looking at. Found by `VaultMovedSpec` while it was being written.

### Handed up — owner decisions this lane could not take

1. **The shell cannot found a vault, and the missing half is Rust.** `Core::open` with
   `create` calls `Vault::create`, which lays down the migrations; **nothing over the ABI
   writes the `core_vault` row** that makes them a vault. `Vault::found` has no registered
   command (`grep -rn 'with_system_commands' crates/vault/src/commands/mod.rs:265`, and no
   `vault.found` anywhere in `crates/vault/src/commands`) and there is no founding arm in
   `envelope.proto`. `Shelf.found` is complete and correct the day that door lands; until
   then it deletes the file it made and answers `NOT_FOUNDED`. **Which lane adds it?**
2. **`ERROR_CODE_VAULT_MOVED` does not exist.** `error.proto` has 25 codes and none is it,
   and `crates/api-proto` is another lane's. `Shelf.freeze` is the shell-side state and its
   caller today is W5's restore client; when the code is minted the mapping goes beside its
   siblings in `sync/ReadFailures.kt` and calls the same function. **Recommend minting it
   with the lease in W5** rather than in an api-proto sweep, so the producer and the code
   land together.
3. **`VaultLockup` has no slot for a frozen vault.** Three states — syncing, synced,
   offline — all of them a gateway's vocabulary, and since this cut the shell reaches only
   `STATE_ONLINE`. There is no state for "moved" and no string field for its line, so the
   freeze reaches a member through the write refusal (which every screen renders) and
   through `HomeBridge.frozenLine()`. **Recommend the api-proto lane trim the enum and add
   the slot in one act**, since both are the same message.
4. **`ChangeEvent`'s field 3 now has no reader on the phone**, which is what W2 left it on
   the wire for. It can leave with its Rust producers whenever that crate's lane runs.
5. **`Copy.kt` carries 14 app sentences naming a gateway** — Locker's offline notice,
   Tally's "materialises on the gateway", Photos' "On this phone only until the gateway
   answers" and others. It is GENERATED from `copy/<app>.json` by
   `contracts/tools/export-copy.ts`, so the fix is in those leaves and belongs with each
   app's own lane, not here. `grep -n -i 'gateway' mobile/shared/src/commonMain/kotlin/dev/centraid/design/Copy.kt`.

### Found, not this lane's slice

1. **`Mount.kt` is dead product code.** `Mount.Waiting`, `Mount.Mounted`, `Mount.Revoked`
   and `remount()` have no caller outside `NavigationAndMountSpec`, and `Waiting.Reason`
   still spells `NOT_PAIRED` and `BOOTSTRAPPING`. `MountKey` lost its last caller with the
   file-name change. The law the spec pins — the vault is a MOUNT and never a navigation
   parameter — is real and worth keeping; the types under it are not currently used to keep
   it.
2. **`AndroidBackgroundTasks` registers WorkManager under `"centraid-sync-pass"`**, a
   periodic `androidx.work.Worker` with an empty body. The pass it was named for is gone.
   The name is persisted unique-work state, so renaming it orphans what is already
   scheduled on a device — an owner call, not a worker's.
3. **`ScreenEffect.FetchOriginal` is emitted and nothing serves it.** The Photos grid's
   download arrow rode `seat.bytes.fetch`, which left with the seat plane. The effect and
   the affordance are kept because the phone's byte plane is W6's; `ScreenRuntime` says so
   where it used to serve it. This is the exact "emitted with no producer" shape #1025 S5
   was written to close, and it is open again until W6 runs.
4. **`TransferRule` and its sheet survive with nothing to govern.** The rule decides when
   ORIGINALS may cross a metered link from a gateway. Both shells still offer "Download
   settings". W6's, with the byte plane.
5. **`mobile/maestro/flows/cold-start-and-relaunch.yaml` still does not exist.** Third
   wave running that Reference A's inventory names it.

## W4 — the standalone adapter (lane B)

One binary and one image anyone can run, over `crates/gateway-core`'s ports and
nothing else, passing the same conformance suite the Cloudflare adapter will —
in **all four store-and-mode combinations**. *Neither deployment is the
reference implementation: the protocol and its conformance suite are* (§3), so
the interesting thing about this lane is what is **not** in it: no rule.

### What landed

| Where | What |
| --- | --- |
| `crates/gateway-server/Cargo.toml`, `README.md` (new) | the crate, `#![forbid(unsafe_code)]`, and what is deliberately not in it |
| `crates/gateway-server/src/lib.rs` (new) | the shape, and the three things that are this deployment's rather than the protocol's |
| `crates/gateway-server/src/clock.rs` (new) | the ONE reach for the wall clock; every rule takes time as an input (F10) |
| `crates/gateway-server/src/sql.rs` (new) | 23 statements, every one `include_str!`'d from `contracts/` |
| `crates/gateway-server/src/state.rs` (new) | `StateStore` over SQLite; the compare-and-set under `BEGIN IMMEDIATE` (F7) |
| `crates/gateway-server/src/bytes/{mod,fs,s3,sigv4,configured}.rs` (new) | two byte stores, the optional mirror the scrub repairs from, and AWS SigV4 |
| `crates/gateway-server/src/tenancy.rs` (new) | admission by invite, owner-managed (Q13) |
| `crates/gateway-server/src/http.rs` (new) | axum over the rules, and the proxy a phone `PUT`s to |
| `crates/gateway-server/src/serve.rs` (new) | the listener, and the only one in this workspace |
| `crates/gateway-server/src/acme.rs` (new) | TLS-ALPN-01: no inbound port 80, no DNS API token |
| `crates/gateway-server/src/service.rs` (new) | the systemd unit and launchd agent, carried over from the v0 installer |
| `crates/gateway-server/src/config.rs` (new) | what an operator wrote down, and the defaults if they wrote nothing |
| `crates/gateway-server/src/bin/centraid-gateway.rs` (new) | `serve`, `invite`, `invites`, `scrub`, `health`, `install` |
| `crates/gateway-server/tests/common/mod.rs` (new) | the harness, and a real S3-compatible store over a real socket |
| `crates/gateway-server/tests/conformance.rs` (new) | `conformance::run`, four times, plus the red-first check |
| `crates/gateway-server/tests/tenancy.rs` (new) | two tenants, a live server, real certificates and signatures |
| `crates/gateway-server/tests/canary.rs` (new) | the raw SQLite bytes, every stored file, and the log |
| `crates/gateway-server/tests/first_run.rs` (new) | no vault, no keys, no private key on disk |
| `crates/gateway-server/tests/no_rules_here.rs` (new) | the architecture, as a grep |
| `crates/gateway-server/tests/container.rs` (new) | every coupling between the image and the CLI |
| `contracts/gateway/schema.sql` | `base`, `base_object`, `client_base_delete` |
| `contracts/gateway/standalone.sql` (new) | the `invite` table: this deployment's admission, and nothing else |
| `contracts/gateway/queries/*.sql` (23 new) | one statement per file, so `sql-confinement` needs no allowlist edit |
| `deploy/gateway-server/{Dockerfile,README.md}` (new) | the image, and self-hosting it |
| `deploy/README.md` | which gateway "binds no TCP listener" is about, now that there are two |
| `crates/xtask/src/rules.rs` | `no-listening-socket` repointed, with a two-entry named allowlist and two new tests |
| `crates/vault/tests/one_hash.rs` | one allowlist entry: `gateway-server/src/bytes/sigv4.rs` |
| `.governance/packs/.../gateway-engine-mode-agnostic/**`, `CONSTITUTION.md` | the directive that lost its subject, repointed (W4B-4, its own commit) |
| `Cargo.toml` | axum, reqwest, tokio-rustls-acme, tokio-rustls, time; and the `sha2`/`hmac` boundary comment, which now names the two crates that carry it |

### The conformance run, combination by combination

`conformance::run` is a library function precisely so more than one adapter can
drive it. All four are green, and the two axes are independent rather than
redundant:

| Combination | Result | What only this one exercises |
| --- | --- | --- |
| filesystem × attest | **green** | the store attests what the adapter recorded at upload |
| filesystem × read-and-hash | **green** | the adapter reads and hashes; catches bytes that do not hash to their name |
| S3 × attest | **green** | a real signed `HEAD`, a real attestation header, parsed |
| S3 × read-and-hash | **green** | a real signed `GET`, hashed here, with the attestation asked for on the same request |

Plus `the_suite_goes_red_against_a_harness_that_stores_nothing`: a harness that
drops uploads on the floor takes the suite red **against this adapter**, so the
four rows above are not satisfied by a harness that quietly did nothing.

**What the S3 half could not be run against, named rather than skipped.** The S3
store is a real HTTP server over a real socket, reached by the real `reqwest`
client with a real SigV4 signature — but it is not MinIO, not B2 and not R2. It
verifies the *shape* of the `Authorization` header rather than recomputing the
signature; the chain itself is pinned against AWS's own published vectors in
`sigv4`'s unit tests (RFC 4231 case 2 for the MAC, the 2015-08-30 `us-east-1`
`iam` signing key for the four-step derivation). **Interoperability with a
particular vendor is untested here**, which is precisely why the checksum mode
is configuration rather than something the adapter sniffs.

### Two defects the four runs found, and neither was visible by reading

1. **`Response::content_length()` on a `HEAD` is zero.** reqwest reports the
   body it received, not the header, so every attest-mode commit failed with
   `SizeMismatch` — a message naming the checksum rather than the header that
   caused it. The store's `Content-Length` header is what is read now.
2. **An upload the client did not attest is a rejection in BOTH modes.**
   `checksum/no-attestation-is-a-rejection` asserts it for `ReadAndHash` too,
   and `gateway-core`'s in-memory adapter answers `None` in both. The S3 store
   was reading and hashing an unattested object anyway, which would have
   **accepted bytes the hosted adapter refuses** — the exact divergence the
   shared suite exists to catch. It now asks for the attestation on the same
   request with `x-amz-checksum-mode: ENABLED` rather than paying a second round
   trip. (This is also a tension worth naming: `ByteStore::evidence`'s doc
   comment reads as though a store that cannot attest is simply read and hashed,
   while the suite requires the refusal. The suite is the authority and this
   adapter follows it; **owner question** below.)

### What the canary scanned

The suite's own canary runs in all four combinations, through the two windows a
`Harness` opens. `tests/canary.rs` is wider, because those two windows are the
adapter's own account of itself:

- **the SQLite file's raw bytes on disk**, after the object has been declared,
  committed, tombstoned and purged — a value that reached a column and was
  deleted is still in the file, and a `SELECT` would not show it;
- **every byte of every file** under the data directory, sidecar markers
  included;
- **the log**, captured while the path runs, for the plaintext, its BLAKE3, and
  for a whole vault key or object name — a log is the one place the gateway's
  entire view would otherwise be gathered in one copyable file.

Needles: the plaintext and its BLAKE3, in raw bytes and in hex. The ciphertext
is derived from the plaintext so it shares no run with it, so a hit means a
leak rather than a collision. The check is asked of something: the ciphertext's
presence on disk is asserted **before** the purge, or a scan after it would be
scanning an empty directory and calling that clean.

And on a live server: an invite minted through the real CLI does not appear in
`gateway.sqlite`, its `-wal` or its `-shm`; only its BLAKE3 does.

### The rulings this lane spent

**§3 — one protocol, two deployments.** No `GatewayMode` here either, and
`tests/no_rules_here.rs` is the grep that says so; `bytes/`, `tenancy.rs` and
`service.rs`/`acme.rs` are the three places this deployment differs, and every
one of them is behind a port or is admission.

**F7 — the manifest CAS is the fence.** `BEGIN IMMEDIATE`, which takes the write
lock *before* the read, so the read and the write are one step. `BEGIN DEFERRED`
would be the bug with a transaction around it: it takes a read lock and upgrades,
which SQLite answers with `SQLITE_BUSY` and a retry loop a careless author turns
back into read-decide-write. The decision inside is `commit::compare_and_set` —
three mechanisms, one rule.

**F4 — the guard reads padded size and server time.** Untouched. The delete rate
limit's memory is one row per vault, because `record_client_base_delete(vault,
at)` carries no object name.

**F13 — quotas and lapse are rules.** A redeemed invite carries a quota; there
is no unbounded arm anywhere, and `Quota` has no `None`.

**Q13 — household tenancy.** By invite, owner-minted, single-use under a race
(the redemption is a conditional `UPDATE` on `redeemed_at_ms IS NULL`), and the
server keeps the invite's BLAKE3 and never the invite.

**Q24 — append-only off by default.** `Config::append_only` is `false`, the
default is asserted in `config.rs` and in `tenancy.rs`, and
`deploy/gateway-server/README.md` says what turning it on costs beside the five
defences that need no decision at all.

**W4c owns Cloudflare.** No Worker was written.

### Findings, and the questions that go with them

1. **`contracts/gateway/schema.sql` had nowhere to put a base.** `BaseRecord` is
   a **group** of objects under one commit head, and the floor, the coverage
   window and the size guard are all defined over the group. `object.generation`
   cannot stand in: a phone may commit many bases under one generation id, and
   the suite's own abuse run lands fifty. `base` and `base_object` are added to
   the **shared** schema, because the Worker needs them as much as this does.
2. **`client_delete`'s key cannot be written by the port that needs it.** It is
   keyed `(vault_key, object_name)`; `StateStore::record_client_base_delete`
   carries no name, because the rule does not need one. `client_base_delete` is
   added as the rate limit's own one-row-per-vault memory, and `client_delete`
   stays as the per-object audit ledger — **which the engine never writes**.
   **Owner question:** should `client_delete` be written from the delete path
   (an owner reading "what did this device delete, and when" has nothing today),
   or dropped from the schema?
3. **`no-listening-socket` was written before the product had a server.** Its
   finding text said the blob door is "the only listener the product may ever
   have"; #1029 §3 introduces a gateway whose entire job is to be dialled. It is
   **repointed, not relaxed**: it still scans every crate and every other file
   inside this one, the exemption is two named files with reasons rather than a
   crate or a `tests/` glob, and two new tests keep it honest — a second listener
   in the gateway crate is still caught, and a dead allowlist entry fails.
   **Owner question:** is a named-file allowlist the right shape here, or should
   the rule instead learn the difference between a shipped tree and a `tests/`
   one?
4. **A second `sha2`/`hmac` carve-out.** SigV4 is an HMAC-SHA256 chain over a
   SHA-256 payload digest; a signature restated in BLAKE3 opens no bucket. The
   spelling is confined to `bytes/sigv4.rs` — the module's own constants are what
   the S3 store and the tests use, so the boundary is one file including in
   tests — with one `SHA256_ALLOWED` entry in lane A's shape. The workspace
   comment beside `sha2` now names the two gateway crates rather than claiming
   only `xtask` and `identity` carry it. **Owner question:** W0.5-R1 is still a
   ruling with a recommendation rather than a `docs/decisions.md` supersession of
   D-1025-S4-5; this is its third coat and W9 should close it.
5. **There are two service-unit generators in the tree now.**
   `crates/centraid/src/cmd/units.rs` and `gateway_install.rs` survive — the
   brief expected W2 to have deleted them — and `deploy/systemd/`,
   `deploy/launchd/` and `contracts/deploy/units/*.expected` are their frozen
   goldens. They were **not** moved here, and the reason is that the move is
   bigger than it looks: their units carry a `LoadCredentialEncrypted` keystore
   credential that a **blind** gateway has no use for, and their goldens are
   byte-frozen against v0's own generator over a `centraid gateway` exec line
   that would have to change. `deploy/README.md` now states the seam.
   **Owner question:** retire `centraid gateway install` and its credential arm
   and regenerate the goldens against `centraid-gateway serve`, or keep both
   because `centraid` still installs as a service for a different job?
   Recommend the first, in a wave that can also touch `contracts/deploy/units/`.
6. **`deploy/docker/Dockerfile`'s default command no longer works.** Its
   `CMD ["gateway", "--data-dir", "/data"]` refers to a verb W2 reduced to
   `gateway install`; the image builds and then exits on `docker run`. Found in
   passing, not this lane's subject, and not fixed here.
7. **The image could not be built.** This container has no Docker daemon
   (`/var/run/docker.sock` is absent), so `docker build` did not run anywhere in
   this lane. `tests/container.rs` checks every coupling a build would have
   caught — the package, the binary, the profile and the `target/` path, each
   verb and flag in `CMD`/`ENTRYPOINT`/`HEALTHCHECK`, the environment variable
   the CLI reads, the unprivileged user, the state directory and the digest pins
   — and claims nothing more than that.
8. **The replay window is still the only anti-replay bound**, as lane A recorded.
   This adapter adds no seen-nonce store, so a captured **delete** is replayable
   inside the window. Repeating the question rather than letting it go quiet.

### Verification (lane B)

`export CARGO_TARGET_DIR=/home/user/.cargo-target-w4b` throughout.

| Exit item | Result |
| --- | --- |
| 1 `cargo build --workspace` | **clean** |
| 2 `cargo test -p centraid-gateway-server` | **64 green** — 37 unit + `conformance` 5, `tenancy` 5, `container` 6, `first_run` 5, `no_rules_here` 4, `canary` 2. Named: `the_suite_is_green_against_{a_directory,an_s3_store}_in_{attest,read_and_hash}_mode`, `one_tenant_cannot_{read,write_under,delete}_anothers_*`, `a_signature_does_not_travel_between_paths`, `no_plaintext_and_no_plaintext_hash_is_anywhere_on_disk`, `nothing_the_gateway_logs_carries_a_plaintext_or_a_whole_key` |
| 3 `cargo test --workspace` | **green, 1596 tests, exit 0** (1530 on base; +66) |
| 4 conformance, four combinations | **4/4 green** — the table above. S3 against an in-process S3-compatible store, not a vendor |
| 5 `gate --lane fmt` / `--lane clippy` / `--lane rules` | **PASS**, **PASS**, **PASS** (4 rules, 0 pending; sql-confinement clean over 207 files, no-listening-socket clean over 317 with 2 named) |
| 6 `gate --profile local` | `fmt` `clippy` `test` `rules` all **ok**. **BUDGET 196.1s of 120s**, `test` 193.6s, at load average 4.5–5.5 on 4 vCPUs beside the sibling mobile lane's two resident JVM daemons — the same contention lane A measured as 73.3s alone against 161.8s shared. This crate's own suite is **0.23s** of execution. Nothing in a ledger was touched. `ledgers` fails on **"no merge base found"**, the worktree limitation both W3 lanes and lane A recorded |
| 7 `bun run check:push:static` | **4/4 green** (`bun install` first; `bun run format` over the two new READMEs) |
| 8 `node scripts/check-ledgers.mjs --base c4120bf0` | **ok — 19 sections across 5 ledgers hold** |
| 9 `node .governance/law/run.mjs --brief-digest 1d83dd8ab268` | **10 rules, no findings.** The law **moved**, as W4B-4 intended: the digest is now **`2612c611d7e6`** |
| 10 live run, no vault and no keys | **yes.** `serve` on an empty directory → `{"protocol_min":1,"protocol_max":1,…}`; every unauthenticated verb refused (`GatewaySignatureInvalid`, `Unauthorized`); an invite minted, redeemed once, and the second redemption refused; `scrub` clean; no file in the data directory that looks like key material; the invite code absent from `gateway.sqlite`, its `-wal` and its `-shm` |
## W5 — keys, restore and the phone's client

Base `0f988007`. Branch `claude/1029-w5-keys-restore`. Law digest `1d83dd8ab268`.

**What landed, and what did not.** The four ABI doors, the `PERSIST_WAL` shim and the
restore drill landed. **The phone's gateway client and the seed's custody screens did
not** — see "What this wave did not build" at the end, which names each piece, why it
stopped, and what the next wave inherits. Nothing was half-built: no signing code, no
background-transfer code and no phrase screens exist in a partial state.

### The hand-offs

1. **`vault.found` over the ABI — DONE.** `crates/api-proto/proto/centraid/core/v1/vault.proto`
   carries `FoundRequest`/`FoundResponse`; `envelope.proto` gains `Request.found = 14` and
   `Response.found = 14`; `crates/core`'s `api::found` and a `handle.rs` dispatch arm write
   the row. Its own request arm and **not** a registered command: the registry's gate order
   evaluates a `Principal` against `core_vault.self_party_id` and writes a receipt naming the
   vault, and founding is the act that writes both — a command exempted from the gate order
   would be a second command plane wearing the first one's name. A second found is refused
   with `ERROR_CODE_VAULT_ALREADY_HELD`, because `Vault::found` inserts unconditionally and
   two `core_vault` rows make `vault_id`'s `ORDER BY … LIMIT 1` a random draw.
   Kotlin: `VaultRoster.found` beside `identify`, `Shelf.found(name, ownerName)`.
   Tests: `founding_turns_a_created_file_into_a_vault_that_can_name_itself`,
   `a_second_found_is_refused_and_the_vault_already_here_is_untouched`,
   `a_found_request_over_the_envelope_makes_the_file_a_vault`, `FoundDoorSpec`.

2. **`ERROR_CODE_VAULT_MOVED` — ALREADY MINTED; the GAP WAS THE FIELD.** The brief's State
   table predates `4947f59f`: the code (`= 25`) and `lease.proto`'s `VaultMoved` were on this
   base already. What did not exist was anywhere for the companion to ride — `error.proto`'s
   own comment says "a `VaultMoved` (`lease.proto`) rides with this code" and there was no
   field. `Error.moved` is that field. Without it a phone learns THAT its vault moved and
   never when, which is half of "N changes since `<date>`", and a client inferring the date
   from its own clock would be inventing the one fact the refusal exists to carry.
   `dev.centraid.shared.sync.movedFrom` is the one reader; the unacked count is an ARGUMENT
   and never read off the refusal, because the gateway cannot know what this phone has not
   sent it.

3. **The `VaultLockup` trim plus the frozen slot — DONE.** `STATE_SYNCING` and
   `STATE_OFFLINE` were facts about a PASS that #1029 §1 deleted; both are reserved by number
   AND by name, which is what keeps the `WIRE_JSON` promise `buf.yaml` makes for
   `centraid.screen.v1`. `STATE_FROZEN = 4` and `string frozen_line = 9` take their place.
   Before this, `Shelf` could only say `STATE_ONLINE` about a vault that had moved — a
   switcher row reading "synced" over a vault refusing every write, which is the umbrella's
   UI invariant broken in the smallest possible way. Both shells' `stateLine` tables say the
   same sentence. `HomeBridge.frozenLine` stays and is not a second source: it and the lockup
   both read `Shelf.Holding.frozenLine`.

4. **`ChangeEvent.commit_seq` — DELETED, with its producers.** Its only reader was a seat's
   overlay. What makes deleting it right rather than tidy: the producer is now a rusqlite
   `update_hook`, which knows tables and no position, so it wrote a literal ZERO into every
   event in the vault's life — worse than an absent field, because an absent field cannot be
   believed. `rows_applied` went with it (callerless since the applier left), as did
   `apps/kit`'s mirror and its max-coalescing.

5. **`SQLITE_FCNTL_PERSIST_WAL` — SHIM LANDED, AND W3's COST DOES NOT REPRODUCE HERE.**
   The receipt carried W1's claim (`NO_CKPT_ON_CLOSE` is the whole requirement) and W3's
   (a full base per app launch) with no measurement between them.
   `crates/vault/tests/relaunch.rs` is the measurement: found, capture, **checkpoint** — the
   case the two claims differ over, since the app owns checkpoints and a checkpointed WAL is
   the one SQLite would delete at close — drop the connection, reopen, capture. Same
   generation, `broke: false`, and the `-wal` survives with its salts. **On this host W1 was
   right and the base-per-launch cost is not real.**
   The shim landed anyway, and not defensively: the two settings are different promises —
   one says do not checkpoint at close, the other says do not delete the `-wal` at close even
   when it has been checkpointed — and the measurement is a Linux measurement against this
   workspace's `libsqlite3-sys`. Neither phone's SQLite has ever been compiled in this
   container. One unsafe call, in `crates/core-ffi/src/wal.rs`, plugged into
   `centraid_vault::wal_persistence`; a host that installs nothing gets what it had before,
   and a VFS that refuses the control is logged rather than fatal.

6. **Android's `"centraid-sync-pass"` — UNTOUCHED, and it is still the name.** This wave did
   not build background transfers, so nothing was renamed and nothing scheduled was orphaned.
   The hand-off passes through unchanged to whoever builds them.

### The drill, its shape, and its edges

`crates/centraid/tests/restore_drill.rs`, under the gate step **`restore-drill`**.

One phrase (a published BIP-39 vector, so the derivation is checked against something
outside this repository), one account key, **two** vaults minted at two indices and named by
the account's own signed listing. Real commits, a real page-identical base and real
segments. Every object uploaded through `centraid_gateway_core::Gateway`'s own rules: lease,
plan, quota, write-once, compare-and-set on `prev_head`. Then the phone is lost — **not
deleted**, because F1 is about a phone that is still there — and a fresh phone restores.

**What makes the restore claim worth anything is the signature, not a comment.**
`restore_onto_a_fresh_phone(phrase, gateway, listing, dir, now)` takes no path on the old
phone, no key, no index and no vault id. F2 holds structurally: it is not that the restore
declines to read the lost phone, it is that it cannot. It verifies the listing against the
key its own seed just produced, claims each lease at `epoch + 1` (F3) with a fresh device
key, reads the head the gateway holds, downloads what the manifest names, and applies the
base and every segment.

Asserted: both vaults discovered; both censuses match table by table; `segments_applied > 0`,
so the tail AFTER the base is proved and not only the base; the old phone's next put is
refused with `VAULT_MOVED` naming epoch 2 and the moment it moved; every table on the old
phone is at or above its count at backup and `core_content_item` is exactly three rows above
it; its spool is non-empty.

**What it cannot prove.**
- **No phone shell is compiled** (no Android SDK; a Kotlin/Native link is outside the disk
  budget). The freeze itself — writes refused, reads kept, the line drawn, nothing wiped —
  is Kotlin, and is pinned by `VaultMovedSpec` and `VaultMovedProducerSpec`. What the drill
  asserts is the refusal those specs key on, with its companion, and that the old phone's
  rows and spool are intact for them to show.
- **No HTTPS, no request signing, no pkarr.** The gateway is called as a library. The
  transport is the piece this wave did not build.
- **One SQLite**, the host's.

The step was `release`-only and is now a `local` step, so every profile carries it: release
is the profile that runs least often, and a promise proved only there is a promise proved
after the merge. It runs **both** drills in one `cargo test --workspace --test restore_drill`
— two `-p` invocations resolve features differently from the `--workspace` build the `test`
step just did and rebuilt 105.7 s of graph every run; naming the target across the workspace
costs 1.5 s.

### Three reds in `:core:jvmTest`, one known and two hiding behind it

The brief named one and asked for a judgement. Judging it uncovered two more, both
reproduced at `0f988007` by stashing everything but the spec fix.

1. **`AbiRoundTripSpec`'s event drain — the EXPECTATION was stale, not the core.** Proved
   rather than argued: the spec now drains the queue to empty and THEN asserts clause 6 over
   four idle `next_event`s, and it passes — so nothing is emitted on an idle handle and this
   is not a battery finding. The 3 → 8 was the `core.add_party` twelve lines above it, whose
   deny is receipted and so is a commit the `update_hook` reports. A shell MUST get those.
   What the old assertion actually said was "a command produces no change events", true only
   while nothing produced any.
2. **The two-handles sentence literal still said "replica"**; production has said "vault"
   since `a53e15b9`. Unseen because assertion 1 failed twelve lines earlier.
3. **`centraid_open` could answer `OK` with a null handle** — a contract violation
   `code_for`'s own comment forbids in those words. It used `code_for`, whose
   `_ => CENTRAID_OK` arm is right for `call` (the reason rides in the out-buffer) and wrong
   for `open` (there is none). Reachable from an ordinary case: a `.db` copied away from its
   `-wal` has `application_id 0` and `Vault::open` refuses it. `code_for_open` never answers
   OK; `an_open_that_refuses_an_ordinary_file_never_answers_ok` pins it. The spec's copy takes
   its sidecars now, so that assertion tests what it says it tests.

### Rulings spent

- **F1** — the drill does not delete the old phone and asserts, per table, that nothing
  shrank. There is no `thaw` and nothing takes a vault back.
- **F2** — held by the restore function's signature rather than by discipline.
- **F3** — the restore claims `epoch + 1`; `VAULT_MOVED` names the epoch that took it.
- **§6** — nothing opened a socket; `no-listening-socket` scans 301 files clean.
- **Doctrine 2** — one unsafe call, in `crates/core-ffi`.
- **Doctrine 8** — `Error.moved` rather than a second refusal envelope; the drill joined the
  existing `restore-drill` step rather than adding a second name for one promise;
  `backup::drill::write_one` is public rather than copied.

### Found, not this lane's slice

1. **`crates/api-proto/proto/centraid/core/v1/pair.proto` has no importer and no consumer.**
   `envelope.proto`'s import of it was unused (`buf lint` says so once buf is on PATH) and is
   dropped here; nothing in Rust or Kotlin names `PairOk` or `PairRequest`. It is dead
   schema. Deleting a `centraid.core.v1` FILE is a `buf breaking` FILE-category act and
   belongs to whoever owns that promise, not to this lane.
2. **Neither `buf` nor `node_modules` existed in this container**, and
   `cargo xtask gate --profile mobile-jvm` cannot run without either — its first two
   sub-steps are `bun contracts/tools/build-screen-fixtures.ts` (which shells out to `buf`)
   and `bun run format`. Both were installed with the repo's own pinned commands. Any brief
   that quotes a mobile-jvm budget is quoting a run that had them.
3. **`crates/core`'s `VaultAlreadyHeld` doc and member sentence were pairing-flavoured**,
   naming `Handle::pair` and telling a member to "pair into a new one" for a plane that no
   longer exists. Reworded here because this wave gave the variant its new producer.

### What this wave did not build

Named so the next wave inherits a clean edge rather than a half-built one.

- **W5-2, the seed and custody.** No seed slot in the FFI, no phrase setup or check screens,
  no synchronizable keychain item. The Android caveat the brief names — Block Store restores
  only in the device-setup flow, so the written phrase is the common path there — has no copy
  to live in yet. `crates/identity`'s `RecoveryPhrase`/`Seed` are landed and the drill drives
  them; what is missing is the door onto the phone and the screens around it.
- **W5-3, the phone's gateway client.** Nothing: no request signing, no clock-skew recovery,
  no background transfers on either platform, no batching, no gateway switching, no hosted
  registration, no invite redemption, no pkarr publish. The two blockers are real and worth
  writing down: `commonMain` has no Ed25519, so signing is either a platform seam or a door
  over the ABI onto `crates/gateway-core`'s `auth` — a design decision, not a coding task —
  and neither mobile shell can be compiled in this container, so the background-transfer
  halves (`BGTaskScheduler` ids in `Info.plist`, a CONCRETE Android worker) would ship
  unverified. Half-written crypto is worse than none, so none was written.

## W5 — the phone's client (lane B)

Base `50461b81`. Branch `claude/1029-w5b-phone-client`. Law digest `2612c611d7e6`,
unmoved at close.

**The half W5 lane A did not build.** Lane A named two blockers and stopped rather than
half-building; both are answered here, and the drill it left is extended from a proof of
restore into a proof of the product.

### The design decision lane A left open

`commonMain` has no Ed25519, so signing is either a platform seam — a Swift half and a
Kotlin half — or a door onto the rules. **It is the door**, and the reason is
`gateway_core::auth`'s own opening sentence about the two SERVER adapters, which applies
with more force to a client: *"A phone that signs one shape and is verified against the
other fails for a reason nobody can read in a log."* Two shells signing their own preimages
would be two shapes, drifting, surfacing as `SignatureInvalid` on somebody's restore.

So `crates/gateway-client` signs and **the platform carries**. `Transport` is a port, not
a client, and that is not portability taste: iOS suspends a process within seconds of the
member leaving the app, and the only thing that keeps uploading is an `NSURLSession`
background task the system owns — a Rust client holding its own socket could not do the one
thing a phone client exists for.

**What makes a file-based background upload signable without reading the file.** A signature
covers a body digest, and an uploader that had to read 16 MiB to compute one defeats
`uploadTask(with:fromFile:)`. It does not have to: an object's name IS the BLAKE3-256 of
its sealed bytes (`ids.rs`), so for `PUT /v1/objects/{vault}/{name}` the digest is already
in the path. `DeviceSigner::sign_object_put` is that one line, and
`a_signed_object_put_covers_the_bytes_it_names` holds it against `ObjectName::of`.

### What landed

1. **`crates/gateway-client`** — `signer` (four headers over
   `gateway_core::auth::preimage`, the clock offset on the signer rather than at a call
   site), `transport` (the port, plus one `reqwest` impl that is explicitly not the
   phone's, redirects off because the signature covers a path and not a host), `client`
   (preflight, lease, declare, commit, put/get, the background authorisation), `outcome`
   (the wire spelling read back into a typed thing), `spool` (batching, the presigned
   lifetime rule, `BackupState`), `directory` (gateways, switching, invite redemption,
   `appAccountToken`), `publish` (the pkarr refresh policy). 39 tests.

2. **Clock-skew recovery, once.** The 401 carries the server's time; the signer learns an
   OFFSET and every later stamp carries it, including a background task's hours afterwards.
   A second skew refusal is `ClockUnrecoverable` and the call ends —
   `a_clock_that_is_still_wrong_after_one_correction_stops` asserts two attempts and never
   three. The offset is never written to a vault row and never shown: the moment a
   gateway's refusal could move a phone's idea of *when a thing happened*, a gateway could
   backdate a member's history.

3. **"This server needs an update" is a LATCH, not a check.** `ServerNeeds::Update` is set
   once and every write refuses locally —
   `a_server_below_this_phones_minimum_is_written_to_zero_times` asserts the health check
   and **nothing after it**. Reads still go through: `a_latched_client_still_reads`, because
   restore must work from a server the phone will not trust with new bytes.

4. **`gateway-server`'s `ErrorBody` was dropping both companions the rules carry.** The code
   went out and `VaultMoved`'s epoch and moment did not, so a phone learned THAT its vault
   moved and never when — half of "N changes since `<date>`", and the half a client would
   have to invent from its own clock. Same for `VersionWindow`'s range, which
   `version::admit`'s own comment says is carried "so the phone can render the typed state
   without a second round trip". Both ride now, and a missing one is `Malformed` on the
   client rather than defaulted: a shell drawing "0 changes since 1 January 1970" over a
   frozen vault would be showing a fabricated fact, which is worse than an error because it
   reads like one.

5. **Background transfers, both platforms.** iOS: a background `URLSession`,
   `uploadTaskWithRequest:fromFile:` over the sealed spool file, the object's name on the
   task so a relaunched process knows what finished, `discretionary` left false because
   `TransferRule` already owns the member's bill. The long `BGProcessingTask` joins the
   refresh task and **both ids are in `Info.plist`** — an undeclared identifier raises an
   exception that TERMINATES the app. Android: `CentraidSyncWorker` and
   `CentraidUploadWorker`, concrete `CoroutineWorker`s.

6. **`"centraid-sync-pass"` is KEPT, and `KEEP` is what changed.** The old code scheduled
   `PeriodicWorkRequestBuilder<androidx.work.Worker>` — the ABSTRACT class. WorkManager
   instantiates a worker reflectively; that one has no runnable body, so the work was
   accepted, reported enqueued, and failed inside the framework every run, while
   `register()` answered "Centraid catches up in the background". The unique name is
   unchanged so nothing a shipped build scheduled is orphaned; the policy moves KEEP →
   **UPDATE**, because `KEEP` would keep exactly the unrunnable request. That is the
   migration, and it is the answer to the hand-off's question.

7. **Custody.** The seed is the one secret allowed to leave a device. iOS:
   `kSecAttrSynchronizable` with `kSecAttrAccessibleAfterFirstUnlock` (the two go together;
   a synchronizable item with a device-only accessibility is refused), under its own service
   so `IosSecureStore.clear`'s class-plus-service delete cannot reach it. F5 holds: the seed
   is upstream of every vault-derived key, so syncing it adds nothing the phrase on a
   member's shelf does not already carry — syncing anything DERIVED from it would.
   **Android is not symmetric and the copy says so**: Block Store restores only in the
   device-setup flow, `restoresAfterSetup` is false, and `ANDROID_SENTENCE` tells a member
   who set their phone up first that they will need their 24 words.

8. **The UI invariant, in the type system.** `BackupState` has no "backed up" a caller can
   construct out of hope: its one constructor takes a gateway's own `committed_at_ms`, and
   the only source of that is `CommitAck`. Kotlin's `BackupClaim` is a **formatter**, handed
   those two numbers — a Kotlin copy of the rule would be a second answer to "is this backed
   up", with the wrong half being the one a member reads.

9. **The drill's wire arm.** See below.

### The drill: what the wire arm proves that the library arm did not

`the_restore_crosses_a_real_socket_and_the_old_phone_is_refused_by_the_server`, in the same
file and therefore under the same `restore-drill` gate step.

| Proved over the wire | Where it would otherwise break |
|---|---|
| the signature this client makes is the one this server accepts | a phone that cannot authenticate at all |
| the four headers, spelled the same on both sides | one rename, and every request fails |
| declare and commit as JSON, field by field | a name nobody checks until a release |
| `VAULT_MOVED` rendered by the server and read by the client, epoch AND moment | the freeze drawing a fabricated date |
| a wrong clock recovered across a real socket, once | a phone off for a month that can never back up again |
| the standalone deployment's `ReadAndHash` checksum mode | the drill ran `Attest` only |

The old phone's clock starts at the **Unix epoch** and nothing corrects it but the protocol.
`a_wrong_clock_is_recovered_against_a_real_server_in_one_retry` skips the preflight entirely,
so the 401 path is decided by a real server rather than by a scripted answer.

Two things only the wire arm could find:

- **The client must carry `centraid-attested-checksum`.** Without it every object uploads
  and the COMMIT is refused `GatewayChecksumMissing` — `ChecksumEvidence::None` is a
  rejection, not a shrug. That reads as a server fault and is not one.
- **The drill had never exercised `ReadAndHash`.** The library arm runs `Attest`, the hosted
  mode. Between the two arms the step now covers both, which is the split the conformance
  suite is built around.

**What the wire arm does NOT prove, said plainly.** *TLS is the deployment's.*
`TlsConfig::Terminated` is this server's default arm and the one every test runs — a reverse
proxy, a Tunnel or a Funnel holds the certificate — so what crosses is **HTTP over a real
TCP socket with real signing on top**. The signature is what authenticates a request in this
protocol; TLS is confidentiality, and `acme.rs` is where it is obtained. Calling this arm
"HTTPS" would be claiming a run that did not happen. *pkarr is not resolved here* either:
the record and the resolver have their own tests against a real `iroh-dns-server`, and a
drill that started a DNS server to be handed back a `127.0.0.1` port it already knew would
be asserting the harness. `ResolutionSource::Typed` is the documented equal-standing source
and is the one used.

### What I could not compile

- **Neither mobile shell.** No Android SDK in this container, and a Kotlin/Native link is
  outside the disk budget (16 GB free at close, with a sibling lane building wasm). So
  `PlatformServices.ios.kt`'s new `IosBackgroundTransfers` and `IosSyncedSecrets`, and
  `PlatformServices.android.kt`'s two workers and `AndroidSyncedSecrets`, are **unverified by
  any compiler** — the same status as every other line in those two files, whose headers
  already say so. `BackgroundTransferLawSpec` scans them for the four regressions whose
  failure modes are silent on a phone (an undeclared `BGTaskScheduler` id, an abstract
  worker, a data-bodied background upload, `KEEP` over the broken entry). A scan is not a
  compiler and is not offered as one; it is what would have caught the abstract `Worker`,
  which passed every reviewer and every gate.
- **`play-services-auth-blockstore`** is a new Gradle dependency, added to the catalog and to
  `:shared`'s androidMain behind `androidEnabled`. It has never been resolved here.

### Not built, and why

- **The manifest head is not published in the pkarr record.** The brief asked for it. The
  record has no entry for one, and adding it is a format change in
  `centraid_identity::record` — **W4c is live in `crates/identity` and this lane stayed out**.
  It would also be the wrong shape: a record is a public DNS answer under a key anyone may
  query, and a head that changed on every commit would publish a member's write cadence —
  how often they use their vault, and when they stopped — to anyone who resolves it. The
  head reaches a phone from the gateway over a signed request, where the only party that
  learns it already holds the objects. `publish.rs`'s header carries this.
- **Hosted-account registration is the mechanism only.** `PurchaseToken::mint` maps a random
  UUID to an account key; the server side of that mapping is `gateway/cloudflare`, which is
  W4c's. **No price and no licence text is encoded anywhere** — Q15 and Q16 are open.

### Rulings spent

- **F1** — the old phone freezes and keeps its spool. The wire arm asserts it still holds
  every row it wrote after the backup, and `BackupClaim.frozen` is asserted never to say
  "lost" or "deleted".
- **F2** — the wire restore takes the phrase and a URL. Nothing in it reads the old phone.
- **F3** — the fresh phone claims `epoch + 1` and the server is what decides.
- **F5** — the synchronizable item holds the SEED and nothing derived from it, under a
  service string `SecureStore.clear` cannot reach.
- **§6** — no listening socket and no iroh endpoint: `no-listening-socket` scans 330 files
  clean, and `grep -rn 'iroh\|listen(\|bind(' mobile/` finds only the `rebind()` method,
  comments, and a generated file under `build/`.
- **Q15/Q16** — mechanism built, no price, no licence text.
- **Doctrine 9** — `Error.moved` and `STATE_FROZEN` were used, not re-minted. The wire arm
  joined the existing `restore-drill` step rather than adding a second name for one promise.
  `ATTESTED_CHECKSUM_HEADER` is the header the server already reads, not a new one.

### Found, not this lane's slice

1. **`ErrorBody`'s companions were missing in `gateway-server` and are presumably missing in
   the Cloudflare Worker too.** This lane fixed the standalone adapter; `gateway/cloudflare`
   is W4c's tree and was not touched. **A phone talking to the hosted deployment will get a
   `VAULT_MOVED` it must treat as malformed** until the Worker renders `moved` and
   `protocol` the same way. That is a real, member-visible gap with an owner.
2. **The attestation header's VALUE is not read by `gateway-server`** — `http.rs` checks
   `contains_key` only. The store's own evidence is what is verified, so this is not a
   soundness hole, but a client could send any value and an operator debugging a mismatch
   would find a header that means nothing. Worth either reading it or documenting that its
   presence is the whole signal.
3. **The `restore-drill` step's `--nocapture` prints nothing useful now** that the wire arm
   spawns a server; a failure inside `tokio::spawn` is swallowed by the `let _ =`. Not
   changed here because the step's invocation is shared with the library arm.

## W4 — the hosted adapter (lane C)

Base `590bdaa2`, branch `claude/1029-w4c-cloudflare`, law digest `2612c611d7e6`
at base and at head — **no drift**.

The claim: `crates/gateway-core` really is the whole of the rules, because a
second adapter on a completely different runtime now passes the same suite
without reimplementing one of them.

### The files

| Path | What it is |
| --- | --- |
| `crates/identity/Cargo.toml`, `src/lib.rs`, `src/certificate.rs`, `src/phrase.rs`, `src/sealed_box.rs` | the wasm split: `discovery` and `mint`, both default-on |
| `crates/identity/tests/wasm_half.rs` | the local grep for it (2 tests) |
| `Cargo.toml` | `hpke`'s `getrandom` moved off the workspace table onto `centraid-identity`'s `mint` |
| `crates/gateway-core/src/error.rs` | `Companions`, `Moved`, `ProtocolWindow`, `Quota`, `LeaseEpochs`, `SizeCap`, `Refusal::companions()` |
| `crates/gateway-core/src/plan.rs` | `Entitlement`, `RETAIN_AFTER_LAPSE`, `plan::judge` (F13) |
| `crates/gateway-core/src/store.rs` | `StateStore::record_client_delete`; `ByteStore::evidence` reworded |
| `crates/gateway-core/src/engine.rs` | the delete path writes the audit ledger |
| `crates/gateway-core/src/memory.rs` | the in-memory half of both |
| `crates/gateway-core/src/conformance.rs` | `Harness::error_body` and `errors/a-refusal-carries-its-companions-on-the-wire` |
| `crates/gateway-core/tests/audit_ledger.rs` | the ledger rule (2 tests) |
| `crates/gateway-core/tests/conformance.rs` | the in-memory harness's `error_body` |
| `crates/gateway-server/src/state.rs`, `src/http.rs` | the ledger write; `ErrorBody` with companions; the attestation header's value read |
| `crates/gateway-server/tests/audit_ledger.rs`, `tests/common/mod.rs`, `tests/conformance.rs` | the adapter-storage proof and the suite's new window |
| `crates/centraid/tests/container.rs` | the image's verbs, pinned (4 tests) |
| `crates/vault/tests/one_hash.rs` | the scan now covers `gateway/` too; two entries added |
| `deploy/docker/Dockerfile` | `CMD` fixed, `HEALTHCHECK` removed, stale iroh prose corrected |
| `contracts/gateway/hosted.sql` | this deployment's admission addendum |
| `contracts/gateway/queries/{purchase_token_insert,purchase_token_select,purchase_token_redeem,purchase_receipt_insert,purchase_receipts_select,account_vault_insert,account_vaults_select,table_clear}.sql` | eight statements |
| `gateway/cloudflare/Cargo.toml`, `Cargo.lock` | its own cargo workspace |
| `gateway/cloudflare/src/lib.rs` | the Worker, the three Durable Objects, the routes |
| `gateway/cloudflare/src/vault.rs` | `StateStore` over the DO's SQLite |
| `gateway/cloudflare/src/r2.rs` | `ByteStore` over R2 |
| `gateway/cloudflare/src/sigv4.rs` | presigning |
| `gateway/cloudflare/src/mailbox.rs` | the mailbox object and its alarm |
| `gateway/cloudflare/src/accounts.rs` | admission by key and purchase |
| `gateway/cloudflare/src/wire.rs` | headers, statuses, the error body |
| `gateway/cloudflare/src/sql.rs` | the shared statements, by `include_str!` |
| `gateway/cloudflare/src/conformance.rs` | the harness, and the forgetful one |
| `gateway/cloudflare/tests/no_rules_here.rs` | the grep (6 tests) |
| `gateway/cloudflare/{wrangler.toml,README.md,scripts/conformance.mjs}` | deployment, the register, the runner |
| `.github/workflows/lane-release-gateway-worker.yml`, `release.yml` | the deploy lane |

### W4C-1 — a feature, not a second crate, and the evidence for it

`pkarr`, `url` and `base64` are reached from exactly two modules —
`rg -l 'pkarr|url::|base64' crates/identity/src` names `record.rs` and
`discovery.rs` and nothing else. A split crate would have moved six files to buy
a boundary a `#[cfg]` already draws, and would have made
`centraid_identity::DeviceCertificate` two paths for the same 104 bytes.

The part the brief did not anticipate: **`hpke` pulls `getrandom`**, which has no
`wasm32-unknown-unknown` backend unless one is named in RUSTFLAGS. A feature
named in `[workspace.dependencies]` is unioned into every inheriting member and
cannot be switched off downstream, so `hpke/getrandom` moved onto
`centraid-identity`'s own `mint` feature. `SealedBox::seal` went with it;
`open` did not, because opening needs no entropy.

### W4C-2 — three things the runtime decided, and one it did not

- **The Durable Object is the fence.** `compare_and_set_head` takes no
  transaction and no lock: one object per vault, one request at a time. Three
  mechanisms, one rule — `commit::compare_and_set` in all three.
- **The 10 GB cap shapes what is in the object.** An object row is under 200
  bytes, so ten million objects is ~2 GB and that vault holds 160 TB at the
  16 MiB cap. Per-item rows are not here and the phone's ledger is.
- **R2 attests only what the client sent**, and the binding says so in its own
  types: `checksum().sha256` is an `Option`. `None` is `ChecksumEvidence::None`
  and a refused commit. `ReadAndHash` is implemented too and asks for the
  attestation **first**, so it cannot become a way past the missing-checksum
  rule — W4b's S3 store had exactly that hole.
- **The binding cannot presign**, so there are two R2 APIs: the binding for the
  gateway's own reads, a signed S3 query string for the phone's transfer.

Two rules moved **into** `gateway-core` rather than being written in the
adapter, which is where the architecture says they go: `plan::judge` and
`plan::RETAIN_AFTER_LAPSE` decide what a verified receipt means by the gateway's
own clock. The hosted adapter is the only deployment that verifies purchases,
but it must not be the place that decides what one means — and there is no
second implementation to disagree with it, which is precisely why it would have
gone unnoticed.

`workers-rs` did **not** block anything. Q14's TypeScript fallback was not
needed and was not taken.

### W4C-3 — what ran under Miniflare, and what the canary scanned

`node gateway/cloudflare/scripts/conformance.mjs`: `wrangler dev --env dev`
(workerd, a real Durable Object, a real local R2 bucket), `POST /__conformance`.

**21 of 21 cases GREEN**, and the run covers both checksum modes against the one
store this deployment has — `checksum/attest-mode-commits-verified-bytes` and
`checksum/read-and-hash-mode-commits-verified-bytes`, plus
`read-and-hash-catches-bytes-that-do-not-hash-to-their-name` and
`no-attestation-is-a-rejection` in both. There is one store here and not two, so
the four-way table W4b ran has no counterpart: R2 × attest is production, R2 ×
read-and-hash is the suite's, and a second store is not something this
deployment has.

**`?forgetful=1` goes RED**, which is what makes the green mean anything: the
harness drops uploads and nine cases fail on `Refused(Checksum(Missing))` while
`checksum/no-attestation-is-a-rejection` and the four that touch no bytes stay
green. The runner asserts both verdicts.

The canary's two windows on this deployment: **every object in R2**, listed and
read back, and **every table in the Durable Object's SQLite**, every row, every
column, blobs in hex. Needles: a planted plaintext and its BLAKE3, raw and hex,
with a ciphertext derived so it shares no run with the plaintext.

**Running it found three defects reading did not**, all recorded in
`dbc0f7f6`: a Durable Object's SQLite **enforces foreign keys** (the harness's
reset emptied `account` before `vault`, and every later case reported "setup
failed" with nothing naming the cause); `env.secret(…)` answers nothing under
Miniflare without `.dev.vars`; and `wrangler` walks **up** for its config and
found this repository's root `wrangler.json`, the public site's.

### W4C-4 — the four hand-offs

1. **The audit ledger is written.** It is `client_delete` (the brief says
   `client_base_delete`; W4b's receipt item 2 is the one meant). A port
   operation `StateStore::record_client_delete` and a call from
   `Gateway::delete` for **every** granted tombstone of **every** kind, above
   the port so neither adapter can be the one that keeps it. It records a vault
   key, an object name, a kind and the gateway's own clock — every one already a
   column on `object` for the same object, so it adds durability and not
   visibility. Proved by the rule (`gateway-core/tests/audit_ledger.rs`,
   including that a refused delete writes nothing) and by each adapter's storage
   (`gateway-server/tests/audit_ledger.rs`, over both byte stores).
2. **The two service-unit generators are NOT deleted, and this is an owner
   hand-off rather than a decision.** Every deletion in this environment is
   refused by the permission system: `git rm` of
   `crates/centraid/src/cmd/{units,gateway_install}.rs`,
   `crates/centraid/tests/gateway_install.rs`, `contracts/deploy/units/`,
   `deploy/systemd/` and `deploy/launchd/` was denied ("Irreversible Local
   Destruction"), and it was not worked around — truncating the files would have
   been the same act with the audit trail removed. **Everything else was
   prepared**: the blast radius is `crates/centraid/src/main.rs`'s
   `Command::Gateway`/`GatewayCommand`, `cmd/mod.rs`'s two `pub mod` lines,
   `deploy/vps/install.sh:207`'s `centraid gateway install` (successor:
   `centraid-gateway install`, which exists), and prose in `deploy/README.md`,
   `docs/logs.md`, `ARCHITECTURE.md` and `crates/centraid/README.md`. No
   `.governance/` or `.github/` file names any of them, so it is one product
   commit. `deploy/systemd/` and `deploy/launchd/` belong in the deletion too:
   their `ExecStart=/usr/local/bin/centraid gateway --data-dir …` names a verb
   W2 removed, so they are dead on arrival exactly as the goldens are.
3. **`deploy/docker/Dockerfile` is fixed.** `CMD` is `doctor --data-dir /data`,
   which is a verb the CLI has; the `HEALTHCHECK` is gone, because a health
   check on a container whose process exits reports `unhealthy` forever; the
   `EXPOSE` comment no longer cites `tests/no_listener.rs`, which does not
   exist, or an iroh endpoint W2 deleted; the image's own labels say what it is.
   `crates/centraid/tests/container.rs` is why it cannot rot silently again,
   and it is the claim `gateway-server/tests/container.rs` already makes about
   the other image.
4. **`ByteStore::evidence`'s doc is reworded.** It now says which answer each
   mode owes and that **an unattested upload is a refusal in both modes, not an
   invitation to read and hash the bytes anyway** — naming W4b's S3 defect as
   the reason. The suite is the authority and the port now says the same thing
   so an adapter author does not have to infer it.

### Handed up — owner decisions this lane could not take

1. **The deletions above.** Blocked by the environment, not by judgement.
2. **SigV4 is written twice.** `gateway-server/src/bytes/sigv4.rs` signs headers
   for requests that server makes; `gateway/cloudflare/src/sigv4.rs` signs a
   query string for a request this one never makes. They overlap in the
   string-to-sign and the signing key. **Recommend** extracting a WASM-clean
   `centraid-sigv4` crate; not done here because it would move a one-hash
   allowlist entry and is worth its own review rather than a footnote in this
   one.
3. **`account_vault` is read and never written.** The listing a restored phone
   reads is in place; the route that adds a vault to an account belongs with the
   phone's registration flow, which W5 owns. **Owner question:** should the
   vault object call the account object on its first `put_vault`, or should the
   phone register with both?
4. **No staging run, and no store call.** This container has no Cloudflare
   account and no store credentials. What a real account would still prove:
   that R2's attestation arrives through the binding as documented, that a URL
   this crate signs is one R2 accepts, that a Durable Object alarm fires after a
   month of silence, and that `?1`-numbered placeholders bind positionally in DO
   SQL — Miniflare says they do, and Miniflare is workerd, which is the same
   engine, but it is not the same deployment.
5. **`subtle` is declared by `crates/identity` and used by nothing**
   (`rg -l subtle crates/identity/src` is empty). Outside this lane's slice;
   filed rather than removed.

### Verification (lane C)

`export CARGO_TARGET_DIR=/home/user/.cargo-target-w4c` throughout; the Worker's
own workspace uses `/home/user/.cargo-target-w4c-wasm`.

| Exit item | Result |
| --- | --- |
| 1 `cargo build --workspace` | **clean** |
| 2 `cargo test --workspace` | **green, 1615 tests, exit 0** (1596 on base; +19). The Worker's own 14 unit + 6 scan tests are in its own workspace and are not in that number |
| 3 `cargo check -p centraid-identity --no-default-features --target wasm32-unknown-unknown` | **clean** |
| 4 the Worker builds for `wasm32-unknown-unknown` | **clean**, and `worker-build --release` produces the shim and a 32.4 kB `index.js`. **`workers-rs` blocked nothing**; Q14's fallback was not needed |
| 5 conformance under Miniflare | **21/21 GREEN**, both checksum modes, one store (there is one here). **`?forgetful=1` RED**, as it must be |
| 6 the canary over R2 and the Durable Object SQL | **clean** — `canary/no-plaintext-or-plaintext-hash-is-anywhere-in-the-store`, over every stored object and every table of the object's SQLite |
| 7 `gate --lane fmt` / `--lane clippy` / `--lane rules` | **PASS**, **PASS**, **PASS** (4 rules, 0 pending; sql-confinement clean over 211 files, no-listening-socket clean over 321 with 2 named) |
| 8 `gate --profile local` | `fmt` `clippy` `test` `rules` all **ok**. **BUDGET 157.9s of 120s**, `test` 156.0s, on 4 vCPUs beside a live sibling lane — inside the 73s-alone to 196s-shared band lanes A and B measured. Nothing in a ledger was touched. `ledgers` fails on **"no merge base found"**, the worktree limitation every lane has recorded |
| 9 `bun run check:push:static` | **4/4 green** (`bun install` first; `bun run format`, and three `oxlint` findings in the runner fixed rather than suppressed) |
| 10 `node scripts/check-ledgers.mjs --base 590bdaa2` | **ok — 19 sections across 5 ledgers hold** |
| 11 `node .governance/law/run.mjs --brief-digest 2612c611d7e6` | **10 rules, no findings.** `lawDigest` base and head are both `2612c611d7e6…` — **no drift** |

**Disk** was the binding constraint the brief warned about: two lanes and a
second artefact tree filled the volume during `cargo test --workspace`, which
failed with `No space left on device`. Both target directories were `cargo
clean`ed and the run repeated; no ledger, budget or test was touched to get
past it.
## W6 — blobs, file keys and thumbnails

Branch `claude/1029-w6-blobs`, base `3fe7cc84`. Rust **1677** (base 1652); Kotlin `:shared`
**220**, `:core` **16/16**.

### The file table

| File | What landed |
| --- | --- |
| `crates/media/src/object/mod.rs` | the chunk AAD binds the header's FIXED PREFIX, not the wrap; `rewrap`; three tests |
| `crates/media/src/object/header.rs` | the field table gains an "in the chunk AAD" column, and the wrap is the one `no` |
| `crates/media/src/object/pack.rs` | `build_all` — fill packs to the cap, one after another — and `table_cost` |
| `crates/media/tests/object_vectors.rs` | a `rotation` block pinning "a re-wrap does not re-encrypt the body" |
| `contracts/crypto/object-vectors.json` | regenerated; `sealedBase64` and the new `rotation` block |
| `contracts/migrations/004_blob_custody.sql` | **rung four** — `backup_blob_custody`, `backup_blob_placement` |
| `crates/vault/src/migrations.rs` | `BLOB_CUSTODY_SQL`, appended to `LADDER` |
| `crates/vault/src/backup/custody.rs` | `FileKey`, `BlobRole`, `Placement`, `Custody`, `admit`, `record_placements`, `lookup`, `thumbnails`, `originals`, `open_blob`, `grid_fetches` |
| `crates/vault/src/backup/objects.rs` | `ObjectKeys::rotate_root`; the "rotation costs a full re-upload" finding replaced by what it costs now |
| `crates/vault/src/backup/restore.rs` | `restored-blob-custody`, and why `restored-blob-coverage` takes a store it is not opening |
| `crates/vault/src/backup/drill.rs` | `run_drill` takes `member_bytes`; `write_one` writes custody so the check has rows |
| `crates/vault/tests/restore_grid.rs` | the 100k acceptance criterion, the ranges, and the ordering |
| `crates/vault/tests/baseline.rs` | rung four's four objects declared, `user_version` 4 |
| `crates/blobs/src/plan.rs` | `wants_from_custody` — the transfer rule governs something again |
| `crates/core/src/handle.rs` | `open_own_bytes`: the core owns the runtime and the byte store |
| `crates/core-ffi/src/lib.rs` | `centraid_open` opens `<vault>.bytes`; a store that will not open is not a failed open |
| `crates/centraid/tests/restore_drill.rs` | a real `ContentBytes` handed to `restored-blob-coverage` |
| `mobile/.../screen/ScreenMachine.kt`, `.../sync/ScreenRuntime.kt` | what serves `FetchOriginal` and the one hop that does not |
| `mobile/.../shell/CameraRoll.kt`, `.../shell/Staging.kt` | the gateway is not the writer any more, and the invoke key never leaves the device |

### What the restore test proves, at what scale

`crates/vault/tests/restore_grid.rs` packs **100 000 thumbnails** of 1 KiB through the real
sealer into real packs and plans the grid over the rows that come out:

```
restore grid: 100000 thumbnails of 1024 B in 8 packs = 8 requests
```

**8, and the reason it is 8 is packs.** `grid_fetches` groups placements by `object_name`, so
its length is the number of distinct objects the vault's index names — 100 000 × ~1.7 KiB
sealed ÷ 16 MiB — and the item count never enters the arithmetic. The test asserts
`fetches.len() == packs`, that `fetches.len() * 100 < 100 000`, that every item is in exactly
one fetch (a cheap incomplete grid is not a grid), and that no object is fetched twice. 1 KiB
is at the SMALL end of a real thumbnail, which packs MORE per pack and makes the assertion
harder, not easier. Two tests beside it carry the other halves: every item opens from the
range the row recorded, out of real pack bytes and without reading the item table; and the
grid's plan names **not one original object**, while the originals' own rows are there to be
fetched on demand (F14).

### The five hand-offs

1. **Exclude the wrapped key from the chunk AAD — DONE.** The AAD is bytes 0..58: version,
   kind, role, flags, salt, dictionary id, and the wrap's declared LENGTH (which is what stops
   a wrapped object being re-presented as a file-key one). `object::rewrap` and
   `ObjectKeys::rotate_root` copy a body verbatim under a new root, and
   `a_substituted_wrap_still_fails_to_open_the_body` asserts the strength argument instead of
   repeating it. Vectors regenerated with a `rotation` block. **The honest residual**: an
   object's name is the BLAKE3 of its whole bytes, so a re-wrapped object is a new object to
   the store and the wrapped kinds are still re-uploaded. What makes rotation affordable is
   that a `blob` or `thumbnail` carries no wrap at all — a rotation does not touch a single
   photograph, which is almost all of a phone's bytes.
2. **The content store over the C ABI — DONE, and the decision is written down.** The core
   owns a two-worker tokio runtime and opens `<vault>.bytes`. Multi-threaded is not a
   preference: `ContentBytes` drives each verb with `block_on` from its own thread, and on a
   current-thread runtime nothing drives the tasks iroh-blobs spawns for its store actor, so
   the first verb waits on a task nobody polls. The alternatives were "leave it" (F14 is then
   unreachable from a phone) and "the shell owns one" (a Rust runtime handle across the ABI is
   a pointer with no type on the other side). A store that will not open leaves the core as it
   was — text, photographs refused by name — because an open that failed over a byte store
   would take a member's notes down with their camera roll.
3. **`ScreenEffect.FetchOriginal` — HALF SERVED, AND NOT DELETED. Say the blocker.** What is
   built: the vault holds the file key and the `(object, offset, length)` for every original,
   `custody::open_blob` turns those into verified plaintext, and the member's transfer rule
   decides whether a window may ask. What is **not** built: the request that carries the tap.
   `Request` has no `fetch_original` arm, and adding one means a proto field, a handler, and a
   **gateway transport inside `crates/core`** — a layering decision for the umbrella, not one
   to take while wiring a screen. The effect is kept because the remaining hop is a wire, not
   a design, and both Kotlin sites now name that hop instead of naming this wave.
4. **`TransferRule` and the two "Download settings" sheets — KEPT, AND GIVEN SOMETHING TO
   GOVERN.** They rode `SyncWindow` to a `seat.sync` that left with the seat plane, and
   `plan()` had no caller outside its own crate. The rule was never wrong; what it governed
   went away. `plan::wants_from_custody` turns the vault's custody rows into `Want`s, so a
   `MANUAL` rule withholds every original and lets every thumbnail cross, and a tap still
   overrides it for one item.
5. **`restored-blob-coverage` — SERVED, AND A BETTER CHECK BESIDE IT.** `run_drill` takes
   `member_bytes`, and `crates/centraid`'s drill — the one crate above `crates/blobs` that
   runs it — hands it a real `ContentBytes` and asserts it answers `0 missing`. But the
   hand-off's framing is half right and the half that is wrong matters: **under F14 a restored
   phone holds no plaintext at all**, because it shows the grid and fetches originals on
   demand, so a coverage check over a local store would fail on every correct restore. The new
   `restored-blob-custody` needs no store and is what a restore can actually promise — every
   blob's file key and at least one placement came back. `crates/vault`'s drill passes `None`
   and leans on it.

### Rulings spent

- **F14** — the vault owns its copy, with eviction. A custody row names a plaintext hash the
  vault can re-derive and an object it can re-fetch, never a PhotoKit asset id, so
  `ByteStore::sweep` may evict at any time without the row becoming a lie. This is also what
  made `restored-blob-custody` necessary.
- **F6** — 16 MiB per object. A blob over it is an ordered list of `blob` objects, and
  `Placement.part_index` is the only thing that says which half of a video is first.
- **F8** — `build_all` reaches `finish` and `repack` unchanged; the `LiveShareIndex` seam is
  W8's and was not filled.
- **§4, the phone deduplicates** — `custody::admit` is a `SELECT` on the second sight of the
  same bytes, and the gateway is never asked.
- **ONE HASH** — the drill's stand-in object name goes through `content_digest`, which is
  `crates/vault`'s one declared route; `one_hash.rs` caught the direct `blake3::hash` and was
  obeyed rather than amended. **No SHA carve-out added.**
- **`estate-separation`** — no law-estate path was touched, so no separate commit was owed.

### Found, not this lane's slice

1. **The forbidden-token grep is not empty, and the doctrine it stands for is satisfied.**
   `grep -rn 'blob:blake3-\|already_held\|add_asset:' crates/ mobile/` returns 49 lines. None
   of the three crosses the gateway wire: `blob:blake3-<hex>` is a `content_uri` value in a
   table inside the encrypted vault file; `already_held` is a field of the core↔shell C ABI
   reply, same device, same process; `media.add_asset:<hash>` is a `Command.invoke_key` over
   that same ABI. The sentence "no plaintext hash crosses the wire" is enforced by
   `gateway-core`'s own conformance canary
   (`canary/no-plaintext-or-plaintext-hash-is-anywhere-in-the-store`), which fails if either
   the plaintext or its hash appears in a stored object or in the gateway's state. Emptying
   the grep means renaming the vault's content-URI scheme and the stage reply's field — ten
   crates, both shells, and a change to a `core_content_item` column's VALUE shape, which is a
   data migration rather than a code change — and buys the property nothing. **Recommendation:
   retire the literal grep in favour of the canary, or scope it to the gateway crates.** What
   was genuinely wrong and is fixed: `CameraRoll.kt` and `Staging.kt` still said the gateway
   was the writer and read the intent id from a replay ledger.
2. **`encode_table` clamps an item id longer than 65535 bytes to `u16::MAX` instead of
   refusing it**, so a pathological id would produce a table that decodes as a different
   table. Unreachable from any caller in the tree today (ids are `thumb-<n>`-shaped), but it
   is a silent truncation in a length prefix and those are worth refusing.
3. **`ObjectFetch::byte_span` is computed and nothing ranges on it.** It is the right shape
   for a partly-dead pack — fetch the live span rather than the whole object — and the
   transport that would use it does not exist yet. Kept because the alternative is recomputing
   it at the call site that eventually appears.
4. **The `local` profile's `ledgers` step fails in this container for an environment reason,
   not a code one.** `git merge-base HEAD origin/main` exits 1 — the umbrella's history has no
   common ancestor with `origin/main` in this checkout — and it fails identically at the base
   commit `3fe7cc84`. `node scripts/check-ledgers.mjs --base 3fe7cc84` is clean.

## W13 — durability and crypto

Branch `claude/1029-w13-durability`, base `2ac95e6d`. `cargo test --workspace`: base **1,694**
passed across 142 binaries, 0 failed; at the end of the lane **1,705** passed across 143, 0 failed.
Five audit findings — 3 (Critical), 6 (High), 15 (Med), 22 (Med) and three of 24's five (Low).

### The file table

| File | What landed |
| --- | --- |
| `crates/media/src/object/header.rs` | `Kind::Manifest` no longer compresses, and why; the kind test says so |
| `crates/media/src/object/dict.rs` | the sentence at line 15 was a promise nothing kept, and where it is kept now |
| `crates/media/src/object/mod.rs` | two tests that used `Manifest` as a stand-in compressing kind use `Segment` |
| `crates/media/tests/primitives.rs` | the two fixture paths it named do not exist; the two that do |
| `crates/media/README.md` | the conformance-boundary paragraph, repointed at the fixtures and tests that are there |
| `contracts/crypto/object-vectors.json` | regenerated: the manifest vector is `compressed: false`, 278 → 262 bytes |
| `crates/vault/src/backup/objects.rs` | the dictionary is a field on `ObjectKeys`; `with_dictionary`, `adopting`, `dictionary()`; `page_dictionary` → `shipped_dictionary`, which refuses rather than substituting |
| `crates/vault/src/backup/manifest.rs` | the manifest's plaintext frame `u32be len ‖ dictionary ‖ json`; `open_with_dictionary`; the design and why it is not a separate object |
| `crates/vault/src/backup/drill.rs` | the restore adopts the dictionary the manifest carried before it opens a base range |
| `crates/vault/tests/dictionary_durability.rs` | **new** — the two red-first tests and the golden vector |
| `crates/vault/src/log/census.rs` | **new** — `RunningCensus`: `apply`, `forget`, `read`, the seed scan and the three exclusions |
| `crates/vault/src/log/guard.rs` | the hook carries a signed per-table delta; applied after COMMIT only; `census()` reads the counters; **no `count(*)` left in this file** |
| `crates/vault/src/log/mod.rs`, `crates/vault/src/file.rs` | the module, and the counter the vault holds |
| `crates/vault/tests/running_census.rs` | **new** — the red-first shadow-table test, and the randomised workload with rollbacks |
| `crates/vault/src/backup/spool.rs` | `unique_temp_name` refuses instead of answering one fixed name |
| `crates/vault/src/backup/store.rs` | its test follows the new signature |
| `crates/xtask/src/rules.rs` | the dead `blob-door` escape hatch removed from `listener_hits`; the rule is stricter |
| `mobile/iosApp/Sources/VaultFileProtection.swift` | **new** — `isExcludedFromBackup` and `completeUntilFirstUserAuthentication` over the vault directory and every item in it |
| `mobile/iosApp/Sources/ShellModel.swift` | the sweep before the open, after it, and on `didEnterBackground` |
| `SECURITY.md` | the size-class leak, Padmé's bound, and that it bounds rather than removes |
| `CHANGELOG.md` | the entry |

### The dictionary design, and why (finding 3)

**Option (a): the bytes ride inside the generation manifest**, `u32be len ‖ dictionary ‖ json`,
uncompressed and sealed — so `Kind::Manifest` stops compressing, because an object sealed against
the dictionary it carries cannot be opened by anybody who does not already have it.

Option (b) — a `blob` object of its own whose name a manifest or the head carries — costs 16 KiB
once per *generation* rather than once per manifest, and would have been cheaper. It was declined
because **it reintroduces the failure at one remove**: a dictionary in its own object is a thing
that can be absent, garbage-collected, or not uploaded yet, and a generation whose dictionary
object is gone is exactly as unopenable as one whose dictionary was never written. Carrying the
bytes inside the manifest makes the two inseparable, and the manifest is already the one object a
restore must open first. Option (c) was ruled out by the brief: `ObjectKind` is W16's.

The bytes are not trusted on sight — `Dictionary::from_bytes` re-derives the id as their BLAKE3,
and every base and segment header names the id it was sealed against, so a substituted dictionary
is a `DictionaryMismatch` and never a wrong plaintext. The gateway is as blind to them as to
everything else: they are inside the seal.

### The F5 inventory (finding 6) — **8 rows, a grep each**

Every path the app derives under the vault directory, the line that creates it, and the line that
excludes it. iOS does not compile in this container (TESTING.md), so this table is the exit.
`VaultFileProtection.secure(directory:)` walks the directory and every item under it, because iOS
**does not inherit** `isExcludedFromBackup` — a file created inside an excluded directory is not
itself excluded.

| # | Path | Created at (grep) | Excluded at (grep) |
| --- | --- | --- | --- |
| 1 | the vault directory (`Documents`) | `grep -n "static var vaultDirectory" mobile/iosApp/Sources/ShellModel.swift` → `:207` | `grep -n "VaultFileProtection.secure" mobile/iosApp/Sources/ShellModel.swift` → `:148, :150, :160` (the root itself) |
| 2 | `<stem>.sqlite3`, the vault file | `grep -n "PREFIX + hex(services.secureRandom" …/shell/Shelf.kt` → `:720` | `grep -n "isExcludedFromBackup = true" mobile/iosApp/Sources/VaultFileProtection.swift` → `:85` (the sweep, per item) |
| 3 | `<stem>.sqlite3-wal` | `grep -n 'SIDECARS = listOf' …/shell/Shelf.kt` → `:818` (SQLite creates it) | as row 2 |
| 4 | `<stem>.sqlite3-shm` | `grep -n 'SIDECARS = listOf' …/shell/Shelf.kt` → `:818` | as row 2 |
| 5 | `<stem>.bytes/`, the byte store (originals **and thumbnails** — there is no separate thumbnail cache; `grep -rn 'cachesDirectory' mobile` is empty) | `grep -n 'with_extension("bytes")' crates/core-ffi/src/lib.rs` → `:173` | as row 2 |
| 6 | the backup home's `objects/`, `spool/`, `scratch/` | `grep -n 'for child in \["objects", "spool", "scratch"\]' crates/vault/src/backup/mod.rs` → `:125` | as row 2, **conditional — see the find below** |
| 7 | `head.json` | `grep -n 'join("head.json")' crates/vault/src/backup/mod.rs` → `:169` | as row 2, same condition |
| 8 | `*.tmp` durable-write temporaries | `grep -n "unique_temp_name(path)" crates/vault/src/backup/spool.rs` → `:77` | as row 2 |

Data Protection: `grep -n "protectionKey" mobile/iosApp/Sources/VaultFileProtection.swift` → `:93`,
applying `completeUntilFirstUserAuthentication` (`:53`) to the directory and to every item.
Not `.complete`, which is #1029 line 84's own choice and the product's: capture and upload run
while the phone is locked, and under `.complete` every background write becomes a failure.

**The Android claim is confirmed**, three mechanisms at once —
`grep -n 'android:allowBackup\|dataExtractionRules\|fullBackupContent' mobile/androidApp/src/main/AndroidManifest.xml`
→ `:28 android:allowBackup="false"`, `:29 android:dataExtractionRules="@xml/data_extraction_rules"`,
`:30 android:fullBackupContent="@xml/full_backup_content"`.

### The census test's shape (finding 15)

`running_census.rs` holds two tests. The red-first one asserts the census names no `fts_` table;
on the base it named ninety shadow tables and eighteen virtual ones. The other runs a
deterministic randomised workload — insert one to three, update, delete the oldest, or **write
three rows and then refuse** — and after *every* round compares `vault.census()` against a
`count(*)` scan of the same table list. The rollback round is the one that matters: the hook fires
for every row a refused body wrote, and the guard applies the tally only on the success path, so no
`rollback_hook` is needed and none is installed.

The counters live in `crates/vault/src/log/census.rs`, not in the guard, so the guard has no scan
in it at all. **One scan remains and it is the seed**: a table whose count nothing in this process
holds is counted once and remembered. That is a vault-sized cost once per process instead of once
per capture tick, and it is stated rather than hidden. The table LIST is re-read from
`sqlite_master` every call — a schema-sized query, which is what makes a table a migration created
since the last call appear, with its count seeded on the spot.

### Exit list

1. `cargo build --workspace --all-targets` — clean.
2. `cargo test --workspace` — **1,705 passed, 0 failed** (floor 1,694). New: `a_manifest_opens_with_the_root_key_and_no_dictionary_at_all`, `a_generation_opens_against_the_dictionary_its_manifest_carries`, `the_shipped_dictionarys_id_is_the_one_this_build_is_pinned_to`, `the_census_names_no_fts5_shadow_table`, `the_running_census_equals_a_scan_after_every_commit_and_every_rollback`, `a_delta_for_an_unseeded_table_is_not_invented`, `the_counters_move_by_their_deltas_once_seeded`, `every_listener_is_a_hit_including_one_wearing_the_retired_attribute`.
3. Red-first, by name and by commit: `a_manifest_opens_with_the_root_key_and_no_dictionary_at_all` fails at `84885fd6` with `Err(DictionaryRequired)`; `the_census_names_no_fts5_shadow_table` fails at `38913400` naming 90 shadow tables. The fixes are `ab520c7f` and `887202b1`.
4. `cargo test -p centraid-media` and `-p centraid-vault` — green. The golden vector pins the shipped dictionary's id at **`84f64d4aa6ab33c496ffaec1ced1f7a6be84d62904de9a5fd9ef7a20f8b43bd9`**.
5. `grep -rn 'or_else' crates/vault/src/backup/objects.rs` — **empty**.
6. `grep -rn 'count(\*)' crates/vault/src/log/guard.rs` — **empty**. The seed scan is `crates/vault/src/log/census.rs:155`, in a function whose whole documentation is why it is there.
7. The F5 inventory above — 8 rows, a grep per row.
8. `cargo xtask gate --profile local --lane fmt` / `--lane clippy` / `--lane rules` — all **PASS** (rules: 4 applied, 0 pending, 0 findings).

### Finds outside this lane's slices

1. **`BackupHome` is not wired into the phone's core yet.** `grep -rn "BackupHome::open" --include=*.rs crates` names only `crates/vault/src/backup/drill.rs:107`, so rows 6 and 7 of the F5 inventory are excluded **only if** the backup home is opened under the vault directory. It must be. Whoever wires it: put it under the directory the shell hands in, or the sweep will not see it.
2. **The spool's temp-name collision is in `crates/vault/src/backup/spool.rs`, not `crates/gateway-client/src/spool.rs`** as the brief has it. `crates/gateway-client/src/spool.rs` has no temp-name logic at all — it batches uploads. The fixed one is the vault's.
3. **Five more references to fixture files that do not exist**, outside `crates/media`: `crates/identity/tests/identity_vectors.rs:16`, `crates/protocol/src/lib.rs:24`, `crates/vault/src/custody/member_key.rs:59`, `crates/vault/src/backup/store.rs:97`, `crates/blobs/src/store.rs:20`, plus `docs/protocol.md:87` and `docs/vault-ontology.md:32`. All name `contracts/golden/format-golden.json` or `contracts/protocol/framing-golden.json`; `contracts/golden/` holds only `issue-1020/` and `issue-929/`, and `contracts/protocol/` does not exist.
4. **`SECURITY.md`'s `### Backups` section is stale beyond finding 22.** It says WAL segments are "sealed with deterministic nonces" (B9 replaced them with random ones), says "the base copy is not sealed" (it is, as a `base` object), and describes `crates/vault/src/backup/kit.rs`, which `#1029` §0 retired for the 24-word phrase. Not touched: correcting it is a rewrite of a section, and this lane's ruling was to add.
5. **The census change moves what a manifest records.** `base_census` and every `SegmentRef::census` now carry ~108 fewer entries. Nothing compares a manifest's census against a differently-built list — `RestoredGeneration::census_matches` iterates the census's own tables — but a generation sealed before this change and restored after it carries the old list, which is harmless and worth knowing.
6. **`bun run format` cannot run in this container**: `oxfmt: command not found`. `bun run check:push:static` was not run for the same reason. The staged-file `format-check` and `lint-check` directives ran at every commit hook and passed.
7. `cargo xtask gate --profile local` (the whole profile) was not run to completion in this lane; the three lanes it contains that judge this change — `fmt`, `clippy`, `rules` — were, each inside its 120 s budget (clippy 95.2 s cold, 46.1 s warm). W6's receipt records that the profile's `ledgers` step fails in this container for an environment reason (`git merge-base HEAD origin/main` exits 1), and that is unchanged.

### Falsification

The claim this lane rests on is that **a build whose zstd trainer has moved can still open a
backup the previous build sealed**. The way to falsify it is not to read the manifest code: it is
`a_generation_opens_against_the_dictionary_its_manifest_carries`, which seals a generation against
a dictionary trained on a corpus this build cannot produce, asserts that this build's own keys
**fail** to open the segment, and then opens it with the dictionary recovered from the manifest.
Delete the `adopting` call in `drill.rs` and the restore drill still passes, because the drill
seals and restores in one process with one trainer — which is exactly why the trainer-drift test
exists and why reading the drill would not have found finding 3.

What would falsify the census claim is a writer that reaches the vault outside `Vault::commit`.
The hook is installed per commit, so such a writer moves rows the counters never see, and the
counters would drift until the next `forget()` or process restart. Nothing in the tree does this
today — `crate::log::guard` is the only door — but it is the assumption the design rests on, and
the workload test would not catch a violation added later in a path it does not exercise.

The F5 claim is the weakest of the three and it is stated as such: **nothing in this container
compiled or ran that Swift**. What the inventory proves is that every vault-derived path is named,
that the exclusion call reaches the directory and every item under it, and that the sweep runs at
three moments including the one before iOS takes a backup. What it does not prove is that iOS
accepted the resource value — that needs the physical-device run TESTING.md already parks.
## W16 — the cut

Branch `claude/1029-w16-the-cut`, base `2ac95e6d`. Six commits, the law commit alone.
A deletion lane, executing the [scope amendment of
2026-09-21](https://github.com/srikanth235/centraid/issues/1029#issuecomment-5755559795).

**Base test floor: 1,698 passed / 0 failed / 5 ignored** (`cargo test --workspace
--no-fail-fast` at `2ac95e6d`). **At HEAD: 1,645 passed / 0 failed.** 54 tests deleted
with their subjects and 3 renamed; every one is named in the commit that removed it.

| Commit | What |
| --- | --- |
| `b6d5d10f` | W16-1 — the hosted adapter on Cloudflare, the worker release lane, the wasm target |
| `f65008f2` | W16-1's law half — `gateway-engine-mode-agnostic` retired, **alone** |
| `81e2add6` | W16-2 — the mailbox, the account (`AccountKey`, `VaultClaim`, `VaultListing`), plan lapse |
| `6580ffd1` | W16-3 — sharing in the gateway, the wire and the pack (F8) |
| `13bf54b3` | W16-5 — the S3 byte store and SigV4 |
| (this one) | W16-4's shell surfaces and `lint-types.sh`, the residual prose, and this receipt |

### Every deleted path

**Whole trees:** `gateway/cloudflare/` (its own cargo workspace, 14 files),
`.github/workflows/lane-release-gateway-worker.yml`, `contracts/gateway/hosted.sql`,
`wrangler.toml` (the adapter's, inside `gateway/`),
`.governance/packs/srikanth235/centraid/directives/gateway-engine-mode-agnostic/`.

**Rust modules:** `crates/gateway-core/src/{mailbox,share}.rs`,
`crates/identity/src/account.rs`, `crates/gateway-server/src/bytes/{s3,sigv4}.rs`,
`crates/gateway-core/tests/wasm_clean.rs` (→ `tests/pure_rules.rs`, purity half kept),
`crates/identity/tests/wasm_half.rs`.

**Protocol:** `mailbox.proto` (and its `build.rs` row, 17 → 16).
`ERROR_CODE_GATEWAY_PLAN_LAPSED = 91`, `ERROR_CODE_GATEWAY_MAILBOX_REFUSED = 94`,
`OBJECT_KIND_SHARE_ENTRY = 6`, `VaultRegistration.vault_claim = 1` and
`VaultsResponse.signed_listing = 1` all become `reserved`, never re-used: a phone on an
older build already reads those numbers, and a second meaning for one is a refusal or a
stored object kind that lies.

**Schema:** `contracts/gateway/schema.sql` loses `mailbox_capability`, `mailbox_entry`,
`share_capability`, `share_scope`, `share_feed`, and `account`'s `plan_state` /
`lapse_at_ms` / `retain_until_ms`. Eight query files with no caller left:
`account_vault_{insert}`, `account_vaults_select`, `purchase_{receipt_insert,
receipts_select,token_insert,token_redeem,token_select}`, `table_clear`.

**Elsewhere:** the `oauth-worker` release surface and the `continuous` cadence that had
only it; the `CLOUDFLARE_*` secret group; two stale `egress-ledger.json` rows and the
`workerd` `lifecycle-ledger.json` row (wrangler is no longer a dependency); three
`.gitignore` lines; `crates/identity`'s `discovery`/`mint` feature split; the workspace
`time` dependency; `Rules` / `Connectors` / `Copies` in `BandPolicy.kt`; `"connectors"`
in `FirstMoves.kt`; `desktop/electron` and `extension` in `scripts/lint-types.sh`.

### The greps that proved them dead

| Claim | Command and answer |
| --- | --- |
| the hosted adapter is gone from code | `grep -rli 'cloudflare\|wrangler\|miniflare\|workerd\|durable object' --exclude-dir=receipts --exclude-dir=.git --exclude-dir=node_modules .` → 21 files, **none of them gateway code**: `CONSTITUTION.md` (Evolution Log, frozen and append-only), `tests/claims.json` (law estate), the docs-site host (`wrangler.json`, `scripts/docs-site/*`), the Assist-OAuth docs W2's deletion left (`docs/{enrollment,logs,oauth-assist,release,release/oauth-assist-google,recovery/oauth-assist}.md`, `SECURITY.md`, `privacy.html`, `terms.html`) and **Cloudflare Tunnel as a self-hosting shape** (`gateway-server/{README.md,src/{acme,config,serve,bin/centraid-gateway}.rs,tests/container.rs}`, `deploy/gateway-server/README.md`, `restore_drill.rs`) |
| the mailbox, the account and the listing are gone | `grep -rn 'mailbox\|Mailbox\|deposit_capab\|ShareEntry\|share_feed\|share_id\|VaultListing\|VaultClaim' crates contracts mobile/shared/src --include=*.rs --include=*.proto --include=*.sql --include=*.kt --include=*.json` → **5 hits, every one a comment saying the thing is struck** (`identity/src/record.rs:22-23`, `error.proto:182`, `lease.proto`'s two `reserved` notes) |
| SigV4 and the S3 store are gone | `grep -rn 'sigv4\|SigV4\|S3Store' crates` → **no code**, 13 comment hits: the "seven days is SigV4's cap" presign note (`store.rs`, `fs.rs`, `backup.proto`, `spool.rs` — W13's file), and the module docs that record the retirement |
| nothing links the wasm target | `grep -rn 'wasm32' crates .github Cargo.toml` → **empty** |
| the shell leads with no dead plane | `grep -rn '"Rules"\|"Connectors"\|"Copies"\|"connectors"' mobile/shared/src/commonMain` → **empty** |
| `AccountKey` had no consumer outside the listing | `grep -rn 'AccountKey' --include=*.rs --include=*.kt --include=*.swift --include=*.proto crates mobile contracts` → `derive.rs`, `account.rs`, `record.rs` (the account record), `discovery.rs` (resolving it), `publish.rs` (publishing it), `restore_drill.rs` and two vector tests. Every one is the listing or the record that exists to find it. **Deleted**, and the `seed / account'` slot is RETIRED rather than freed — `ACCOUNT_INDEX` stays reserved with the reason on it, so no future vault index re-derives a key an old seed already produced there |
| `time` had no other direct consumer | `cargo tree -i time` → only transitive (`asn1-rs`/`x509-parser`/`rcgen` under `tokio-rustls-acme`, `netwatch` under iroh) |
| `hmac` and `sha2` still have consumers | `cargo tree -i hmac` → `centraid-identity`, `hkdf`→`hpke`, `pbkdf2`→`scrypt`→`centraid-vault`. `cargo tree -i sha2` → `centraid-gateway-core` (`checksum.rs`, W17's), `centraid-identity`, `ed25519-dalek`. Both workspace entries stay |

### The re-judgments (decisions, not deferrals)

**1. `wasm_clean.rs` — SPLIT, not deleted.** It held two invariants. The
deployment-discriminator scan went with the second deployment; the purity scan — no
thread, no file, no ambient clock, no ambient randomness — has a live consumer: it is what
makes `ServerTime` an argument and the conformance suite runnable anywhere, and W17 needs
it when the transport changes underneath these rules. It survives as `tests/pure_rules.rs`.

**2. `plan.rs` — the lapse went, the quota stayed.** The amendment strikes "plan lapse
F13", not quota; `tenancy.rs` sets `Plan::active(quota_bytes)` from the invite the owner
mints, which is Q13's household. Deleting the module whole would have deleted a live rule
the amendment did not strike.

**3. `repack` — kept, F8's predicate deleted.** `LiveShareIndex` was a seam nobody could
answer. Left in place it reads as an enforced rule; `repack` itself is what keeps a pack
from carrying dead thumbnails forever and never had anything to do with sharing.

**4. `restore_drill.rs` — rewritten, not deleted.** The drill IS the restore, which
survives. It re-derives each vault's keys from the phrase by index instead of from a signed
listing, and says in the file that **where the index list comes from is W15's**.

**5. `the_stores_own_checksum_is_named_in_exactly_one_module` — tightened, not deleted.**
Its expected list goes from `["bytes/sigv4.rs"]` to empty. That is a stronger assertion
than the one it replaces, which is why it survives its subject.

**6. Root `wrangler.json` — KEPT, against the brief.** It is the **docs-site** static-assets
deploy for `centraid.dev`; the hosted adapter's own config was
`gateway/cloudflare/wrangler.toml`, which is deleted. The brief's §1 state section listed
them as one thing. Confirmed by the root as a brief error, recorded here as one.

### Not landed, and why

**THE VAULT SCHEMA BAND (W16-3's second half and all of W16-4's table work).** The
`share_*` band (nine tables, `vault-ddl.sql:3273-3438`), `outbox_*`, `replica_*`,
`blob_device_*`, `access_device*`, `automation_*` and the `intents`/`devices`/pair
leftovers are **still in the DDL a new vault gets**, with their readers in
`crates/apps/{docs,people}`, `crates/vault/src/{access.rs,commands/core.rs}` and
`crates/apps/kit/src/fixtures.rs`.

The reason is a fact the brief's state section did not carry: **all three schema fixtures
are generated from one frozen binary corpus**, not from each other.

```
contracts/golden/issue-1020/vault.db.gz  (frozen v0 vault, 89 KB, no generator)
  ├─ cargo run -p centraid-ontology --bin export-ddl              → contracts/schema/vault-ddl.sql
  ├─ cargo run -p centraid-ontology --bin export-golden-manifest  → contracts/golden/issue-1020/manifest.json
  └─ cargo run -p centraid-vault    --bin export-baseline         → contracts/migrations/001_baseline.sql
```

`TESTING.md:116` states it plainly — the corpora are **frozen vaults** and only the
*derived* fixtures are regenerable. `crates/ontology/tests/fixtures.rs` diffs the derived
files against the corpus and `crates/vault/tests/baseline_corpus.rs` re-freezes it from
Rust and reproduces v0's manifest. `export-golden-manifest`'s own header says why it may
not be more: _"a re-generation is not a re-freeze: the corpus was frozen when it was frozen,
and this program only restates what is in it."_

So dropping a table means mutating the frozen `.db.gz` by hand and re-gzipping it — there
is no tool for it in `crates/xtask`, `crates/ontology/src/bin`, `crates/vault/src/bin`,
`TESTING.md` or the W2 receipt section, and a hand-edited golden corpus is the "green by
editing the fixture" this repository's doctrine forbids. **Stopped on the root's second
stop condition.** Deferred rows, one per plane, each with the command that blocked it:

| Plane | Tables still in the DDL a new vault gets | Blocked by |
| --- | --- | --- |
| sharing (§7) | `share_authority`, `share_authority_request`, `share_authority_use`, `share_delivery_config`, `share_fulfillment`, `share_party_vault_binding`, `share_subscription`, `share_subscription_lineage`, `share_subscription_member` | no tool mutates `contracts/golden/issue-1020/vault.db.gz`; `cargo run -p centraid-ontology --bin export-ddl` only re-reads it |
| outbox | `outbox_item`, `blob_outbox` | as above |
| replica | `replica_log`, `replica_meta`, `replica_intent_outcome`, `replica_invocation_commit`, `replica_parked_payload` | as above |
| device / pairing | `blob_device_*` ×2, `access_device`, `access_device_secret` | as above |
| automations | `automation_state`, `automation_trigger_cursor`, `trigger_ingress` | as above |
| intents | `intents` (the earlier audit counted 6 live callers) | as above |
| the W2 deferred band | `sync_connection*`, `sync_external_entity`, `sync_import_batch`/`_row`, `access_agent*`, `conversation_provider_consent`, the conversation/turn/item/attachment band, `harness_health`, plus `locker_item.connection_id` and `commands/locker.rs:611,958` | as above |

**The question this raises for the owner, with a recommendation.** The corpus is a
*historical* artefact — a v0 vault as it was — and `001_baseline.sql`, the migration a
*new* vault runs, is derived from it. Those two jobs have diverged: v0's record should not
be edited, and v0's table list should not be what v1 founds. **Recommendation: split them**
— keep the corpus frozen as the migration-compatibility record, and give `001_baseline.sql`
its own generator from the v1 ontology, so a plane deleted in code can be deleted in the
schema without touching the frozen file. That is a slice, not a step, and it is the
prerequisite for every row in the table above.

### Found, and not this lane's slice

1. **`scripts/release/surfaces.mjs` still lists `desktop` and `companion`**, whose
   workflows W2 deleted. `node --test scripts/release/surfaces.test.mjs` is **RED on
   `2ac95e6d`** for exactly that (`every surface names a workflow file that exists on
   disk`); this lane removed the third dead surface (`oauth-worker`) and the failure list
   went 3 → 2. `scripts/release/publish-guards.test.mjs` names surfaces `web` and `docs`
   that do not exist. Neither is in `check:push:static`. **W9's or a release lane's.**
2. **`scripts/docs-site/src/content/{privacy,terms}.html` describe the Assist OAuth
   courier**, whose Worker W2 deleted — not the hosted gateway. Striking sentences from a
   published privacy policy and terms of service is the owner's call, not a deletion lane's.
   Same for `docs/{oauth-assist,enrollment,logs}.md`, `docs/release/oauth-assist-google.md`,
   `docs/recovery/oauth-assist.md` and `SECURITY.md:140-174` (**W13's file**). **W9's.**
3. **`crates/gateway-core::plan::Plan` should be `quota::Allowance`.** "Plan" is a purchase
   word and there are no purchases. The rename collides with `error::Quota`, the refusal
   companion, so it is a question rather than a guess. **W9's, or W17's if it touches the
   wire.**
4. **"Seven days is SigV4's cap"** is now a number with no protocol behind it
   (`gateway-core/src/store.rs:114`, `gateway-server/src/bytes/fs.rs:28`,
   `backup.proto:83`, `gateway-client/src/spool.rs:260` — **W13's file**). Whatever replaces
   the presigned URL over iroh sets its own bound. **W17's.**
5. **`.gitignore` still ignores `apps/web/public/centraid-worker-iroh.{js,wasm}`**, a tree
   that does not exist. **W9's.**
6. **`mobile/shared/build/` is committed-adjacent build output** that a repo-wide grep
   walks (`kover/bin-reports/jvmTest.ic` matched the Cloudflare grep). Untracked, so it is
   noise rather than a finding — but it makes every `grep -r` at the repo root noisier than
   it should be. **W9's.**

### Rulings spent

- **Amendment 2026-09-21, "Struck from v0"** — five of the six items are deleted in this
  lane. The sixth, `BackgroundTransfers` on the phone, is W18's.
- **Amendment, "Superseded" — object names stay BLAKE3, the attested checksum goes.** NOT
  started: it changes the wire and is W17's. `gateway-core/src/checksum.rs` and its `sha2`
  dependency are untouched, and `client.rs` says so where it names the header.
- **F8** ("never repack a shared pack") — deleted with sharing, and `repack` kept.
- **F13** (free tier and lapse) — the lapse half is deleted; the quota half is Q13's
  household bound and stays.
- **D-1025-S4-5 / W0.5-R1** (the `sha2`/`hmac` carve-out is one module per crate) — survives
  in a tighter form: `crates/gateway-server` now names SHA-256 in **no** module, asserted.
- **`estate-separation`** — the directive retirement is `f65008f2`, alone.
- **ACME stays** until W17 rules on HTTPS, per the brief. `src/acme.rs` is untouched.

### Verification

`export CARGO_TARGET_DIR=/home/user/.cargo-target-w16 CARGO_INCREMENTAL=0` throughout.

| Exit item | Result |
| --- | --- |
| 1 `cargo build --workspace` / `--all-targets` | **clean**, both |
| 2 `cargo test --workspace --no-fail-fast` | **1,645 passed, 0 failed** — the 1,698 floor minus 54 tests whose subjects were deleted, plus 1 renamed-and-tightened. Each named in its commit |
| 3 the Cloudflare grep | 21 files, none of them gateway code — the table above says which and why |
| 4 the mailbox/account/share grep | **5 hits, all comments recording the deletion** |
| 5 `grep -rn 'sigv4\|SigV4\|S3Store' crates` | **no code**; `cargo tree -i hmac` / `-i sha2` each name their remaining consumers |
| 6 `grep '^CREATE TABLE' vault-ddl.sql \| grep -i 'share_\|replica_\|outbox\|blob_device\|access_device\|automation_'` | **22 — NOT empty.** The frozen-corpus stop above |
| 7 the shell-surface grep | **empty** |
| 8 `bun install --frozen-lockfile && bun run lint:types` | **green** (it was RED on `2ac95e6d`: `desktop/electron` and `extension` had no tsconfig) |
| 9 `cargo xtask gate --profile local --lane fmt\|clippy\|rules` | **PASS**, all three |
| 10 `cargo xtask gate --profile local` | FAIL on `ledgers` (**"no merge base found"** — it cannot run in a worktree, same as W2). Budget line: _"the `local` profile took 269.2s against a 120s budget"_, `test` 264.4s of it, on a host a sibling lane was building on. Over before this lane and not a reason to touch a ledger |
| 11 `cargo xtask gate --profile mobile-jvm` | **PASS**, 27.6s of a 420s budget |
| 12 `bun run check:push:static` | **4/4 green** |
| 13 `node .governance/law/run.mjs --brief-digest 2612c611d7e6` | **10 rules, no findings.** The law moved once, in `f65008f2`, alone |
| 14 `git log --oneline 2ac95e6d..HEAD` | 6 commits, one per slice at least, the law commit alone |

### Falsification

The two riskiest claims in this section, and the throwaway check against each.

**1. "`AccountKey` has no consumer outside the listing."** A grep over `crates` could miss a
consumer that reaches it through a re-export, or one on the phone. The throwaway check was
to delete the type first and read the compiler's answer: the whole break set was
`record.rs` (`AccountRecord::sign`), `discovery.rs` (`publish_account`/`resolve_account`/
`locate_account`), `publish.rs`, `restore_drill.rs` and the two vector tests — the same set
the grep named and nothing else, and `mobile/` and `crates/core-ffi` did not move. The
compiler is a better grep than the grep, and it agreed.

**2. "The purity scan in `wasm_clean.rs` has a live consumer, so it survives its file."**
The risk is the reverse of the usual one: keeping a test whose subject left, which is how a
suite fills with assertions nobody can fail. The throwaway check was to break it on
purpose — a `std::time::SystemTime::now()` in `gateway-core/src/lease.rs` — and
`pure_rules.rs::no_rule_reaches_for_a_thread_a_file_an_ambient_clock_or_ambient_randomness`
went red naming the file and line. It is still a scan with teeth over a crate that still
has to be pure, which is the claim; the line was reverted before the build that follows.

## W19 — the baseline

Branch `claude/1029-w19-baseline`, base `1ee293d2`. Seven commits, 53 files,
**+8,619 / −5,158**. **Base test floor: 1,652 passed / 0 failed / 0 ignored**
(`cargo test --workspace --no-fail-fast`). **At HEAD: 1,618 passed / 0 failed.**

**The design, settled by the root and executed here.** The corpus keeps
describing v0; the ladder head describes what a new vault gets; the two are
separate fixtures with separate generators and separate drift checks; the
deletions are a rung. That is the owner's ruling of 2026-09-21
([comment 5756495615](https://github.com/srikanth235/centraid/issues/1029#issuecomment-5756495615)),
and it is what unblocks every row W16 handed up: a plane deleted in code can now
be deleted in the schema without anybody hand-editing a frozen corpus.

| Commit | What |
| --- | --- |
| `f867177f` | W19-1 — the corpus's description moves to `contracts/golden/issue-1020/vault-ddl.sql`, regenerated by its own tool |
| `22f7b069` | W19-2 **red** — `crates/vault/tests/ladder_ddl.rs` and `render_ladder_ddl`; 1 passed, 2 failed |
| `4e0db86c` | W19-2 green — `export-ladder-ddl`, and `contracts/schema/vault-ddl.sql` regenerated from a founded vault |
| `a3f90347` | the fallout: a fixture vault now carries rung two's guards |
| `2fcb315f` | W19-3 — rung five, `contracts/migrations/005_the_cut.sql` |
| `ba59b3f3` | W19-4 — the readers |
| `a4df687f` | W19-5 — the registers |

### The files

| File | What it is | Kept current by |
| --- | --- | --- |
| `contracts/golden/issue-1020/vault-ddl.sql` | the frozen v0 corpus's `sqlite_master` (230 `CREATE TABLE`) | `cargo run -p centraid-ontology --bin export-ddl -- contracts/golden/issue-1020/vault.db.gz`; `crates/ontology/tests/fixtures.rs` |
| `contracts/schema/vault-ddl.sql` | **the schema a new vault gets** (186 `CREATE TABLE`: 101 base + 17 FTS virtual + 85 shadow) | `cargo run -p centraid-vault --bin export-ladder-ddl`; `crates/vault/tests/ladder_ddl.rs`, which founds a vault to do it |
| `contracts/migrations/005_the_cut.sql` | rung five, hand-written | it is a migration; `baseline.rs` and `ladder_ddl.rs` prove it |
| `contracts/golden/issue-1020/{vault.db.gz,manifest.json}` | **untouched** | `git diff --stat 1ee293d2..HEAD --` those two paths is empty |

### The dropped set

**43 tables, 119 schema objects.** Nine sharing (`share_authority`,
`_request`, `_use`, `share_delivery_config`, `share_fulfillment`,
`share_party_vault_binding`, `share_subscription`, `_lineage`, `_member`); two
outbox (`outbox_item`, `blob_outbox`); six replica (`replica_log`,
`replica_meta`, `replica_intent_outcome`, `replica_invocation_commit`,
`replica_parked_payload`, `blob_replica`); two device blob keys
(`blob_device_content_key`, `blob_device_wrap_key`); three automations
(`automation_state`, `automation_trigger_cursor`, `trigger_ingress`); eight
connector (`sync_connection` ×5, `sync_external_entity`, `sync_import_batch`,
`_row`); two agent (`access_agent`, `access_agent_secret`); twelve conversation
ledger (`conversations`, `turns`, `items`, `attachments`, five
`conversation_*`, `harness_health`, `fts_conversation`). Plus the `run_summary`
view, the `core_entity_revoke_on_purge` trigger whose whole body was an UPDATE
on `share_authority`, each dropped table's own indexes and triggers,
`fts_conversation`'s five shadow tables, and
`ALTER TABLE locker_item DROP COLUMN connection_id` with its index.

`baseline.rs` names all 119 as `DROPPED_OBJECTS` and `locker_item` as
`ALTERED_OBJECTS`, beside the twelve the ladder adds, so a table that comes back
or a drop that stops running is a failure with a name. `head_version()` is 5.

**Three keeps, on their merits, not on a citation.**

1. **`access_device` and `access_device_secret` — KEPT**, against Reference A's
   "delete what nothing imports". Things import it: `Vault::enrol_device` has
   live callers (`crates/vault/src/backup/base.rs:376`,
   `crates/vault/tests/common/mod.rs:171`), and the base copy carrying
   `access_device_secret` is a sealed custody property (#1029 B1, sealed by W3 —
   `backup/base.rs:488`, `tests/snapshot_faults.rs:130`,
   `tests/disk_full.rs:185`). Exit item 7's grep is not empty for exactly these
   two, and that is the reason.
2. **`agent_command` / `agent_command_invocation` — KEPT.** The command registry
   and the invocation journal despite their names; a rename is its own rung.
3. **`row_version` — KEPT** as a plain revision counter (open question 11).

**The re-judgment.** Reference A puts the conversation/turn/item/attachment band
on the delete list because the assistant is deleted, while `CLAUDE.md` says the
runtime model is *conversation ⊃ turn ⊃ item*.
`grep -rn 'INSERT INTO conversation\|INSERT INTO turn\|INSERT INTO item\b\|INSERT INTO attachment' crates --include=*.rs`
→ **empty**. No Rust writes a row into that band, so it drops with the rest, and
**the vocabulary line in `CLAUDE.md` is W9's to retire.**

### The readers deleted, with their greps

| Deleted | Why it was dead | Grep |
| --- | --- | --- |
| `crates/vault/src/intents.rs` (705 lines) | its subject is the replay-outcome ledger over `replica_intent_outcome`, `replica_invocation_commit` and `replica_parked_payload` | `grep -rn 'mod intents\|intents::' crates --include=*.rs` → **empty** |
| `crates/apps/docs/src/{shares,origins}.rs` (1,419 lines) and the `shared_with` / `shared_from` / `shared_from_known` payload fields | the nine share tables | `grep -rn 'FROM share_\|INTO share_\|UPDATE share_\|JOIN share_' crates --include=*.rs` → **no SQL**, only `tally_expense_split.share_minor`; the four remaining name-hits are `baseline.rs`'s `DROPPED_OBJECTS` and the two parity mappings |
| People's share roster, dashboard and person readings (`VaultLinks`, `LinkCounts`, `Sharing`, `live_bindings_statement`, `person_links_statement`) | `share_party_vault_binding` | as above |
| `commands/locker.rs`'s `set_connection` and `CONNECTION_IS_LIVE` | `sync_connection` | `grep -rn 'FROM sync_\|INTO sync_\|UPDATE sync_\|JOIN sync_' crates --include=*.rs` → **empty** |
| `commands/core.rs`'s `PARTY_POINTERS`, `NOT_A_PARTY_POINTER`, `PointerCollision` | both named `share_authority*`; the merge sweep is now the two mechanical walks alone | `grep -rn 'PointerCollision' crates` → **empty**; `grep -rn 'FROM replica_\|INTO replica_\|UPDATE replica_\|DELETE FROM replica_' crates --include=*.rs` → **one comment** (`snapshot.rs:28`, recording what the snapshot used to truncate) |
| the kit's `ShareSeed`, `seed_share_authority`, `amend_share_authority`, `seed_share_fulfillment`, `seed_party_vault_binding`, `seed_standing_answers`, and the year-3 share/binding seeding | the same tables | as above |

**`devices.rs` is KEPT** — Reference A said "delete what nothing imports", and
W2 already split it for the same reason. Its `revoke_device` lost the
`replica_intent_outcome` sweep and is now the one DELETE it always was.
`intents::canonical_json` and `compare_utf16` moved to
`crates/vault/src/canonical.rs` (their callers are `audit.rs` and
`backup/manifest.rs`, neither an intent); `NeededBytes` moved to `content.rs`
(it is the argument `stage_bytes` takes).

**34 tests left with their subjects, every one named in its commit:** Docs'
three share-door tests and `the_nine_share_windows_are_all_exercised_by_the_corpus`,
People's four denied-share-plane tests and
`live_bindings_count_per_party_and_a_party_with_none_is_unlinked`,
`folding_a_party_with_a_standing_answer_revokes_the_duplicate_rather_than_dropping_it`,
`the_payload_hash_ignores_base_version_order` and the intent-payload half of
`intents.rs`'s own module tests.

### The frozen fixtures are filtered, never edited

`rows.json` and `queries.json` are frozen goldens (TESTING.md). Four bundles
outlived the cut, so `centraid_apps_kit::contract_vault::FrozenRowMapping` lets
a test state what it is skipping — and **refuses a mapping that names something
the schema still has**, so a mapping cannot outlive its reason. Docs' and
People's parity tests filter the sharing keys out of v0's expected answers with
the mapping in each file's header and a guard that fails when nothing is
filtered. `crates/search/tests/door.rs` filters the sealed-column registry by
what its own fixture schema carries.

**`contracts/schema/v0-registries.json` is NOT pruned, against the brief's
W19-5.** It is the **v0** record and `crates/ontology/tests/commitments.rs`
checks it against the FROZEN corpus, which still has every dropped table:
pruning it turned four corpus commitments red
(`every_physical_table_is_a_registered_entity_a_local_table_or_a_private_one`,
`no_replicated_table_references_a_private_one_by_name`, and two in
`registries.rs`). The reason is recorded as **ONT-27** in the drift register.

### Verification

`export CARGO_TARGET_DIR=/home/user/.cargo-target-w19 CARGO_INCREMENTAL=0`.

| Exit item | Result |
| --- | --- |
| 1 `cargo build --workspace --all-targets` | **clean** |
| 2 `cargo test --workspace` | **1,618 passed / 0 failed / 0 ignored**, from a 1,652 floor |
| 3 `cargo test -p centraid-vault --test baseline` | **6 passed.** The drift test was red at `22f7b069` (1 passed, 2 failed) |
| 4 `cargo test -p centraid-ontology` | **green** — `fixtures.rs` 3, `commitments.rs` 9, `golden_vault.rs` 9, untouched |
| 5 `export-ddl … \| diff - contracts/golden/issue-1020/vault-ddl.sql` | **empty** |
| 6 `export-ladder-ddl \| diff - contracts/schema/vault-ddl.sql` | **empty** |
| 7 `grep -c 'CREATE TABLE' contracts/schema/vault-ddl.sql` | **186.** The plane grep returns `access_device` and `access_device_secret` only — the deliberate keep above |
| 8 `git diff --stat 1ee293d2..HEAD -- …/vault.db.gz …/manifest.json` | **empty: the corpus and its manifest are untouched** |
| 9 `grep -rn 'mod intents\|intents::' crates --include=*.rs` | **empty** |
| 10 `cargo xtask gate --profile local --lane {fmt,clippy,rules}` | **PASS / PASS / PASS** (`rules`: 4 rules applied, `sql-confinement` 214 files clean) |
| 11 `cargo xtask gate --profile local` | **FAIL on `ledgers` only** — "no merge base found (tried origin/main, main, origin/master, master)", which is the worktree condition W2 and W16 both recorded and is not a reason to touch a ledger. Budget: **387.3s against 120s, 381.6s of it `test`** on a cold tree; `test` was already over warm before this lane (W2 measured 152.1s, 124.8s of it `test`). `restore-drill` **ok**, and it is the drill that founds a vault at the new ladder head |
| 12 `bun install --frozen-lockfile && bun run check:push:static` | **4/4 gates passed** |
| 13 `node .governance/law/run.mjs --brief-digest 2612c611d7e6` | **10 rules, no findings; no drift line — the law did not move** |

### Found, and not this lane's slice

1. **`CLAUDE.md`'s "the runtime model is conversation ⊃ turn ⊃ item"** describes
   a band with no storage and no writer. **W9's**, and the grep is above.
2. **Prose still describing the dropped planes**: `ARCHITECTURE.md`'s runtime-
   model and sharing sections, `SECURITY.md:73`'s "28 private tables" and its
   `sync_connection_credential` example, `docs/recovery/shared-origin-loss.md`
   (a whole recovery doc about `share_subscription`), `docs/glossary.md`.
   **W9's**, per the brief's "prose beyond the registers".
3. **Squashing the ladder before the first release.** A new vault founds 43
   tables and drops them in the same `Vault::create`. It is honest and cheap —
   two `sqlite_master` rows per table — and squashing is a decision about the
   migration contract, not a cleanup. **Owner question.**
4. **`agent_command` / `agent_command_invocation` should be renamed.** They are
   the command registry and the invocation journal and there are no agents. A
   rename is its own rung. **W9's, or an owner question.**
5. **`contracts/README.md` says `002_revisions.sql` "is a proposal and is
   deliberately not on `LADDER`".** It has been rung two for four rungs.
   Corrected in passing is out of scope for this lane's register pass; noted.
6. **The backup dictionary is trained from `001_baseline.sql`'s text**, comment
   lines included, so editing a rung's header is a format change
   (`crates/vault/tests/dictionary_durability.rs`). Discovered by doing it; the
   file was restored to its committed bytes. Worth a line in
   `docs/traps/`. **W9's.**

### Falsification

What would show this lane wrong. **If `contracts/schema/vault-ddl.sql` ever
stops being regenerable** — if `cargo run -p centraid-vault --bin
export-ladder-ddl | diff - contracts/schema/vault-ddl.sql` is not empty — the
fixture is a lie with a filename again, and `crates/vault/tests/ladder_ddl.rs`
is what makes that red rather than quiet. **If a dropped table comes back**, or
a drop stops running, `baseline.rs`'s named `DROPPED_OBJECTS` fails; a filter
in a parity test that stops filtering anything fails its own guard; a
`FrozenRowMapping` that names a table the schema has again is refused by the
builder. **What none of this proves** is that the 43 tables were the right 43:
that is Reference A's list plus W16's deferred table, re-judged here on
consumers and greps, and three tables survived the re-judgment for reasons
written above. A reader who thinks one of the 43 has a consumer this lane
missed should run its name past `grep -rn '<table>' crates --include=*.rs` —
every one of them was empty before it was dropped, except the ones whose
readers are deleted in `ba59b3f3`.

### Rulings spent

- **Owner ruling 2026-09-21** (comment 5756495615) — the whole design.
- **Scope amendment 2026-09-21** (comment 5755559795) — the sharing plane.
- **Reference A**, "Schema" and "`crates/vault/src`" rows — the dropped set,
  with three documented deviations (the two `access_device*` tables kept,
  `devices.rs` kept, `v0-registries.json` not pruned).
- **`migrations.rs:83-86`** — appended, never inserted, never edited. Rung five
  is appended; `001_baseline.sql` was restored to its committed bytes when an
  edit to its header moved the shipped dictionary's id.
- **TESTING.md "Fixtures and parity"** — every fixture regenerated by its own
  tool or filtered in its test; the corpus and its manifest are byte-identical.
- **D-1020-D1-13** — one file is both the migration and the fixture; rung five
  follows it.

## W17 — the transport

Branch `claude/1029-w17-transport`, base `1ee293d2`. Seven commits, no law commit.
The lane that executes the [scope amendment of
2026-09-21](https://github.com/srikanth235/centraid/issues/1029#issuecomment-5755559795)'s
"Superseded" block: the gateway API is carried over iroh, the pair ticket returns, the
phone dials and accepts no inbound connection, and object names are BLAKE3 with the
attested checksum retired.

**Base test floor: 1,652 passed / 0 failed / 5 ignored** (`cargo test --workspace` at
`1ee293d2`, 143 `test result` lines summed). **At HEAD: 1,658 passed / 0 failed / 5
ignored.** Net +6 across a lane that added 17 and retired 11 whose subject went — the
attested checksum's two mode arms, its "no attestation is a rejection" case, the
`attestation` header helper's four assertions and the re-declared-checksum binding, each
named in the commit that removed it.

| Commit | What |
| --- | --- |
| `2aa291c7` | W17-1 — `ALPN` in `gateway-core`, `docs/protocol.md`, the CHANGELOG line |
| `cb67521e` | W17-2 + W17-6a — `IrohListener`, `node.key`, `ListenerConfig`, the pairing print; `crates/net` deleted and `ticket.rs` moved to `crates/identity` |
| `bf49f2ec` | W17-3 — `IrohTransport`; `no-listening-socket` restated with two cases |
| `2cc11525` | W17-4 — **the wire test, red** |
| `5ca72aab` | W17-5a — the two bugs it found: the body limit and the refusal body |
| `b78afe6d` | W17-5b — the attested checksum retired; `MAX_OBJECT_BYTES` one declaration |
| `a5c27801` | W17-6b — `endpoint=` in the pkarr record, `_centraid` → `_centraid2` |

### The file table

| Path | What changed |
| --- | --- |
| `crates/gateway-core/src/lib.rs` | `pub const ALPN: &[u8] = b"centraid-gateway/1"` — the one declaration |
| `crates/gateway-core/src/error.rs` | `ErrorBody` + five companion bodies moved here; `ChecksumFault` narrowed to three arms |
| `crates/gateway-core/src/checksum.rs` | **deleted** |
| `crates/gateway-core/src/store.rs` | `checksum_mode` + `evidence` → `stored`; `StoredBytes`; `StoredObject.checksum` gone |
| `crates/gateway-core/src/{upload,engine,memory,conformance}.rs` | the declaration, the commit rule, the in-memory store, the suite |
| `crates/gateway-server/src/serve.rs` | `IrohListener`, `bind_iroh`, `serve_iroh`, `node_secret` |
| `crates/gateway-server/src/config.rs` | `ListenerConfig` (iroh default), `IrohConfig`; `Mode` deleted |
| `crates/gateway-server/src/http.rs` | body limits declared; `bytes_hash_to_their_name`; `ErrorBody` re-exported |
| `crates/gateway-server/src/bin/centraid-gateway.rs` | serves over iroh; prints the endpoint id and the pairing payload |
| `crates/gateway-server/tests/wire_iroh.rs` | **new** — the test that moves real bytes |
| `crates/gateway-client/src/transport.rs` | `IrohTransport`; the module header, superseded and rewritten |
| `crates/gateway-client/src/{client,outcome}.rs` | the attestation header gone; `ErrorBody` imported |
| `crates/identity/src/ticket.rs` | **moved** from `crates/net`; `mint` / `invite_code` added |
| `crates/identity/src/record.rs` | `endpoint=`, optional `gateway=`, `_centraid2` |
| `crates/identity/src/discovery.rs` | `Located` carries both coordinates |
| `crates/net/` | **deleted** |
| `crates/media/src/object/mod.rs` | `MAX_OBJECT_BYTES` imports the rules' declaration |
| `crates/xtask/src/rules.rs` | `no-listening-socket` restated + two cases |
| `crates/vault/tests/one_hash.rs` | the `checksum.rs` allowlist row deleted |
| `contracts/gateway/{schema.sql,queries/object_*.sql}` | `attested_checksum` column dropped |
| `contracts/crypto/discovery-vectors.json` | regenerated by `CENTRAID_UPDATE_FIXTURES=1` |

### `IrohListener`, in five lines

1. `bind_iroh(data_dir, config)` binds an `Endpoint` on the persistent `node.key`, offering
   `centraid-gateway/1` — the **only** `.alpns(…)` in the workspace.
2. `IrohListener::spawn` runs one task per accepted connection; each awaits its handshake
   in its own task, never inline in the accept loop (Reference A's defect).
3. Every accepted bi-stream is pushed into one bounded (64) channel; `accept` pops it.
4. `Listener::Io` is `tokio::io::Join<RecvStream, SendStream>`, `Addr` is `EndpointId`.
5. One bi-stream is handed to hyper as one HTTP/1.1 connection, so **the client picks**:
   finish the stream and get one request per stream, keep writing and get keep-alive. The
   listener decides nothing about a request, which is what `serve.rs`'s header requires.

### `IrohTransport`, in five lines

1. `dial_only_endpoint()` binds an endpoint with **no ALPNs**; nothing here calls `accept`.
2. `connect` dials the laptop's `EndpointAddr` under `centraid_gateway_core::ALPN` and
   opens one bi-stream.
3. `hyper::client::conn::http1::handshake` runs over `join(recv, send)`; the driver is
   spawned and the `SendRequest` half is kept.
4. That half is reused for every later request behind a `Mutex`, so keep-alive works as it
   does over TCP and a spool drain is one hole-punch rather than four hundred.
5. A connection the peer closed is re-dialled **once**, then `TransportError`. That is not
   a retry of a decision: a closed connection carried no answer to re-judge.

### The pairing payload, field by field

`base64url(PairTicket)`, shown as text and as a half-block Unicode QR:

| Field | Value |
| --- | --- |
| `v` | `1` |
| `gateway_endpoint` | the laptop's `EndpointId`, 32 raw bytes |
| `relay_url` | the relay the laptop expects to be reachable through; empty = n0's |
| `ticket_id` | `hex(blake3(invite)[..8])` — the row `centraid-gateway invites` prints |
| `secret` | **the invite code `tenancy.rs` already requires**, UTF-8, trimmed once |
| `vault_name` | empty on a laptop |
| `expires_at_ms` | the invite's own expiry (30 days), not a second lifetime |
| `direct_addrs` | `endpoint.addr().ip_addrs()` as dialling hints |

There is **no second admission**. `secret` is the invite the owner reads out; the server
holds its BLAKE3 and redeems it through the conditional `UPDATE` that already existed.

### Where the `EndpointId` lives, and how 24 words become a dial

- **In the pkarr record**: `_centraid2.<z-base32 of the vault identity key>` TXT
  `endpoint=<32 bytes hex>`, beside an optional `gateway=` and the required `cert=`.
- **In the pair ticket** the phone scans at pairing: `PairTicket.gateway_endpoint`.
- **In the vault: not yet.** W19 owns the schema ladder for this umbrella and the root
  ruled that this lane must not add a rung. The client is constructed from the ticket and
  from the record. **Hand-off to W19, the exact column wanted:** a
  `gateway_endpoint BLOB` (32 bytes, nullable) on whatever per-vault settings table W19
  lands, written once at pairing, so a phone that has paired need not re-resolve DNS to
  reach its own laptop on the same network.

**From 24 words to a dial**, which is W15's path and is why `Located` has two accessors:
parse the phrase → `VaultMint`/`restore_vault_keys` for vault *i* → `identity.public()` is
the key the record is published under → `Discovery::locate_vault(key, Published)` →
`Located::endpoint()` is 32 bytes → `iroh::EndpointId` → `IrohTransport::new(endpoint,
EndpointAddr::new(id))` → `GatewayClient::new(transport, signer, vault)`. `Located::gateway()`
is `None` for a laptop and that is not a failure.

### The wire test's assertions, by name

`crates/gateway-server/tests/wire_iroh.rs`, real server through `IrohListener` on a
loopback endpoint with **relay off and address lookup off**, real
`GatewayClient<IrohTransport>` handed the direct address:

- `the_whole_client_path_moves_sixteen_mebibytes_over_iroh` — preflight (version agreed),
  `claim_lease` (epoch 1, no head), `declare` (one target, not already committed),
  `put_object` of **16 MiB**, `commit` with `prev_head: null`, `get_object`, byte-equal.
- `an_unsigned_request_is_refused_across_the_wire` — 401 and
  `code == "GatewaySignatureInvalid"`. The carrier carried it; the router refused it.
- `a_version_window_refusal_parses_on_the_client` — a lease signed at
  `PROTOCOL_MAX + 7` comes back as `ClientError::Version(ServerNeeds::PhoneUpdate { server:
  (1, 1) })`, and the raw body parses as `ErrorBody`.

The server endpoint is bound through `serve::bind_iroh` with the real `local_only` and
`bind_addr` settings rather than a construction written in the test, because offering an
ALPN outside `serve.rs` is a `no-listening-socket` finding and should stay one.

**`conformance::run` is NOT driven through a transport, and the reason is structural.**
`conformance::Harness` requires `fn gateway(&mut self) -> &mut Gateway<Self::State,
Self::Bytes>`: every case reaches *into* a `Gateway` value and resets it between cases. A
`GatewayClient` has no `Gateway` to hand back. Driving the suite over the carrier needs
`Harness` widened into a transport-shaped trait that the in-process adapters then
implement through an adapter of their own — a real piece of work with a real payoff, and
**not** a second harness. Recorded here rather than smuggled in.

### The one policy change, and it is recorded

`no-listening-socket` is **restated**, cited to the amendment, in the commit that needed
it (`bf49f2ec`), with two cases of its own. It grepped for `TcpListener` alone; an iroh
endpoint binds a UDP socket, so a phone that started accepting inbound QUIC would have
passed in silence — a check passing for the wrong reason, which is the failure the
constitution's 2026-09-21 Evolution Log entry was written about from the other side. The
rule's subject is now the amendment's own sentence, "the phone dials; it accepts no
inbound connection", and its patterns follow it: `.alpns(` and `.accept()` join the two
TCP ones. **It catches strictly more than it did** and the exemption is still one file
with a reason. `a_gateway_client_endpoint_that_offers_an_alpn_or_accepts_is_a_finding`
and `a_dial_only_endpoint_is_not_a_listener` pin both halves.

### Finds outside this lane's slice

1. **A 16 MiB object could not be uploaded at all, on either carrier.** The router declared
   no body limit, so axum's default 2 MiB applied to the `Bytes` extractor — one eighth of
   the size the protocol's own rules admit (F6) — and the failure was a stream closed
   mid-write, not a refusal anybody could read. No test had ever put a full-sized object
   through the HTTP adapter. Fixed here because the wire test could not be green otherwise.
2. **The retention comment W16 handed on, re-judged.** "Seven days is SigV4's cap" was a
   number with no protocol behind it: v0 presigns nothing, because every upload target is
   a path on the member's own laptop. **The number stays and the reason changes.** It is
   now the half that was always true and is now the whole of it — a target must outlive
   the longest deferral a phone can suffer, and seven days is the week an iOS device can
   be off charge and off Wi-Fi before it comes back to finish a transfer. Three sites
   moved together: `spool.rs`'s `LONGEST_DEFERRAL_MS`, its test (renamed from
   `the_longest_deferral_is_the_sigv4_cap` to `the_longest_deferral_is_a_week`, because a
   test naming the wrong protocol is the comment again), and `bytes/fs.rs`'s
   `TARGET_LIFETIME`.
   **Owner question, with a recommendation.** With no presigning left, should a target
   expire at all? *Recommend keeping the expiry:* it is what makes an abandoned
   declaration collectable by listing, and the phone's `Batch::usable_for` comparison is
   only meaningful against a finite lifetime. What it must not do is read as somebody
   else's cap, and it no longer does.
3. **`MAX_OBJECT_BYTES` was two numbers held equal by a comment.** The comment said the
   conformance suite held them equal "in practice"; two numbers held equal by a suite are
   two numbers. Collapsed.
4. **The `ledgers` gate step cannot run in these worktrees.** `git merge-base HEAD
   origin/main` is empty — the umbrella branch shares no ancestor with `origin/main` — so
   the down-only check refuses to pass without a comparison. It is identical on the base
   (`git merge-base 1ee293d2 origin/main` is also empty) and no ledger file was touched by
   this lane. Not a finding of this lane's; named so the next one does not re-diagnose it.

### Falsification

The two riskiest claims here, and the throwaway check against each.

**1. "Nothing on the wire changes."** The claim a carrier swap most easily breaks, and a
test written beside the carrier is exactly the test that would not notice. The throwaway
check was to make the *server* speak the old wire and see whether the client noticed: the
`VersionWindow` case is that, run for real — the server wrote `server_protocol_min` and
the client read `min`, and the test went red with "a VersionWindow refusal did not reach
the phone as one" rather than passing on a carrier that faithfully delivered an
unparseable body. The carrier was never the thing under test; the protocol was, and the
protocol is what failed.

**2. "The phone's endpoint accepts nothing."** The risk is that the restated rule is a
rule about my own code's current spelling rather than about the property. The throwaway
check was to add `.alpns(vec![ALPN.to_vec()])` to `IrohTransport::dial_only_endpoint` and
run `cargo xtask gate --profile local --lane rules`: it went red at
`crates/gateway-client/src/transport.rs`, naming the file and the line, with the
amendment's sentence in the finding. The same edit against the rule as it was on the base
was green — which is the whole reason the restatement exists. The line was reverted before
the run that follows.

### Verification

| Command | Outcome |
| --- | --- |
| `cargo build --workspace --all-targets` | clean, 0 warnings |
| `cargo test --workspace` | **1,658 passed / 0 failed / 5 ignored** (base 1,652) |
| `cargo test -p centraid-gateway-server --test wire_iroh` | 3 passed; red at `2cc11525` |
| `grep -rn 'centraid-gateway/1' crates --include=*.rs` | one declaration (`gateway-core/src/lib.rs:112`) |
| `grep -rn 'AttestedChecksum\|checksum::' crates --include=*.rs` | empty |
| `cargo tree -i sha2` | `centraid-identity` only |
| `grep -rn 'MAX_OBJECT_BYTES' crates --include=*.rs \| grep const` | one declaration, two casts |
| `cargo tree -i centraid-net` | `did not match any packages` |
| `cargo xtask gate --profile local --lane rules` | PASS, `no-listening-socket` clean over 333 files |
| `cargo xtask gate --profile local --lane fmt` / `--lane clippy` | PASS / PASS |
| `cargo xtask gate --profile local` | FAIL — `ledgers` only, for the merge-base reason above. Budget: "the `local` profile took 300.7s against a 120s budget" — `test` at 262.0s, over cold before this lane; no ledger touched |
| `bun run check:push:static` | 4/4 gates passed in 4.3s |
| `node .governance/law/run.mjs --brief-digest 2612c611d7e6` | 10 rules, **no findings**. The law's own digest now reads `4cf9a5a8690a` against the brief's `2612c611d7e6`; `git diff --stat 1ee293d2..HEAD -- .governance/ CONSTITUTION.md tests/` is empty, so the drift is not this lane's |
| the binary, empty state dir, twice | `endpoint  d42a882411fa67d9552acb05c92bd7880d97c86e9d7596891d4f738bd5f1e76f` on both starts; the first also printed `invite 0e47-8956-…-4632` and a `pair` payload, the second printed the invite's hash and minted nothing |

## W18 — the drain pass

Branch `claude/1029-w18-drain`, base `5d4ac8a5`. Five commits, no law commit. The mobile half
of the [scope amendment of
2026-09-21](https://github.com/srikanth235/centraid/issues/1029#issuecomment-5755559795),
"Superseded — Background upload": the phone drains over iroh in the foreground and inside the
`BGProcessingTask` window iOS grants, under WorkManager on Android; there is no transfer while
the app is suspended; force-quit stops it until next launch; this is the iCloud Backup posture
and the copy says so.

**Floor: 236 jvm tests, 0 failed** (`./gradlew -p mobile mobileJvm`, summed from
`mobile/*/build/test-results/*/*.xml`). **At HEAD: 258 passed, 0 failed** — +25 added, −3 retired
with their subject, each named below.

**iOS does not compile in this container.** Every Swift and `iosMain` claim below is an
inventory row with the grep that supports it. No simulator ran.

| Commit | What |
| --- | --- |
| `631c92d8` | W18-1 — the app stops dying: `upload-pass` in `project.yml`, both handlers registered, `BackgroundIdentifierSpec` |
| `f9c1fff7` | W18-2 — `DrainPass`, `DrainDoor`, `DrainClaim`, `DrainCopy` and their spec |
| `7034e07f` | W18-3 — the `URLSession` seam retired, its sentences already moved |
| `6cb90d60` | W18-4 — `PairMachine`, `RestoreMachine`, `CustodyCopy` and their spec |
| (this one) | W18-5 — the receipt, the CHANGELOG line, `docs/mobile-offline.md` |

### The file table

| Path | What changed |
| --- | --- |
| `mobile/iosApp/project.yml` | `dev.centraid.upload-pass` added to `BGTaskSchedulerPermittedIdentifiers` — **the source the plist is generated from** |
| `mobile/iosApp/Sources/BackgroundPasses.swift` | **new** — both handlers, `setTaskCompleted` on every path, the next window resubmitted |
| `mobile/iosApp/Sources/CentraidApp.swift` | `init()` registers before anything submits |
| `mobile/shared/src/commonMain/…/sync/DrainPass.kt` | **new** — the pass, the door, the claim fold, the copy |
| `mobile/shared/src/commonMain/…/custody/PairAndRestore.kt` | **new** — the two flows and their copy |
| `mobile/shared/src/commonMain/…/platform/BackgroundTransfers.kt` | **deleted** |
| `mobile/shared/src/commonMain/…/platform/PlatformServices.kt` | the `backgroundTransfers` member gone, with the paragraph saying where it went |
| `mobile/shared/src/iosMain/…/PlatformServices.ios.kt` | `IosBackgroundTransfers` and five `NSURLSession*` imports gone |
| `mobile/shared/src/androidMain/…/PlatformServices.android.kt` | `AndroidBackgroundTransfers`, `CentraidUploadWorker` and six imports gone |
| `mobile/shared/src/jvmMain/…/PlatformServices.jvm.kt` | `FakeBackgroundTransfers` gone |
| `mobile/shared/src/jvmTest/…/BackgroundIdentifierSpec.kt` | **new** — the identifier guard |
| `mobile/shared/src/jvmTest/…/BackgroundPassLawSpec.kt` | **new**, replacing `BackgroundTransferLawSpec.kt` (**deleted**) |
| `mobile/shared/src/jvmTest/…/{DrainPassSpec,PairAndRestoreSpec}.kt` | **new** |
| `mobile/shared/src/jvmTest/…/CustodyAndBackupClaimSpec.kt` | its two background-upload cases retired |
| `docs/mobile-offline.md` | the provisional iOS-transfer paragraph: the transport half is settled by the amendment, the timing half is not |
| `CHANGELOG.md` | the entry |

### The identifier guard, and the defect it was written for

`grep -n 'BGTaskSchedulerPermittedIdentifiers' -A3 mobile/iosApp/project.yml` on the base named
**one** identifier; `mobile/iosApp/Resources/Info.plist` named two. The plist is **xcodegen's
output** of `project.yml` (the file says so in its own comment), so a generated bundle declared
one identifier while `IosBackgroundTasks.register()` submitted two — and `BGTaskScheduler` raises
`NSInternalInconsistencyException` for an undeclared identifier, which terminates the app rather
than failing the task. Separately, `grep -rn 'forTaskWithIdentifier' mobile/iosApp/Sources` was
**empty**: no launch handler for either identifier, which is the same exception and the same
termination on the first submit, and means a granted window had nothing to run.

`BackgroundIdentifierSpec` reads all three files and asserts, per identifier: present in
`project.yml`, present in `Info.plist`, plist and source declare the **same set in both
directions**, named in a Swift source, `forTaskWithIdentifier:` present, and `setTaskCompleted`
reachable after `expirationHandler`. **Red-first**: with the base's `project.yml` restored, 2 of
its 6 cases fail — `every identifier the shell submits is declared in project.yml, which is the
source` and `the generated plist and its source declare the same set, in both directions`
(`/tmp/…/redfirst.log`, `6 tests completed, 2 failed`).

### The pass's deadline, per platform

| Platform | Where the deadline comes from | Budget handed to the pass |
| --- | --- | --- |
| foreground | the caller's; a pass is not bounded by a window it does not have | caller's choice |
| iOS `BGAppRefreshTask` | `BackgroundPasses.refreshBudgetSeconds`, with `task.expirationHandler` as the truth | 25 s |
| iOS `BGProcessingTask` | `BackgroundPasses.processingBudgetSeconds`, same expiration handler | 8 min |
| Android | WorkManager's stop signal, through `SyncPass.installed` | the worker's |

The expiration handler cancels the work and calls `setTaskCompleted(success: false)`: a drain
stopped mid-object resumes next window, because the spool never loses a sealed object. **The next
window is requested on every path, including a refusal** — `BGTaskRequest` is one-shot, and a
handler that resubmits only on success runs once in the life of an install.

**On Android and the foreground-service question.** WorkManager's own limit is ten minutes per
worker before `onStopped`, which is the same order as the iOS processing window, so a drain of a
full generation may not finish inside one. It does not need to: the pass is resumable by
construction and the periodic work is already every 15 minutes. A foreground service with a
notification buys uninterrupted minutes at the cost of a permanent notification for a backup a
member did not ask to watch, and it is the honest shape only if a resumable drain turns out to
make no progress across windows — which is a measurement nobody has taken. **Recommendation to
the owner: stay on `CoroutineWorker` and revisit if the measurement says otherwise.**

### The iOS inventory — **7 rows, a grep each**

| # | Claim | Grep | Result |
| --- | --- | --- | --- |
| 1 | both identifiers are declared in the plist's source | `grep -n -A3 BGTaskSchedulerPermittedIdentifiers mobile/iosApp/project.yml` | `:112 sync-pass`, `:113 upload-pass` |
| 2 | both are in the committed plist | `grep -n '<string>dev.centraid' mobile/iosApp/Resources/Info.plist` | `:14`, `:15` |
| 3 | a handler is registered for each | `grep -n 'forTaskWithIdentifier' mobile/iosApp/Sources/BackgroundPasses.swift` | `:79`, in a helper called once per identifier from `register()` (`:73-76`) |
| 4 | registration happens at launch, before any submit | `grep -n 'BackgroundPasses.register' mobile/iosApp/Sources/CentraidApp.swift` | `:43`, inside `init()` |
| 5 | the task is completed on every path | `grep -n 'setTaskCompleted' mobile/iosApp/Sources/BackgroundPasses.swift` | `:93` (no pass installed), `:98` (finished), `:106` (expired) |
| 6 | the next window is resubmitted | `grep -n 'resubmit\|BGTaskScheduler.shared.submit' mobile/iosApp/Sources/BackgroundPasses.swift` | `:88` (called first, before the pass), `:116`, `:132` |
| 7 | no `URLSession` upload is left in `iosMain` | `grep -n 'NSURLSession' mobile/shared/src/iosMain/kotlin/dev/centraid/shared/platform/PlatformServices.ios.kt` | empty |

What these rows prove is that the declarations, the registrations and the completion paths are
written and are consistent across the three files. What they do not prove is that iOS accepted
them, which needs the physical-device run `TESTING.md` already parks.

### What was retired, and where its sentences went

`BackgroundTransfers` (127 lines), `IosBackgroundTransfers`, `AndroidBackgroundTransfers`,
`CentraidUploadWorker`, `FakeBackgroundTransfers` and the `PlatformServices` member. **The
sentences moved in the commit before the deletion, not with it**:

| Sentence | Was | Is |
| --- | --- | --- |
| force-quit | `BackgroundTransfers.FORCE_QUIT_SENTENCE` | `DrainCopy.FORCE_QUIT_SENTENCE`, **corrected** |
| Android unmetered | `BackgroundTransfers.ANDROID_UNMETERED_SENTENCE` | `DrainCopy.ANDROID_UNMETERED_SENTENCE`, verbatim |
| in-flight title | `IN_FLIGHT_TITLE` = "Uploading" | `DrainCopy.IN_FLIGHT_TITLE` = "Backing up" |
| the posture | did not exist | `DrainCopy.POSTURE_SENTENCE`, the amendment's own comparison |

**The correction is the important one.** The old sentence ended "Uploads keep going if iOS closes
the app itself", which was true of a system-owned `URLSession` background session and is **false**
of a drain that runs inside this process. A sentence that outlives its mechanism is a promise the
product stops keeping without anyone editing it, so `DrainPassSpec` has a case asserting that
string is gone from every sentence in `DrainCopy`.

Two specs changed rather than vanishing. `BackgroundTransferLawSpec`'s four rows: the two Android
ones survive as `BackgroundPassLawSpec` (their subject survives), the plist row's successor is the
stronger `BackgroundIdentifierSpec`, and the file-based-upload row's subject is deleted — with a
new third row that walks every `.kt` and `.swift` under `mobile/` and fails if the seam comes
back. `CustodyAndBackupClaimSpec` loses its two background-upload cases: the force-quit assertion
is re-made in `DrainPassSpec` over the new home, and the "uncooperative platform" case was about a
seam that no longer exists.

### Exit list

| # | Command | Outcome |
| --- | --- | --- |
| 1 | `cargo xtask gate --profile mobile-jvm` | **PASS**, 100.9 s of a 420 s budget (165.4 s before the merge); its own check `git diff --exit-code -- design copy mobile contracts/screens` clean |
| 2 | the identifier guard | `BackgroundIdentifierSpec`, 6 cases, **2 red on the base `project.yml`** |
| 3 | `grep -rn 'forTaskWithIdentifier' mobile/iosApp/Sources` | `BackgroundPasses.swift:79`, in the helper `register()` calls once per identifier |
| 4 | `grep -rn 'BackgroundTransfers\|backgroundTransfers\|NSURLSessionUploadTask' mobile --include=*.kt --include=*.swift` | **no code hit.** Six prose hits remain — five KDoc lines naming where the seam went and one assertion in `BackgroundPassLawSpec` that it stays gone. They are supersession markers, which this repository treats as state |
| 5 | `grep -rn 'FORCE_QUIT_SENTENCE\|ANDROID_UNMETERED_SENTENCE' mobile/shared/src` | `sync/DrainPass.kt:236,245` and five assertions in `DrainPassSpec` |
| 6 | `grep -rn 'Drain\|BackupStatus' mobile/shared/src/commonMain` | `sync/DrainPass.kt` and `custody/PairAndRestore.kt` (its doc naming the door shape), nowhere else |
| 7 | `./gradlew -p mobile mobileJvm --no-daemon` | **BUILD SUCCESSFUL**, **269 tests, 0 failed** after the W15-1 merge (258 before it; floor 236). `contracts/screens` drift: none — no screen proto was touched |
| 8 | `bun install --frozen-lockfile && bun run check:push:static` | **4/4 gates passed in 5.8 s** |
| 9 | `node .governance/law/run.mjs --brief-digest 4cf9a5a8690a` | **10 rules, no findings**; no drift line — the law is at the brief's digest |
| 10 | the iOS inventory | 7 rows above, a grep each |

### Finds outside this lane's slice

1. **The plist/`project.yml` split is a trap with no guard anywhere else.** `Info.plist` is a
   generated file that is also committed — the same two-sources-of-truth shape `project.yml`'s own
   header says the repository rejected for `.xcodeproj` — and the only thing that had ever compared
   them was a spec that read the plist alone, which is the half that is *not* the source. Every
   other generated-and-committed file in `mobile/iosApp/Resources/` is exposed the same way.
   `BackgroundIdentifierSpec` closes it for this one key only.
2. **`BackgroundTasks.register()` submits two task requests and reports one verdict**, and its
   "both or neither" comment describes a `&&` that short-circuits: a refused refresh means the
   processing request is never submitted at all, which is not "neither", it is "neither, and the
   second was never asked". Left as found — it is `iosMain` and its behaviour is unchanged by this
   lane — but the comment is wrong about its own code.
3. **`docs/mobile-offline.md`'s per-state promise table still names `BackgroundTasks.window(wake)`**
   (lines 157, 211), which `PlatformServices.kt` deleted with the seat plane; its own comment at
   `:93-102` says so. The table describes a scheduler that is gone. Not this lane's to rewrite —
   it is the whole section, and the drain replaces only part of it.

### Falsification

The riskiest claim here is **"the app stops dying"**, because it is a claim about a runtime this
container cannot run, made by a test that reads text. The throwaway check was to ask whether the
guard would have caught the defect *as it actually was*, rather than as I had described it: I
restored the base `project.yml` and ran the spec, and it went red at two named cases, one of them
the both-directions comparison that no previous test asked. The old
`BackgroundTransferLawSpec` row was **green** on that same tree, because it compared the Kotlin
companion against the plist and the plist was the file that was right. That is the whole finding:
a guard pointed at the generated file passes while the source is wrong.

What would falsify the second claim — **"a granted window now has something to run"** — is not a
grep: it is a member's phone. The registration exists, names both identifiers, and completes the
task on three paths; whether iOS ever grants the window, and whether the drain fits inside it, are
the two things only the physical-device run can answer, and nothing here claims them.

**The pass has no core behind it yet, and that is stated rather than implied.** `DrainDoor`,
`PairDoor` and `RestoreDoor` are seams onto W15's request kinds, which had not landed in
`envelope.proto` while this lane ran, so there is nothing to encode and no shell trigger is wired
to the pass. Everything that does not depend on the wire — the pass's refusal of a concurrent run,
its rescheduling, the claim fold, every sentence, both flows' state machines — is tested on the
JVM. **Hand-off: when `Drain`, `Pair`, `Restore` and `BackupStatus` exist, the remaining work is
three adapters over `CentraidCore.call`, `BackgroundPasses.pass = …` in `ShellModel`,
`SyncPass.install { … }` on Android, and a foreground trigger on becoming active.**

### After the merge of W15-1 (`b4f0e03e`)

The request contract landed mid-lane and was merged into this branch (`a25e6fd6`; one conflict,
in `CHANGELOG.md`, where both lanes added an entry — both kept). **W15 touched nothing under
`mobile/`**: `git diff --name-only 5d4ac8a5 b4f0e03e -- mobile/` is empty. The Kotlin bindings
are Wire's, generated from `crates/api-proto/proto` by `:core`'s own task; nothing was written by
hand.

`CoreDoors.kt` is the whole of what crosses — `drain = 15`, `pair_phone = 16`, `restore = 17`,
`backup_status = 18`, one `Envelope` each. **At HEAD: 269 jvm tests, 0 failed** (floor 236).

Three alignments, each of which changed the shell rather than the contract:

1. **There is no safety number on the wire.** `PairResponse` carries `gateway_endpoint` and
   `record_published`; `centraid_identity::safety_number` exists in Rust and is not part of the
   answer. The paired screen shows the endpoint id — which the laptop's own terminal prints, so
   it is comparable by eye — in eight-character groups with **every character present**. The
   shell computes no number of its own: that would be a second answer to "who did I pair with".
   **Owner question, with a recommendation.** Should `PairResponse` carry
   `identity::safety_number` over the two identities instead? *Recommend yes:* a safety number is
   designed to be read aloud and compared, and a 64-character hex id is not — members will
   compare the first four characters and stop. The endpoint id is what is available today and it
   is honest; it is not what this comparison should be made of.
2. **A restore reports rows**, not just a vault count: `RestoredVault.rows` is the census the
   generation promised, and "2 vaults" reads identically over two empty files.
3. **The three `stopped` sentences are W15's own words**, with `pending_bytes` rendered in
   decimal units — a phone's own storage screen is decimal, and two numbers for one amount is
   worse than either. Neither DEADLINE nor UNREACHABLE may contain "failed", and a case asserts it.

**The drain's behaviour is not real yet** — W15's note says it seals and answers `UNREACHABLE` —
and **no test in this lane is gated on bytes moving.** Every case here is about shape, refusal,
copy and state.

`VaultSecrets` is the plumbing for the two secrets `centraid_open` takes, and it exists because
they look alike and have opposite rules: the **seed** goes to `SyncedSecrets` (synchronised: it
is the 24 words) and the **device secret** to `SecureStore` (this device only: a copy on a second
phone enrols both as one device, which is what F1's freeze is keyed on). A stored value of the
wrong shape is read as absent rather than handed to the ABI as a `BAD_ARGUMENT`.
`CoreConfiguration` carries both; `ConfigurationJsonSpec` pins that absent is absent and not an
empty string, and that `device` is its own object and never nested inside `vault`.

**One thing is still provisional and is built in exactly one line.** `CONTRACT.md` §4b carries
the seed half today; the `device` object is W15's in-flight extension and is spelled
`"device":{"secret":"<hex>"}` as its author stated it, at
`mobile/core/src/commonMain/kotlin/dev/centraid/core/CentraidCore.kt:127-129`. If the landed
contract spells it otherwise, that line moves and nothing else does.

**What is still not wired, and it is the same hand-off as before, narrowed.** No shell trigger
calls the pass: `BackgroundPasses.pass = …` in `ShellModel`, `SyncPass.install { … }` on Android,
and a foreground trigger on becoming active are three call sites in files no toolchain here
compiles, and each needs the shelf to hand over a core supplier and a vault id. The doors, the
pass, the claim fold, the copy and both custody machines are done and tested.

### W18-6 — the three triggers, and the pass has callers

The root's judgement on the first report was right: "no shell trigger calls the pass" is the whole
product, and a pass nobody invokes is W5B's state with better copy. `SyncPass.installed` was null
on every Android device and `BackgroundPasses.pass` had nothing to be set to, so every granted
window ran nothing. Commit `ca8ab51e`. **278 jvm tests, 0 failed** (floor 236).

**`ShelfDrain` is the join**, in `commonMain`: it walks **every held vault, not the one in
front** — a background window backs up the device, not the screen the member left open — with the
deadline **divided**, because a window that spent its whole budget on the first vault would leave
a second one permanently unbacked-up on a phone that never gets a long window. The foreground's
`0` ("no deadline", `phone.proto`) passes through undivided, since a budget of nothing divided is
still nothing. Two holdings are skipped and neither is a failure: **resting** (no core; waking one
opens SQLite, and a background window is the worst moment for that) and **frozen** (F1 — the
laptop would refuse its next put with `VAULT_MOVED`, so draining it is this phone arguing with a
decision already made).

**The design change was the smallest one, and it was not to `Shelf`.** The shelf already hands
over a core supplier (`Shelf.core()`, `Shelf.all()`), so nothing there moved. Two things did:

1. `ShelfDrain` takes **a supplier of holdings rather than the `Shelf`** — nothing in it opens,
   closes, wakes or reorders a vault, and the narrower dependency is what makes it testable on the
   one toolchain this container has.
2. `ChangeStream` gained **one nullable `onCommit` listener**, called after every routed screen
   has been told. A `ChangeEvent` is the one signal in this process that says the vault moved; the
   alternative was a second collector on the core's `SharedFlow` per vault, to learn a fact this
   consumer already has. It is deliberately **not** in the screens' route list — a route is a
   screen that re-reads — and it is called last, so a member's list does not redraw a moment later
   because a spool was being emptied.

The drain lives on `HomeSession`, which owns the shelf, so Android reaches it directly (the way it
already collects the `StateFlow` directly) and iOS through `HomeBridge.drain`/`becameActive`.

**A real bug the spec caught, in this lane's own new code.** The debounce used `Long.MIN_VALUE` as
the "never run" sentinel, and `now - Long.MIN_VALUE` overflows negative — so every commit after
launch read as inside the debounce and the third trigger was dead until something else ran a pass.
It is nullable now, and `a commit inside the debounce is DROPPED, not queued` asserts the first
commit after launch runs. Nothing about the shape of the code would have shown this.

#### The trigger inventory — **7 rows, a grep each**

| # | Claim | Grep | Result |
| --- | --- | --- | --- |
| 1 | iOS installs the pass when the session exists | `grep -n 'BackgroundPasses.pass' mobile/iosApp/Sources/ShellModel.swift` | `:158`, inside `home.onSession { … }` |
| 2 | iOS drains on becoming active | `grep -n 'shell.becameActive()' mobile/iosApp/Sources/CentraidApp.swift` | `:88`, in the `.active` arm the switcher mask already used |
| 3 | …and that reaches the bridge | `grep -n 'func becameActive' mobile/iosApp/Sources/ShellModel.swift` | `:69`, guarded by `#if canImport(CentraidShared)` |
| 4 | Android installs the worker's pass | `grep -n 'SyncPass.install' mobile/androidApp/.../MainActivity.kt` | `:234`, at the session open, with `SyncPass.WORK_MANAGER_BUDGET_MS` |
| 5 | Android drains on becoming active | `grep -n 'override fun onResume' mobile/androidApp/.../MainActivity.kt` | `:128` — `onResume` returns, doing the amendment's foreground half rather than the gateway catch-up it used to do |
| 6 | the commit trigger is wired | `grep -n 'onCommit' .../shell/HomeSession.kt` | `:547`, launched rather than awaited (the core's event queue is bounded and drops nothing) |
| 7 | both task requests are submitted | `grep -n 'refreshTaken = submit\|processingTaken = submit' .../PlatformServices.ios.kt` | `:338`, `:339` |

Rows 1-5 and 7 are in files no toolchain here compiles, and are verified by reading and by these
greps — the same standing this lane's `BackgroundPasses.swift` and W13's `VaultFileProtection.swift`
have. Row 6 is `commonMain` and is covered by `ShelfDrainSpec`.

#### Find (2), fixed — the `&&` that short-circuited

`IosBackgroundTasks.register()` ran `submit(refresh) && submit(processing)` under a comment
reading "BOTH OR NEITHER". `&&` short-circuits: a refused refresh meant the processing request —
**the one that uploads bytes** — was never submitted at all. That is not "neither"; it is "the
first was refused and the second was never asked", and iOS grants the two independently, so a
phone whose refresh is refused may still be granted a processing window. Both are now submitted,
both results collected, `registered` is `refreshTaken || processingTaken`, and the sentence says
**which** was refused — a phone that will upload but not catch up early is a different product to
use, and saying so is the difference between a member who understands their backup and one who
does not. A `jvmTest` cannot reach `BGTaskScheduler`; this is inventory row 7.

#### The safety number

The root has ruled: `identity::safety_number` joins `PairResponse`. Not blocked on, and the swap
is one line — `PairAndRestore.kt:248` carries the TODO naming the field, and `CorePairDoor` fills
`PairAnswer.gatewayEndpoint` from `paired.gateway_endpoint` in one place, which becomes
`paired.safety_number`.

#### What is left

Nothing in this lane's scope. The remaining unknowns are measurements, not code: whether iOS
grants the windows, whether a drain fits inside one, and whether a resumable Android drain makes
progress across WorkManager windows (which is what the foreground-service recommendation turns
on). None is answerable without a physical device.
## W15 — restore, for real

Branch `claude/1029-w15-restore`, base `5d4ac8a5`. **One commit, and the lane is
NOT complete.** What landed is W15-1, the request contract the sibling lane is
blocked on; W15-2 (the drain's upload half), W15-3 (restore from 24 words) and
W15-4 (the purge schedule) did not, and the hand-off below says exactly where
each stands so the next lane starts from evidence rather than from the brief.

**Base test floor: 1,624 passed / 0 failed / 5 ignored** — `cargo test --workspace`
at `5d4ac8a5`, on a **clean tree** and a fresh cold `CARGO_TARGET_DIR`, 143
`test result` lines summed. It confirms the root's measured 1,624 exactly.
**At HEAD: 1,633 / 0 / 5**, +9.

| Commit | What |
| --- | --- |
| `b4f0e03e` | W15-1 — `phone.proto`, the four arms, `CONTRACT.md` §4b and §4c, `crates/core/src/phone.rs`, `BackupNow` retired |

### The request contract

| Kind (field) | Answer | Bounded? |
| --- | --- | --- |
| `drain = 15` `{ deadline_ms }` | `DrainResponse { acked_txid, pending_bytes, stopped, acked_at_ms? }` | **unbounded**, cancellable |
| `pair_phone = 16` `{ payload }` | `PairResponse { gateway_endpoint, record_published }` | bounded |
| `restore = 17` `{ phrase, endpoint? }` | `RestoreResponse { vaults[], gap_scanned }` | **unbounded**, cancellable |
| `backup_status = 18` `{}` | `BackupStatusResponse { acked_txid?, acked_at_ms?, pending_bytes, laptop_paired }` | bounded |

`DrainStop` is `UNSPECIFIED | EMPTY | DEADLINE | UNREACHABLE`. `BackupNow` is
deleted and `Request.kind` field **10 is reserved, not reused**, with
`ADMIN_COMMAND_BACKUP_NOW`'s value 3 beside it.

Pairing and status are **bounded** although pairing talks to the network, and
that is the classification's own question rather than a lapse: `Bounded` means
"finishes on its own, bounded by its own limit" (`handle.rs`'s `request_kind`),
and a pairing that cannot reach the laptop fails rather than running on. A drain
has **two** stops and they are different facts — `Cancel` is the member leaving
the screen, `deadline_ms` is the operating system taking the window back — which
is why the deadline is not spelled as a cancellation the shell has to schedule.

### The two decisions this slice had to make

**W15-D1 — the laptop's `EndpointId` is NOT a rung, and the vault has no
per-vault settings table.** W17 handed W19 an exact column, `gateway_endpoint
BLOB` (32 bytes, nullable), "on whatever per-vault settings table W19 lands".
W19 landed `005_the_cut.sql`, which lands none. The candidate is `core_vault`,
and `core_vault` is not that table: it is an ontology entity with a
`core_entity` foreign key, a `row_version`, and a place in **every census a
manifest carries**. A laptop's endpoint id there would be sealed into a base,
shipped to the laptop, counted in a census — and handed back to a RESTORED phone
as if it were a fact about that phone. A restored phone learns its laptop from
the identity record it resolved or the id its member typed, which is a coordinate
it has just proved it can reach; inheriting a dead phone's would be inheriting a
claim. It lives in `backup/laptop.json` beside the vault, which is derived state
like everything else under the backup home (§1, F5). **No rung six.**

**W15-D2 — the vault's seed crosses the C ABI, and this library writes no key
down** (`CONTRACT.md` §4b). Sealing needs `ObjectKeys`, which are derived from
the 24 words at this vault's index. The alternatives were a key file beside the
vault — which is the scrypt-wrapped recovery kit `crates/vault/src/backup/mod.rs`
deleted under §5 with one sentence, "a file that carries keys is a file that can
be copied" — or a core that cannot seal at all. So the seed arrives the way
§4a already says a secret arrives: out of the iOS Keychain or the Android
Keystore, borrowed for the length of `centraid_open` like every other input.
**Absent is a state, not a fault** (the core reads and writes and answers a drain
`ERROR_CODE_PEER_UNREACHABLE` with a sentence naming the seed); **present and
unreadable is `BAD_ARGUMENT`**, because carrying on would leave a shell believing
it had unlocked a core that cannot seal a byte.

### The path, said out loud

The backup home is **`<the vault file's directory>/backup`**, computed by one
expression with one reader, `centraid_core::phone::home_root`, and pinned by
`the_backup_home_is_under_the_vaults_own_directory`. W13's F5 rows 6 and 7 are
the mobile shell's OS-backup exclusion over exactly that directory, so a second
call site that chose another one is a member's sealed vault in somebody's iCloud.
`Handle` now keeps the path it was opened on; `Core::open` took it, used it and
dropped it on a `let _ = &path;`.

### What did NOT land, and where it stands

| Slice | State |
| --- | --- |
| **W15-2 — the drain's upload half** | The seal half is real: `phone::drain` opens the backup home under the vault's directory, runs `backup::capture`, and reports the spool's true pending bytes and the cursor's acked txid. **Nothing uploads.** With no laptop paired it answers `DRAIN_STOP_UNREACHABLE`, which is honest and is what an unpaired phone's drain is — and it is also what a paired one answers today, which is not. `deadline_ms` is read and not yet honoured. |
| **W15-3 — restore from 24 words** | `phone::restore` parses the phrase and refuses a bad checksum before anything is derived, and refuses a typed endpoint that is not 32 bytes; then it answers `PEER_UNREACHABLE`. There is no dial, no discovery, no gap-limited derivation and no fetch. `crates/centraid/tests/restore_drill.rs` is **untouched**: it still drives the gateway as a library and takes its index list as a parameter, which is the seam W16 handed on. |
| **W15-4 — purge and scrub schedule** | Untouched. `gateway-core`'s `purge` (`engine.rs:413`) and `scrub` (`:438`) still have no caller but the CLI verb at `bin/centraid-gateway.rs:182`. |
| **the laptop's "which vaults do I hold"** | Not added. `grep -n 'route(' crates/gateway-server/src/http.rs` is the six routes W17 left; there is no vault-listing endpoint, signed or otherwise. |

### Finds outside this lane's slice

1. **`crates/core/src/handle.rs` documents a module that does not exist.** Its
   `holds_a_replica` doc-comment points a reader at
   `crate::link::SeatNetwork::gateway`, and `crates/core/src/link.rs` was deleted
   with the seat plane (the crate's own `lib.rs` header says so in the same
   breath). `grep -rn 'crate::link' crates/core/src` finds it. Left as found
   rather than fixed inside a contract commit; it is a doc bug and stale docs are
   bugs.
2. **`backup.proto`'s `ObjectDeclaration` still carries `attested_checksum`**
   (field 2, with a nine-line comment about R2 and SigV4), which W17 retired
   everywhere in Rust — `grep -rn 'AttestedChecksum|checksum::' crates` is empty.
   The wire message is the last copy of a protocol somebody else's store needed
   and v0 does not have. Not this lane's to strike, because a `buf breaking`
   judgement belongs with whoever owns the schema rung.
3. **The `ledgers` gate step still cannot run in a worktree**, for the merge-base
   reason W17 named. Re-confirmed, not re-diagnosed.
4. **Nothing in this repository persists a PHONE's device key**, and W15-2 cannot
   be built until something does. `grep -rn 'DeviceKey::' crates --include=*.rs`
   outside `crates/identity` returns four hits and **every one of them is
   `DeviceKey::generate()`** — two in `gateway-client`'s own tests, one in
   `wire_iroh.rs`, one in `restore_drill.rs`. A drain signs with a
   `DeviceSigner`, a signer needs a `DeviceCertificate`, and a certificate names
   a device key at an epoch; a phone that minted a fresh one on every launch
   would need a fresh epoch on every launch, and an epoch bump is what F1 spells
   `VAULT_MOVED`. It cannot be derived from the seed either, because a restored
   phone must be a **new** device at epoch + 1 (F3) and a seed-derived key would
   be the same device. The laptop already has the shape of the answer
   (`serve.rs`'s `NODE_KEY_FILE`, minted once, mode 0600, read back on every
   start); whether a phone's copy belongs there or in the Keychain beside the
   seed (W15-D2) is a third contract decision and is named here rather than
   guessed at inside a lane that ran out of room to record it properly.

### The contradiction W15-2 ran into, and why it was not coded around

The brief's acceptance for the drain is "seal N objects, drain with a deadline
that admits k, assert `acked_txid` matches exactly the acked prefix and the next
drain continues from there". **The shipped commit contract cannot produce that
number**, and the disagreement is not a bug in either half.

A gateway commit is *generation-scoped*: `CommitRequest` carries a `generation`,
the object names, a `manifest_head`, a `prev_head` for the compare-and-set and
**one** `first_txid`/`last_txid` pair (`backup.proto`). A manifest is sealed by
`take_generation` over a base plus the segments above it, and there is no such
thing as committing half of one — the head is the manifest or there is no head.
So within a generation a deadline can leave objects uploaded and uncommitted,
and `acked_txid` does not move at all; it moves in whole generations.

That makes the honest deadline semantics **"a pass commits whole generations; a
deadline stops it between them, and an uploaded-but-uncommitted generation is
re-declared next pass, where write-once makes every re-declare a no-op
(`UploadTarget.already_committed`)"** — which is a different sentence from the
one the brief asked to be asserted, and a materially weaker one for a phone with
a long spool and a 28-second background window. The two ways out are a
generation-per-drain-pass policy (more, smaller bases) or a commit that can
advance a txid watermark without a new manifest head, and the second is a change
to `backup.proto` and to the compare-and-set that F7 turns on. **Neither is a
call to make inside an implementation commit**, so the contradiction is recorded
and the code is not written around it.

### Falsification

The riskiest claim here is **"no sixth symbol, and the four flows really cross
the C ABI"** — because the cheap way to be wrong is a test that calls
`crates/core`'s Rust surface and proves the core works while saying nothing
about the boundary. The throwaway check was to encode each of the four kinds
into an `Envelope`, hand the bytes to `centraid_call` itself and decode what came
back, and it earned its keep immediately: the drain came back as an **error body
rather than a `DrainResponse`**, because the contract test's core is opened
without a seed and §4b had just made that a refusal. That is the clause working,
and it is a case a Rust-surface test with a hand-built `Handle` would have
sailed past. It is now two tests — the four-flow round trip over an unlocked
core, and `a_locked_core_refuses_to_drain_rather_than_inventing_a_key` — and the
symbol count is still `5`.

The second claim, **"`BackupNow` is really gone"**, was checked by its own grep
rather than by reading: `grep -rn 'NotYetAvailable' crates/core/src/handle.rs`
returns two lines and both are prose about what used to be there.

### Verification

| Command | Outcome |
| --- | --- |
| `cargo build --workspace --all-targets` | clean, 0 warnings |
| `cargo test --workspace` | **1,633 passed / 0 failed / 5 ignored** (floor 1,624) |
| `cargo test -p centraid-core-ffi --test contract` | 16 passed (was 14) |
| `grep -rn 'NotYetAvailable' crates/core/src/handle.rs` | 2 hits, both comments; **no arm** |
| `grep -rn 'BackupHome::open' crates --include=*.rs` | 8 hits, one of them `crates/core/src/phone.rs:143` — the core's own call site, not only the drill |
| `grep -c 'pub unsafe extern "C" fn' crates/core-ffi/src/lib.rs` | **5** |
| `cargo xtask gate --profile local --lane fmt` / `--lane clippy` / `--lane rules` | PASS / PASS / PASS |
| `bun run check:push:static` | 4/4 gates passed in 4.4s |
