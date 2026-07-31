# Receipt — #656 Testing foundation: author-distrust axiom, computed grades, floor ratchets, blind spots, duplication removal

## Checklist

- [x] Layer 1A — ratchet slack floors and verify the floor-lag warning
- [ ] Layer 1D — duplication removal (backup 3-tier, consent ×4, Playwright-re-proving-jsdom, example/property twins, cron ×4, route-suite merge, grab-bag splits)
- [ ] Layer 1B — client top-level coverage scope + contract-test campaign for zero-test modules
- [ ] Layer 1C — backup mutation ≥60 campaign; gateway/agent-runtime mutation re-seed
- [ ] Layer 1E — matrix honesty sweep
- [ ] Layer 1F — untested load-bearing surfaces + rig budgets
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
```

- 10 tests passed, including the new branch-lag and configured-threshold case.
- Full `bun run coverage` / `bun run check:pr` are recorded at the end of the branch (see PR).

## Steering

**Verdict: PASS** — no steering events observed. The session contains exactly one user-role message (the initial `/goal` command directive); the transcript contains 54 total messages, but these are all system/hook acknowledgments related to the initial task, not mid-task corrections or redirects. No Steering table entries required.

## Audit

| Check | Verdict | Evidence |
| --- | --- | --- |
| **1. "What changed" faithfully describes diff** | PASS | All five bullets match: (1) coverage-floors.json five slack floors raised per ratchet policy ✓, (2) TESTING.md floors table + agent-runtime note updated ✓, (3) report-depth-signals.mjs branch-floor lag detection added ✓, (4) generate.mjs passes floorLagWarningPoints/\_absoluteWeaknessBelow from config ✓, (5) report-depth-signals.test.mjs covers branch lag + thresholds ✓. |
| **2. Each [x] checklist item realized in diff** | PASS | Layer 1A checked item claims five floor raises (agent-runtime 84, automation 82, time-engine 82/65, oauth-worker 82 branches, client/react 54 branches); all present in coverage-floors.json. Claim "TESTING.md note updated" verified: old "do not raise without a dedicated campaign" removed, replaced with ratchet-policy explanation. Claim "floor-lag warning wired to config" verified: generate.mjs now passes floorLagWarningPoints (15) to findAbsoluteWeaknesses, which uses it as threshold; report-depth-signals.mjs implements branch lag check. |
| **3. Checklist mirrors issue Layer 1A structure** | PASS | Issue Layer 1A has six sub-bullets (five scope raisals + lag-warning verification); receipt consolidates into one [x] Layer 1A item. Receipt layers 1B–1F and 2–5 are unchecked ([ ]). This properly mirrors issue structure: checked item maps to all Layer 1A sub-work completed; unchecked items are unstarted future layers. |

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-b98577ce-3a1-1785475629-1 | claude-code | b98577ce-3a10-48fb-8d23-eeabc445519f | #656 | claude-fable-5 | 142 | 496197 | 5556253 | 54175 | 550514 | 14.4689 | 142 | 496197 | 5556253 | 54175 | chore(tests): ratchet slack coverage floors and wire the floor-lag warning (#656 |
| claude-code-b98577ce-3a1-1785475796-1 | claude-code | b98577ce-3a10-48fb-8d23-eeabc445519f | #656 | claude-opus-5 | 8 | 75555 | 333525 | 3945 | 79508 | 0.7376 | 150 | 571752 | 5889778 | 58120 | chore(tests): ratchet slack coverage floors and wire the floor-lag warning (#656 |
| claude-code-b98577ce-3a1-1785475852-1 | claude-code | b98577ce-3a10-48fb-8d23-eeabc445519f | #656 | claude-opus-5 | 4 | 1748 | 201222 | 660 | 2412 | 0.1281 | 154 | 573500 | 6091000 | 58780 | chore(tests): ratchet slack coverage floors and wire the floor-lag warning (#656 |
| claude-code-b98577ce-3a1-1785475939-1 | claude-code | b98577ce-3a10-48fb-8d23-eeabc445519f | #656 | claude-opus-5 | 16 | 29007 | 838180 | 3942 | 32965 | 0.6990 | 170 | 602507 | 6929180 | 62722 | chore(tests): ratchet slack coverage floors and wire the floor-lag warning (#656 |
