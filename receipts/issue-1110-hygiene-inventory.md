# Tighten weekly hygiene inventories (#1110)

## What changed

The existing scanner write entrypoints reconcile skips, environment guards, fixed sleeps and assertion-matcher counts with the current TypeScript tree. Entries for deleted v0 files are removed and every changed count decreases. No scanner is removed, no exception is introduced, and the device park expiries remain unchanged. This follows the quality ladder (#915) and governance estate separation (#1005); the source-side weekly repairs are in #1108.

## Verification

All four scanners pass against the regenerated inventory:

```text
node scripts/test-report/env-red-inventory.mjs: PASS, 0 sites
node scripts/test-report/skip-inventory.mjs: PASS, 0 sites
node scripts/test-report/sleep-inventory.mjs: PASS, 0 sites
node scripts/test-report/hygiene-ratchet.mjs: PASS, 11 truthiness and 7 mock-call assertions
```

No claim is made that hardware tests ran or that the entire weekly lane passes without the source-side repairs in #1108.

## Audit

PASS — independent read-only verifier confirmed every removed skip/env-red/sleep inventory path is absent. Running bun run test:skip-inventory, test:env-red, test:sleep-inventory, and test:hygiene-ratchet in this worktree passes with budgets 0, 0, 0, and matcher counts 11/7. These changes tighten stale budgets to the measured surviving TypeScript suite; they neither add exemptions nor claim device coverage.

## Governance dependency repair

Main's Dependabot run 38585967160 cannot resolve the patched KaTeX through @eslint/markdown 8.0.3 and micromark-extension-math 3.1.0, whose latest published dependency range remains ^0.16.0. The isolated law package now overrides only KaTeX to 0.18.2; both Bun and npm lockfiles resolve that version. The root product dependency tree is unchanged. A compatibility regression test exercises the extension's renderToString interface, math constructs, macros, error handling and default rejection of a javascript hyperlink.

PASS — independent read-only review exercised those behaviors with the installed 0.18.2 package. All smoke assertions passed. No security allowance changed. This is a narrow compatibility check across the parent's declared range, not a guarantee for every rendering case.

The full law suite returns 177/179 before and after the dependency change: the same fixture byte-reproduction and range-independence tests fail in both trees. Those inherited fixture failures were reproduced, not relabeled as passes. The two added dependency compatibility tests pass separately.

## Arrival fixture repair

Both previously inherited arrival tests compared against a stale evaluator-domain path. Independent recursive JSON comparison found exactly one difference: `.github/workflows/ci.yml` was removed from the current evaluator pack by 2814721f, but persisted in the historical-range fixture. Remove only that array element; retain byte equality, detached-checkout and dirty-receipt assertions. No generator logic changes.

Verification: `bun run governance:law:test` PASS, 181/181 including dependency compatibility and both formerly failing arrival cases. Independent read-only audit: PASS, exact cause and one-field correction confirmed.

## Current-main reconciliation, 2026-10-15 afternoon

Merged main 448aacb82082f09d89e1cc8827756d0256fe46b0 after #1117 and its #1121 fossil cleanup. tests/inventory.json now matches main exactly: the owner's complete cleanup supersedes this draft's inventory edits. The remaining law diff is the KaTeX override and lockfiles, compatibility regression tests, and stale arrival-fixture workflow path removal, with their registry evidence. No owner ledger cleanup is undone. Current exact-head validation is recorded on PR #1111.

Reconciliation verification found one remaining inventory repair: `bun run test:hygiene-ratchet` fails on main's slack matcher budgets, 378 versus 11 truthiness assertions and 778 versus 7 mock-call assertions. `node scripts/test-report/hygiene-ratchet.mjs --write` restores exactly those two tighten-only changes in tests/inventory.json; all owner fossil cleanup is retained. The preceding statement that inventory has no diff is superseded for these two counters only.
