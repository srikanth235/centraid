# Receipt — #656 Testing foundation: author-distrust axiom, computed grades, floor ratchets, blind spots, duplication removal

## Checklist

- [x] Layer 1A — ratchet slack floors and verify the floor-lag warning
- [x] Layer 1D — duplication removal, so every law has one owner
- [x] Layer 1B — gate the client↔gateway seam and give it laws
- [x] Layer 1C — the backup mutation contradiction, resolved in favour of the matrix
- [ ] Layer 1E — matrix honesty sweep
- [x] Layer 1F — put tests under load-bearing code that had none
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

**Layer 1D — duplication removal, so every law has one owner.** Deletions were only made where the surviving owner was verified to assert the same law; where it did not, the duplicate was kept and the refusal recorded (below).

- `packages/backup/src/engine.test.ts` — now sole owner of the no-change / incremental / restore-refusal / verify laws, and *strengthened first*: a bounded incremental put-count assertion, and proof that a refusal aborts before the destination directory exists.
- `packages/gateway/src/backup/backup-service.contract.test.ts`, `packages/gateway/src/backup/backup.integration.test.ts` — seven engine-law restatements deleted; these files keep only fencing, policy echo, and CLI-restore→adopt→quarantine.
- `packages/gateway/src/backup/recover.integration.test.ts`, `packages/gateway/src/backup/recover.test-fixtures.ts` (new) — the newer-software refusal folded into the blank-machine test (one seeded machine now serves both halves, saving a ~45 s fixture rerun); its residue assertions extracted into `expectRefusalLeavesNoResidue`.
- `packages/automation/src/fire/scheduler-ledger.contract.test.ts` — four examples subsumed by their property twins deleted; one generator *widened* (1–2 min → 1–179 s) so a deleted example stays inside the property's range instead of silently falling out of coverage.
- `packages/automation/src/fire/cursor-engine.test.ts`, `packages/automation/src/fire/cursor-invariants.test.ts`, `packages/automation/src/fire/in-process-scheduler.test.ts` — cron gap-collapse arithmetic stripped from three restatements; `cron-cursor.test.ts` owns enumeration/collapse. The unique "registration itself must never fire" clause was rescued into the surviving test rather than deleted with its file.
- `packages/gateway/src/lifecycle/automation-lifecycle-over-http.test.ts`, `packages/gateway/src/routes/lifecycle-automation-routes.test.ts`, `packages/automation/src/manifest/manifest.test.ts` — trigger validation proven once against the validator; both route files reduced to wiring and now assert the validator's verbatim message, which is what actually proves delegation.
- `packages/gateway/src/serve/vault-plane.test.ts` (deleted, 1,646 lines in one flat describe, carried a file-size waiver) → `packages/gateway/src/serve/vault-plane-wal.test.ts`, `packages/gateway/src/serve/vault-plane-consent.test.ts`, `packages/gateway/src/serve/vault-plane-assistant.test.ts`, `packages/gateway/src/serve/vault-plane-app-bridge.test.ts`, `packages/gateway/src/serve/vault-plane-links.test.ts`, `packages/gateway/src/serve/vault-plane-scopes.test.ts`, `packages/gateway/src/serve/vault-plane.test-fixtures.ts`. All under the size cap, so the waiver is gone. The duplicate 40-line consent-lifecycle bodies are one `test.each` table, with `grantsRevoked` strengthened from `toBeGreaterThan(0)` to `toBe(1)` on both doors.
- `packages/app-engine/src/conversation/history.test.ts` — twin scoping blocks parameterized into one `it.each`; both sides now assert exact title sets and both polarities of `getSession`, where each original asserted only one.
- `tests/matrix.json` — three `minimumTests` lowered with `approvedMinimumTestsDeviation` (the documented escape hatch's exact use case): `scheduler-no-backfill` 23→19, `backup-round-trip` 18→16, `blank-machine-restore` 3→2.

**Layer 1C — the backup mutation contradiction, resolved in favour of the matrix.** `packages/backup` scored **46.07% → 97.09%**; the floor of 42 was not describing a weak surface, it was describing a missing test suite for a surface that turned out to be almost entirely defensible. No matrix demotion was needed.

- `packages/backup/src/crypto-properties.test.ts`, `packages/backup/src/wal-address-properties.test.ts`, `packages/backup/src/wal-prefix-properties.test.ts` (new), `packages/backup/src/wal-address.test-fixtures.ts` (new) — mutants killed by asserting the law each mutant violates, never implementation detail: encoder totality (an encoder either refuses an address or emits a key that parses back to exactly it), prefix soundness stated as an iff (over-matching makes GC delete a live stream; under-matching makes restore read a truncated stream as idle), refusals naming the field they refused, per-vault key separation, and `chunkId` as a keyed content address. The address suite was split in two because the combined file exceeded the size cap.
- `packages/backup/src/wal-format.ts` — `assertValidPosition` moved past the existing `// Stryker disable all` marker. It contributed 18 structurally unkillable mutants: `WalPairPosition` never appears in a key, so it is reachable only through seal/open, which the mutate-set scoping rule puts out of bounds. No behaviour change.
- `tests/mutation-floors.json` — `packages/backup` 42→**94** (97.09% measured locally, five consecutive identical runs). The two seeds left "conservatively low until first measured nightly" on 2026-07-23 are now measured, not guessed: `packages/gateway` 55→**76** and `packages/agent-runtime` 55→**89**, both from nightly run 30524995032, verified to have measured byte-identical code (`git diff origin/main...HEAD` over both mutate sets and their tests is empty). Five further floors are stale-low against the same nightly and are recorded in the file's `_comment` rather than ratcheted here.
- `scripts/mutation/seeds.mjs`, `packages/blob-format/stryker.config.mjs` — mutate paths follow the blob-format `index.ts` → `cbsf.ts` split.

### Refused deletions (the surviving owner was weaker, so the duplicate stays)

The issue named these as duplicates; each was checked against its claimed owner and kept.

- **All four consent-clamp sites.** `execution-clamp.test.ts` only inspects a decision object — it never executes a read or crosses a seam. `gateway.contract.test.ts` S2 proves the mask actually strips columns from `gw.read()` output, `duties.test.ts:589` is the view-service law (join denial + receipts), and the vault-plane case proves the clamp survives the HTTP/`agentBridgeFor` seam on real rows. Deleting any would let a gateway compute the right mask and then return every column.
- **`duties.test.ts:90/106/118/128` are not verbatim copies** of `execution.test.ts`: they drive the same laws through `gw.invoke()` and assert the rollback (`core_tag` count is 0), which is proven nowhere else.
- **`wal.integration.test.ts:1050/:1127` are not WAL-format laws** — they assert the `basePending`-clearing rule owned by `backup-service.ts`, and moving them into `packages/backup` would invert the dependency graph. **`:1523` stays put** because moving a hard PR-gating ratio assertion (`drained.bytes < dbBytes/2`) into the nightly perf lane would demote it, and the rig budget model is wall-clock with a relative band, which cannot express a deterministic absolute ratio.
- **One `scheduler-ledger` example survives**: its property twin hardcodes a `[enabled, disabled]` registry and never generates the zero-enabled case the example pins.

**Layer 1B — gate the client↔gateway seam and give it laws.** `packages/client/src/*.ts` sat between the `replica/**` and `react/**` globs, gated by nothing but the repo-wide 62 across 2,079 executable lines, and fourteen gateway-client modules had no test file referencing them at all.

- `tests/coverage-floors.json` — new scope `packages/client/src/*.{ts,tsx}` at 78/65. Exclusion is expressed **by construction, not negation**: vitest resolves threshold globs with picomatch, where `*` does not cross `/`, so the glob matches exactly the 43 top-level modules and cannot reach `replica/**` or `react/**`. Measured 63.80 → **80.80 lines**, 58.62 → **67.71 branches**; the floor was proven to gate by re-running with the new tests excluded and watching it fail.
- `.governance/packs/srikanth235/centraid/directives/coverage-scope-reachability/allowlist.txt` — the `packages/client` ungating row was **removed** rather than a new row added: all three client trees now carry floors, so a future unfloored client tree fails the directive.
- `packages/client/src/gateway-client-seam-fixtures.ts` (new) — a recording transport that fails closed on unrouted paths, so a test cannot pass by accident.
- New contract suites written as laws for the seam, not line-chasing: `packages/client/src/gateway-client-storage.contract.test.ts`, `packages/client/src/gateway-client-atlas.contract.test.ts`, `packages/client/src/gateway-client-conversation-history.contract.test.ts`, `packages/client/src/gateway-client-editing.contract.test.ts`, `packages/client/src/gateway-client-members.contract.test.ts`, `packages/client/src/gateway-client-capture.contract.test.ts`, `packages/client/src/device-blob-source.contract.test.ts`, `packages/client/src/video-frame.contract.test.ts`. The laws that matter most: an expected refusal is data the editor renders rather than an exception; a named scope pins a request to that space while an omitted one degrades to the ambient vault and never to none; concurrent callers share one editing session open; blob bytes arrive frame by frame and the object is never ranged whole; a provider that lies about object size is refused before any decrypt; renaming a bundled app never opens a draft worktree; removing the last owner must echo the space name back. No client source behaviour was changed.

**Layer 1F — put tests under load-bearing code that had none.**

- `apps/desktop/src/preload.ts` (the renderer/main privilege boundary, 298 lines, no test) → logic extracted to `apps/desktop/src/main/preload-core.ts`; `preload.ts` is now 39 lines of Electron binding, and `apps/desktop/src/main/ipc-core.test.ts` re-points its import-parity law at the new core. `apps/desktop/src/main/preload-core.test.ts` covers the exposed surface, channel allowlisting, and leak containment, and was sabotage-verified. Measures 100%.
- `apps/web/src/sw-runtime.test.ts`, `apps/web/src/sw-tunnel.test.ts` and `apps/web/src/sw-runtime.test-fixtures.ts` (all new) drive `apps/web/public/sw.js` through `node:vm` with fake `caches`/`clients`/`self`; `vitest.config.ts` gains one narrow, commented `coverageInclude` entry for that named file, since it lives outside `src/`; `apps/web/src/sw-inbox-wake.test.ts` re-points its source read at the same shared path constant. The highest-value block is never-cache: cross-origin, non-GET, `destination === ""` so authenticated gateway JSON never reaches Cache Storage, ephemeral bridge scope, Range, SSE, `no-store`. Measured 86.87 lines / 71.69 branches.
- `scripts/test-report/generate.test.mjs` (new) drives the generator as a subprocess against synthetic roots and asserts the **honesty exits** — owner-does-not-exist, unmapped e2e evidence, declared-owner-produced-nothing, nightly zero-grey, job-reconciliation silent-all-clear — i.e. that it reports red, not merely that it renders.
- CI-gate linters had no test, so a broken one would pass everything silently. `scripts/lint-e2e-flows.test.mjs`, `scripts/lint-tsconfigs.test.mjs`, `scripts/lint-css-classes.test.mjs`, `scripts/lint-protocol-routes.test.mjs`, `scripts/check-mobile-native-state.test.mjs` (all new) prove the **fail path** — each linter rejects a synthetic violation. `scripts/lint-css-classes.mjs`, `scripts/lint-protocol-routes.mjs`, `scripts/lint-tsconfigs.mjs`, `scripts/check-mobile-native-state.mjs` gained a minimal behaviour-preserving extraction of the rule core behind the repo's existing main guard; messages unchanged, all five still exit 0 on the real repo.
- `scripts/gateway-npm/publish.test.mjs` (new) covers the abort paths only; no test reaches a git mutation or an `npm publish`.
- `packages/blob-format/src/index.ts` → `packages/blob-format/src/cbsf.ts` behind a re-export barrel, the same shape `packages/protocol` uses, so the root `coverageExclude` `**/index.ts` no longer erases the whole package. `packages/blob-format/src/cbsf.test.ts` and `packages/blob-format/src/cbsf-properties.test.ts` follow the rename. It measured **0 lines** before and 100% now, with a floor of 98/96.
- `packages/test-kit/src/quality-signal.test.ts` (new) plus additions to `packages/test-kit/src/test-kit.test.ts`. The load-bearing law: `recordQualityResult` and `qualityRegressionBudget` derive the artifact filename independently, so if they ever disagree every rig reads `null` forever and the entire perf/scale lane goes permanently, silently green.
- `tests/quality-rig-budgets.json` + `tests/helpers/rig-budgets.ts` (new) — all 25 rigs registered, but the finding was that **nothing read this file**: it was documentation that had drifted to 9 of 24 rigs. It is now load-bearing — five inline `BUDGET_MS` constants in `tests/perf/desktop-cold.perf.test.ts`, `tests/perf/replica-sync-io.perf.test.ts`, `tests/perf/tunnel-native.perf.test.ts`, `tests/scale/automations-fire.scale.test.ts` and `tests/scale/gateway-sessions.scale.test.ts` now read from it via a helper that throws rather than defaulting; `scripts/test-report/ratchet-floors.mjs` makes every number tighten-only; and `scripts/test-report/validate-nightly-wiring.mjs` fails on an unregistered rig, a wrong lane, a non-positive budget, a phantom entry, or a re-inlined constant. Sabotage-verified.
- `scripts/test-report/validate-release-wiring.mjs` + `scripts/test-report/validate-release-wiring.test.mjs` (new), wired into `test:matrix` in `package.json` (so it runs in `check:pr`): ten structural invariants over the ~800 lines of release workflows that had none — single tag entry point, every lane reachable and `workflow_call`-only, secret isolation per lane, mobile stays dispatch-only, and the one that matters most, that `release-check.needs` covers every job, because a lane missing from it fails while the release reports success. The test sabotages each invariant in a temp copy of the real workflows; two of its own assertions were too weak and the sabotage caught them. **No `.github/workflows/**` file was edited.**
- `scripts/test-report/report-depth-signals.mjs` / `generate.mjs` — coverage scopes are matched with a new `scopeMatcher` instead of a `startsWith` prefix. The prefix matcher could not express a scope narrower than a directory, so the new client scope would have rendered as an unmeasured blank row in the report the governance loop trusts. Kept dependency-free because the generator is executed from synthetic roots with no `node_modules`.
- `tests/coverage-floors.json` — `packages/blob-format/src/**` 98/96 and `apps/desktop/src/main/*-core.ts` 96/89 (measured 98.87/91.44). The desktop gate is deliberately the `*-core.ts` glob, not `apps/desktop/src/main/**`: the whole directory measures 34.46/41.92 because it is dominated by Electron-bound shell that cannot be unit-tested, so a floor there would be honest but would gate nothing.

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
```sh
bun run --cwd packages/backup test
bun run --cwd packages/gateway test
bun run --cwd packages/automation test
bun run --cwd packages/app-engine test
node scripts/mutation/run.mjs --package backup --enforce-floors
bun run test:matrix
```

- backup 346 passed / 26 skipped · gateway 1,244 passed (see the one pre-existing failure noted below) · automation 372 passed · app-engine 592 passed.
- Backup mutation: **97.09%**, floors met.
- `test:matrix`, `test:ratchet`, `scripts:test` (97 assertions) all pass.
- **Pre-existing, not from this branch:** `packages/gateway/src/cli/status-admin.test.ts` "never-installed unit reads clean" fails on a host that has a gateway service installed. `packages/gateway/src/cli/` is untouched here; the test reads real host state instead of a fixture. Recorded rather than papered over — it is a genuine instance of the host-dependence this issue is about.
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
| claude-code-b98577ce-3a1-1785478825-1 | claude-code | b98577ce-3a10-48fb-8d23-eeabc445519f | #656 | claude-opus-5 | 12 | 6793 | 1745746 | 5183 | 11988 | 1.0450 | 716 | 1195506 | 63240886 | 224614 | test(backup): give each law one owner and kill the backup mutation contradiction |
| claude-code-b98577ce-3a1-1785478885-1 | claude-code | b98577ce-3a10-48fb-8d23-eeabc445519f | #656 | claude-opus-5 | 4 | 9244 | 589722 | 2062 | 11310 | 0.4042 | 720 | 1204750 | 63830608 | 226676 | test(backup): give each law one owner and kill the backup mutation contradiction |
| claude-code-b98577ce-3a1-1785478981-1 | claude-code | b98577ce-3a10-48fb-8d23-eeabc445519f | #656 | claude-opus-5 | 6 | 5514 | 899585 | 6641 | 12161 | 0.6503 | 726 | 1210264 | 64730193 | 233317 | test(client): gate the client seam and test the surfaces that had no tests (#656 |
| claude-code-b98577ce-3a1-1785479077-1 | claude-code | b98577ce-3a10-48fb-8d23-eeabc445519f | #656 | claude-opus-5 | 22 | 10901 | 3369184 | 5658 | 16581 | 1.8943 | 748 | 1221165 | 68099377 | 238975 | test(client): gate the client seam and test the surfaces that had no tests (#656 |
| claude-code-b98577ce-3a1-1785479241-1 | claude-code | b98577ce-3a10-48fb-8d23-eeabc445519f | #656 | claude-opus-5 | 28 | 13140 | 4396957 | 6282 | 19450 | 2.4378 | 776 | 1234305 | 72496334 | 245257 | test(client): gate the client seam and test the surfaces that had no tests (#656 |
