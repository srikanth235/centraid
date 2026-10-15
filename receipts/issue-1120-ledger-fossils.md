# #1120 — the test ledgers lose the fossils of the retired shells

This follows up #1117 (#1113), which removed Tally from the same files, and the owner's request of 2026-10-15 to sweep the rest. It touches law and registry files only. The branch stacks on `claude/issue-1099-money`, so the two cannot conflict.

## What changed

Every path-bearing entry in `tests/inventory.json` and `tests/claims.json` was classified: (a) exists, (b) deleted with no rename, (c) moved to an existing successor, (d) not a path. The full history was fetched first, because the clone was shallow. `git log -M --diff-filter=DR` finds no rename whose source is a ledger path, and a basename sweep found only name coincidences, so class (c) is empty and nothing was re-pointed.

- `tests/inventory.json`, 4,105 entries removed and 107 kept:
  - `commentDensity.files`: 3,861 pins removed, 93 kept. `allowlist`: 74 removed, 5 kept.
  - `fileSize.sites`: 119 removed, 9 kept. `_budget` 128 to 9.
  - `skips.sites`: 22 removed. `_budget` 25 to 3.
  - `envRed.sites`: 4 removed. `_budget` 6 to 2.
  - `sleeps.sites`: 25 removed, which counted 36 fixed sleeps. `_budget` 36 to 0.
  - Each budget falls by exactly the rows removed. The five sections' `approvedDeviation` notes now name #1120, because the pairing rule reads a deleted pin or row as a widening. `envRed` and `sleeps` had no note and gained one.
- `tests/claims.json`:
  - 35 of 45 claim rows removed; the 10 kept have live owners.
  - 137 of 148 flows removed. The 134 with a floor each get a one-shot `removedMinimumTestsFlows` marker naming the deleted owner, the deleting commit and #1120. The three app-weight flows had no floor and need none.
  - The 8 `consentLedger` rows, 7 `joinLaws` rows and 21 `engineRegistry` rows; the keys stay, as empty arrays.
  - The `appEngines`, `appSeats`, `appStates` and `appScenarios` sections (every owner and flow they named is gone) and the `seats` vocabulary they used, whose doctrine anchor no longer exists.
  - The 25 `naCells` of those grids, 14 `workspaceSurfaces` and 4 `revisitTriggers` globs.
  - The 21 retirement markers already spent on the trunk, as the markers' own comment asks. The two Tally markers from #1117 stay.
- `tests/floors.json`: the derived `minimumTests` mirror, refreshed with `check-ledgers --write`.
- Kept as labels (class d): `lanes`, `vocabulary`, `severity`, `trackingIssues`, `gaps`, and the 27 `surface.*` N/A cells. Several describe surfaces that no longer exist (extension, oauth-worker, desktop); sweeping a vocabulary that lanes reference is a separate decision.
- Not done, six flows: pairs of flows share one deleted owner, and `ratchet-floors` allows one marker per deleted rig per change set. One of each pair is retired here; the other stays until a follow-up after this lands, when the first marker is on the base: `replica-multi-writer`, `desktop-app-open-journey`, `web-real-journey`, `gateway-journey`, `web-offline-pending-row` and `web-accessibility-axe`.
- Not touched: the three expired `tests/quarantine.json` lanes, whose owners are device-farm secrets and a runner label and not fossils. No expiry was extended.

## Verification

```sh
node scripts/test-report/ratchet-floors.mjs
node scripts/lint-oversized-files.mjs
node scripts/lint-law-registry.mjs
node scripts/test-report/lint-evidence-mapping.mjs
node scripts/test-report/sleep-inventory.mjs
node scripts/ci/advisory-expiry.mjs
node scripts/test-report/report-floors.mjs
```

Outcome: all seven exit 0. `ratchet-floors` reports "ok (no decreases vs origin/main)"; `sleep-inventory` was red before (36 slack) and is now green at 0 sites, budget 0; `lint-evidence-mapping` maps 53 lanes with the same warnings as before.

```sh
node scripts/check-ledgers.mjs
node scripts/check-comment-density-ratchet.mjs
node scripts/test-report/skip-inventory.mjs
node scripts/test-report/env-red-inventory.mjs
node scripts/test-report/hygiene-ratchet.mjs
node scripts/lint-journey-ledger.mjs
```

Outcome: all six exit 1, as on the base. `check-ledgers` now reports only the three expired quarantine lanes (it also checks the `minimumTests` mirror and every down-only budget against origin/main, both clean). `check-comment-density-ratchet` reports the same 13 risen pins in `packages/design` and the same 93 measured files. `skip-inventory` and `env-red-inventory` no longer report stale entries and now report only slack (budget 3 against 0 skips, budget 2 against 0 guard sites): the brief caps a fall at the rows removed, so the last tightening is left for the owner. `hygiene-ratchet` is unchanged and is not path-keyed. `lint-journey-ledger` still names the deleted Tally consumer in the territory file `tests/journeys.json`.

```sh
node node_modules/vitest/vitest.mjs run --config scripts/test-report/vitest.config.ts
node --test scripts/check-ledgers.test.mjs scripts/check-comment-density-ratchet.test.mjs scripts/lint-law-registry.test.mjs scripts/lint-journey-ledger.test.mjs
bash .governance/packs/srikanth235/centraid/directives/coverage-scope-reachability/check.sh
```

Outcome: the vitest run has the same 7 failures in `validate-release-wiring.test.mjs` as the base (175 pass either way); the 51 `node --test` cases pass; the reachability directive passes.

```sh
CARGO_TARGET_DIR=/home/user/target-1120 cargo xtask rules && bun run check:push:static
node .governance/law/run.mjs
```

Outcome: pass. Every rule is ok and 4/4 static gates pass. The law window door reports ten rules and one finding, `receipt-per-issue` on this receipt's own Audit, which stays PENDING until an independent auditor fills it.

## Audit

PENDING
