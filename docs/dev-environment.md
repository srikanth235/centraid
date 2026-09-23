# Dev environment (G1)

Stand up Centraid development without tribal knowledge. **Do not invent a new manifest format** — promote `.claude/launch.json` when present; otherwise use the patterns below ([decisions.md](decisions.md)).

## Prerequisites

- Rust at the channel pinned in `rust-toolchain.toml` (rustup reads it; [`flake.nix`](../flake.nix)'s dev shell reads it through `rust-overlay`)
- [Bun](https://bun.sh) matching root `packageManager` (pinned in `package.json`) — for `packages/design`, `packages/test-kit` and the repo tooling scripts
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
| **gateway** | `cargo run -p centraid-gateway-server --bin centraid-gateway -- serve --data-dir <dir>` | The laptop's blind store. Headless, iroh by default, and it prints its `endpoint` line on every start. `centraid-gateway invite --data-dir <dir>` mints a one-shot invite and prints a pairing QR; `invites` lists what became of each ([gateway.md](gateway.md)) |
| **demo data** | `cargo run -p centraid --bin seed-demo-vault -- <data-dir>/vault/<id> --file vault.db --name <name>` | Writes rows through the real command plane into a gateway's vault ([mobile/README.md](../mobile/README.md#seeing-it-with-real-data-pair-with-a-gateway)); `mobile/scripts/demo-vault.sh` wraps it for the emulator and simulator |
| **mobile (JVM)** | `cd mobile && ./gradlew mobileJvm` | `:shared:jvmTest`, `:core:jvmTest` over the real `centraid-core-ffi` cdylib, and the kover report — the gate's `mobile-jvm` step |
| **mobile (Android)** | `cd mobile && ./gradlew -Pcentraid.android=true :androidApp:assembleDebug` | Needs `ANDROID_HOME`; `mobile/scripts/android-core.sh` cross-compiles the core into `jniLibs` first |
| **mobile (iOS)** | the numbered steps in [mobile/README.md](../mobile/README.md#the-ios-hand-off) | Rust slice → `:shared:assembleCentraidSharedDebugXCFramework` → `protoc` → `xcodegen generate` → `xcodebuild … test` on a simulator (**not** `swift test`, which cannot build `Sources/`'s UIKit imports for the macOS host). Skipping the first two links stale code with no error ([traps/stale-core-slice.md](traps/stale-core-slice.md)) |
| **mobile flows** | `maestro test mobile/maestro/flows` | Needs a running simulator or emulator with the app installed |
| **service unit** | `centraid-gateway install --data-dir <dir>` (or `centraid gateway install`) | Writes a launchd or systemd unit and prints the enable command; never enables it ([deploy/README.md](../deploy/README.md)) |
| **docs site** | `bun run docs:build` then `bun run docs:serve` | **4173** on 127.0.0.1 |

Every verb logs through `tracing` to stderr, filtered by `--log` / `CENTRAID_LOG` — where those lines end up per host is [logs.md](logs.md).

Do not point two processes at one vault directory: the core holds the one writable connection and the whole pragma set depends on being the only opener ([traps/wal-checkpoint.md](traps/wal-checkpoint.md)). Two `centraid-gateway` processes over one data directory is fine and expected — `serve` and `invite` share it through the state file.

## Worktrees

Agents often work in git worktrees (including under `.claude/worktrees/`).

1. **Install** — each worktree needs its own `bun install` (do not assume root `node_modules` is visible unless you deliberately symlink — prefer install).
2. **One `CARGO_TARGET_DIR` per worktree** — sharing one is not only lock contention. A build script's `OUT_DIR` is keyed by package identity, which is the same in every worktree, so a lane that edits a `.proto` hands its generated Rust to every other lane; and a gate verdict taken from a shared directory is worth nothing. Export `CARGO_TARGET_DIR=<something unique>` and `touch crates/api-proto/build.rs` before the first build in a fresh one ([traps/shared-cargo-target.md](traps/shared-cargo-target.md)).
3. **Do not share** writable `--data-dir` trees across concurrent agents, and give each worktree its own `CARGO_TARGET_DIR` ([traps/shared-cargo-target.md](traps/shared-cargo-target.md)).
4. **Seed data** — use a dedicated `--data-dir` and `seed-demo-vault` rather than copying a live vault (see [traps/wal-checkpoint.md](traps/wal-checkpoint.md)).

More traps: [traps/worktrees.md](traps/worktrees.md). Multi-agent rules: [multi-agent.md](multi-agent.md).

### Receipts are append-only, and sibling appends merge by union

One issue carries one receipt (`receipts/issue-<N>-<slug>.md`), and a slice adds exactly one section at the **end** of it: `doc-integrity` requires the trunk's copy to stay a byte-prefix of yours. Two sibling slices appending to the same receipt therefore conflict on every rebase, always with the same correct resolution — keep both hunks, upstream first. The root `.gitattributes` marks `receipts/*.md merge=union`, and git's built-in union driver concatenates a conflicting hunk ours-then-theirs; during a `git rebase` onto `main` "ours" is `main`, so main's section lands first and the prefix survives. Check the seam afterwards: union factors out the blank line both sides share, so the second section may need one blank line reinserted before its heading — still an append, still prefix-safe.

Two things the driver does not do. It cannot tell an append from an edit — it resolves _any_ conflicting hunk the same way — so the rule it does not replace still stands: never touch text above your own section, and `doc-integrity` still fails you if you do. And GitHub's own PR mergeability check does not honour `.gitattributes` merge drivers, so this helps local rebases only. Rebase, do not merge: `git merge` resolves union with the **checked-out** branch first, so merging `main` into a slice branch would put your section above main's and break the byte-prefix.

## `.claude/launch.json`

If a local `.claude/launch.json` exists (may be gitignored), treat it as the **named service list** for launch integrations (ports, cwd, commands). Keep it in sync when you add a long-lived dev process. If absent, the table above is the source of truth until someone adds the file.

## The local gate loop

One command gates the tree ([#1020](https://github.com/srikanth235/centraid/issues/1020)): `cargo xtask gate --profile <local|pr|nightly|release|mobile-jvm>`. The profiles, their steps and their budgets are in [toolchain.md](toolchain.md#cargo-xtask-gate-1020) and [`crates/xtask/README.md`](../crates/xtask/README.md); this section is the loop.

| When | What runs | Where |
| --- | --- | --- |
| after an edit | `cargo xtask gate --profile local` — `fmt`, `clippy`, `test` (workspace minus `centraid-sim`), `rules`, `ledgers`. Budget 120 s on a warm tree | by hand |
| a narrower answer | `cargo test -p <crate>`, `cargo xtask rules`, `SIM_SEED=<n> cargo test -p centraid-sim` to replay one simulation seed | by hand |
| commit | the pre-commit hook | `.githooks/pre-commit` |
| push | the pre-push hook | `.githooks/pre-push` |
| want CI's answer early | `cargo xtask gate --profile pr` — `local` plus supply chain, CI policy, secrets, release build, the TypeScript static tier, emitters, the call budget and the fault door | [`gate.yml`](../.github/workflows/gate.yml), required on every pull request and push to `main`, beside `dependency-review` |
| Kotlin changed | `cargo xtask gate --profile mobile-jvm` — builds `centraid-core-ffi`, runs `./gradlew mobileJvm`, regenerates the native theme and screen fixtures and fails on drift. Budget 420 s | [`gate-nightly.yml`](../.github/workflows/gate-nightly.yml) |
| nightly | `cargo xtask gate --profile nightly` — `pr` plus `device-lanes` and the deeper suites. One lane alone: `--lane <name>` | [`gate-nightly.yml`](../.github/workflows/gate-nightly.yml), 05:30 UTC |
| release | `cargo xtask gate --profile release` — `nightly` plus `restore-drill`, `artifact-identity`, `prebuilt-core-required`, `vps-smoke` | [`release.yml`](../.github/workflows/release.yml)'s lanes |

A failing step writes its command, stdout and stderr under `target/xtask/<profile>/<step>/` and names that directory on its one line. **Every cargo and xtask command needs its own `CARGO_TARGET_DIR`** when more than one worktree is in flight — see the worktree rules above.

**The hooks.** `.githooks/*` are governance-kit dispatchers: each runs the directives under `.governance/packs/` whose `hook:` field names that hook.

- **pre-commit** runs `scripts/test.sh` (path-gated to commits that stage shell or governance files), then the nine pre-commit directives — among them `format-check` and `lint-check`, which run `oxfmt` and `oxlint` on **staged files only**, and `law`, which runs the ESLint rule catalog under [`.governance/law/`](../.governance/law/README.md) at its hook door ([#1005](https://github.com/srikanth235/centraid/issues/1005)).
- **pre-push** runs the `pre-push-gate` directive. The tier is chosen by the destination ([#988](https://github.com/srikanth235/centraid/issues/988)): a push to `main` runs `bun run check:push`, every other ref runs `bun run check:push:static`, and `CENTRAID_PUSH_TIER=full` widens a branch push to the `main` tier. Both are gate lists in the root `package.json`, run concurrently by `scripts/ci/run-gates.mjs`, with every failure reported in one pass. `check:push:static` is also what the gate's `ts-static` step runs.
- **commit-msg** carries the `law` directive's message checks; **post-commit** can only warn.

Staged-files-only is on purpose: a repo-wide gate at commit time fires on debt in files you never opened, and a gate that fires for someone else's mess is one people learn to bypass.

**Format before you commit.** `bun run format` writes oxfmt's output over the tree; `cargo fmt --all` does the same for Rust. Neither hook rewrites a tracked file.

**A tier does not re-run against a tree it already passed.** `scripts/ci/gate-stamp.mjs` keys a pass on the oid of a git tree built from the working copy in a _copy_ of the index, plus `origin/main`. `check:push --stamp` skips the static members on a match, and `bun run governance` — the stamped entry point to the digest-locked `.governance/run.sh` — takes the same treatment. A tier is stamped only when every one of its gates ran and passed; `CI` in the environment disables stamps outright; `CENTRAID_GATE_STAMPS=0` turns them off. Every root script that runs turbo goes through `scripts/ci/turbo.mjs`, which points it at one cache shared by every worktree. Both live outside the repository ([toolchain.md](toolchain.md#where-the-caches-live)).

**Governance.** `law` generates the change set into `.governance/law/out/arrival.json` and lints it together with the governance documents the change touched. At pre-commit it opens the **hook door** — the rules answerable from the commit being written, all fatal there; everywhere else (`bash .governance/run.sh`, `bun run governance:law`, [`governance.yml`](../.github/workflows/governance.yml)) the **window door** runs the whole catalog at each rule's declared severity. `estate-separation` refuses a commit that edits the law estate and the territory estate together (waive with `governance: allow-estate-separation <reason>` in the commit body); `registry-completeness` asks for the changelog line, the `docs/decisions.md` ruling, the gate authorisation or the docket row a change's own events call for. [CONSTITUTION.md](../CONSTITUTION.md#estate-separation) carries both directives and [docs/decisions.md](decisions.md#governance-as-a-constitution-1005) the rulings behind them.

`.github/CODEOWNERS` is generated, not hand-kept:

```bash
node .governance/law/codeowners.mjs --check   # exit 1 on drift
node .governance/law/codeowners.mjs --write   # regenerate from the packs' lawPaths
```

What the **host** would enforce — branch protection requiring code-owner review on the default branch, and `gate`, `dependency-review` and `governance` in the required set — is configured outside this repository and is the owner's to enable. It is **not confirmed enabled**; the rules observe and report either way.

**`governance.yml` cannot be given a `timeout-minutes` by hand.** It is listed in `.governance/install.yaml`'s `managed_digests`, so `managed-tree-integrity` fails on any edit to it, and `scripts/lint-workflow-pins.mjs` skips any file whose first lines carry `# governance-kit:managed`. The supported path to a timeout is a kit update.

### Escape hatches

```sh
SKIP_CHECK_PR=1 git push     # skip the pre-push gate only
SKIP_GOVERNANCE=1 git push   # skip every governance hook
git push --no-verify         # skip all hooks entirely
```

All three are legitimate for a WIP branch or a spike, and all three leave CI as the enforcing copy. A gate with no exit is a gate people disable permanently.

### What deliberately does not run locally

`deny` without `cargo-deny` installed, `ci-policy` without `actionlint`, `secrets` without `gitleaks`, `osv` without `osv-scanner`, and `buf` without `buf` — each prints a loud `SKIP` naming what turns it into a real run, and each is required in CI. `device-lanes` need attached devices and run only on the self-hosted runner.

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
