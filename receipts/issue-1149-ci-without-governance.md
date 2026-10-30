# Issue #1149 — Retire `.governance` and cut CI down to the native-app product

[#1149](https://github.com/srikanth235/centraid/issues/1149). The owner asked for a thorough audit of every CI surface: hooks, the PR gate and the post-merge lanes. Those surfaces predate the pivot to native apps ([#1029](https://github.com/srikanth235/centraid/issues/1029)), and the owner chose to delete `.governance` outright, keep two small hooks and cut the v0 tooling aggressively. They also asked for `centraid-city/` to go.

## Audit findings

What was broken or dead before this change:

| Surface | Finding |
| --- | --- |
| `pre-push` on `main` | `check:push` called `test:claims` and `test:report:smoke`, whose scripts were deleted, so every push to `main` with the hook installed failed. |
| `package.json` | 23 of 103 scripts pointed at files that no longer exist. Most of the rest served the retired TS/web product. |
| `.github/actions/setup` | The `v1` Cargo preset ran `actions/cache/save` inside the composite action, immediately after the restore and **before any build**. On a cache miss on `main` it saved an empty `target/`, and every later run then hit that exact key, so `target/` was never actually cached. |
| Candidate pointer | `gate-nightly.yml`'s `promote-candidate` ran `scripts/ci/write-candidate.mjs`, which only writes `artifacts/candidate.json`. `refs/candidates/latest` did not exist on the remote (`git ls-remote origin 'refs/candidates/*'` was empty), so `release.yml`'s `require-candidate` failed every tag. |
| TypeScript tests | No CI lane ran `packages/design` or `packages/test-kit` vitest, or the release scripts' tests. Run here for the first time: `icons-contract.test.ts` was red (Notes' rename row names icon `Edit`, which does not exist), and 5 release-script tests were red (they still expected the deleted desktop/companion surfaces). |
| Governance | `law` and six directives, ~38k lines including lockfiles. `no-hardcoded-model-ids` scanned `packages/` and `apps/` for TS model ids, and nothing there uses one. `coverage-scope-reachability` guarded two packages' coverage floors. The rest policed process: estates, docket, amendment pairing, doctrine citation, registry completeness. |
| Product lints | `lint:product` bundled 26 lints and ran only post-merge (`candidate.yml`) and in the broken `check:push`. Three of the lints with a live subject were red on `main`: `lint-copy` (a 15-word Locker note against a 12-word cap), `lint-native-controls` (`ProofScreen.kt` drew two raw Material `Button`s) and `lint-journey-ledger` (two `tests/journeys.json` rows named consumers that are gone). |
| Workflows | `candidate.yml` (CodeQL plus evidence rows, rolling issues, lane-health scoring), `hygiene.yml` (seven test-suite ratchets over v0 trees), `sonarcloud.yml` (a configurator), `cache-cleanup.yml` (needed only because PRs saved caches), `toolchain-upgrade.yml`. `gate-nightly.yml` carried a device-lanes job gated on a runner that does not exist and a `flake` job that grepped one file. Every job ran `harden-runner` in `audit` mode, which enforced nothing. |

## What changed

- **Governance deleted.** `.governance/`, `CONSTITUTION.md`, `.github/workflows/governance.yml`, the law-only `tests/` ledgers (`budgets`, `claims`, `floors`, `inventory`, `quarantine`, `diff-coverage-deviation`, `path-filter-ledger`) and `contracts/ledgers/advisory.json`. `.github/CODEOWNERS` is now hand-written over `.github/`, `.githooks/` and `crates/xtask/`.
- **Hooks.** `.githooks/pre-commit` runs oxfmt `--check` and oxlint over the staged files. `.githooks/commit-msg` requires `type(scope)!: subject (#N)` of at most 100 characters. `post-commit`, `prepare-commit-msg` and `pre-push` are deleted.
- **Workflows**, 15 down to 7:
  - `gate.yml` has the jobs `gate`, `engine`, `native-python`, `dependency-review` and the new `pr-title`, which runs `.githooks/commit-msg` over the squash subject. The prebuilt core moved from push-to-main into `nightly.yml`.
  - `nightly.yml` (formerly `gate-nightly.yml`) runs `gate`, `mobile-jvm` and `prebuilt-core`. When all three are green it `git push`es `refs/candidates/latest`.
  - `codeql.yml` replaces `candidate.yml`'s CodeQL job.
  - `release.yml` checks the tag against the pointer alone; the gh-pages history checkout is gone.
  - `lane-prebuilt-core.yml` dropped its `probe` job.
  - `harden-runner`, `dtolnay/rust-toolchain` and the seven copies of the channel-parsing step are gone.
- **Setup action.** Rust is installed by `rustup toolchain install` from `rust-toolchain.toml`. The Cargo cache is `Swatinem/rust-cache@v2.9.1` (pinned SHA) with `save-if: main`, saved in its post step after the build.
- **`cargo xtask gate`:**
  - `ci-policy` is `ci::action_pins` (a Rust SHA-pin check over `.github/**`, with cases) plus actionlint.
  - The `advisory` step and the evidence row are deleted.
  - `ts-static` runs `bun run check`.
  - `doc-links` skips `receipts/*.md` and `QUALITY.md` § Resolved directly, instead of reading the deleted pack row.
  - The repo-root marker is `rust-toolchain.toml` + `Cargo.toml`.
- **`package.json`** is down to 23 scripts. `check` = format:check, lint, typecheck, test and scripts:test. turbo, knip, sherif, stryker, oxlint-tsgolint, playwright, pngjs, `@google/design.md` and `@vitest/coverage-v8` are dropped. `turbo.json`, `knip.json`, the root `vitest.config.ts`, `vitest.diff-coverage.config.ts` and `packages/design`'s stryker files are deleted.
- **`scripts/`** keeps only:
  - `docs-site/` and `home-site/`;
  - `site-tokens.mjs`, minus the nightly-report surface;
  - `install-gateway.*`;
  - `release/`, minus the nightly-quality blocker;
  - `ci/osv-lockfile-scan.mjs`;
  - the three product lints whose subject is live: `lint-copy` (screen strings vs DESIGN.md Copy), `lint-native-controls` (no raw platform controls outside the kit) and `lint-journey-ledger`.

  `bun run check` runs those three, plus `lint:site-tokens`, as `lint:product`. The web-element lints over `packages/design/src/elements` (aria labels, container opacity, motion, design tokens) passed but were not kept, and `lint-test-reachability` goes with the runner configs it modelled. `oxlint.config.ts` exempts `packages/design/src/roles.ts` from `max-lines` inline, its one oversized file.
- **`centraid-city/`** is deleted, along with its `/city` mount in `scripts/docs-site/assemble.mjs`.
- **Fixed in passing:**
  - Notes' rename row asks for `Pencil` on both shells.
  - Locker's "Use" note reads "Each item's last use, and failed unlocks. Nothing else is logged." (11 words).
  - `ProofScreen.kt` draws the kit's `OutlineButton`.
  - `tests/journeys.json` drops the v0 `gateway/own-echo/none` row and repoints `year3-tasks` at `crates/apps/agenda/tests/task_year3.rs`.
  - The release-script tests now expect the three current surfaces.
  - `release:prepare` runs `cargo xtask gate --profile pr`.
  - Dependabot groups the lint/format pins instead of ignoring them.
- **Docs.** `docs/decisions.md` adds [R-1149-1..3](../docs/decisions.md#ci-without-governance-1149) and the list of rulings they supersede. `crates/xtask/README.md`, AGENTS.md and the docs that named the deleted surfaces are updated.

## Decisions

- **R-1149-1..3**, recorded in [docs/decisions.md](../docs/decisions.md#ci-without-governance-1149): no governance layer; seven workflows with five required `gate` jobs; `cargo xtask gate` is the one entrypoint, with `bun run check` as its TypeScript half.
- **Owner hand-off.** Branch protection's required checks must become `gate`, `engine`, `native-python`, `dependency-review` and `pr-title`, and the `Governance` check must be removed. Until then a required `Governance` check never reports and blocks every PR.
- **Not done.** `G-supply-chain` asks for a verified checksum on every downloaded tool. Only nextest has one; actionlint, gitleaks, osv-scanner and buf are still fetched by version alone, as they were before.

## Verification

```text
bun run check                                   # ok — format, lint, lint:product, typecheck, 402 + 22 vitest, 49 release vitest + 43 node:test
cargo test -p xtask                             # ok — 134 + 2 passed
cargo clippy -p xtask --all-targets -D warnings # ok
cargo fmt --all --check                         # ok
actionlint                                      # ok, no findings over the 7 workflows
cargo run -p xtask -- doc-links                 # see the gate run below
bash .githooks/commit-msg <subject>             # accepts "ci: …(#1149)", "feat(vault)!: …(#12)", merges; rejects no type, no (#N), (#0)
```

The full `cargo xtask gate --profile pr` run is recorded below.
