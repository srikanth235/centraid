# Issue #464 — Fold pairing-relay journeys into nightly e2e

GitHub issue: [#464](https://github.com/srikanth235/centraid/issues/464)

## Checklist

- [x] Three pairing owners run as jobs inside nightly e2e (not a separate top-level workflow)
- [x] Report job merges same-run pairing artifacts; no `gh run list --workflow pairing-relay-e2e.yml`
- [x] `pairing-relay-e2e.yml` removed
- [x] Docs describe one nightly lane
- [x] Matrix owners unchanged; `bun run test:matrix` passes
- [x] PR open with clear summary

## What changed

Three pairing owners run as jobs inside nightly e2e (not a separate top-level workflow): `pairing-lifecycle`, `pairing-ticket-hygiene`, and `pairing-cross-network-relay` now live in `.github/workflows/e2e.yml` and invoke `tests/agent-e2e-pairing/flows/device-pairing-lifecycle.mjs`, `pairing-ticket-hygiene.mjs`, and `cross-network-relay.mjs`.

Report job merges same-run pairing artifacts; no `gh run list --workflow pairing-relay-e2e.yml` — deleted the foreign-run merge step; uploads use `nightly-evidence-pairing-lifecycle`, `nightly-evidence-pairing-ticket-hygiene`, and `nightly-evidence-pairing-cross-network-relay` so `pattern: nightly-evidence-*` already covers them.

`pairing-relay-e2e.yml` removed — deleted `.github/workflows/pairing-relay-e2e.yml`.

Docs describe one nightly lane — `TESTING.md` lane table and `tests/agent-e2e-pairing/README.md` point at e2e only.

Matrix owners unchanged; `bun run test:matrix` passes — catalog still points at the same flow scripts; `package.json` `test:matrix` now also runs `scripts/test-report/validate-nightly-wiring.mjs` so the fold cannot silently regress.

PR open with clear summary — this work ships via the PR that closes #464 with the fold described above.

## Out of scope

- Fixing the cross-network-relay `isRelay` / Docker isolation flake on runners.
- Running pairing journeys on every PR `ci` job.
- Companion extension e2e, Codex EPIPE, report UX changes.
- Renaming the workflow from `e2e` to `nightly`.

## Decisions

- Keep three independent jobs (not one sequential job) so one flaky relay run still leaves lifecycle/hygiene evidence for the health report — same isolation rationale as the old standalone workflow, without a second top-level workflow file.
- Do not mark cross-network-relay `continue-on-error`; failure still fails that job, but `test-health-report` runs with `if: always()` so partial evidence still publishes.

## Verification

```sh
bun run test:matrix
# expects: matrix summary + "nightly-wiring: e2e.yml owns pairing lifecycle..."
```

Structural proof greps e2e.yml for the three flow scripts, `nightly-evidence-pairing-*` artifact names, report `needs`, absence of `pairing-relay-e2e.yml`, and no executable `gh run download` / pairing-relay workflow list. Captured under the implementer scratch as `test-matrix.txt` and `pairing-fold-diff.txt`.

## Audit

PASS — diff matches the checklist: pairing jobs live only under e2e.yml, standalone workflow file deleted, report job no longer fetches foreign runs, docs and matrix-validation wiring updated, flow owners unchanged.

## Steering

PASS — no user interrupts or mid-task corrections redirected this work; single-shot fold of pairing-relay into e2e per the agreed plan for issue #464.

## Accounting

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | total | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | cum-cost-usd |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
