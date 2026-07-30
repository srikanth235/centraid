# Issue #637 — CI caching strategy

<!-- governance: allow-receipt-per-issue Issue #637 is landed on the multi-issue PR branch that also carries #630 readiness work. This receipt names only the #637 caching surface; co-branch #630 files are covered by receipts/issue-630-blueprint-readiness.md and must not force a second crosswalk here. -->

## Checklist

Mirrors issue #637 acceptance criteria (implementation phases). Post-merge measurement items stay open until warm traffic exists.

- [x] Phase 0 — Cargo caches are saved only from main; PR runs restore without saving
- [x] Phase 0 — A closed PR's caches are deleted automatically (cache-cleanup workflow)
- [x] Phase 1 — Warm nightly e2e and PR build jobs can use turbo-cache (wired; hit evidence post-merge)
- [x] Phase 1 — macOS mobile-e2e-ios cannot restore a Linux-built native/*.node (OS-aware hash + job exclusion)
- [x] Phase 2 — Root Dockerfile COPYs workspace manifests before bun install; gateway-package uses buildx registry-backed layer cache
- [x] Phase 3 — mobile-smoke uses gradle/actions/setup-gradle pinned by SHA, writing only on main
- [ ] Steady-state GET /actions/cache/usage ≤ 8 GB after warm traffic
- [ ] ios-app and AVD caches survive a week of normal PR + nightly traffic
- [ ] One-time manual purge of existing duplicate cargo entries

## What changed

### Phase 0 — Cargo restore always / save only on main; PR-close cache cleanup

- `.github/actions/setup/action.yml` — each cargo preset uses `actions/cache/restore` on every ref and `actions/cache/save` only when `github.ref == refs/heads/main` and the restore was not an exact hit (Phase 0 — Cargo caches are saved only from main; PR runs restore without saving).
- `.github/workflows/cache-cleanup.yml` — on `pull_request: closed`, deletes Actions caches for `refs/heads/<head_ref>` and `refs/pull/<n>/merge` (Phase 0 — A closed PR's caches are deleted automatically).

### Phase 1 — turbo-cache + OS-aware hash

- `turbo.json` — `globalEnv: ["RUNNER_OS"]` so Linux and macOS never share `native/*.node` hashes (Phase 1 — macOS mobile-e2e-ios cannot restore a Linux-built native/*.node).
- `.github/workflows/e2e.yml` — `turbo-cache: "true"` on build-bearing nightly jobs; `mobile-e2e-ios` intentionally left uncached with an explanatory comment (Phase 1 — Warm nightly e2e…; job exclusion belt-and-braces with OS hash).
- `.github/workflows/ci.yml` `mutation-pr` — turbo-cache on.
- `.github/workflows/lane-gateway-package.yml` — turbo-cache on the host gateway closure build.

### Phase 2 — Dockerfile manifests-first + registry buildcache

- `Dockerfile` — `# syntax=docker/dockerfile:1.7-labs`; COPY root manifests + `COPY --parents packages/*/package.json apps/*/package.json` before `bun install`, then COPY sources; base images digest-pinned (Phase 2 — Root Dockerfile COPYs workspace manifests before bun install).
- `.github/workflows/lane-gateway-package.yml` — buildx + `docker/build-push-action` with `push: false`/`load: true`, `cache-from` registry `…/centraid-gateway:buildcache`, `cache-to` only on main; `packages: write` permission (Phase 2 — gateway-package uses buildx registry-backed layer cache).
- `.github/workflows/ci.yml` `gateway-package` job — grants `packages: write` to the reusable lane (required; without it GitHub rejects the call with `packages: none` and the entire `ci` workflow hits `startup_failure`).

### Phase 3 — Gradle dependency cache for mobile-smoke

- `.github/workflows/ci.yml` `mobile-smoke` — `gradle/actions/setup-gradle@3f131e8634966bd73d06cc69884922b02e6faf92` (v6.2.0) with `cache-read-only` when not on main (Phase 3 — mobile-smoke uses gradle/actions/setup-gradle pinned by SHA, writing only on main).

### Receipt

- `receipts/issue-637-ci-caching-strategy.md` — this file.

## Decisions

- Save cargo only on main (Gradle-style write-on-default-branch), not “save on exact miss from any ref”, so PR branches never grow the 10 GB pool.
- Exclude `mobile-e2e-ios` from turbo-cache even after OS-aware hashing — zero-risk option from the issue open questions.
- Registry `type=registry,mode=max` for Docker layer cache instead of GHA-backed cache, so multi-GB layers stay off the Actions pool.
- Caller-side `permissions.packages: write` on `ci.yml` `gateway-package` (mirrors `release.yml` → `lane-release-gateway-image`); elevating only the reusable workflow is not enough when the parent workflow top-level is `contents: read`.
- Do not enable `org.gradle.caching` task-output cache; deps/wrapper only so mobile-smoke still executes compile tasks.
- Per-stage production lock in the Docker deps stage left as a residual (called out in Dockerfile); not required for layer-cache correctness after manifests-first COPY.
- Land on the existing #630 PR branch rather than a separate PR so the caching fixes ride the same CI surface under active load.

## Out of scope

- Timeout (`timeout-minutes`) changes
- Sharding/splitting `verify` coverage
- Bun install caching (#538)
- CocoaPods caching
- `org.gradle.caching` task outputs
- Runner hardware changes
- Post-merge wall-clock before/after table (filled after warm runs)
- One-time manual cargo duplicate purge (operator step)

## Verification

```bash
# Staged surface is only the #637 caching paths
git diff --name-only origin/main...HEAD | rg 'setup/action|cache-cleanup|ci\.yml|e2e\.yml|lane-gateway|turbo\.json|^Dockerfile$|issue-637'

# Setup action: cargo save gated on main
rg -n "cache/save|refs/heads/main" .github/actions/setup/action.yml

# Turbo OS hash
rg -n "RUNNER_OS|turbo-cache" turbo.json .github/workflows/e2e.yml .github/workflows/ci.yml .github/workflows/lane-gateway-package.yml

# Dockerfile manifests before install
rg -n "bun install|COPY --parents|package.json" Dockerfile | head -20

# mobile-smoke gradle pin
rg -n "setup-gradle|cache-read-only" .github/workflows/ci.yml
```

Post-merge operator checks:

```bash
gh api repos/srikanth235/centraid/actions/cache/usage
# After a closed PR: entry count for that ref trends to zero
# Warm CI logs: turbo cache hits on e2e / mutation-pr / gateway-package
```

## Audit

- **PASS** — (1) `## What changed` faithfully describes the #637 surface on disk: cargo restore-always / save-only-on-main in `.github/actions/setup/action.yml` (three presets); new `.github/workflows/cache-cleanup.yml` deleting `refs/heads/<head_ref>` and `refs/pull/<n>/merge` on `pull_request: closed`; `turbo.json` `globalEnv: ["RUNNER_OS"]`; `turbo-cache: "true"` on build-bearing `e2e.yml` jobs with `mobile-e2e-ios` deliberately uncached; `turbo-cache` on `ci.yml` `mutation-pr` and `lane-gateway-package.yml`; root `Dockerfile` manifests-first `COPY` + `1.7-labs` + digest-pinned bases; gateway-package buildx with registry `cache-from` / main-only `cache-to` and `packages: write` (caller `ci.yml` job also grants `packages: write`); `mobile-smoke` `gradle/actions/setup-gradle@3f131e8634…` with `cache-read-only` off main. No material misdescription of those paths.
- **PASS** — (2) Every `[x]` checklist item is realized in the tree: Phase 0 cargo main-only save + cache-cleanup workflow; Phase 1 turbo wiring + OS hash + iOS exclusion; Phase 2 Dockerfile + registry buildcache; Phase 3 Gradle SHA pin with write-on-main. The three unchecked items (≤8 GB steady-state, ios-app/AVD week survival, one-time cargo purge) remain intentionally open as post-merge / operator work and are not claimed done.
- **PASS** — (3) `## Checklist` mirrors issue #637 acceptance criteria: Phase 0–3 implementation bullets map 1:1 to the issue’s cargo save policy, closed-PR deletion, turbo warm wiring (e2e + gateway-package/mutation-pr), macOS native hazard (hash + exclude), Dockerfile manifests-first + buildx registry cache, and setup-gradle pin/write policy; open post-merge items (usage ≤ 8 GB, ios-app/AVD survival, manual cargo purge) stay unchecked, matching criteria that need warm traffic or operator action.

## Steering

- One human redirect applies to this work: the operator directed the agent off prior #630-surface work onto **issue #637** and to land it on the **existing PR branch** (correction-style, not a mid-toolstream interrupt sentinel). Recorded here in prose; no structural interrupt mid-task beyond that redirect.
- **PASS** — That redirect is the only correction-class steering event for #637 in the supplied session framing. Ordinary task setup and non-redirect messages are not treated as steering.
- Ledger row append via `agent-steering-accounting` `lib/ledger.py append-row` was not executed in this attestation context (no shell). If the harness requires a durable `### Steering` table row for the redirect, the parent agent may append it with type `correction`, tier `classifier`, issue `#637`, and user-reason summarizing “work on #637 and add to existing PR”.

## Accounting

No steering ledger rows required beyond the redirect described above (helper not run from this sub-agent). **PASS** — no non-steering messages were misclassified as steering events.
