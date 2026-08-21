# Issue #802 — fix red main after #800

GitHub issue: [#802](https://github.com/srikanth235/centraid/issues/802)

`main` went red on the #800 push (`50a79022e`). Two independent gates failed;
neither is a product-floor change.

## Checklist

- [x] `bun run test:ratchet` is green on this branch against `origin/main`
- [x] Spent `replacesMinimumTestsFlow` markers for `desktop-builder-journey` and `mobile-template-gate` are gone; their `approvedMinimumTestsDeviation` ledgers stay
- [x] `tests/matrix.json` whole-file fingerprint re-pinned; qualities / `demonstratedRed` / `matrixGovernanceFingerprint` unchanged
- [x] Web offline-reconnect journey writes through the already-open Tasks session after the harness transport is severed

## User impact

None at runtime. Offline add still queues, survives a reload, and settles
once on reconnect — the journey no longer remounts an already-open Tasks
route first.

## What changed

`bun run test:ratchet` is green on this branch against `origin/main`. Spent
`replacesMinimumTestsFlow` markers for `desktop-builder-journey` and
`mobile-template-gate` are gone; their `approvedMinimumTestsDeviation`
ledgers stay. `tests/matrix.json` whole-file fingerprint re-pinned; qualities /
`demonstratedRed` / `matrixGovernanceFingerprint` unchanged. Web
offline-reconnect journey writes through the already-open Tasks session
after the harness transport is severed.

**Spent ratchet markers** in `tests/matrix.json`. #799/#800 recorded two
flow-floor transfers with `replacesMinimumTestsFlow`. Those markers are
one-shot: they exist to account for a removal against the merge base. Once
#800 landed, the predecessors left `main` and `ratchet-floors` reported
`flow replacement names unknown predecessor` for every comparison against
`origin/main`, including `main` against itself. Same leftover #753 already
paid down after #749. Only the markers are removed. The paired
`approvedMinimumTestsDeviation` strings stay as the provenance ledger.
`tests/quality/classification-ratchet.json` re-pins the `tests/matrix.json`
whole-file fingerprint and records the #802 `approvedDeviation`; qualities
and `demonstratedRed` are untouched so `matrixGovernanceFingerprint` is
unchanged.

**Offline-reconnect remount** in
`apps/web/tests/e2e/offline-reconnect.spec.ts`. The journey proved
write-rail readiness, then severed the harness transport and remounted
Tasks via the command palette "exactly as pending-overlay does". That is
not what pending-overlay does. pending-overlay remounts Tasks by switching
*from another app*, which reuses the warm replica session (30s idle grace).
Remounting the *same* route after the toggle starts a new replica walk; an
offline walk cannot finish; the add throws `not-bootstrapped` and the board
paints "No vault access yet". CI screenshot from run 31932075555 shows the
title still in the capture bar and an empty Today view. The fix writes
through the session the readiness probe already proved. The next write's
drain sees the dead harness transport and admits the intent as queued. The
later full reload while still offline remains the durability check.

**Changelog.** `CHANGELOG.md` records the two CI fixes under Unreleased /
Fixed.

## Decisions

#802 removes two spent replacesMinimumTestsFlow markers left on main by #800 (desktop-builder-journey, mobile-template-gate). They are one-shot: once the predecessors left main, ratchet-floors fails on the base branch against itself. The matrixGovernanceFingerprint is unchanged because qualities and demonstratedRed are untouched. No quality grade, budget, or demonstrated-red claim weakens.

The offline-reconnect remount is a test-sequence bug, not a product-floor
change. A same-route remount that starts a new replica walk while the
transport is down is not the contract TESTING.md names; the durable outbox
reload after the queued write is.

## Out of scope

- The previous `main` push (#798) `verify` failure on `test:perf:pr` /
  `perf:low-end` (retried once, still red). Separate flake/budget question.
- Teaching `replacesMinimumTestsFlow` to no-op once the predecessor is gone
  from the base. The one-shot design is deliberate; delete spent markers.
- Changing `submitCapture` to treat `queued` as success. The board refresh
  already projects the pending row; this issue does not retune capture UX.
- Making a same-route remount restore a remembered replica while offline.
  Real if a member re-opens Tasks from the palette during an outage; not
  required to unblock `main`.

## Verification

```sh
bun run test:ratchet
bun run lint:quality-knobs
bun run test:matrix
bun run test:ratchet:unit
bun run test:qualities
bun run typecheck:affected
bun run format:check
```

- `bun run test:ratchet` is green on this branch against `origin/main` (25 inventoried skips).
- `bun run lint:quality-knobs` — no silent widening.
- `bun run test:matrix` — 15 surfaces × 11 dimensions, 128 canonical flows.
- `bun run test:ratchet:unit` — 314 passed.
- `bun run test:qualities` — 23 passed, including the offline-reconnect integration.
- `bun run typecheck:affected` — green after a worktree `bun run build`.
- `bun run format:check` — 4272 files clean.
- Web Playwright `offline-reconnect.spec.ts` not re-run locally (needs the CI
  harness gateway). Diagnosis is from the failed run's screenshot and
  accessibility snapshot: remount painted `not-bootstrapped`.

## Audit

- (1) What changed vs diff: PASS — Working tree vs `50a79022e` is the four files named: `tests/matrix.json` drops only the two `replacesMinimumTestsFlow` keys on `desktop-app-open-journey` / `mobile-native-v0-resilience`; `tests/quality/classification-ratchet.json` rewrites `approvedDeviation` to the #802 text and re-pins the `tests/matrix.json` fingerprint (`4bfddbca…` → `64fbb17c…`) while leaving `matrixGovernanceFingerprint` and the other file hashes unchanged; `apps/web/tests/e2e/offline-reconnect.spec.ts` removes the post-`setHarnessControlOnline(false)` `openFirstParty(..., "Tasks")` remount; `CHANGELOG.md` adds one Unreleased/Fixed bullet for #802.
- (2) Checked items realized in the diff: PASS — Spent `replacesMinimumTestsFlow` lines are gone and both `approvedMinimumTestsDeviation` ledgers remain; the matrix whole-file fingerprint is re-pinned with qualities / `demonstratedRed` / `matrixGovernanceFingerprint` untouched; the offline journey now fills/adds on the already-open Tasks session after the transport is severed. The ratchet-green box is a verification claim (receipt reports it green) whose enabling edit is the marker deletion.
- (3) Checklist mirrors the issue: PASS — Issue #802 now has a `## Checklist` with the same four work items, in the same order and wording, as the receipt (ratchet green against `origin/main`; spent `replacesMinimumTestsFlow` markers gone with `approvedMinimumTestsDeviation` kept; matrix fingerprint re-pinned with qualities / `demonstratedRed` / `matrixGovernanceFingerprint` unchanged; offline-reconnect writes through the already-open Tasks session). GitHub boxes are unchecked; the receipt marks them `[x]`.
