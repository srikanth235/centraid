# issue-892 — tighten the PR gate loop

Umbrella worked by root-agent orchestration per [docs/multi-agent.md](../docs/multi-agent.md): one issue, one receipt, no child issues. The slices below are the issue's own phases, sequenced as it prescribes — Phase 0 before 1, the turbo-cache diagnosis before any lane restructuring, the merge-queue evaluation decided before the mutation-pr restructure.

## Checklist

### Phase 0 — stop the bleeding

- [x] Green `mobile-device-gate`: root-cause the 17m38s-vs-12-min overrun; either fix the slow path or re-derive the budget from `ledger/durations.json` once three real runs exist
- [x] Fix the stale-JS apk cache key: fold a JS-bundle-input hash into `android-release--` across `ci.yml`, `mobile-canary.yml`, `e2e.yml`, and `android-emulator-install.sh`
- [x] Diagnose the turbo remote-cache miss

### Phase 1 — reclaim minutes

- [x] Split `verify`: uninstrumented pass/fail suite ∥ coverage+report job
- [x] Parallelize the coverage job itself, fail-closed on the merge
- [x] Fold `client-e2e / boot-smoke` into a lane that already built
- [x] Trim `mobile-smoke`: drop `ci:android-native`
- [x] Restructure `mutation-pr`: full-seed runs move to the per-merge canary tier; remove `package.json`/`bun.lock` from `MUTATION_GLOBAL_WATCH`
- [x] Stop reinstalling the iroh-wasm toolchain per run

### Phase 2 — reinvest in the unowned promises

- [x] Wire `tests/agent-e2e-compat` into a scheduled lane, with `CENTRAID_UPGRADE_PREV_INSTALLER` sourced from the latest release artifact
- [x] Golden-vault gate on the PR loop
- [x] N−1 binary skew (nightly)
- [x] Widen mutation seeds to `apps/mobile/src/lib/upload/` and `apps/mobile/src/lib/replica/`
- [x] Replica convergence property test on the PR loop
- [x] AuthZ deny-matrix generated from the route table
- [x] PWA offline journey in `client-e2e / web-e2e`: `context.setOffline(true)`
- [x] Runtime accessibility scan (axe) riding the Playwright lanes already paid for

### Phase 3 — meta-hardening

- [x] Evaluate a GitHub merge queue
- [x] Path-filter inverse lint
- [x] Pin the Maestro install by version + checksum-verified artifact
- [x] Per-lane first-attempt pass-rate in the test-health report
- [x] Invariant sweep (`vault doctor`) at the end of every e2e/integration harness run
- [x] Chronic-red rule
- [x] Give advisory outputs an expiry or budget
- [x] Verify `governance.yml` has its own branch-protection entry
- [x] Remove or re-park `desktop-e2e-windows`; revisit whether `desktop-e2e-macos` belongs on the PR loop

## What changed

### Phase 0.1 — the device gate's budget became a bound

The root cause of **17m38s against a twelve-minute budget** is that the budget was a *verdict*, not a bound: `tests/agent-e2e-mobile/lib/run-suite.mjs` ran all five members to completion and only then compared elapsed time. Two things could each overrun it unbounded, and both are in the issue's own remedy list.

- The classified single retry re-runs a whole journey **inside** the wall clock the budget measures (five members at budget plus one multi-minute retry is the observed number). `fitsInBudget()` now refuses a retry whose expected cost — the first attempt's own elapsed time, the only honest estimate available — exceeds what remains.
- `MAESTRO_CHUNK_TIMEOUT_MS` was twelve minutes, i.e. the *entire* suite budget, so one wedged chunk could spend it alone. `runSuite` publishes the run's absolute deadline as `CENTRAID_MOBILE_DEADLINE_MS`; `maestroChunkTimeoutMs()` in `tests/agent-e2e-mobile/lib/harness.mjs` clamps every chunk to the smaller of the flat ceiling and the time left, never below a 15s floor.
- The runner refuses to start a member past the deadline and names the unrun ones.
- `FIRST_LAUNCH_TIMEOUT_MS` is now build-typed. Its 120s existed because `clearState` drops a **dev** build's cached bundle and Metro must re-serve it; a release artifact carries its own Hermes bundle, so on that path it is 45s. It only ever cost time on the way to a failure, which is exactly where two minutes per doomed wait came from.

`tests/agent-e2e-mobile/lib/run-suite.test.mjs` is new and pins both pure helpers off-device. `tests/agent-e2e-mobile/flows/pr-gate-budget.md` records the deadline rules and **corrects its own derivation**: the "emulator and install" row priced work this budget does not contain (`android-emulator-install.sh` runs before the suite's clock starts), so it is relabelled as headroom. **The twelve minutes did not move.**

### Phase 0.2 — the apk cache key names the JS

`apps/mobile/scripts/js-bundle-fingerprint.mjs` (new, with `js-bundle-fingerprint.test.mjs`) hashes the tracked inputs of the embedded Hermes bundle — the app's own source, the four workspace packages the phone imports, the Expo/Metro/Babel configuration, and `bun.lock`. Every Android lane now derives two keys: `hash` (native only) keys the **gradle build directory**, and `apk_key` (native + JS) keys the **apk**. A JS-only PR therefore misses the apk cache and hits the gradle cache — repackage, not recompile, which is what "build once, run many" meant once the device lanes moved to the release artifact.

The iOS nightly had the identical defect (it builds `--configuration Release`, so its `.app` embeds the bundle too) and is fixed the same way. `apps/mobile/scripts/android-emulator-install.sh` additionally stamps the JS hash beside the banked apk and **refuses to install a mismatch**, so a future drift in one of the three hand-written key expressions fails loudly rather than testing another commit's JS.

### Phase 0.3 — the turbo cache, diagnosed and instrumented

One provable defect, found by `turbo run build --dry=json`: `turbo.json` declared `src/generated/centraid_web_iroh_bg.wasm` as an output of the generic `build` task, and that file is **git-tracked** — so it is simultaneously one of the task's hashed inputs. Turbo calls that overlap undefined, it never errors, and `@centraid/web`'s cache entry carried a 1.9 MB artifact on every save and restore. `scripts/lint-turbo-cache.mjs` (+ test, + `bun run lint:turbo-cache` on `static`) makes it impossible to reintroduce: no declared output may name a tracked path.

The rest of the question needs numbers this tree cannot produce, so the change is to **make the next run answer it**: `scripts/ci/turbo-cache-report.mjs` (+ test) runs turbo with `--summarize` and emits a per-task HIT/MISS table, the aggregate hit rate, the wall time spent inside misses, and the **global hash inputs** — the one thing per-task output can never show, and the most common cause of a whole-graph miss. `bun run build:ci` replaces `bun run build` in the build-bearing lanes. It reports; it does not gate (`--min-hit-rate` exists and no lane passes it) because a threshold invented before the first measurement is the opposite of what this repo's budgets are.

A second, larger find fell out of the same investigation. `apps/web/src/generated/centraid_web_iroh_bg.wasm` is **committed**, so `ensure-iroh-wasm.mjs` always exits early — yet four jobs (`verify` and all three of `lane-client-e2e`) ran `scripts/ci/ensure-iroh-wasm-toolchain.sh` unconditionally first, paying `rustup target add` + `cargo install wasm-bindgen-cli --locked` + apt (~1.7 min each) to provision a toolchain for a build that cannot happen. Its own header still claimed the binary was gitignored. The script now short-circuits when the committed artifact is present (`FORCE_IROH_WASM=1` overrides), so behaviour on a genuinely absent binding is unchanged. The `iroh-wasm` lane — the one that *does* rebuild — was the single lane not requesting the `cargo-cache: iroh-wasm` preset that exists for it; it now does, and version-checks the restored `wasm-bindgen` rather than reinstalling.

### Phase 1 — the lane restructure

- **`verify` split.** `verify` runs the uninstrumented suite (`bun run test:suite`) plus everything that needs the built dist and is not instrumentation. `coverage-shard` (×4, under the new `vitest.shard.config.ts` — the root config minus `thresholds`, because a shard sees a quarter of the world) and `coverage` (merge + floors + diff-coverage + wall-clock + tripwire + report) run in parallel. **Both are in `check`'s needs**: the split changed when answers arrive, never which answers gate.
- **Fail-closed merge.** `scripts/ci/assert-shard-blobs.mjs` (+ test) requires the exact blob set {1..N} before vitest is allowed to merge, and distinguishes a missing shard from a shard-count mismatch from a duplicate. `coverage` is an ordinary (not `always()`) dependent of `coverage-shard`, so a dead shard fails the merge rather than shrinking the world the floors score — the #556 shape this split would otherwise introduce.
- **`boot-smoke` folded** out of `lane-client-e2e.yml` into `verify`, which already builds a superset of its closure. It was 4m38s of build for a ~0s L2 assertion, and because `verify` is unfiltered it now also runs on PRs that never woke the `client` filter.
- **`mobile-smoke` trimmed**: `ci:android-native` removed. `mobile-device-gate` compiles the same native tree under `assembleRelease` and then runs the artifact, on the same path filter. The job's stale "fails before an expensive macOS build" rationale is corrected in place — since #890 W4 there is no macOS build on the PR loop to fail before.
- **`mutation-pr` restructured.** `MUTATION_GLOBAL_WATCH` in `scripts/mutation/seeds.mjs` no longer lists `package.json`/`bun.lock`; it watches the mutation configuration itself. The new `mutation-canary` job (ci.yml, push-to-main, serialized, deliberately outside `check`) owns the full seed set with one-commit attribution and files a deduplicated tracking issue on red.

### Phase 2 — the unowned promises

- **`tests/agent-e2e-compat` is wired.** The new `compat-upgrade-and-skew` job in `e2e.yml` resolves the latest release, downloads its installer asset, and runs both `install-upgrade-lifecycle.mjs` and `released-binary-skew.mjs`. Both are written to skip-with-citation, so the lane is green and **loud** from its first run and starts driving real binaries the day a release exists — with no further wiring. It is registered in the report and failure-issue `needs` lists and in the dispatch `suite` choices.
- **The golden-vault gate.** `scripts/golden-vault/build.mjs` freezes a deterministic populated vault per release into `packages/vault/tests/golden/<label>/` (gzipped: a freshly migrated `vault.db` is ~5.6 MB of mostly empty pages, over the `repo-hygiene` limit, and compresses to ~100 KB). `packages/vault/src/golden-vault.test.ts` inflates each corpus into a scratch dir, opens it — which runs the migration ladder — and requires every frozen row to survive with its values intact. `packages/vault/src/golden-snapshot.ts` owns the comparison and distinguishes a **dropped row** (data loss), a **rewritten value** (a migration rewrote a member's content) and a **retired column** (legitimate sometimes, silent never; the remedy is to re-freeze in the release that retires it). `golden-snapshot.test.ts` is the demonstrated red — every case breaks a vault the way a bad migration would and requires the comparison to say so.
- **`vault doctor`.** `packages/vault/src/doctor.ts` (+ test) sweeps page integrity, foreign keys, the polymorphic `(type, id)` pointers SQLite cannot enforce (walking #441's own `POLY_REF_REGISTRY`, so the sweep and the purge can never disagree about the set), and blob custody accounting. `assertVaultTreeHealthy` opens a directory tree read-only and is called at teardown in `tests/integration-mobile/lib/gateway.ts` — which is what converts that whole existing suite into a data-corruption detector.
- **N−1 binary skew** rides the same job as the upgrade lane, because they share "the previous release, runnable".
- **Mutation seeds widened** to `upload/transfer-policy.ts`, `upload/reconcile-gate.ts`, `replica/background-scopes.ts` and `replica/mobile-intent-id.ts`, in `apps/mobile/stryker.config.mjs`, `apps/mobile/vitest.mutation.config.ts` and the seed's watch list.
- **Replica convergence as a law.** `packages/client/src/replica/convergence-properties.test.ts` drives two `ReplicaSqliteStore`s with the same canonical log cut into **different batchings** and requires byte-identical rows, plus a model-replay check so "both replicas are identically stale" cannot pass. The canonical log's ORDER is deliberately not shuffled: commutativity is a claim this protocol does not make.
- **The deny matrix is generated.** `packages/server/src/serve/authz-deny-matrix.test.ts` enumerates `ROUTES` itself — 66 assertions — and requires every route to refuse an anonymous caller and a bearer the gateway does not honour (the wire signature of a revoked pair and an expired grant alike), plus a proved-device principal on the admin tier. A route escapes only through `DELIBERATELY_PUBLIC` with a stated reason.
- **The PWA offline journey.** `apps/web/tests/e2e/pwa-offline-journey.spec.ts` takes the **browser** offline with `context.setOffline(true)`, not just the harness transport, and reloads: the navigation is answered from `centraid-shell-<version>` or nothing renders. The three existing offline specs all sever an application-level transport, so the shell-cache path had never run.
- **Axe per journey page.** `apps/web/tests/e2e/accessibility.spec.ts` scanned one blueprint and called it "a first-party blueprint"; it now scans all eight.

### Phase 3 — meta-hardening

- **Merge queue: evaluated, not adopted**, with the reason and the revisit condition recorded in [docs/decisions.md](../docs/decisions.md). A queue's cost and flake exposure are a direct function of the required set's duration and first-attempt pass rate — both of which this change just moved and neither of which has been measured on the new shape.
- **Path-filter inverse lint.** `scripts/lint-path-filters.mjs` (+ test, + `tests/path-filter-ledger.json`) requires every workspace package, app and tracked top-level directory to be claimed by a `changes` filter or ledgered with the always-on job that covers it. It found three unclaimed paths (`assets`, `packages/test-kit`, `receipts`, now ledgered with reasons) and **four duplicate globs** — `packages/server/**` four times inside `gateway`, twice inside `client`, twice inside `extension`, and `packages/core/**` twice inside `gateway`, exactly the hand-maintenance wear the issue named. The duplicates are removed; the set each filter matches is unchanged.
- **Maestro pinned by checksum.** `scripts/ci/install-maestro.sh` fetches the pinned release artifact and verifies its sha256, replacing `curl -fsSL https://get.maestro.mobile.dev | bash` in all four device lanes. `scripts/test-report/validate-nightly-wiring.mjs` discovers lanes by the new marker and **bans the old one**.
- **Lane health and chronic red.** `scripts/ci/lane-health.mjs` (+ test) measures per-lane first-attempt pass rate over the last 40 `main` runs — only `run_attempt === 1` counts, because a green third try is a lane somebody re-ran — and fails when a lane has been red on main for more than three days without an unexpired entry in `tests/lane-quarantine.json`. Wired as the nightly `lane-health` job.
- **Advisory expiry.** `scripts/ci/advisory-expiry.mjs` (+ test, + `tests/advisory-ledger.json`, + `bun run test:advisory-expiry` on `gates`) requires every step that declares itself advisory to carry an owner, an issue and a `revisitBy` date, and fails on a past date or a stale entry.
- **`governance.yml` branch protection** cannot be asserted from inside the tree — it is repository configuration — so [docs/decisions.md](../docs/decisions.md) states plainly that the required set must be exactly `check` **and** `governance`, and why a kit-managed workflow is otherwise invisible to the aggregate.
- **`desktop-e2e-windows` removed.** It was gated behind an unset repo variable, so it never ran and never could go red; its parking note (Windows first-run founding, #846 P12 / #850) is preserved as prose where the job was. `desktop-e2e-macos` stays non-required, with the reason recorded.

Docs moved with the code, in the same change: [docs/decisions.md](../docs/decisions.md) gains a "The PR gate loop (#892)" section with eleven rulings, the merge-queue evaluation and the `governance.yml` branch-protection note; [TESTING.md](../TESTING.md) records the `verify`/`coverage` split, the sharded lane and its fail-closed merge, the `boot-smoke` move, the mutation tiers, the golden-vault gate, `vault doctor`, and the deny-by-default matrix.

Also fixed, found in passing and left in rather than filed: `mobile-canary.yml`'s red-canary step had **never filed an issue** — it passed `--body` (an unknown flag to `scripts/ci/file-tracking-issue.mjs`) and omitted the required `--search`/`--body-file`, so every red canary since #890 W4 threw on argument parsing inside an `if: failure()` step nobody was watching. `.gitignore` gains `.vitest-reports`, the per-shard blob directory.

### Checklist crosswalk

One row per checked item, quoting the issue's own wording, with the files that realize it. The prose above says *why*; this says *where*.

| Checklist item | Realized by |
| --- | --- |
| Green `mobile-device-gate`: root-cause the 17m38s-vs-12-min overrun; either fix the slow path or re-derive the budget from `ledger/durations.json` once three real runs exist | `tests/agent-e2e-mobile/lib/run-suite.mjs`, `tests/agent-e2e-mobile/lib/run-suite.test.mjs`, `tests/agent-e2e-mobile/lib/harness.mjs`, `tests/agent-e2e-mobile/flows/pr-gate-budget.md` |
| Fix the stale-JS apk cache key: fold a JS-bundle-input hash into `android-release--` across `ci.yml`, `mobile-canary.yml`, `e2e.yml`, and `android-emulator-install.sh` | `apps/mobile/scripts/js-bundle-fingerprint.mjs`, `apps/mobile/scripts/js-bundle-fingerprint.test.mjs`, `apps/mobile/scripts/android-emulator-install.sh`, `.github/workflows/ci.yml`, `.github/workflows/mobile-canary.yml`, `.github/workflows/e2e.yml` |
| Diagnose the turbo remote-cache miss | `turbo.json`, `scripts/lint-turbo-cache.mjs`, `scripts/lint-turbo-cache.test.mjs`, `scripts/ci/turbo-cache-report.mjs`, `scripts/ci/turbo-cache-report.test.mjs`, `package.json` (`build:ci`, `lint:turbo-cache`) |
| Split `verify`: uninstrumented pass/fail suite ∥ coverage+report job | `.github/workflows/ci.yml` (`verify` / `coverage-shard` / `coverage`), `package.json` (`test:suite`) |
| Parallelize the coverage job itself, fail-closed on the merge | `vitest.shard.config.ts`, `scripts/ci/assert-shard-blobs.mjs`, `scripts/ci/assert-shard-blobs.test.mjs`, `package.json` (`coverage:shard`, `coverage:merge`), `.gitignore` |
| Fold `client-e2e / boot-smoke` into a lane that already built | `.github/workflows/lane-client-e2e.yml`, `.github/workflows/ci.yml` |
| Trim `mobile-smoke`: drop `ci:android-native` | `.github/workflows/ci.yml` (`mobile-smoke`) |
| Restructure `mutation-pr`: full-seed runs move to the per-merge canary tier; remove `package.json`/`bun.lock` from `MUTATION_GLOBAL_WATCH` | `scripts/mutation/seeds.mjs`, `.github/workflows/ci.yml` (`mutation-pr`, `mutation-canary`) |
| Stop reinstalling the iroh-wasm toolchain per run | `scripts/ci/ensure-iroh-wasm-toolchain.sh`, `.github/workflows/ci.yml` (`iroh-wasm`, `verify`) |
| Wire `tests/agent-e2e-compat` into a scheduled lane, with `CENTRAID_UPGRADE_PREV_INSTALLER` sourced from the latest release artifact | `.github/workflows/e2e.yml` (`compat-upgrade-and-skew`) |
| Golden-vault gate on the PR loop | `scripts/golden-vault/build.mjs`, `packages/vault/src/golden-snapshot.ts`, `packages/vault/src/golden-snapshot.test.ts`, `packages/vault/src/golden-vault.test.ts`, `packages/vault/src/index.ts`, `packages/vault/tests/golden/v0-baseline/manifest.json`, `packages/vault/tests/golden/v0-baseline/vault.db.gz`, `packages/vault/tests/golden/v0-baseline/journal.db.gz`, `package.json` (`golden-vault:freeze`) |
| N−1 binary skew (nightly) | `.github/workflows/e2e.yml` (`compat-upgrade-and-skew`, sharing the previous release with the upgrade lane) |
| Widen mutation seeds to `apps/mobile/src/lib/upload/` and `apps/mobile/src/lib/replica/` | `apps/mobile/stryker.config.mjs`, `apps/mobile/vitest.mutation.config.ts`, `scripts/mutation/seeds.mjs`, `tests/mutation-floors.json` |
| Replica convergence property test on the PR loop | `packages/client/src/replica/convergence-properties.test.ts` |
| AuthZ deny-matrix generated from the route table | `packages/server/src/serve/authz-deny-matrix.test.ts` |
| PWA offline journey in `client-e2e / web-e2e`: `context.setOffline(true)` | `apps/web/tests/e2e/pwa-offline-journey.spec.ts` |
| Runtime accessibility scan (axe) riding the Playwright lanes already paid for | `apps/web/tests/e2e/accessibility.spec.ts` |
| Evaluate a GitHub merge queue | `docs/decisions.md` ("The merge queue: evaluated, and NOT adopted yet") |
| Path-filter inverse lint | `scripts/lint-path-filters.mjs`, `scripts/lint-path-filters.test.mjs`, `tests/path-filter-ledger.json`, `.github/workflows/ci.yml` (the deduplicated `changes` table) |
| Pin the Maestro install by version + checksum-verified artifact | `scripts/ci/install-maestro.sh`, `scripts/test-report/validate-nightly-wiring.mjs`, `.github/workflows/ci.yml`, `.github/workflows/e2e.yml`, `.github/workflows/mobile-canary.yml`, `.github/workflows/mobile-alarm-test.yml` |
| Per-lane first-attempt pass-rate in the test-health report | `scripts/ci/lane-health.mjs`, `scripts/ci/lane-health.test.mjs`, `.github/workflows/e2e.yml` (`lane-health`) |
| Invariant sweep (`vault doctor`) at the end of every e2e/integration harness run | `packages/vault/src/doctor.ts`, `packages/vault/src/doctor.test.ts`, `packages/vault/src/index.ts`, `tests/integration-mobile/lib/gateway.ts` |
| Chronic-red rule | `scripts/ci/lane-health.mjs`, `tests/lane-quarantine.json`, `.github/workflows/e2e.yml` |
| Give advisory outputs an expiry or budget | `scripts/ci/advisory-expiry.mjs`, `scripts/ci/advisory-expiry.test.mjs`, `tests/advisory-ledger.json`, `.github/workflows/ci.yml` (`gates`) |
| Verify `governance.yml` has its own branch-protection entry | `docs/decisions.md` ("`governance.yml` and branch protection"), `TESTING.md` |
| Remove or re-park `desktop-e2e-windows`; revisit whether `desktop-e2e-macos` belongs on the PR loop | `.github/workflows/ci.yml` |

## Decisions

1. **The device-gate overrun is fixed by bounding the budget, not by widening it or by re-deriving from the ledger.** The issue offered "fix the slow path or re-derive from `ledger/durations.json` once three real runs exist"; the ledger holds `records: []`, so re-derivation is unavailable, and the slow path turned out to be the budget's own toothlessness rather than any single journey. This is the budget doc's own remedy #2 ("a run that spent minutes retrying an infrastructure-classified failure is an infrastructure problem") made mechanical.
2. **Coverage is sharded 4 ways, not 8.** Eight would halve per-shard wall clock again and roughly double total runner minutes against the ~20 minutes being replaced. Four buys most of the latency at a modest compute cost. The number is one constant in two places (`ci.yml`'s matrix and `CENTRAID_COVERAGE_SHARDS`), and `assert-shard-blobs.mjs` reports a mismatch between them as its own nameable error.
3. **`verify` deliberately re-runs the suite the coverage lane also runs.** That is duplicated compute, chosen for latency, and it is the shape the issue asked for ("uninstrumented pass/fail suite ∥ coverage+report job").
4. **The `apps/mobile` mutation floor stays at 62 rather than moving to the wider set's provisional-local 61.** The widened set measures 72.31 local (was 73.00 for the narrower one), so `(measured − 11)` would be 61 — but floors are tighten-only and 62 holds against 72.31 with margin. Lowering it to match a convention would be a weakening dressed as accounting. `background-scopes.ts` measures 59.09 as a FILE, below `_absoluteWeaknessBelow`; it is seeded anyway and recorded in `tests/mutation-floors.json`, because excluding an under-defended module *because* it is under-defended is how these two trees came to have no adversary at all.
5. **The golden corpus committed here is a v-current baseline, not prior-release evidence.** A golden vault is only prior-release evidence if the release froze it. This change ships the mechanism and the first corpus; the discipline is one freeze per release, and it starts paying the moment the next migration lands. Recorded in the builder's header and in decisions.
6. **`replica_meta` is excluded from the golden corpus.** It is the replica protocol's singleton, rewritten by the act of opening the vault, so freezing it would fail the gate on every run for a reason unrelated to an upgrade eating anything. It is the only exclusion, the reason is recorded in the code, and a test caps the list at three so the gate cannot be disarmed one table at a time.
7. **The deny matrix folds "wrong vault", "expired grant" and "revoked pair" into one forged-bearer principal.** All three present a credential the gateway no longer honours; three fixtures of the same wire shape would be three copies of one assertion. The genuinely distinct third principal — a proved device with the wrong *authority* — is asserted separately.
8. **The merge queue is deferred with a bounded revisit condition rather than adopted or dropped.** See decisions; the ordering argument is that its economics depend on numbers this change just moved.
9. **The advisory-expiry rule covers only steps that NAME themselves advisory, not every `continue-on-error: true`.** Most of those are artifact restores whose failure is benign and whose consequence is re-checked; sweeping them in would flood the gate and teach people to widen it.
10. **`check:mobile-suite-budgets` was red against a stale `origin/main`, not against this change.** The container's `origin/main` was 3b8c3f0c while HEAD was c54367eb; the ratchet was reading #890's own already-merged widening as a new one. After `git fetch origin main` the gate is green on an unmodified tree and on this branch. No code changed for it — recorded because a red gate that turns out to be a stale fetch is exactly the kind of thing a receipt should say out loud rather than leave a reader to rediscover.
11. **The comment-density ratchet took one hand-raised pin and eight allowlist entries, and they were earned by trimming first.** `tests/comment-density-ratchet.json` caps an unpinned file at a 15% comment share, and eight new files in this change are gate code whose header explains what the gate catches — the case its `allowlist` calls "the pressure valve that exists so nobody deletes load-bearing rationale to hit a number". They were cut back before being allowlisted, not instead of it: `packages/vault/src/doctor.ts` 40.14 → 27.55, `packages/vault/src/golden-snapshot.ts` 39.07 → 28.54, `packages/vault/src/golden-vault.test.ts` 49.39 → 35.36, `apps/web/tests/e2e/accessibility.spec.ts` 30.65 → 17.93. Each allowlist entry carries its own reason. The single raised pin is `accessibility.spec.ts`, where the axe lane went from one blueprint to eight.
12. **`apps/mobile/src/apps/tally/TallyHome.test.tsx` is re-pinned here and is NOT this change's.** It measures 31.21 → 31.29 against `origin/main`'s own content — #890 changed it without re-pinning, so `test:comment-density` has been red on `main` since `c54367eb` and blocks every PR that runs `check:push`. It is re-pinned to its measured value (no content change) because a pre-existing red that blocks everyone is exactly the "nothing structural keeps main green" failure this issue exists to address. Attributed in `tests/comment-density-ratchet.json`'s `approvedDeviation` and here, so nobody mistakes it for a regression of this change's.
13. **`scripts/golden-vault/snapshot.mjs` became `packages/vault/src/golden-snapshot.ts`.** The first draft kept it beside the freezer script, and `packages/vault`'s `rootDir` refuses an import from outside `src/`. Moving it into the package is the better home anyway — it is a claim about vault schemas, the freezer already imports `packages/vault/dist`, and it now sits under the package's coverage floor.

## User impact

No deliberate visual product change is claimed: every change here is to the gate loop, the test layer, and the vault's structural self-check. What is newly *asserted* about the shipped product is the PWA's offline promise. First-run: the connect screen and the connected Home shell are unchanged; the new claim is that a member who reloads with no network keeps the app rather than a browser error page, and the changed harness `apps/web/tests/e2e/pwa-offline-journey.spec.ts` emits that evidence at `artifacts/e2e/ui-impact/issue-892-pwa-offline-shell.png` when the web e2e lane runs.

## Out of scope

- **Crash-point injection and soak/memory testing**, **generalizing the alarm-test pattern**, and **cross-platform pixel truth for `design-gallery`** — all three are named in the issue's own "Deliberately not doing", and none is touched here.
- **Trimming `gates`, `static`'s linters, `changes`, `gitleaks`, `osv-scanner`, `dependency-review`, `docs`, `web-build`, `companion-static` or `check`** — the issue calls these the best bargain in the repo. Three linters were *added* to that tier; none was removed.
- **Enabling the merge queue.** Evaluated and deferred with a stated revisit condition (decisions, "The merge queue: evaluated, and NOT adopted yet").
- **The `governance` branch-protection entry itself.** It is repository configuration, not repository content; the requirement is documented rather than asserted, because no gate in this tree can see a ruleset.
- **Freezing a golden vault per historical release.** Only a release can freeze its own corpus; back-filling one from today's tree would produce a file that looks like evidence and is not.
- **Adding axe to the desktop Playwright lane.** The desktop renderer is the same inline blueprint tree the web lane now scans eight times; a second shell would re-scan the same trees for a new dependency in `apps/desktop`.
- **`apps/mobile/src/lib/upload/native-policy.ts`, `store.ts`, `uploader.ts` and the replica native session** stay out of the mutation seed: they import `expo-battery`/`expo-network`/the native module or drive SQLite, so mutating them measures the mocks.

## Verification

Every command below was run in this container against this branch.

Formatting, lint, types, dead code:

```sh
bun run format:check
bun run lint
bun run typecheck
bun run lint:types
bun run knip
```

The offline gate battery, including the three linters this change adds:

```sh
bun run lint:turbo-cache          # 2 turbo config(s) clean
bun run lint:path-filters         # 10 filter(s) cover every workspace and top-level path
bun run test:advisory-expiry      # 2 advisory step(s) owned, dated and unexpired
bun run lint:workflow-pins        # 23 workflow(s) clean
bun run test:matrix               # matrix + nightly-wiring + release-wiring
bun run scripts:test              # 446 tests
bun run test:ratchet
bun run test:comment-density      # ok — no pin rose, no unpinned file over cap
bun run check:mobile-suite-budgets
```

The pre-push gate (`bun run check:push`, 56 gates) was run in full. Three failed and all three are named above or here: `test:affected` (the two environment-dependent server files), `test:comment-density` (addressed — see `## Decisions` 11–12), and `design:gallery`, which needs a downloaded Playwright browser this container cannot fetch (`bunx playwright install` fails on the pinned revision; the two browser lanes above ran only because the image's own Chromium could be pointed at directly).

The new suites, each run individually:

```sh
node node_modules/vitest/vitest.mjs run --config scripts/test-report/vitest.config.ts \
  tests/agent-e2e-mobile/lib/run-suite.test.mjs                 # 8 passed
node node_modules/vitest/vitest.mjs run --project @centraid/vault \
  packages/vault/src/doctor.test.ts                             # 4 passed
node node_modules/vitest/vitest.mjs run --project @centraid/vault \
  packages/vault/src/golden-vault.test.ts                       # 4 passed
node node_modules/vitest/vitest.mjs run --project @centraid/vault \
  packages/vault/src/golden-snapshot.test.ts                    # 11 passed
node node_modules/vitest/vitest.mjs run --project @centraid/server \
  packages/server/src/serve/authz-deny-matrix.test.ts           # 66 passed
node node_modules/vitest/vitest.mjs run --project @centraid/client \
  packages/client/src/replica/convergence-properties.test.ts    # 2 passed
node node_modules/vitest/vitest.mjs run --config tests/integration-mobile/vitest.config.ts
#                                                               # 60 passed, with the
#                                                               # vault-doctor sweep at teardown
```

The two browser lanes, against the container's Chromium (the repo pins a Playwright build this image does not carry, so the run used a temporary `launchOptions.executablePath` override that was reverted afterwards — the specs and the committed config are unmodified):

```sh
cd apps/web && bunx playwright test -c tests/e2e/playwright.config.ts pwa-offline-journey
#   1 passed — the shell, the session and recovery all survive a real browser offline
cd apps/web && bunx playwright test -c tests/e2e/playwright.config.ts accessibility
#   10 passed — cold connect, connected Home, and all eight first-party blueprints
```

**The demonstrated reds.** Two new gates were seeded red on purpose before being accepted green:

```sh
# 1. The PWA offline journey depends on the service worker, not on luck.
#    Unregistering the SW and clearing every cache immediately before
#    `context.setOffline(true)` fails the reload assertion at line 147.
#    Reverted after the run.

# 2. The golden-vault comparison catches what a row count cannot.
node --test scripts/golden-vault/snapshot.test.mjs   # (before the module moved into
#   a DROPPED row is data loss and is named             packages/vault; the same eleven
#   a REWRITTEN value is caught even though the         cases now run as
#     row count is unchanged                            packages/vault/src/golden-snapshot.test.ts)
#   a DROPPED COLUMN is its own class
#   a DROPPED TABLE names how many rows went with it
```

`vault doctor` is likewise pinned against a real orphan rather than only against a healthy vault: `doctor.test.ts` inserts an `enrich_derivation` row pointing at a purged target and requires the sweep to name it, and requires an unresolvable logical type NOT to be flagged.

The widened mutation seed was measured, not assumed:

```sh
node scripts/mutation/run.mjs --package mobile
#   apps/mobile: 72.3% (ok)  — reconcile-gate 100.00, transfer-policy 73.21,
#                              mobile-intent-id 68.75, background-scopes 59.09
```

The turbo cache-report and the golden-vault freezer were exercised end to end:

```sh
node scripts/ci/turbo-cache-report.mjs --report-only   # per-task table + global hash inputs
node scripts/golden-vault/build.mjs --label v0-baseline
#   froze v0-baseline — 56 table(s), 184 row(s), schema v7 (ontology 1.4)
```

**The whole repo suite**, and the two failures it leaves:

```sh
node node_modules/vitest/vitest.mjs run --reporter=dot
#   Test Files  2 failed | 1500 passed | 4 skipped (1506)
#        Tests  3 failed | 18159 passed | 5 expected fail | 37 skipped (18204)
```

The three failures are environment-dependent and **reproduce identically on a stashed, unmodified tree** — verified by `git stash -u` and re-running exactly those two files:

- `packages/server/src/serve/gateway-db-lock.integration.test.ts` — needs the `sqlite3` CLI, which this container does not carry.
- `packages/server/src/acp/backends/acp/launch.test.ts` (×2) — the root / non-root `IS_SANDBOX` pair; this container runs as root, so the non-root half cannot hold.

Neither is caused by this change and neither is fixed by it. Recorded rather than elided, because "the suite is green except for two files I decided not to mention" is the shape this repo's honesty gates exist to prevent.

**Not verifiable in this container**, and named rather than implied: the CI wall-clock claims (the `verify` split, the four-way coverage shard, the turbo cache hit rate, the device gate's warm runtime) are the numbers the next real run produces. That is the point of `build:ci` and `lane-health`: this change makes them measurable, and the merge-queue decision is explicitly deferred until they exist.

## Audit

**VERDICT: REFUTED — the independent audit required by `receipt-per-issue` rule 7 has NOT been performed.**

Recorded as REFUTED rather than PASS because the directive's own rule is to default to REFUTED when uncertain, and "nobody independent has looked" is the strongest form of uncertain. The verdict is about the audit's absence, not about a finding.

**Why it is absent.** Rule 7 wants the verdict of a **fresh-context sub-agent** handed only the diff, this receipt, and the issue. The session that produced this change was instructed not to spawn sub-agents, so no such agent ran. Writing "PASS" here would have been the exact failure the rule exists to catch — an author attesting to their own work in the section reserved for someone who has not seen their reasoning — and it would have been indistinguishable, to every mechanical check in this repo, from a real audit.

**What to do before merging.** Run the audit. Hand a fresh-context agent only `git diff origin/main`, this receipt, and `gh issue view 892`, ask it adversarially whether (a) `## What changed` faithfully describes the diff, (b) each `- [x]` item is realized in the diff, and (c) the `## Checklist` mirrors the issue's checklist, and replace this section with its verdict and findings.

**Author's own review, which is NOT that audit and does not substitute for it.** Recorded so the independent auditor has the author's claims to attack rather than to reconstruct:

- Every checklist item above maps to a named artifact in the diff. The three most overclaimable were re-read against the issue's wording: "diagnose the turbo remote-cache miss" delivered one *provable* fix plus instrumentation, and `What changed` says so rather than claiming the miss is fully explained; "evaluate a merge queue" is a recorded decision with a revisit condition, matching the verb the issue used; "verify `governance.yml` has its own branch-protection entry" is documented as unverifiable from inside the tree rather than ticked against a check that does not exist.
- The diff exceeds the issue's literal text in one place: the iOS `.app` cache key, which the issue names only for the Android lanes. `e2e.yml` is in the issue's list and holds both, the defect is identical, and leaving a known stale-artifact false-pass in place would contradict the issue's premise. Named in `What changed` rather than folded in silently.
- Two fixes are outside the checklist entirely — `mobile-canary.yml`'s never-firing tracking-issue call, and the four duplicate path-filter globs. Both were surfaced *by* work the issue asked for, and both are named under "Also fixed, found in passing".
- The `apps/mobile` mutation floor is unchanged at 62 while its seed widened, which could read as a silent widening. The arithmetic — the wider set measures 72.31, and the provisional-local convention would have *lowered* the floor to 61 — is recorded here, in `## Decisions`, and in `tests/mutation-floors.json`.

## Session

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-31 | claude-code | 97d5a659-40fb-5616-9fe5-7a9b639aeb27 |
