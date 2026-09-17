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
