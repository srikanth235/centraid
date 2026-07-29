# Test-report zero-grey umbrella — issue #587

Progress log for [issue #587](https://github.com/srikanth235/centraid/issues/587).
The issue's resolved sequencing is authoritative: A → B → D4 → C → the
remaining D work → E/F. This file records implementation state and durable
decisions for the multi-session change.

## Scope map

- [x] A — report honesty: Playwright owner resolution, evidence matchability,
      zero-grey nightly, and explicit absence/failure states
- [x] B — honest matrix labels: tracked gaps, structural skips, compat revisit
      triggers, and distinct partial presentation
- [x] C — ten missing perf/scale harnesses plus extension/oauth-worker triage
- [x] D — identity history, flake/actionability/trends, floor signals, debt
      inventory, matrix completeness, notifications, and quality dimensions
- [x] E/F — required-check-capable mobile bundle/native guards and dependency
      update policy
- [ ] Verification — nightly-equivalent report, full PR gate, receipt audit,
      and green GitHub Actions

## Working decisions

- Keep per-push/main grey legal; only a full nightly has an absolute zero-grey
  contract.
- Preserve `lane-did-not-run`, `owner-silent`, `evidence-unmatched`,
  `infra-mismatch`, and product `failed` as separate report states even though
  all but main-slot absence fail a nightly.
- Treat `skip` as structural N/A only. A missing harness is a tracked `gap`.
- New perf/scale budgets start as trailing-median regression guards, not
  invented absolute limits. Durable numeric history lands before the harnesses.
- Native drift uses a committed fingerprint ratchet, not generated-template
  equality, because the native projects contain intentional customizations.
- Root manifest and lockfile changes feed the existing `ci.yml` changes job so
  mobile smoke remains eligible to be a required check.

## Progress

### 2026-07-28 — baseline

- Created `codex/issue-587-test-report` from `origin/main` at `aaa347cb`.
- Confirmed the baseline checkout is clean and the umbrella acceptance criteria
  include the 2026-07-28 E/F addendum.
- Baseline commands and matrix totals will be recorded before implementation.

### 2026-07-29 — implementation

- Repaired Playwright owner resolution, added Playwright orphan detection and
  full-nightly owner matchability, and made the nightly zero-grey contract
  absolute while retaining the main-slot ratchet.
- Added explicit `evidence-unmatched`, `lane-did-not-run`, `owner-silent`,
  `infra-mismatch`, and `flaky` states, identity history, numeric lane trends,
  per-owner flake rates, actionable failure details, debt inventories, and
  QUALITY.md Open observations.
- Tightened the matrix contract with structured live tracking, closed-issue
  rejection, compat migration triggers, non-boilerplate partial notes, and
  workspace completeness. The checked-out baseline was
  38 solid / 62 partial / 50 skip / 0 gap (the issue snapshot recorded
  38 / 63 / 49 / 0); the result is 48 / 62 / 38 / 2.
- Added four performance rigs and six scale rigs, split their nightly work into
  an independent 30-minute lane, and established a 3× trailing-median budget
  after ten samples rather than inventing absolute limits.
- Added a required-check-capable mobile smoke job, iOS and Android Metro
  exports, committed native fingerprints, native lock/path consistency checks,
  advisory Expo compatibility diagnostics, an SDK-derived Xcode assertion,
  and per-major Dependabot isolation.
- Cherry-picked the prerequisite #609 repair because `main` still carried the
  SDK 57 Babel/native breakage; without that repair, the new required bundle
  gate would be red by construction.

## Durable decisions

- The report accepts supply-chain, bundle-size, and accessibility as useful
  future dimensions, but does not add hollow columns before their lanes exist;
  #587 remains their live umbrella until they are split into follow-up issues.
- Android uses the same committed-fingerprint guard as iOS, the JS smoke
  exports both platforms, and native-lock validation is iOS-specific because
  Android dependency resolution has no committed lock equivalent in this repo.
  Android runner/toolchain liveness remains owned by its journey lane.
- `expo install --check` is advisory: it catches SDK compatibility drift but
  did not catch either Babel 8 failure class. Metro export is the blocking
  compensating control.
- Dependabot continues proposing majors. Only their grouping changes: each
  major gets an independent PR so the suite can accept or reject that exact
  upgrade, while patch/minor updates remain grouped.

## Verification ledger

Commands are appended here as phases complete; the issue receipt remains the
final replayable verification source.

- `bun run test:ratchet:unit` — 114 passed.
- `bun run test:matrix` — passed.
- `bun run test:report:smoke` — passed.
- `bun run test:perf` — 11 passed, 2 skipped (one existing noisy
  `vault-write` rerun was required).
- `bun run test:scale` — 12 passed.
- `bun run build` — 17/17 tasks passed on a clean cold build.
- `bun run --cwd apps/mobile ci:native-state` — passed.
- `bun run --cwd apps/mobile ci:bundle` — iOS 2,132 modules and Android 2,129
  modules bundled successfully. Before the #609 prerequisite was installed,
  the same gate reproduced Babel 8's `Requires Babel "^7.0.0-0"` failure.
- `bun run check:pr:full` — all gates passed; affected tests completed 36/36
  tasks and diff coverage completed 760 files / 6,255 tests, with the
  repository's approved 47.6% coverage deviation.
