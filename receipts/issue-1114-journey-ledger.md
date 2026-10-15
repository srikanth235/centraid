# #1114 — the journey ledger loses Tally

This follows up PR #1112, which deleted Tally from v0 (#1099). It edits territory and registry files only. `tests/journeys.json` is not in the law estate, so it goes apart from the PR for the law ledgers (`tests/{claims,floors,inventory}.json`, #1113).

## What changed

- `tests/journeys.json`:
  - The `year3-tally` volume is removed, along with its one entry, `gateway/app-read/year3-tally/ci-linux-x64-4c`. That entry's consumer, `crates/apps/tally/tests/year3.rs`, and the fixture `crates/apps/kit::fixtures::year3_tally` were deleted in #1112.
  - All three of the entry's metrics (`dashboardFold`, `searchFold`, `writeThroughTheGate`) were `status: "projected"` and parked under `_observedMs`, so the ratchet read neither and no ceiling moves.
  - The root `approvedDeviation` and `entries.approvedDeviation` each gain a leading #1099 note saying what was removed. `check-ledgers` reads the section note and `ratchet-floors` reads the root note.
- `CHANGELOG.md`: one line under _Removed_.

## Verification

```sh
node scripts/lint-journey-ledger.mjs
```

Outcome on origin/main (40d96f5de): exit 1, with `"gateway/app-read/year3-tally/ci-linux-x64-4c" names consumer crates/apps/tally/tests/year3.rs, which does not exist` and `1 problem(s)`. Outcome with this change: exit 0, with `journey-ledger: ok — every entry names its volume, hardware, spans and consumers`.

```sh
node scripts/test-report/ratchet-floors.mjs
```

Outcome: exit 0, with `ratchet-floors: ok (no decreases vs origin/main)`.

## Audit

**PASS.** An independent Sonnet auditor checked this change against the receipt. It was read-only and had no part in writing the change.

- **Only Tally was removed: PASS.** Parsing origin/main and this tree as JSON, exactly four paths differ: `/volumes/year3-tally` is removed, `/entries/gateway/app-read/year3-tally/ci-linux-x64-4c` is removed, and the two `approvedDeviation` strings change. Each new string ends with the old one, byte for byte.
- **No ratcheted ceiling moves: PASS.** `dashboardFold`, `searchFold` and `writeThroughTheGate` were all `projected` and held their numbers under `_observedMs`, so the ratchet never read them.
- **Tally is gone from main: PASS.** `git ls-tree origin/main crates/apps` has no tally. `year3_tally`, `crates/apps/tally` and `centraid-apps-tally` appear outside history only in this file.
- **The Verification is accurate: PASS.** The lint exits 1 on origin/main and 0 here, and `ratchet-floors` exits 0.
- **Nothing missed: PASS.** The `tally` mentions left are the two new #1114/#1099 notes and a historical provenance line.
- The auditor caught the earlier wording "both metrics" (there were three), which was corrected before commit.
