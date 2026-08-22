## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-22 | grok | - |

# Issue #850 — fix red main after #839/#845

GitHub issue: [#850](https://github.com/srikanth235/centraid/issues/850)

`main` (`255be5deb`, #839/#845) left required `ci.yml` red: `verify`
`test:suite-wall-clock` (2018.1s vs 1620.0s across 1332 files). `check`
failed because `verify` failed. Collection-tripwire and diff-coverage
never ran on that PR because wall-clock is the next step after coverage.

## Checklist

- [x] Widen `lanes.pr-vitest.budgetMs` from 1,620,000 to 2,321,000 using the CI verify measurement (2018.1s across 1332 files, 15% headroom)
- [x] Record a changed top-level `approvedDeviation` that names what #839/#842 bought; mere presence of old ledger text does not waive (#781)
- [x] Do not rewrite `scripts/test-report/suite-wall-clock.test.mjs` or `scripts/test-report/ratchet-floors.test.mjs` to allow a quiet widen; `bun run test:ratchet:unit` still encodes tighten-only + changed-`approvedDeviation`
- [x] `CHANGELOG.md` Unreleased/Fixed names the CI repair

## Decisions

#850 does not drop tests, quarantine files, or raise the ceiling silently.
The extra ~398s is the #839/#842 suite that already merged into the PR
vitest lane (`vitest.quality.config.ts` is a coverage project; scale/soak
are not). CI did not upload `artifacts/test-results/vitest.json` (only the
test-health report), so ranking used the #845 added-test file list plus the
CI sum. A 15% headroom reseed from that CI measurement is the same policy
as the 2026-07-31 seed (#656). `--write` still only lowers the number.
Prior: #842 W0.1 wired the gate and left 1,620,000 ms untouched on purpose.

## What changed

Widen `lanes.pr-vitest.budgetMs` from 1,620,000 to 2,321,000 using the CI verify measurement (2018.1s across 1332 files, 15% headroom)
in `tests/suite-wall-clock.json`. Record a changed top-level `approvedDeviation` that names what #839/#842 bought; mere presence of old ledger text does not waive (#781). `_comment` records the 2026-08-22 CI reseed (run 32567610776). `TESTING.md` states the current ceiling. `CHANGELOG.md` Unreleased/Fixed names the CI repair.

Do not rewrite `scripts/test-report/suite-wall-clock.test.mjs` or `scripts/test-report/ratchet-floors.test.mjs` to allow a quiet widen; `bun run test:ratchet:unit` still encodes tighten-only + changed-`approvedDeviation`. Those two files are not in the diff.

## User impact

None at runtime. The required PR vitest lane still runs the same files; the
ceiling now describes the suite #845 shipped.

## Out of scope

- Advisory OS desktop e2e (`desktop-e2e-windows`, `desktop-e2e-macos`).
- Nightly/scheduled workflows (`e2e.yml`, soak, scale, interop).
- Remaining #839 / #842 product-QA waves and #846 pinned defects.
- Speeding individual new files in this pass — the extra work is the
  intended #839/#842 evidence, not leftover `sleep`.

## Verification

```sh
bun run test:ratchet
bun run test:ratchet:unit
bun run test:suite-wall-clock
bun run test:collection-tripwire -- --require-report
bun run test:diff-coverage
```

- `test:ratchet` is green against `origin/main` because `approvedDeviation`
  changed in the same diff as the `budgetMs` widen.
- `test:ratchet:unit` still encodes tighten-only + changed-`approvedDeviation`.
- After `bun run coverage`, `test:suite-wall-clock` must print the
  under-ceiling form (`N.Ns of M.Ms`) and exit 0 across a 1332-class file
  count, not a filtered subset.

## Audit

- (1) What changed vs diff: PASS — Staged files are `CHANGELOG.md`, `TESTING.md`, `tests/suite-wall-clock.json`, and this receipt. JSON `lanes.pr-vitest.budgetMs` is `1620000` → `2321000` (2018.1s × 1.15 ≈ 2,321,000ms), a new top-level `approvedDeviation` names the #839/#842 suites and cites #781, and `_comment` records the 2026-08-22 reseed from run 32567610776. `TESTING.md` states the 2,321,000 ms ceiling; `CHANGELOG.md` Unreleased/Fixed names the CI repair. The two ratchet unit-test files are absent from the diff, as claimed. No extra intended files; ignored worktree dirt is unrelated.
- (2) Checked items realized in the diff: PASS — All four `[x]` items match the staged edit: budget widen in `tests/suite-wall-clock.json`, new `approvedDeviation` vs prior JSON (no field on `origin/main`), no rewrite of `scripts/test-report/suite-wall-clock.test.mjs` or `scripts/test-report/ratchet-floors.test.mjs`, and a `### Fixed` CHANGELOG line for #850.
- (3) Checklist mirrors the issue: PASS — Receipt checklist is the issue #850 checklist verbatim (same four items, same order and wording); only the boxes are marked `[x]`.

Verdict: PASS — Receipt, issue checklist, and intended diff agree on the wall-clock reseed and docs.
