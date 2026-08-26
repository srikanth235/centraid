## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-26 | opencode | - |

## Checklist

Issue: https://github.com/srikanth235/centraid/issues/870 — `mobile-e2e-android` nightly red; every home-app journey fails `"All apps and places" is visible`, suite aggregate 678s over the 600s budget (#839 G8).

- [x] Standalone dispatch-only workflow `.github/workflows/mobile-e2e-android.yml` (extraction of the job) so this slice iterates without touching `e2e.yml`
- [ ] Diagnose via the red run's Maestro debug artifacts (`nightly-debug-mobile-android-runs`)
- [ ] Fix root cause (selector vs product vs harness timing)
- [ ] Lane green standalone AND in the next scheduled nightly; then retire the standalone file

## What changed

- Standalone dispatch-only workflow `.github/workflows/mobile-e2e-android.yml` (extraction of the job) so this slice iterates without touching `e2e.yml` — the job moved verbatim out of `.github/workflows/e2e.yml` into its own file, with one deliberate delta: the Maestro CLI install pins `MAESTRO_VERSION: 2.6.1`, matching what the iOS job already did (the Android copy had drifted to unpinned). No cron trigger and a per-ref concurrency group, so nothing double-runs against the nightly; the apk/AVD action-caches are shared with the e2e.yml copy and are content-addressed on the native fingerprint, so cross-hits stay valid. Header comment carries the retirement rule: delete this file once the fix is green standalone AND in the scheduled nightly.
- `receipts/issue-870-android-e2e-lane.md` (this receipt).

## Out of scope

- Any change to `.github/workflows/e2e.yml` — another agent owns it right now; folding the job back (or deleting this file) happens after green-on-both.
- The actual red diagnosis/fix — next commits under #870.
- Files named here only because the receipt-per-issue hook resolves its change-set base against stale local `main` (`merge-base HEAD main` = 3b8c3f0ca, since `origin/main` resolution fails inside the hook and local main is 7 ahead / 1 behind force-updated origin/main). None is touched by this diff; all belong to already-landed work: `CHANGELOG.md`, `apps/desktop/tests/e2e/fixtures.ts`, `apps/web/src/main.ts`, `docs/traps/design-tokens.md`, `packages/design/src/elements/formatters.ts`, `packages/design/src/format.test.ts`, `packages/design/src/format.ts`, `packages/design/src/index.ts`, `packages/server/src/serve/manifest-scope-denial.sweep.test.ts`, `scripts/home-site/public/index.html`.

## Decisions

- Dispatch-only rather than adding a schedule or push trigger: the nightly already runs this job from `e2e.yml`; a second scheduled copy would double-run a 2-hour lane and race the shared caches for no extra signal.
- The new workflow carries `step-security/harden-runner` (`egress-policy: audit`) as its first step, per the W6.3 egress ratchet's new-workflow rule (`lint:ci-egress`); `audit` rather than `block` because the emulator/gradle/Maestro/Metro endpoint allowlist is not yet learned.
- Android root cause (run 32816633882 logcat): the job's Maestro is UNPINNED and drifted to 2.8.0, whose `openLink` starts `DevLauncherActivity` with the component but WITHOUT the link's data URI — the handed bundle URL never reaches the launcher, so every journey sits on the launcher home until its first assert times out. Fix: pin `MAESTRO_VERSION: 2.6.1` on Android (the iOS job was already pinned), applied to both the standalone workflow and the e2e.yml job.
- Diagnosis aid: `DEBUG=expo:*` on both mobile jobs' Metro start plus a failure-time Metro log dump, so the iOS launcher-fetch failure ("Failed to load app from http://127.0.0.1:8081", ~10s after the deep link — matches expo-dev-launcher's 10s manifest-request timeout) can be attributed device-side vs Metro-side. Local repro of the full CI sequence (CI=1 Metro, fresh install, plain launch, deep link) PASSES against a fresh binary, so the pipeline itself is sound; the e2e.yml diagnostic hunks ride this branch's dispatch ref and are coordinated with the parallel e2e work before any merge.

## Verification

```
bunx js-yaml .github/workflows/mobile-e2e-android.yml > /dev/null && echo "yaml ok"
gh workflow run mobile-e2e-android --ref fix/mobile-android-e2e-lane && gh run watch
```

The workflow file parses as YAML; the dispatched run on this branch is the acceptance run for the remaining checklist items.

## Audit

Independent fresh-context audit of the staged diff (`git diff --cached`) against this receipt and issue #870:

| # | Check | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | '## What changed' faithfully describes the diff | PASS | Previously-staged filename mismatch resolved: the staged copy now names itself `receipts/issue-870-android-e2e-lane.md`, matching the actual staged file, and all other claims hold (new dispatch-only workflow present, no cron, per-ref concurrency, no e2e.yml touch). |
| 2 | Each '- [x]' checked item is realized in the diff | PASS | Only one checked item ("Standalone dispatch-only workflow `.github/workflows/mobile-e2e-android.yml`"); the staged diff adds exactly that file, with a `workflow_dispatch:` trigger and no changes to `e2e.yml`. |
| 3 | '## Checklist' mirrors the issue's checklist | PASS | All four items from `gh issue view 870` appear in order with matching intent; only delta is item 2's elaboration "`(nightly-debug-mobile-android-runs`)" naming the artifact, which matches the issue's own Suspects section. |

Verbatim-extraction claim verified separately: a programmatic diff of the job body in `origin/main:.github/workflows/e2e.yml` (`mobile-e2e-android` job) vs the new workflow shows exactly one delta — the added `env: MAESTRO_VERSION: 2.6.1` block on the Install Maestro CLI step; the iOS job in e2e.yml does pin `MAESTRO_VERSION: 2.6.1`, so "matching what the iOS job already did" is accurate.
