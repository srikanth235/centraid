# #1113 — the law-estate test ledgers lose Tally

This follows up PR #1112, which deleted Tally from v0 (#1099). It touches law and registry files only. `tests/journeys.json` is territory, so its Tally rows are #1114.

## What changed

- `tests/claims.json`:
  - Removed the `tally` block from each of the four `app*` sections.
  - Removed the four `naCells` rows: `appSeats.tally.viewer` and `appEngines.tally.{custody,consent,triage}`.
  - Removed the flows `mobile-sharing-reach` and `mobile-pending-restart-journey`. Each gets a one-shot `removedMinimumTestsFlows` marker, which `ratchet-floors` requires, naming the deleted rig and #1099.
- `tests/floors.json`: the two derived `minimumTests` mirror rows, refreshed with `check-ledgers --write`. The one remaining text mention is a historical `approvedDeviation` and stays.
- `tests/inventory.json`:
  - Removed 162 `commentDensity.files` rows, one allowlist row and three `fileSize.sites` rows.
  - `_budget` goes from 131 to 128.
  - The `commentDensity` and `fileSize` `approvedDeviation` notes now name the removals, because the pairing rule reads a deleted pin as a widening.
- Left in place as historical evidence: past-tense mentions of Tally in a `claims.json` flow note.
- Not done: the stale paths outside Tally. About 97% of the paths in `inventory.json` (3,897 of 3,999) and 93% in `claims.json` (329 of 353) point at files the retired web, desktop and TypeScript shells took with them. Sweeping them is a separate decision.

## Verification

```sh
node scripts/test-report/ratchet-floors.mjs
node scripts/lint-oversized-files.mjs
node scripts/lint-law-registry.mjs
node scripts/test-report/lint-evidence-mapping.mjs
```

Outcome: all four pass with exit 0. `ratchet-floors` reports "ok (no decreases vs origin/main)". `lint-evidence-mapping` maps 53 lanes and prints two warnings that were already there.

```sh
cargo xtask rules && bun run check:push:static
```

Outcome: pass. Every rule is ok, and 4/4 static gates pass. The law hook door reported no findings on either commit.

```sh
node scripts/check-ledgers.mjs
```

Outcome: fail, the same as on origin/main. Three `tests/quarantine.json` lanes expired on 2026-10-04. This change neither causes nor touches that, and the comment-density and `hygiene-ratchet` slack findings are also as they were before.

## Audit

**PASS.** An independent Sonnet auditor checked the law commit against this receipt. It was read-only and had no part in writing the change.

- **Only Tally was removed: PASS.**
  - `claims.json` loses the `tally` element from each of `appEngines`, `appSeats`, `appStates` and `appScenarios`; the other seven entries in each are identical.
  - `naCells` goes from 56 to 52 and flows from 150 to 148.
  - No surviving value changed; the only additions are the two `removedMinimumTestsFlows` markers.
- **No number loosened: PASS.** `_budget` 131→128 equals the drop in `fileSize.sites`, and `floors.json` loses only the two removed flows' mirror rows.
- **The counts match: PASS.** `commentDensity.files` 4116→3954 (162 rows), allowlist 80→79, `fileSize.sites` 131→128, 4 `naCells`, 2 markers, 4 app blocks.
- **Nothing missed: PASS.** Every `tally` match left in the three files is historical text: the two marker reasons and an owner path, two `approvedDeviation` notes, and one older deviation note.
- **The scripts pass: PASS.** `ratchet-floors`, `lint-oversized-files`, `lint-law-registry` and `lint-evidence-mapping` all exit 0 (the last with two warnings that were already there).

The auditor also found the law commit's message said "seven" `naCells`, where the diff has four. The message was corrected before push.
