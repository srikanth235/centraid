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

`.github/workflows/ci.yml` parks advisory `desktop-e2e-windows` behind `vars.CENTRAID_DESKTOP_E2E_WINDOWS == '1'` (unset, so the job never runs; actionlint forbids `if: false`). #846 P12: Windows first-run founding hangs; `shouldUseFileFallback()` throws on non-Linux when `safeStorage` is unavailable, and the job does not set `CENTRAID_INSECURE_DEVICE_SECRETS=1`. The job stays in the file, still absent from `check` `needs`. `desktop-e2e-macos` is unchanged.

Do not rewrite `scripts/test-report/suite-wall-clock.test.mjs` or `scripts/test-report/ratchet-floors.test.mjs` to allow a quiet widen; `bun run test:ratchet:unit` still encodes tighten-only + changed-`approvedDeviation`. Those two files are not in the diff.

## User impact

None at runtime. The required PR vitest lane still runs the same files; the
ceiling now describes the suite #845 shipped.

## Out of scope

- Advisory `desktop-e2e-macos` (still runs). Parking Windows does not fix #846 P12.
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

- (1) What changed vs diff: PASS — Combined `origin/main`…HEAD plus this unstaged commit matches the two layers the section names. Already committed (`f7bfd3cc5`): `tests/suite-wall-clock.json` `lanes.pr-vitest.budgetMs` `1620000` → `2321000` (2018.1s × 1.15 ≈ 2,321,000ms), new top-level `approvedDeviation` naming the #839/#842 suites and citing #781, `_comment` reseeded 2026-08-22 from run 32567610776, `TESTING.md` stating the 2,321,000 ms ceiling. This commit: `.github/workflows/ci.yml` parks advisory `desktop-e2e-windows` behind `vars.CENTRAID_DESKTOP_E2E_WINDOWS == '1'` (unset; actionlint forbids `if: false`; path filter commented, job body kept); `check` `needs` still omits it; `desktop-e2e-macos` `if:` is unchanged. Unstaged `CHANGELOG.md` Unreleased/Fixed still names the wall-clock reseed and now also names the park until #846 P12. The throw/`CENTRAID_INSECURE_DEVICE_SECRETS` rationale matches `shouldUseFileFallback()` in `apps/desktop/src/main/gateway-secrets.ts` and #846 P12. `scripts/test-report/suite-wall-clock.test.mjs` and `scripts/test-report/ratchet-floors.test.mjs` are absent from the combined diff. Intended files only; ignored worktree dirt is unrelated.
- (2) Checked items realized in the diff: PASS — All four `[x]` items hold vs `origin/main` (committed reseed, not this park): budget widen in `tests/suite-wall-clock.json`, `approvedDeviation` absent on `origin/main` and present here, no rewrite of the two ratchet unit-test files, `### Fixed` CHANGELOG line for #850 (this commit only extends that same line). The Windows park is extra vs the boxes and is not claimed as a checklist item.
- (3) Checklist mirrors the issue: PASS — Receipt `## Checklist` is issue #850's four items verbatim (same order and wording); only the boxes are `[x]`. #850 does not list parking `desktop-e2e-windows`; the receipt correctly leaves that off the list.

Verdict: PASS — What changed covers the committed wall-clock reseed and this `desktop-e2e-windows` park; the four `[x]` items and the issue checklist still match.
