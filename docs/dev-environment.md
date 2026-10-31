# Dev environment (G1)

Stand up Centraid development without tribal knowledge. **Do not invent a new manifest format** — promote `.claude/launch.json` when present; otherwise use the patterns below ([decisions.md](decisions.md)).

## Prerequisites

- Rust at the channel pinned in `rust-toolchain.toml` (rustup reads it)
- [Bun](https://bun.sh) matching root `packageManager` (pinned in `package.json`) — for `packages/design` and the repo tooling scripts
- Node 24.4.1 — `.node-version` and `package.json#engines.node` must agree, and CI runs exactly this version. Locally a different Node only **warns** (#668); match it with `nvm use` if you hit a toolchain difference
- For mobile: a JDK for the committed Gradle wrapper (`mobile/gradlew`); the Android SDK for `:androidApp`; Xcode at `.xcode-version` plus `xcodegen` for the iOS shell ([mobile/README.md](../mobile/README.md#the-toolchain))

## Fresh clone

```sh
git clone <repo-url> centraid && cd centraid
git config core.hooksPath .githooks   # once per clone
bun install
cargo build --workspace               # the core, the gateway and the two CLI binaries
```

`CLAUDE.md` is a symlink to `AGENTS.md` (`ln -sf AGENTS.md CLAUDE.md`), so every agent CLI reads one manual with no sync burden. Restore the symlink if a tool ever replaces it with a copy.

## Dev loops

| Name | Command | Notes |
| --- | --- | --- |
| **gateway** | `cargo run -p centraid-gateway --bin centraid-gateway -- serve --data-dir <dir>` | A blind store for the phone's backup. Headless; it listens on 8443, advertises itself on the LAN, prints its `gateway`, `pin` and `listening` lines on every start and — until a phone pairs — a pairing QR. `centraid-gateway pair --data-dir <dir>` prints another QR; `pairings` lists what paired ([gateway.md](gateway.md)) |
| **demo data** | `mobile/scripts/demo-vault.sh [ios\|android]` | Runs `seed-demo-vault` twice through the real command plane, places `demo-vault.sqlite3` and `work-vault.sqlite3` in the running simulator's or emulator's vault directory as `demo-vault/vault.db` and `work-vault/vault.db` (one directory per vault), and relaunches the **debug** app with the demo seed so both open keyed and the demo Locker unlocks and reveals ([mobile/README.md](../mobile/README.md#the-demo-vault-opens-keyed)). The seeder prints `CENTRAID_DEMO_WORDS` (the public all-`abandon` BIP-39 words) and `CENTRAID_DEMO_SEED` (their seed, hex) |
| **mobile (JVM)** | `cd mobile && ./gradlew mobileJvm` | `:core:jvmTest` over the real `centraid-core-ffi` cdylib — the gate's `mobile-jvm` step |
| **mobile (Android)** | `cd mobile && ./gradlew -Pcentraid.android=true :androidApp:assembleDebug` | Needs `ANDROID_HOME`; `mobile/scripts/android-core.sh` cross-compiles the core into `jniLibs` first |
| **mobile (iOS)** | the numbered steps in [mobile/README.md](../mobile/README.md#the-ios-hand-off) | Rust slice (`mobile/scripts/ios-core.sh`, which the app links by path) → `xcodegen generate` (which also generates the Swift protobuf types, and needs `brew install protobuf swift-protobuf`; Xcode regenerates them when a `.proto` changes) → `xcodebuild … test` on a simulator (there is no `swift test`: `Sources/` imports UIKit, which the macOS host does not have). Skipping the first links stale code with no error ([traps/stale-core-slice.md](traps/stale-core-slice.md)) |
| **mobile flows** | `maestro test mobile/maestro/flows` | Needs a running simulator or emulator with the app installed |
| **service unit** | `centraid-gateway install --data-dir <dir>` (or `centraid gateway install`) | Writes a launchd or systemd unit and prints the enable command; never enables it ([deploy/README.md](../deploy/README.md)) |
| **docs site** | `bun run docs:build` then `bun run docs:serve` | **4173** on 127.0.0.1 |

Every verb logs through `tracing` to stderr, filtered by `--log` / `CENTRAID_LOG` — where those lines end up per host is [logs.md](logs.md).

Do not point two processes at one vault directory: the core holds the one writable connection and the whole pragma set depends on being the only opener ([traps/wal-checkpoint.md](traps/wal-checkpoint.md)). Two `centraid-gateway` processes over one data directory is fine and expected — `serve` and `pair` share it through `state.db` — but never two `serve`s.

## Worktrees

Agents often work in git worktrees (including under `.claude/worktrees/`).

1. **Install** — each worktree needs its own `bun install` (do not assume root `node_modules` is visible unless you deliberately symlink — prefer install).
2. **One `CARGO_TARGET_DIR` per worktree** — sharing one is not only lock contention. A build script's `OUT_DIR` is keyed by package identity, which is the same in every worktree, so a lane that edits a `.proto` hands its generated Rust to every other lane; and a gate verdict taken from a shared directory is worth nothing. Export `CARGO_TARGET_DIR=<something unique>` and `touch crates/api-proto/build.rs` before the first build in a fresh one ([traps/shared-cargo-target.md](traps/shared-cargo-target.md)).
3. **Do not share** writable `--data-dir` trees across concurrent agents, and give each worktree its own `CARGO_TARGET_DIR` ([traps/shared-cargo-target.md](traps/shared-cargo-target.md)).
4. **Seed data** — use a dedicated `--data-dir` and `seed-demo-vault` rather than copying a live vault (see [traps/wal-checkpoint.md](traps/wal-checkpoint.md)).

More traps: [traps/worktrees.md](traps/worktrees.md). Multi-agent rules: [multi-agent.md](multi-agent.md).

### Receipts are append-only, and sibling appends merge by union

One issue carries one receipt (`receipts/issue-<N>-<slug>.md`), and a slice adds exactly one section at the **end** of it, so the trunk's copy stays a byte-prefix of yours. Two sibling slices appending to the same receipt therefore conflict on every rebase, always with the same correct resolution — keep both hunks, upstream first. The root `.gitattributes` marks `receipts/*.md merge=union`, and git's built-in union driver concatenates a conflicting hunk ours-then-theirs; during a `git rebase` onto `main` "ours" is `main`, so main's section lands first and the prefix survives. Check the seam afterwards: union factors out the blank line both sides share, so the second section may need one blank line reinserted before its heading — still an append, still prefix-safe.

Two things the driver does not do. It cannot tell an append from an edit — it resolves _any_ conflicting hunk the same way — so the rule it does not replace still stands: never touch text above your own section. And GitHub's own PR mergeability check does not honour `.gitattributes` merge drivers, so this helps local rebases only. Rebase, do not merge: `git merge` resolves union with the **checked-out** branch first, so merging `main` into a slice branch would put your section above main's and break the byte-prefix.

## `.claude/launch.json`

If a local `.claude/launch.json` exists (may be gitignored), treat it as the **named service list** for launch integrations (ports, cwd, commands). Keep it in sync when you add a long-lived dev process. If absent, the table above is the source of truth until someone adds the file.

## The local gate loop

One command gates the tree ([#1020](https://github.com/srikanth235/centraid/issues/1020)): `cargo xtask gate --profile <local|pr|nightly|release|mobile-jvm>`. The profiles, their steps and their budgets are in [toolchain.md](toolchain.md#cargo-xtask-gate-1020) and [`crates/xtask/README.md`](../crates/xtask/README.md); this section is the loop: the pre-commit hook on each commit, `bun run check` and `cargo xtask gate --profile local` before a push, and [`gate.yml`](../.github/workflows/gate.yml) on the pull request.

| When | What runs | Where |
| --- | --- | --- |
| commit | `.githooks/pre-commit` — `oxfmt --check` and `oxlint` over the **staged** files; `.githooks/commit-msg` — the subject shape | the hooks |
| after an edit | `cargo xtask gate --profile local` — `fmt`, `clippy`, `test` (**the crates the change touches and the crates that depend on them**, not the workspace), `restore-drill`, `rules`, `doc-links`, `ledgers`. Budget 120 s on a warm tree | by hand |
| TypeScript changed | `bun run check` — `format:check`, `lint`, `typecheck`, `test`, `scripts:test`; the `pr` profile's `ts-static` step | by hand |
| which crates `test` would run | `cargo xtask test-plan` (add `--reads` for the table of files each crate reads from outside its own directory) — prints the selection and why, and runs nothing | by hand |
| a narrower answer | `cargo test -p <crate>`, `cargo xtask rules`, `cargo xtask doc-links`, `cargo xtask gate --profile local --lane restore-drill` for the drill alone | by hand |
| want CI's answer early | `cargo xtask gate --profile pr` — `local` plus supply chain, CI policy, secrets, release build, `bun run check`, emitters, the call budget, the search budget (a release build of the year-3 search vault) and the fault door | [`gate.yml`](../.github/workflows/gate.yml)'s `gate` job, on every pull request and push to `main` |
| the on-device engine (`crates/assist-llama`, or `crates/core-ffi` with llama.cpp) changed | `cargo clippy -p centraid-assist-llama -p centraid-core-ffi --all-targets --features centraid-core-ffi/llama -- -D warnings`, then `cargo test` over the same packages and feature — the `engine` job's two commands; `cmake` and a C++ compiler required, about five minutes of llama.cpp cold. `cargo xtask gate` compiles none of it | [`gate.yml`](../.github/workflows/gate.yml)'s `engine` job |
| `mobile/core` changed | `cargo xtask gate --profile mobile-jvm` — builds `centraid-core-ffi`, runs `./gradlew mobileJvm`, regenerates the native theme and screen fixtures and fails on drift. Budget 420 s | [`nightly.yml`](../.github/workflows/nightly.yml) |
| nightly | `cargo xtask gate --profile nightly` — `pr` plus `device-lanes`, which skip loudly without `CENTRAID_DEVICE_RUNNER`. On a machine with devices attached: `CENTRAID_DEVICE_RUNNER=1 cargo xtask gate --profile nightly --lane <name>` | [`nightly.yml`](../.github/workflows/nightly.yml), 05:30 UTC |
| release | `cargo xtask gate --profile release` — `nightly` plus `artifact-identity` and `prebuilt-core-required` | [`release.yml`](../.github/workflows/release.yml)'s lanes |

**`local` tests what the change touches** (hand-off 6.5, [v1-handoffs.md](release/v1-handoffs.md#6-ci-branch-protection-and-the-inherited-reds)). The files that differ from the merge base with `origin/main` (committed, staged, unstaged and untracked) select the crates they sit in, the crates whose sources read them from outside their own directory (`contracts/`, `copy/`, `design/`, a Swift file the assistant embeds — derived from the sources, not listed), and every crate that depends on either. A documentation edit selects none. The root `Cargo.toml` and `Cargo.lock`, the toolchain pin, `.cargo/`, any crate manifest, `crates/xtask`'s code, or no base at all runs the whole workspace. The step says which, loudly: a banner naming each crate and why, a `NARROWED to N of M crates` prefix on its evidence line, and `target/xtask/local/test/selection.txt`. The narrowing is a nextest filter over `--workspace`, not `-p`, so it builds under the feature set `clippy` and `restore-drill` already built; without `cargo-nextest` the step runs the whole workspace and says why. It is **not** `pr`: CI runs every crate on every pull request, which is where a read the derivation missed is caught. **An edit that reaches `centraid-core` — any app crate, and everything beneath them — still runs its 369-test suite (about three minutes), so the 120 s budget holds for documentation and for the four crates outside core's cone and not for the rest;** the numbers and the owner's options are hand-off 6.5. `CENTRAID_GATE_TESTS=all` widens a local run to the whole workspace; `CENTRAID_GATE_BASE=<commit or tree>` names a different base, which is how a stacked branch is compared against its parent.

A failing step writes its command, stdout and stderr under `target/xtask/<profile>/<step>/` and names that directory on its one line. **Every cargo and xtask command needs its own `CARGO_TARGET_DIR`** when more than one worktree is in flight — see the worktree rules above.

**The hooks.** There are two, enabled once per clone with `git config core.hooksPath .githooks`:

- **pre-commit** runs `oxfmt --check` and `oxlint --deny-warnings` with the root configs over the **staged** files only. It rewrites nothing; fix with `bun run format` and `bun run lint:fix`. Without `bun install` it prints a notice and passes.
- **commit-msg** requires the subject `type(scope)!: subject (#N)` — a Conventional Commits type (`feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`, `revert`, `style`), an optional scope and `!`, and the issue the change answers to — in at most 100 characters. Merge, revert, `fixup!`, `squash!` and `amend!` subjects pass. A squash merge's subject is the PR title, so `gate.yml`'s `pr-title` job runs the same file over the title.

Staged-files-only is on purpose: a repo-wide check at commit time fires on debt in files you never opened, and a check that fires for someone else's mess is one people learn to bypass. There is no push hook: `bun run check` and the `local` profile are run by hand, and CI runs the whole tree.

**Format before you commit.** `bun run format` writes oxfmt's output over the tree; `cargo fmt --all` does the same for Rust. Neither hook rewrites a tracked file.

`.github/CODEOWNERS` names the owner of the CI surface: `/.github/`, `/.githooks/` and `/crates/xtask/`. What the **host** would enforce — branch protection requiring code-owner review on the default branch, and `gate`, `engine`, `native-python`, `dependency-review` and `pr-title` in the required set — is configured outside this repository and is the owner's to enable ([v1-handoffs.md](release/v1-handoffs.md#6-ci-branch-protection-and-the-inherited-reds)).

**Skipping the hooks.** `git commit --no-verify` skips both. It is legitimate for a WIP branch or a spike; CI is the enforcing copy either way.

### What deliberately does not run locally

`deny` without `cargo-deny` installed, `ci-policy` without `actionlint`, `secrets` without `gitleaks`, `osv` without `osv-scanner`, and `buf` without `buf` — each prints a loud `SKIP` naming what turns it into a real run, and each is required in CI. `device-lanes` need attached devices and `CENTRAID_DEVICE_RUNNER=1`.

## Tools only via repo scripts

Never raw `npx vitest`, `npx tsc`, etc. Use:

```sh
cargo xtask gate --profile local
cargo test -p <crate>
bun run format
bun run typecheck
```

Pinned toolchains live in `rust-toolchain.toml`, `mobile/gradle/libs.versions.toml` and the root `package.json`. The complete ownership and command contract is [toolchain.md](toolchain.md).

## Related

- [multi-agent.md](multi-agent.md)
- [logs.md](logs.md)
- [README.md](../README.md)
