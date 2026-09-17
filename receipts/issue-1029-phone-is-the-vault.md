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
