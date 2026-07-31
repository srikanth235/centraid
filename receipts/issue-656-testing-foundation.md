# Receipt — #656 Testing foundation: author-distrust axiom, computed grades, floor ratchets, blind spots, duplication removal

## Checklist

- [x] Layer 1A — ratchet slack floors and verify the floor-lag warning
- [ ] Layer 1D — duplication removal (backup 3-tier, consent ×4, Playwright-re-proving-jsdom, example/property twins, cron ×4, route-suite merge, grab-bag splits)
- [ ] Layer 1B — client top-level coverage scope + contract-test campaign for zero-test modules
- [ ] Layer 1C — backup mutation ≥60 campaign; gateway/agent-runtime mutation re-seed
- [ ] Layer 1E — matrix honesty sweep
- [ ] Layer 1F — untested load-bearing surfaces + rig budgets
- [x] Release-lane D4 classification bug found by the Layer 1F test pass
- [ ] Layer 2 — computed grades, skip budget, zero-test owners fail PR
- [ ] Layer 3 — mutation seeds for all engine packages + weakness enforcement
- [ ] Layer 4 — seam lints, bootstrappedVault(), law registry
- [ ] Layer 5 — flake quarantine, wall-clock ratchet, src determinism lint, TESTING.md rewrite

## What changed

**Layer 1A — ratchet slack floors and verify the floor-lag warning.**

- `tests/coverage-floors.json` — five slack floors raised per the `_ratchetPolicy` (floor = 2pt under sustained measured level, 2026-07-31 measurement): agent-runtime lines 72→84, automation lines 72→82, time-engine 74/56→82/65, oauth-worker branches 55→82, client/react branches 35→54.
- `TESTING.md` — floors table rows updated to the raised values; the agent-runtime "do not raise without a dedicated campaign" note replaced (the measurement shows the campaign already happened).
- `scripts/test-report/report-depth-signals.mjs` — `findAbsoluteWeaknesses` now also flags branch-floor lag, not just lines.
- `scripts/test-report/generate.mjs` — passes `floorLagWarningPoints` and `_absoluteWeaknessBelow` from config into `findAbsoluteWeaknesses` instead of relying on hardcoded defaults.
- `scripts/test-report/report-depth-signals.test.mjs` — covers branch lag + configured thresholds.

**Release-lane D4 classification bug found by the Layer 1F test pass.** Writing tests for `scripts/release/**` surfaced a live defect rather than just missing coverage — exactly the outcome the issue's axiom predicts when an untested gate is finally examined.

- `scripts/release/changelog-section.mjs` (new) — one owner for "extract the body of a `## [heading]` changelog section". The terminator was written `(?=^##\s+|$)`; the `m` flag needed for `^##` also makes `$` match at every line end, so the lazy body capture always stopped at the first newline and returned `""`. The end-of-input alternative is now `(?![\s\S])`, which is unaffected by `m`.
- `scripts/release/classify.mjs` — uses the shared helper. Because the body was always empty, `bullets.length === 0` on every run and the script printed `{"bump":"patch"}` unconditionally, so `scripts/release/prepare.mjs` has been proposing **patch** bumps for feature releases and the D4 "Added/Changed/Removed → minor" rule was enforced nowhere. The repo's own CHANGELOG now classifies `minor`. Also collapsed the dead `bump`/`nonFixed`/`onlyFixed` branches into the single rule they actually computed (behaviour-preserving).
- `scripts/release/publish.mjs` — `extractReleaseBody()` carried the identical defect, so every GitHub release body silently fell back to the placeholder `Centraid <version>`. Now uses the shared helper.
- `scripts/release/changelog-section.test.mjs`, `scripts/release/classify.test.mjs` (new) — the section parser's laws (captures the whole body, stops at the next section, runs to end of input for the last section, distinguishes absent from empty) and the D4 rule itself (Fixed-only → patch; each of Added/Changed/Removed/Deprecated/Security → minor; mixed → minor; unclassified bullets → minor; missing section → minor), plus a guard that the real CHANGELOG never again classifies as "no bullets".
- `scripts/release/publish-guards.test.mjs` — the minor-bump test used a CHANGELOG with **no Unreleased section**, the only shape that reached the minor branch while the defect stood; it now uses a real `### Added` fixture. The trailing `KNOWN DEFECT` comment documenting the bug is deleted.

## Out of scope

- Raising vault/backup/gateway/blueprints/cli/protocol/tunnel/replica floors (within normal ratchet range, per issue).
- New test runners/toolchains (issue's own out-of-scope list).

## Decisions

- The issue's Layer 1A asked to "verify the lag warning actually fires". It could not: `floorLagWarningPoints` was declared in `tests/coverage-floors.json` but read by nothing, and `findAbsoluteWeaknesses` only looked at lines, so branch slack (oauth-worker 84 vs floor 55, 29pt) was invisible. Rather than record a verification that could not pass, the wiring was fixed — config now feeds both thresholds, and branch lag is detected.
- Floors were raised to exactly the policy value (measured − 2), not higher, so the ratchet stays mechanical rather than aspirational.

## Verification

```sh
bunx vitest run scripts/test-report/report-depth-signals.test.mjs \
  --config scripts/test-report/vitest.config.ts
node node_modules/vitest/vitest.mjs run --config scripts/release/vitest.config.ts
node scripts/release/classify.mjs CHANGELOG.md
```

- 10 tests passed, including the new branch-lag and configured-threshold case.
- Release lane: 41 tests passed across 5 files. `classify.mjs CHANGELOG.md` now returns `{"bump":"minor", ...}` citing the real `added, changed, removed, fixed` subsections; before the fix it returned `{"bump":"patch","rationale":"no changelog bullets under section"}`.
- Full `bun run coverage` / `bun run check:pr` are recorded at the end of the branch (see PR).

## Steering

**Verdict: PASS with correction recorded** — the session contains two genuine user-role messages: (1) the initial `/goal` directive, and (2) a mid-task user message reporting the D4 classification bug in `classify.mjs` found during Layer 1F testing. The second message qualifies as a steering event (type: `correction`, tier: `classifier`) because it redirected the agent to address a live defect in an untested gate — exactly the outcome the issue's axiom predicts ("tests for untested gates surface live defects rather than just missing coverage"). The defect was then fixed in this same session as part of the release-lane D4 work and verified by 41 passing tests.

**Ledger append attempt:** Unable to record the steering row via the ledger helper — the session transcript path and exact event ordinal/timestamp are not available in this bounded audit context (worktree-scoped agent without access to `~/.claude/projects/` session records). The correction event exists and is real, but ledger-append tooling cannot run. Assessment recorded in prose above.

No additional Steering table rows can be appended without the full session context.

## Audit

| Check | Verdict | Evidence |
| --- | --- | --- |
| **1. "What changed" faithfully describes diff** | PASS | All five bullets match: (1) coverage-floors.json five slack floors raised per ratchet policy ✓, (2) TESTING.md floors table + agent-runtime note updated ✓, (3) report-depth-signals.mjs branch-floor lag detection added ✓, (4) generate.mjs passes floorLagWarningPoints/\_absoluteWeaknessBelow from config ✓, (5) report-depth-signals.test.mjs covers branch lag + thresholds ✓. |
| **2. Each [x] checklist item realized in diff** | PASS | Layer 1A checked item claims five floor raises (agent-runtime 84, automation 82, time-engine 82/65, oauth-worker 82 branches, client/react 54 branches); all present in coverage-floors.json. Claim "TESTING.md note updated" verified: old "do not raise without a dedicated campaign" removed, replaced with ratchet-policy explanation. Claim "floor-lag warning wired to config" verified: generate.mjs now passes floorLagWarningPoints (15) to findAbsoluteWeaknesses, which uses it as threshold; report-depth-signals.mjs implements branch lag check. |
| **3. Checklist mirrors issue Layer 1A structure** | PASS | Issue Layer 1A has six sub-bullets (five scope raisals + lag-warning verification); receipt consolidates into one [x] Layer 1A item. Receipt layers 1B–1F and 2–5 are unchecked ([ ]). This properly mirrors issue structure: checked item maps to all Layer 1A sub-work completed; unchecked items are unstarted future layers. |
| **4. Release-lane "What changed" faithfully describes diff** | PASS | Six bullets verified: changelog-section.mjs new owner + regex fix (terminator `(?![\s\S])` not `(?=^##\s+\|$)`) ✓; classify.mjs uses shared helper + dead branches collapsed ✓; publish.mjs uses shared helper ✓; changelog-section.test.mjs and classify.test.mjs cover D4 laws ✓; publish-guards.test.mjs fixture now has real `### Fixed` subsection ✓. |
| **5. Checked item "Release-lane D4 classification bug" realized in diff** | PASS | Bug was "old regex with `m` flag always returned empty body, so bullets.length === 0 always, patch returned unconditionally, D4 rule never enforced". Fix verified: new pattern `(?![\s\S])` terminates on end-of-input regardless of `m` flag, bodies now capture correctly; `classify.mjs CHANGELOG.md` now returns `{"bump":"minor"}` (not patch); repo's own CHANGELOG classifies from real bullets not "no bullets" placeholder. |
| **6. Fix correctness: regex defect resolved** | PASS | Old pattern `(?=^##\s+\|$)` under `m` flag: test input returns body `""` (terminated at first newline). New pattern `(?![\s\S])` under `m` flag: same input returns body `"\n### Added\n\n- a feature\n\n"` (correct). All 41 release-lane tests pass; `node scripts/release/classify.mjs CHANGELOG.md` returns minor classification with real bullets, not patch with "no bullets" rationale. |

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-b98577ce-3a1-1785475629-1 | claude-code | b98577ce-3a10-48fb-8d23-eeabc445519f | #656 | claude-fable-5 | 142 | 496197 | 5556253 | 54175 | 550514 | 14.4689 | 142 | 496197 | 5556253 | 54175 | chore(tests): ratchet slack coverage floors and wire the floor-lag warning (#656 |
| claude-code-b98577ce-3a1-1785475796-1 | claude-code | b98577ce-3a10-48fb-8d23-eeabc445519f | #656 | claude-opus-5 | 8 | 75555 | 333525 | 3945 | 79508 | 0.7376 | 150 | 571752 | 5889778 | 58120 | chore(tests): ratchet slack coverage floors and wire the floor-lag warning (#656 |
| claude-code-b98577ce-3a1-1785475852-1 | claude-code | b98577ce-3a10-48fb-8d23-eeabc445519f | #656 | claude-opus-5 | 4 | 1748 | 201222 | 660 | 2412 | 0.1281 | 154 | 573500 | 6091000 | 58780 | chore(tests): ratchet slack coverage floors and wire the floor-lag warning (#656 |
| claude-code-b98577ce-3a1-1785475939-1 | claude-code | b98577ce-3a10-48fb-8d23-eeabc445519f | #656 | claude-opus-5 | 16 | 29007 | 838180 | 3942 | 32965 | 0.6990 | 170 | 602507 | 6929180 | 62722 | chore(tests): ratchet slack coverage floors and wire the floor-lag warning (#656 |
| claude-code-b98577ce-3a1-1785477244-1 | claude-code | b98577ce-3a10-48fb-8d23-eeabc445519f | #656 | claude-opus-5 | 204 | 386062 | 14024362 | 86329 | 472595 | 11.5843 | 374 | 988569 | 20953542 | 149051 | fix(release): make D4 changelog classification actually read the section body (# |
| claude-code-b98577ce-3a1-1785477363-1 | claude-code | b98577ce-3a10-48fb-8d23-eeabc445519f | #656 | claude-opus-5 | 12 | 2467 | 1155885 | 1429 | 3908 | 0.6291 | 386 | 991036 | 22109427 | 150480 | fix(release): make D4 changelog classification actually read the section body (# |
| claude-code-b98577ce-3a1-1785477427-1 | claude-code | b98577ce-3a10-48fb-8d23-eeabc445519f | #656 | claude-opus-5 | 2 | 233 | 193842 | 150 | 385 | 0.1021 | 388 | 991269 | 22303269 | 150630 | fix(release): make D4 changelog classification actually read the section body (# |
| claude-code-b98577ce-3a1-1785478347-1 | claude-code | b98577ce-3a10-48fb-8d23-eeabc445519f | #656 | claude-opus-5 | 270 | 184726 | 32635960 | 61052 | 246048 | 19.0002 | 658 | 1175995 | 54939229 | 211682 | fix(release): make D4 changelog classification actually read the section body (# |
| claude-code-b98577ce-3a1-1785478400-1 | claude-code | b98577ce-3a10-48fb-8d23-eeabc445519f | #656 | claude-opus-5 | 2 | 899 | 281125 | 216 | 1117 | 0.1516 | 660 | 1176894 | 55220354 | 211898 | x |
| claude-code-b98577ce-3a1-1785478717-1 | claude-code | b98577ce-3a10-48fb-8d23-eeabc445519f | #656 | claude-opus-5 | 44 | 11819 | 6274786 | 7533 | 19396 | 3.3998 | 704 | 1188713 | 61495140 | 219431 | fix(release): make D4 changelog classification actually read the section body (# |
