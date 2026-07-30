# Issue #646 — close mobile native-state completeness loop (recipe + ratchet)

## Checklist

- [x] L1: local module under `apps/mobile/modules/` without matching `Podfile.lock` entry fails `ci:native-state` with a named error (unit-tested)
- [x] Android shape check: module whose directories imply a platform not declared in `expo-module.config.json` fails with a named error (documented Android depth limit)
- [x] `ci:native-state --write` refuses to update `native-fingerprints.json` when L1–L3 fail
- [x] `ci:native-state --write` updates both platform hashes when only L4 is dirty, and prints the curated summary (platforms moved + module↔lock delta)
- [x] Mismatch errors name the exact remediation command
- [x] Pure `package.json` script key reorder does not move either platform fingerprint (`sourceSkips` in place, tested)
- [x] `check:pr` runs the verify when `apps/mobile/**` is in the affected set
- [x] Trap doc exists (incl. macOS-only `pod install` repair note) and is linked from AGENTS docs index / traps table
- [x] Complete `Podfile.lock` for all local Centraid modules + matching fingerprints; `bun run --cwd apps/mobile ci:native-state` green; #644 rebase coordination recorded
- [x] Receipt records the invariant and the #631 vs #638 contrast
- [x] `ci:versions` step renamed to clearly-advisory presentation with output in `GITHUB_STEP_SUMMARY`; pin alignment filed as follow-up in Decisions

## What changed

### Invariant

> Fingerprints may only ratchet when the native **recipe** is complete and coherent. Incomplete worlds cannot be blessed by updating only `native-fingerprints.json`.

### #631 vs #638 contrast

| Landing | Modules | `Podfile.lock` | Fingerprints |
| --- | --- | --- | --- |
| **#631** (storage) | +`centraid-storage` | regenerated | ratcheted — full triple |
| **#638** (network-status, ocr) | +two modules | **unchanged** | ratcheted to incomplete world |

#638 left main green on identity while the recipe was incomplete; follow-on #644 expanded the lock and hit L4 first. This issue closes that hole with L1 + `--write` refusal.

### Code

- `apps/mobile/scripts/verify-native-state-lib.mjs` — pure L1–L4 validators and status/write formatters (unit-testable without project I/O).
- `apps/mobile/scripts/verify-native-state.mjs` — CLI + I/O: L1 iOS module↔lock completeness (`DEPENDENCIES` + `EXTERNAL SOURCES`); L1 Android `expo-module.config.json` platform-shape; `--status` / `--write` flags on the existing sole entry; remediation lines always name `ci:native-state --write` vs fix-recipe-first; curated write summary (platforms moved + module↔lock delta).
- `apps/mobile/scripts/verify-native-state.test.mjs` — unit coverage for L1 named failures, Android shape, remediation, status report, write summary, `sourceSkips`, script-key reorder invariance, write-refuse gate.
- `apps/mobile/scripts/native-fingerprint.mjs` — `sourceSkips: SourceSkips.PackageJsonScriptsAll` so pure script-key reorders do not move iOS/Android identity.
- `scripts/check-mobile-native-state.mjs` + root `package.json` `check:mobile-native-state` wired into `check:pr` / `check:pr:full` when `apps/mobile/**` is affected.
- `apps/mobile/ios/Podfile.lock` — complete recipe from coordinated #644 content (`CentraidNetworkStatus`, `CentraidOcr`, `ExpoClipboard` + existing storage/tunnel).
- `apps/mobile/native-fingerprints.json` — ratcheted via `--write` after L1–L3 green under the new skip + complete lock.
- `docs/traps/mobile-native-state.md` + `AGENTS.md` traps table row (Linux can verify but not repair; exact macOS `pod install` command).
- `.github/workflows/ci.yml` — `ci:versions` step renamed **Advisory — Expo compatibility map (non-blocking)**; output mirrored to `GITHUB_STEP_SUMMARY`; still non-blocking.

### #644 lock coordination

**Sequencing flipped:** #644 (`#643` onboarding fit) merged to main first with the complete `Podfile.lock` (CentraidNetworkStatus / CentraidOcr / ExpoClipboard). This PR rebases onto that tip and **does not re-ship the lock**; it only ratchets `native-fingerprints.json` under L1–L4 + `PackageJsonScriptsAll`, and lands the gate/docs. No lock thrash.

## Decisions

- **Android L1 depth** — shape assertion only on `expo-module.config.json`; no invented Android lockfile. Real completeness gate remains `ci:android-native` compilation.
- **CLI naming** — extend `ci:native-state` in place with flags; no `native:state` alias (forbidden synonym / knip + script-sort liability).
- **Fingerprint deafening** — `PackageJsonScriptsAll` rather than formatter carve-out; keeps #642 oxfmt `sortScripts` contract intact.
- **#644 coordination** — sequencing flipped: #644 merged complete lock first; this PR ratchets fingerprints only (no lock re-ship).
- **`ci:versions` pin alignment** — presentation demoted to advisory + step summary only. Honest hard pin alignment (shared `expo`/`react`/`typescript` pins) is a **dedicated follow-up issue**, deliberately out of this PR.
- **Lock source** — complete `Podfile.lock` is now on main via #644; this PR does not rewrite it.

## Out of scope

- Auto-commit / auto-refresh fingerprints in CI or pre-commit
- Full prebuild-on-every-PR; replacing `@expo/fingerprint`
- Desktop e2e delete-confirm Enter flake
- Hard-pinning full Expo compatibility map
- #642-only oxfmt/iroh-wasm generated-bindings ignore fix
- Nightly iOS/Android e2e redesign
- Second CLI name (`native:state` alias)

## Verification

Checklist crosswalk (each `[x]` item appears below as a substring for receipt-per-issue):

- L1: local module under `apps/mobile/modules/` without matching `Podfile.lock` entry fails `ci:native-state` with a named error (unit-tested) — covered by `validateIosModuleLockCompleteness` tests and incomplete-lock fixture.
- Android shape check: module whose directories imply a platform not declared in `expo-module.config.json` fails with a named error (documented Android depth limit) — `validateModulePlatformShape` tests + trap doc.
- `ci:native-state --write` refuses to update `native-fingerprints.json` when L1–L3 fail — CLI write-refuse path (fingerprints byte-stable).
- `ci:native-state --write` updates both platform hashes when only L4 is dirty, and prints the curated summary (platforms moved + module↔lock delta) — `formatWriteSummary` + live `--write` run.
- Mismatch errors name the exact remediation command — L4 messages include `ci:native-state --write`; L1 attaches fix-recipe-first.
- Pure `package.json` script key reorder does not move either platform fingerprint (`sourceSkips` in place, tested) — `PackageJsonScriptsAll` + reorder vitest.
- `check:pr` runs the verify when `apps/mobile/**` is in the affected set — `scripts/check-mobile-native-state.mjs` + `check:mobile-native-state` in root package.json.
- Trap doc exists (incl. macOS-only `pod install` repair note) and is linked from AGENTS docs index / traps table — `docs/traps/mobile-native-state.md`.
- Complete `Podfile.lock` for all local Centraid modules + matching fingerprints; `bun run --cwd apps/mobile ci:native-state` green; #644 rebase coordination recorded — hygiene in this PR; Decisions records #644.
- Receipt records the invariant and the #631 vs #638 contrast — see What changed.
- `ci:versions` step renamed to clearly-advisory presentation with output in `GITHUB_STEP_SUMMARY`; pin alignment filed as follow-up in Decisions — ci.yml advisory step.

```sh
# Unit tests (shipped validators + fingerprint options + reorder)
bunx vitest run --cwd apps/mobile scripts/verify-native-state.test.mjs

# Double verify on fixed tree
bun run --cwd apps/mobile ci:native-state
bun run --cwd apps/mobile ci:native-state
bun run --cwd apps/mobile ci:native-state --status

# --write refuses when L1 dirty (fingerprints byte-stable)
# (temporarily strip CentraidOcr from Podfile.lock DEPENDENCIES+EXTERNAL SOURCES)
bun run --cwd apps/mobile ci:native-state --write   # exit 1; no hash write

# Path-filtered check:pr entry
node scripts/check-mobile-native-state.mjs
```

Observations captured under the implementer scratch dir:

- `ci-native-state-1.log` / `ci-native-state-2.log` — exit 0, “Pod lock, project paths, and iOS/Android fingerprints agree”
- `ci-native-state-status.log` — L1–L4 ok; module↔lock present all four Centraid pods
- `ci-native-state-write.log` — platforms moved ios+android; module delta complete
- `ci-native-state-write-refuse.log` — L1 CentraidOcr missing; fingerprints hash unchanged
- `ci-native-state-negative.log` — incomplete lock named L1 errors
- `script-reorder-proof.log` — both platform hashes stable under script-key reverse
- `check-pr-native.log` — `apps/mobile/**` affected → `ci:native-state` green
- `native-state-unit.log` — vitest for `verify-native-state.test.mjs`

## Audit

**PASS**

1. **What changed ↔ diff:** L1 validators, `--status`/`--write`, `PackageJsonScriptsAll`, complete lock + fingerprints, check:pr path filter, trap doc + AGENTS row, advisory `ci:versions` step — all present in the tree.
2. **Checklist `[x]` items realized:** each acceptance box maps to code/tests/docs above; #644 coordination and pin-alignment follow-up recorded under Decisions.
3. **Checklist mirrors #646 acceptance:** recipe completeness, write refusal, remediation commands, sourceSkips, check:pr wiring, trap, hygiene green, receipt invariant, advisory versions.

## Steering

**Verdict: PASS**

1. **Every human-steering event recorded in `### Steering` under `## Accounting`:** PASS — zero human steering events (no interrupt, redirect, or mid-task correction). The session had a single authorized goal (implement #646 scope and open a PR) with a structured on-disk plan; the agent executed continuously. Empty `### Steering` (`_(none)_`) is correct; no rows to invent.
2. **No non-steering message recorded as steering:** PASS — Accounting has no false-positive steering rows (tool denials and ordinary task messages are not classified as steering).

## Accounting

### Costs

_(populated by governance pre-commit hook)_

### Steering

_(none)_
