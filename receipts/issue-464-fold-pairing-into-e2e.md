# Issue #464 — Fold pairing-relay into nightly e2e + testing inventory

GitHub issue: [#464](https://github.com/srikanth235/centraid/issues/464)

## Checklist

- [x] Three pairing owners run as jobs inside nightly e2e (not a separate top-level workflow)
- [x] Report job merges same-run pairing artifacts; no `gh run list --workflow pairing-relay-e2e.yml`
- [x] `pairing-relay-e2e.yml` removed
- [x] Docs describe one nightly lane
- [x] Matrix owners unchanged; `bun run test:matrix` passes
- [x] PR open with clear summary
- [x] Codex backend write EPIPE no longer fails Vitest after child stdin closes
- [x] Test-health report surfaces unhandled Vitest errors and failed-vs-missing cells
- [x] Expected prewarm ENOENT no longer spams warn logs
- [x] Env-gated solid/partial matrix owners are inventoried and validated
- [x] agent-runtime coverage strategy recorded; floors not raised; WAL multi-day hotspot improved
- [x] Per-PR `ci.yml` parallelized (static + verify) with Bun/Turbo/Cargo caches; required `check` aggregator kept
- [x] Test-health report one-hop UX: Job Summary + public GitHub Pages URL on **main** (and nightly); not on PRs

## What changed

Three pairing owners run as jobs inside nightly e2e (not a separate top-level workflow): `pairing-lifecycle`, `pairing-ticket-hygiene`, and `pairing-cross-network-relay` live in `.github/workflows/e2e.yml`.

Report job merges same-run pairing artifacts; no `gh run list --workflow pairing-relay-e2e.yml` — foreign-run merge step deleted; `nightly-evidence-pairing-*` artifacts merge via existing `nightly-evidence-*` pattern.

`pairing-relay-e2e.yml` removed.

Docs describe one nightly lane — `TESTING.md` and `tests/agent-e2e-pairing/README.md`.

Matrix owners unchanged; `bun run test:matrix` passes — plus `validate-nightly-wiring.mjs` and env-gate checks in `validate-matrix.mjs`.

PR open with clear summary — https://github.com/srikanth235/centraid/pull/465.

Codex backend write EPIPE no longer fails Vitest after child stdin closes — `packages/agent-runtime/src/backends/codex/safe-stdin-write.ts` and `packages/agent-runtime/src/backends/codex/safe-stdin-write.test.ts`; wired from `packages/agent-runtime/src/backends/codex/backend.ts` and `packages/agent-runtime/src/backends/codex/model-list.ts`.

Test-health report surfaces unhandled Vitest errors and failed-vs-missing cells — `scripts/test-report/report-signals.mjs`, `scripts/test-report/report-signals.test.mjs`, `scripts/test-report/generate.mjs`, `scripts/test-report/smoke.mjs` (unhandled banner + cellsFailed/cellsMissing legend).

Expected prewarm ENOENT no longer spams warn logs — `packages/gateway/src/serve/app-prewarm-errors.ts`, `packages/gateway/src/serve/app-prewarm-errors.test.ts`, `packages/gateway/src/serve/build-gateway.ts`.

Env-gated solid/partial matrix owners are inventoried and validated — `scripts/test-report/validate-matrix.mjs` + report-signals `detectDefaultCiEnvGate` / `collectEnvGatedOwners` (includes `t.skip` after `process.env.X !== '1'`, matching `packages/vault/src/blob/disk-full.integration.test.ts`). Demoted `blob-custody.durability` from partial→gap in `tests/matrix.json` (cellOwner null) so partial no longer claims a default-CI-skipped sole owner.

agent-runtime coverage strategy recorded; floors not raised; WAL multi-day hotspot improved — `TESTING.md`; `packages/gateway/src/backup/wal.integration.test.ts` multi-day outage 8→4 simulated days.

Also: `package.json` `test:matrix` chain; `scripts/test-report/validate-nightly-wiring.mjs`.

## Out of scope

- Fixing the cross-network-relay `isRelay` / Docker isolation flake on runners.
- Running pairing journeys on every PR `ci` job.
- Full agent-runtime line-coverage campaign to 70%+.
- Making every GitHub Actions nightly desktop/web/mobile job green in this environment.
- Companion PR #463 security follow-ups.


## Decisions

- Keep three independent pairing jobs (not one sequential job) for failure isolation without a second workflow file.
- EPIPE handled at the real stdin write boundary (error sink + write callback), not only a `writable` check — matches the async failure mode Vitest reported.
- Prewarm ENOENT is silent; other prewarm errors stay at warn.
- Env-gate honesty is a hard matrix validation error for solid/partial owners, not only a report footnote.
- agent-runtime keeps a low line floor by design; document rather than raise.
- Multi-day WAL outage uses 4 days instead of 8: same constant-bound claim, less wall clock.
- CI parallelization keeps coverage/perf/native on every PR (no demotion to nightly in this change); gains come from job parallelism + caches, not weaker gates.
- Required GitHub check stays named `check` via aggregator so existing branch protection does not need a rename.
- Report UX: public Pages HTML only from **main** (`publish-report`) and nightly (`publish-nightly-report`). PRs keep Job Summary + artifact only (no Pages slot, no sticky comment). `publish-report` does not gate the required `check` job.
- Pages deploys serialize on `github-pages-test-report` and merge via the `gh-pages` branch so main/nightly slots are not wiped.

## Verification

```sh
bun run format:check
bun run test:matrix
bun run test:report:smoke
bun run test:report:smoke
bun run --cwd packages/agent-runtime test -- src/backends/codex/safe-stdin-write.test.ts
bun run --cwd packages/gateway test -- src/serve/app-prewarm-errors.test.ts
bun run --cwd packages/gateway test -- src/backup/wal.integration.test.ts -t "offline for multiple"
git diff origin/main -- tests/coverage-floors.json   # empty = floors not raised
```

Format: oxfmt on `safe-stdin-write.test.ts` and `app-prewarm-errors.test.ts` (CI `format:check` fix).

Lint: oxlint clean on `safe-stdin-write.ts` / `.test.ts` (no useless returns, no EventEmitter in tests).

Typecheck: annotate `FakeStdin` interface so `makeFakeStdin` no longer hits TS7022 circular self-reference on CI `bun run typecheck`.

Pre-push local gates: `package.json` `check:pr` (aliased as `ci`) runs the early [`.github/workflows/ci.yml`](.github/workflows/ci.yml) steps — format, oxlint, turbo lint, typecheck, lint:types, lint:css, test:matrix — so agents catch CI failures before Actions. Documented in `README.md`, `AGENTS.md`, and `TESTING.md`.

Per-PR `ci.yml` parallelized (static + verify) with Bun/Turbo/Cargo caches; required `check` aggregator kept — former serial `check` job (~18 min) becomes parallel **`static`** (format/lint/typecheck/matrix) and **`verify`** (build/native/data-plane/perf/coverage/report), plus thin required **`check`** aggregator for branch protection. Bun install, Turbo `.turbo`, and data-plane Cargo caches; cancel-in-progress concurrency. Docs: `AGENTS.md`, `README.md`, `TESTING.md`; wording only in `apps/desktop/tests/e2e/COVERAGE_REPORT.md` (PR `ci` job → workflow).

Test-health report one-hop UX: Job Summary + public GitHub Pages URL on **main** (and nightly); not on PRs — `scripts/test-report/summary-markdown.mjs`, `scripts/test-report/write-job-summary.mjs`, `scripts/test-report/prepare-pages-site.mjs`; `scripts/test-report/generate.mjs` emits `summary.json`/`summary.md`; CI `publish-report` (main push only) + e2e `publish-nightly-report` merge into `gh-pages` and `actions/deploy-pages`. Follow-up after #465: fixed ci.yml YAML (missing newline after Job Summary step that zero-job-failed main CI) and dropped PR Pages slots / sticky PR comments per user request.

## Audit

PASS — pairing fold plus inventory backlog (EPIPE, report signals, prewarm, env-gate, strategy/floors/WAL), CI wall-clock parallelization, and main/nightly Pages report UX match the expanded #464 work (PR #465 + main-only follow-up).

## Steering

PASS — user redirected scope mid-stream from fold-only to “fix all of them into this PR” (the testing-inventory prioritized list); that correction is recorded here. No other interrupts.

## Accounting

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | total | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | cum-cost-usd |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
