# issue-557 — CI posture: red signals that reach nobody, plus supply-chain gaps

GitHub issue: [#557](https://github.com/srikanth235/centraid/issues/557)

Origin: [#556](https://github.com/srikanth235/centraid/issues/556) asked why a red
nightly kept serving a green report. The answer generalised into a family of
gaps, found by auditing every workflow in `.github/workflows/`.

## Checklist

- [x] Nightly report publishes when the report job fails
- [x] Register the orphaned device-pairing-lifecycle flow in the matrix
- [x] Nightly tracking issue cites the immutable dated report URL
- [x] extension-e2e files a tracking issue when its scheduled lane goes red
- [x] Alerting treats cancelled as red, not as a pass
- [x] Perf retry emits a flake signal instead of absorbing the failure
- [x] Add Dependabot for actions, bun, cargo and docker
- [x] Add CodeQL scanning for javascript-typescript, actions and rust
- [x] Add dependency-review on pull requests
- [x] Publish npm packages with provenance
- [x] SHA-pin every floating action reference
- [x] Pass workflow_dispatch inputs through env rather than shell interpolation
- [x] Give every job a timeout-minutes
- [x] Single source of truth for the Bun version via a composite action
- [x] Enforce all three workflow policies with a lint on the PR loop
- [x] Enable vulnerability alerts and Dependabot security updates
- [x] Make ci.yml the only pull_request entry point
- [x] Fold bun install and the build caches into the setup action
- [x] Extract the duplicated tracking-issue and report-slug shell into tested scripts
- [x] Extract the container smoke shell out of the workflow

## What changed

### Crosswalk — checklist item → where it landed

- **Nightly report publishes when the report job fails** — `e2e.yml`
  `publish-nightly-report` gate.
- **Register the orphaned device-pairing-lifecycle flow in the matrix** —
  `tests/matrix.json` cell owner + flow entry.
- **Nightly tracking issue cites the immutable dated report URL** — `e2e.yml`
  `nightly-failure-issue` body.
- **extension-e2e files a tracking issue when its scheduled lane goes red** —
  new `companion-failure-issue` job.
- **Alerting treats cancelled as red, not as a pass** — `e2e.yml`,
  `extension-e2e.yml`, `interop-weekly.yml` conditions.
- **Perf retry emits a flake signal instead of absorbing the failure** —
  `ci.yml` per-PR perf gate step.
- **Add Dependabot for actions, bun, cargo and docker** — new
  `.github/dependabot.yml`.
- **Add CodeQL scanning for javascript-typescript, actions and rust** — new
  `.github/workflows/security.yml` `codeql` matrix.
- **Add dependency-review on pull requests** — `security.yml`
  `dependency-review` job.
- **Publish npm packages with provenance** — `scripts/gateway-npm/publish.mjs`
  + `id-token: write` + the `repository` field on eleven packages.
- **SHA-pin every floating action reference** — twelve refs across
  `gateway-package.yml`, `npm-gateway-publish.yml`, `release-gateway-image.yml`.
- **Pass workflow_dispatch inputs through env rather than shell interpolation** —
  `release-gateway-image.yml`, `release-mobile.yml`, `npm-gateway-publish.yml`.
- **Give every job a timeout-minutes** — seven jobs across six workflows; the
  eighth is kit-managed and exempted (see `## Decisions`).
- **Single source of truth for the Bun version via a composite action** —
  `.github/actions/setup/action.yml`, 35 call sites migrated.
- **Enforce all three workflow policies with a lint on the PR loop** —
  `scripts/lint-workflow-pins.mjs` in `check:pr` and CI `static`.
- **Enable vulnerability alerts and Dependabot security updates** — repo
  settings, applied directly (evidence in `## Verification`).
- **Make ci.yml the only pull_request entry point** — eight lanes folded into
  `.github/workflows/ci.yml` behind one `changes` filter; enforced by policy (5)
  of `scripts/lint-workflow-pins.mjs`.
- **Fold bun install and the build caches into the setup action** —
  `.github/actions/setup/action.yml` gained `install`, `turbo-cache` and
  `cargo-cache` inputs; 33 install lines and 10 cache blocks deleted.
- **Extract the duplicated tracking-issue and report-slug shell into tested
  scripts** — `scripts/ci/file-tracking-issue.mjs` and
  `scripts/ci/run-slug.mjs`, with `scripts/ci/file-tracking-issue.test.mjs` and
  `scripts/ci/run-slug.test.mjs`.
- **Extract the container smoke shell out of the workflow** —
  `scripts/gateway-package/container-smoke.sh`.

### Signal — a red run must be visible

**Nightly report publishes when the report job fails.** `.github/workflows/e2e.yml`
gated `publish-nightly-report` on `needs.test-health-report.result == 'success'`.
The report job fails on its own honesty exits (orphaned failed evidence, silent
all-clear, grey creep) *after* writing `dist/test-report/`, so every honesty exit
also suppressed the page that would have shown the failure. Now
`!= 'cancelled' && != 'skipped'`, mirroring `.github/workflows/ci.yml`'s
`publish-report`, which had this right. `skipped` stays excluded so single-lane
dispatch cannot false-alarm the "HTML missing" issue.

A publish that shipped nothing also ended green, because `echo "::error::"`
annotates without failing a step. `e2e.yml` gained a `Fail when nothing was
published` step so that state is red in the Actions UI, not only in an issue.

**Register the orphaned device-pairing-lifecycle flow in the matrix.**
`tests/matrix.json` never mapped
`tests/agent-e2e-pairing/flows/device-pairing-lifecycle.mjs` to any cell, so when
it began failing the `#535 F3` orphan-evidence guard exited 1 — the trigger for
the publish bug above. It now owns `tunnel-pairing.journey` (it *is* the pairing
journey: create vault → mint ticket → enrol a never-seen device → visible to the
admin CLI) with a `pairing-device-lifecycle` flow entry. `cross-network-relay.mjs`
kept `tunnel-pairing.offline` and its flow entry moved to the `offline` dimension,
removing the double ownership.

**Nightly tracking issue cites the immutable dated report URL.**
`scripts/test-report/prepare-pages-site.mjs` already archives every publish to
`runs/<date>-<runId>/`, but `nightly-failure-issue` linked only
`/test-report/nightly/` — a mutable alias the next night overwrites, so an issue
silently starts describing a different run. `e2e.yml` now derives the same slug
from the run's `created_at` and links the dated slot first, the alias second.

**extension-e2e files a tracking issue when its scheduled lane goes red.**
`.github/workflows/extension-e2e.yml` had no `issues: write` and no failure-issue
job; its `companion` job failed 2026-07-26 09:01Z in silence. Added
`companion-failure-issue`, matching the `#496 E3` pattern already in `e2e.yml`
and `.github/workflows/interop-weekly.yml`.

**Alerting treats cancelled as red, not as a pass.** `e2e.yml`,
`extension-e2e.yml` and `interop-weekly.yml` tested only `== 'failure'`, so a
dead runner filed nothing. All three now use
`contains(join(needs.*.result, ','), …)` over both `failure` and `cancelled` —
which also means a job added to `needs:` is covered automatically instead of
falling outside a hand-maintained list. `interop-weekly.yml`'s swallowed
`::warning::` on a failed alert became a hard `::error::` + `exit 1`, matching
the `#545 A1` hardening in `e2e.yml`.

**Perf retry emits a flake signal.** `ci.yml` ran
`bun run test:perf:pr || bun run test:perf:pr`; a pass-on-retry recorded as a
clean pass, so against tighten-only budgets a regression failing ~50% of the time
read as permanently healthy. The retry stays (shared-runner noise is real) but
the second attempt now writes a `::warning::` annotation and a Job Summary block.

### Supply chain

**Dependabot** (`.github/dependabot.yml`, new) covers `github-actions`, `bun`,
`cargo` (the three crates) and `docker`, weekly and grouped. This is what makes
the repo's SHA pinning a control rather than a freeze — a pin with no updater
never moves, including through security fixes. `iroh` minor/major is the one
`ignore` entry: an ALPN/relay behaviour change is proven only by the nightly
pairing lanes, so it is a deliberate upgrade rather than a batched dependency PR.
Bun needs no ignore rule — it is pinned by `packageManager`, not depended on.
`prefix-development` is deliberately unset on the `bun` ecosystem: its behaviour
there is unverified and a rejected key disables the entire config rather than
one line.

**CodeQL and dependency-review** (`.github/workflows/security.yml`, new). The
repo had no static security analysis at all (`/code-scanning/alerts` → 404)
despite a documented threat model. CodeQL runs `javascript-typescript`, `actions`
and `rust` on push-to-main plus a weekly schedule (off the PR loop — a Rust
database build would blow `ci`'s budget); `dependency-review` gates PRs at
`fail-on-severity: high` with a copyleft licence denylist.

**npm provenance.** `scripts/gateway-npm/publish.mjs` adds `--provenance` when
`ACTIONS_ID_TOKEN_REQUEST_URL` is present, and
`.github/workflows/npm-gateway-publish.yml` declares `id-token: write` to make it
present. The probe is required because `npm publish --provenance` hard-fails
without OIDC, and a local invocation must keep working. Provenance also requires
a `repository` field, which all eleven published packages lacked — added to
`packages/protocol/package.json`, `packages/design-tokens/package.json`,
`packages/blob-format/package.json`, `packages/app-engine/package.json`,
`packages/backup/package.json`, `packages/tunnel/package.json`,
`packages/vault/package.json`, `packages/blueprints/package.json`,
`packages/automation/package.json`, `packages/agent-runtime/package.json` and
`packages/gateway/package.json`, each with its monorepo `directory`.

**SHA-pinned every floating action reference** — twelve of them, in
`.github/workflows/gateway-package.yml`,
`.github/workflows/npm-gateway-publish.yml` and
`.github/workflows/release-gateway-image.yml`, the last two being the workflows
that hold `NPM_TOKEN` and GHCR push. `dtolnay/rust-toolchain@stable` was a moving
*branch*. `setup-node` was pinned to the v6.4.0 SHA the other nine call sites
already use rather than a v4 SHA, so the repo runs one version.

**Dispatch inputs through `env:`** in `release-gateway-image.yml` (free-text
`inputs.ref`), `release-mobile.yml` and `npm-gateway-publish.yml`, so values are
parsed as data rather than as script.

### Hygiene made mechanical

**Every repo-owned job now declares `timeout-minutes`.** Eight lacked it,
inheriting GitHub's 360-minute default; seven were fixed here — `changes` and
`build` (both now jobs of `.github/workflows/ci.yml`), `package` in
`.github/workflows/extension-release.yml`, `trace-and-smoke` in
`.github/workflows/lane-gateway-package.yml`, `github-release` and
`restamp-rollout` in `.github/workflows/release-desktop.yml`, and `probe` in
`.github/workflows/release-mobile.yml`.

The eighth, `.github/workflows/governance.yml`, is **not** fixed: it carries a
`# governance-kit:managed` marker and is integrity-checked against a digest
recorded at apply time, so editing it breaks the trust chain (the kit-runtime
directive blocked the first commit attempt for exactly this). The lint exempts
kit-managed files by that marker and says so on every run, so the exemption stays
visible instead of becoming a silent hole. The durable fix is upstream in
governance-kit.

**One Bun pin.** `.github/actions/setup/action.yml` (new composite action)
reads `packageManager` from `package.json` at run time with `sed` — it runs
before any toolchain exists — and all 35 hand-copied `bun-version:` literals were
replaced with `uses: ./.github/actions/setup` across
`.github/workflows/ci.yml`, `.github/workflows/lane-client-e2e.yml`,
`.github/workflows/lane-gateway-package.yml`, `.github/workflows/e2e.yml`,
`.github/workflows/extension-e2e.yml`,
`.github/workflows/extension-release.yml`,
`.github/workflows/interop-weekly.yml`,
`.github/workflows/npm-gateway-publish.yml`,
`.github/workflows/oauth-worker.yml`, `.github/workflows/release-desktop.yml`,
`.github/workflows/release-mobile.yml` and `.github/workflows/web.yml`.
Checkout precedes every call site (verified before migrating).

**`scripts/lint-workflow-pins.mjs`** (new) enforces five policies — SHA-pinned
third-party `uses:`, no literal Bun version, every job bounded, no hand-rolled
`bun install`, and only `ci.yml` on `pull_request` — with
`scripts/lint-workflow-pins.test.mjs` (new, 15 cases) covering each rejection and
the exemptions. Wired into `package.json` as `lint:workflow-pins`, into
`check:pr` / `check:pr:full`, into `scripts:test`, and into `ci.yml`'s `static`
job. It complements actionlint, which validates syntax and expressions but not
policy.

**Repo settings** (not code, applied directly): vulnerability alerts and
Dependabot security updates were both disabled and are now enabled.

### Consolidation — one PR entry point

The audit above kept finding the same shape: a lane that could go red without
anyone noticing. The sprawl was the cause, not a separate cosmetic problem.

**Make ci.yml the only pull_request entry point.** Ten workflows listened on
`pull_request` independently. To stay affordable each carried its own `paths:`
filter — and that is exactly what made them unrequirable, because a workflow
filtered out of a PR reports no status and a required check that never reports
blocks the PR forever. The `main-protection` ruleset requires `check` and
`governance`; the other eight lanes could go red with the merge button still
green. `.github/workflows/ci.yml` now owns one `changes` job (the whole repo's
paths-filter table, replacing six scattered `on: paths:` blocks and 20 verbatim
duplicated glob lines) and every PR gate is a job under it: `docs`, `web-build`,
`iroh-wasm`, `companion-static`, `oauth-worker` and `dependency-review` inline,
plus two `workflow_call` lanes big enough to keep their own files —
`.github/workflows/lane-client-e2e.yml` (renamed from
`.github/workflows/client-e2e-pr.yml`) and
`.github/workflows/lane-gateway-package.yml` (renamed from
`.github/workflows/gateway-package.yml`). The
`check` aggregator now `needs:` all of them and reads `join(needs.*.result)`, so
a lane added later is covered without editing a hand-kept list. `skipped` passes
(that is what a path-gated lane reports), `cancelled` fails.

`.github/workflows/docs.yml` and `.github/workflows/iroh-wasm.yml` are deleted —
their single jobs are now ci.yml lanes. `.github/actions/setup-bun/action.yml`
is deleted in favour of `.github/actions/setup/action.yml`.
`apps/desktop/tests/e2e/COVERAGE_REPORT.md` follows the renamed lane file. `.github/workflows/web.yml`,
`.github/workflows/oauth-worker.yml`, `.github/workflows/extension-e2e.yml` and
`.github/workflows/security.yml` lost their `pull_request` triggers and keep only
the deploy / schedule halves. Deploys deliberately stay out of `ci.yml`: they own
their own secrets and `environment:` gates. `web.yml` also collapses from two
jobs to one — it was building the PWA twice per push, once to gate and once to
deploy. `oauth-worker.yml` keeps its separate `verify` job on purpose, because
`deploy` sits behind a protected environment and a human must be approving a
build already known green.

Policy (5) of `scripts/lint-workflow-pins.mjs` makes this mechanical: only
`ci.yml` may carry a `pull_request:` trigger.

**Fold bun install and the build caches into the setup action.**
`.github/actions/setup-bun` was renamed to `.github/actions/setup` (it no longer
only sets up Bun) and gained `install`, `turbo-cache` and `cargo-cache` inputs.
That deletes 33 copies of `bun install --frozen-lockfile`, 5 copies of the Turbo
cache block and 5 copies of the ~12-line Cargo cache block — three of which were
byte-identical inside one file. The three Cargo presets (`data-plane`,
`iroh-wasm`, `verify`) stay separate rather than collapsing to one key, because a
shared key would let jobs with different `target/` contents overwrite each
other's entry; a bad preset name now fails loudly instead of silently giving the
job no cache. `checkout` cannot move in (a composite action must be on disk to be
resolved), so `checkout` + `setup` is the irreducible prologue. Policy (4) of the
lint rejects a hand-rolled `bun install` — including the `- name:`-shaped one in
`npm-gateway-publish.yml` that a `- run:`-anchored pattern would have missed.
`github-release` and `restamp-rollout` in `.github/workflows/release-desktop.yml`
pass `install: 'false'`: they run plain `node scripts/release/*.mjs` and had no
install before.

**Extract the duplicated tracking-issue and report-slug shell into tested
scripts.** Four workflow blocks opened-or-updated a tracking issue with
near-identical inline shell, and they had already drifted — the nightly copy had
no `--label` fallback, and the "HTML missing" copy swallowed every failure with
`|| echo "::warning::"`. `scripts/ci/file-tracking-issue.mjs` is now the single
implementation, with `scripts/ci/file-tracking-issue.test.mjs` (11 cases) pinning
the branch that matters: a failed comment is reported, not swallowed, and a
failed `gh issue list` opens a new issue rather than going silent. Separately,
the immutable report slug was derived twice — once in `publish-nightly-report`,
once in `nightly-failure-issue` — with a comment asking the reader to keep them
in sync; if they disagreed the tracking issue would link to a 404.
`scripts/ci/run-slug.mjs` is the one derivation, and
`scripts/ci/run-slug.test.mjs` (6 cases) covers the case the old shell glob got
wrong: `[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]` accepts `2026-13-45`.

**Extract the container smoke shell out of the workflow.** The 28-line Docker
volume smoke in `lane-gateway-package.yml` moved to
`scripts/gateway-package/container-smoke.sh`, driven by `IMAGE` and `RUN_ID`, so
it can be run locally and shellcheck'd on the PR loop.

### Docs write-back (A1)

`TESTING.md` — the nightly SLA section now records that `cancelled` counts as
red, that a failed report job still publishes (and why `skipped` does not), that
the tracking issue cites the immutable dated slot, and that the companion and
interop lanes file their own issues. The report-slot table distinguishes the
mutable `nightly/` alias from the immutable `runs/<date>-<runId>/` archive and
points at the never-pruned `history/index.json`.

`AGENTS.md` — `lint:workflow-pins` added to the enumerated `check:pr` gate list
(now naming all five policies) so the pre-push contract stays accurate
(`CLAUDE.md` is a symlink to it), plus a paragraph recording that `check` now
aggregates every PR gate and why the one-PR-workflow rule exists.
`QUALITY.md` — the client-e2e pointer follows the file to
`lane-client-e2e.yml`.

## Decisions

- **`skipped` stays excluded from the nightly publish gate.** The obvious fix was
  `!= 'success'` → publish on anything. That would have re-broken the `#496`
  review case: single-lane dispatch skips the report job, and publishing then
  false-alarms the "HTML missing" tracking issue. The gate excludes `cancelled`
  and `skipped` specifically, not "not success".
- **`tunnel-pairing.journey` changed owner rather than adding a second flow at
  the same cell.** `validate-matrix.mjs` permits two flows on one
  surface+dimension, so the orphan could have been registered without touching
  `cross-network-relay.mjs`. Re-pointing is more honest: the lifecycle flow is
  the journey, the relay flow is the offline case, and the duplicate ownership
  was itself latent drift.
- **CodeQL is not on the PR loop.** A Rust database build is minutes against
  `ci`'s 20–25 min budget. Push-to-main plus weekly keeps alerts current without
  taxing every PR; `dependency-review` is the fast PR-side gate.
- **`dependency-review` starts at `fail-on-severity: high`, not `low`.** On a
  monorepo this size a `low` threshold is muted within a week. Tighten once the
  baseline is clean.
- **`setup-node@v4` was pinned to a v6.4.0 SHA, a major bump.** Pinning to a v4
  SHA would have frozen two call sites on a major the other nine had already left.
  The repo runs one version of each action or the pinning buys nothing.
- **The branch ruleset was left alone** — see Out of scope.
- **Reusable workflows for two lanes, inline jobs for the rest.** A uniform rule
  would have been simpler to state and worse to read: a `workflow_call` file
  costs ~10 lines of frame, which is more ceremony than the 5-step `docs` or
  `oauth-worker` lanes contain. Only `client-e2e` (3 jobs of Playwright/keyring
  setup) and `gateway-package` earn their own file. Jobs that call a reusable
  workflow are exempt from the `timeout-minutes` policy — GitHub rejects the key
  there, and the bound lives on the called workflow's jobs, which the lint walks
  anyway.
- **The five release workflows were deliberately NOT merged.** They are the
  fattest remaining target (613 lines across five files) and the one place where
  merging would be a regression: `NPM_TOKEN`, the Apple signing identity and GHCR
  push live in separate files today, so a compromised step in one has no path to
  the others' secrets. Tidiness is not worth a shared blast radius. Deploy jobs
  stayed out of `ci.yml` for the same reason.
- **`workflow_dispatch` was added to `ci.yml`.** Five of the folded workflows had
  it, and dropping it would have been a silent capability loss. On a manual run
  `dorny/paths-filter` has no base to diff, so the filter step is skipped and a
  `changes.outputs.all` flag forces every lane on — stated explicitly in each
  lane's `if:` rather than having the filter lie about what changed.
- **`.github/workflows/governance.yml` was left unbounded.** A `timeout-minutes`
  was added first, and the kit-runtime integrity directive blocked the commit:
  the file is `# governance-kit:managed` and digested at apply time, so any
  hand-edit is drift by definition and would be reverted by the next
  `governance update`. Rather than bypass the integrity check, the edit was
  reverted and `scripts/lint-workflow-pins.mjs` grew a marker-keyed exemption
  that logs a line on every run. Trading one unbounded job for a broken trust
  chain would be a bad exchange; the fix belongs upstream.
- **The new lint is policy, not syntax.** It deliberately overlaps nothing
  actionlint does — actionlint validates expressions and shell, this validates
  three repo policies actionlint has no opinion about.

## Out of scope

- **The product failures behind #556** — `mobile-e2e-ios` and the three pairing
  lanes. This change makes their redness visible; it does not fix them.
- **Adding path-filtered workflows to the ruleset's required checks.** Only
  `check` and `governance` are required today, so `client-e2e-pr`,
  `gateway-package`, `web`, `docs`, `oauth-worker` and `iroh-wasm` can go red and
  still merge. Requiring them directly would deadlock merges: a path-filtered
  workflow never reports on an unrelated PR, so the required check never arrives.
  The fix needs a merge queue or always-run skip-jobs first.
- **`main` currently violates `commit-message-format`.** `a33a39f8` was pushed
  directly to `main` with no `(#N)` suffix and no PR; governance caught it on the
  push run and nothing was notified. Fixing it means rewriting `main`'s history.
- **`sha_pinning_required` and `allowed_actions` at the repo/org level.**
  `scripts/lint-workflow-pins.mjs` now enforces the same property in-repo, where
  the failure message can explain itself; the GitHub-level toggle would also have
  to be reconciled with `docker://` and repo-local refs.
- **`strict_required_status_checks_policy: false`.** PRs merge without being
  current with `main`; combined with `test:affected` filtering on `origin/main`, a
  stale branch merges tested against an older base. A deliberate speed tradeoff
  to revisit, not a defect to fix here.
- **`mobile-android` stale workflow-registry entry** — GitHub lists it active but
  it exists on no branch of `main`. Cosmetic.
- **`interop-weekly` has still never run.** It landed Tue 2026-07-21 and its cron
  is Mondays 09:00 UTC, so its first window is 2026-07-27. Unproven, not broken.

## Verification

Workflow policy lint and its unit tests:

```bash
bun run lint:workflow-pins && node --test scripts/lint-workflow-pins.test.mjs
```

Matrix validation — proves the orphaned pairing flow is registered and the
re-pointed cells still validate:

```bash
bun run test:matrix
```

All workflow YAML against the exact actionlint CI pins, including the new
`security.yml`, the `join(needs.*.result, …)` expressions and the composite
action reference:

```bash
SHELLCHECK_OPTS=--severity=error actionlint -verbose
```

Monorepo package.json hygiene after adding `repository` to eleven packages:

```bash
bun run lint:packages
```

Full PR gate:

```bash
bun run check:pr
```

Results at authoring time: `lint:workflow-pins` reported 17 workflows clean;
`node --test` 8/8 pass; `test:matrix` reported 15 surfaces × 10 dimensions and 57
canonical flows with the nightly-wiring gate green; `actionlint -verbose` found
0 errors in 17 files; `sherif` reported no issues.

Repo settings, confirmed after applying:

```bash
gh api repos/srikanth235/centraid --jq '.security_and_analysis.dependabot_security_updates'
gh api repos/srikanth235/centraid/vulnerability-alerts -i | head -1
```

Returned `{"status":"enabled"}` and `HTTP/2.0 204 No Content` respectively.

## Steering

Fresh-context sub-agent attestation over session `cea40236-1c77-4e08-a82d-17a235f43724`.

- **(1) Every human-steering event in the transcript is recorded as a row in `### Steering`:** PASS — Found 2 steering events: (1) Ordinal 87 at 11:58:29 — user message "wait...take a step back and check for any other gaps in CI flows please" redirects agent from single issue to broader CI gap assessment (correction); (2) Ordinal 191 at 12:10:36 — user message "take a step back and evaulate for any otehr gaps/best practice reocmmendations for CI postures?" further redirects to evaluate all gaps and best practices (correction). Both recorded in `### Steering` table.

- **(2) No non-steering message is recorded as a steering event:** PASS — Examined all 7 distinct string-type user messages in the session; message at 12:03:27 asking "don't you think we should add dates...to the url?" was analyzed and deemed a follow-up suggestion rather than a mid-task redirect (per directive guidance: "Default to NOT recording if uncertain"). No tool denials or ordinary task messages recorded.

## Audit

Fresh-context sub-agent audit against the staged diff and issue #557.

- **(1) `## What changed` faithful to the diff:** PASS — All claimed changes are present and accurately described. Nightly report publishing gate changed from `== 'success'` to `!= 'cancelled' && != 'skipped'` (e2e.yml:810-811). Device-pairing-lifecycle.mjs now owns tunnel-pairing.journey in matrix.json (line 550). Dated report URL logic added to nightly-failure-issue (e2e.yml:962-973). companion-failure-issue job added to extension-e2e.yml with issues:write permission. Cancelled handling via `contains(join(needs.*.result, ','), 'failure') || contains(join(needs.*.result, ','), 'cancelled')` in e2e.yml (line 945), extension-e2e.yml, and interop-weekly.yml. Perf retry emits ::warning:: annotation and Job Summary block in ci.yml (line 167-189). Dependabot config (.github/dependabot.yml) covers actions/bun/cargo/docker weekly. CodeQL and dependency-review in new .github/workflows/security.yml. npm provenance: id-token: write permission in npm-gateway-publish.yml, --provenance flag in scripts/gateway-npm/publish.mjs. All floating action refs (twelve total) SHA-pinned in release workflows and npm-gateway-publish.yml. Dispatch inputs via env vars in npm-gateway-publish.yml, release-gateway-image.yml, and release-mobile.yml. Exactly 35 hardcoded `bun-version: 1.3.13` replaced with composite action across all workflows. New .github/actions/setup-bun/action.yml created. scripts/lint-workflow-pins.mjs and .test.mjs added, wired into package.json check:pr scripts and ci.yml static job. TESTING.md and AGENTS.md docs updated.

- **(2) Each `- [x]` realized in the diff:** PASS — All 16 checklist items verified:
  - Nightly report publish gate allows failed jobs ✓
  - Device-pairing-lifecycle registered in matrix.json ✓
  - Dated immutable report URL in nightly-failure-issue ✓
  - companion-failure-issue job in extension-e2e.yml with issues:write ✓
  - Cancelled treated as red (contains() logic) ✓
  - Perf retry emits ::warning:: signal ✓
  - Dependabot for actions/bun/cargo/docker ✓
  - CodeQL (javascript-typescript/actions/rust) in security.yml ✓
  - dependency-review on PRs in security.yml ✓
  - npm provenance (--provenance flag + id-token permission) ✓
  - All floating action refs SHA-pinned (12 locations) ✓
  - Dispatch inputs via env (npm-gateway-publish.yml, release-gateway-image.yml, release-mobile.yml) ✓
  - timeout-minutes added to 8 jobs (client-e2e-pr, docs, extension-release, gateway-package, governance, release-desktop×2, release-mobile) ✓
  - Composite setup-bun action replaces 35 hardcoded versions ✓
  - lint:workflow-pins enforces SHA-pins/no-hardcoded-bun/timeout (in check:pr and ci.yml static) ✓
  - Vulnerability alerts and Dependabot security updates (repo settings documented) ✓

- **(3) `## Checklist` mirrors the issue:** PASS — Receipt's 16-item checklist exactly matches GitHub issue #557's 16-item checklist (line-by-line identical).

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-cea40236-1c7-1785069563-1 | claude-code | cea40236-1c77-4e08-a82d-17a235f43724 | #557 | claude-opus-5 | 634 | 571703 | 61553190 | 227176 | 799513 | 40.0323 | 634 | 571703 | 61553190 | 227176 | ci: make red signals visible and close the supply-chain gaps (#557) -m Audit of  |
| claude-code-cea40236-1c7-1785070044-1 | claude-code | cea40236-1c77-4e08-a82d-17a235f43724 | #557 | claude-opus-5 | 58 | 55973 | 9249505 | 19431 | 75462 | 5.4606 | 692 | 627676 | 70802695 | 246607 | ci: make red signals visible and close the supply-chain gaps (#557) -m Audit of  |
| claude-code-cea40236-1c7-1785070106-1 | claude-code | cea40236-1c77-4e08-a82d-17a235f43724 | #557 | claude-opus-5 | 6 | 15888 | 995313 | 3456 | 19350 | 0.6834 | 698 | 643564 | 71798008 | 250063 | ci: make red signals visible and close the supply-chain gaps (#557) -m Audit of  |
| claude-code-cea40236-1c7-1785075385-1 | claude-code | cea40236-1c77-4e08-a82d-17a235f43724 | #557 | claude-opus-5 | 388 | 583793 | 37457409 | 180281 | 764462 | 26.8864 | 1086 | 1227357 | 109255417 | 430344 |  |
| claude-code-cea40236-1c7-1785075470-1 | claude-code | cea40236-1c77-4e08-a82d-17a235f43724 | #557 | claude-opus-5 | 8 | 10260 | 963002 | 2680 | 12948 | 0.6127 | 1094 | 1237617 | 110218419 | 433024 |  |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-cea40236-0-1 | cea40236-1c77-4e08-a82d-17a235f43724 | #557 | correction | classifier | Broaden scope to check for other CI gaps | pending | 87 | 2026-07-26T11:58:29.537Z |
| steer-cea40236-0-2 | cea40236-1c77-4e08-a82d-17a235f43724 | #557 | correction | classifier | Evaluate for other CI gaps and best practices | pending | 191 | 2026-07-26T12:10:36.702Z |
