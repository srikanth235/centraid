# Issue #1052 — `rung1-on-main` and `prebuilt-core-required` red on main

Rolling bot issue ([#1052](https://github.com/srikanth235/centraid/issues/1052)) for the `candidate` lane's `rung1-on-main` job; the same push (`2814721f`, the v1 merge) also turned `gate` red at `prebuilt-core / prebuilt-core-required`. The lane had been red for 28 consecutive candidates ([#1062](https://github.com/srikanth235/centraid/issues/1062)). Every cause is a tool or ledger still reading something v1 deleted, or a glob that never matched. The law-estate half (advisory rows, law-registry rows, the gate-class row) is a separate change set under #1062, because `estate-separation` forbids mixing the estates.

## What changed

- `.github/workflows/lane-prebuilt-core.yml` — the required-triple aggregate now finds each triple's identity file at `artifacts/prebuilt-core-*/artifact/*/centraid-*.identity.json`. `upload-artifact` keeps the `artifact/<triple>/` prefix, so the old root-level glob matched nothing and `grep` exited 2 on every run.
- `scripts/security/rust-unsafe-ledger.json` — brought to the v1 tree: six deleted crates removed, `gateway-client`/`gateway-core`/`gateway-server`/`identity` added at 0, `centraid` 18→0, `core-ffi` 86→98, `xtask` 0→1 (a `#[unsafe(no_mangle)]` string in a test fixture; the audit is line-based). Every site carries a `SAFETY:` note.
- `scripts/lint-test-reachability.mjs` — the deleted `desktop/vitest.config.ts` runner removed.
- `scripts/lint-journey-ledger.mjs` (+ test) — search roots that no longer exist are skipped instead of crashing; the grid no longer requires a `desktop` surface.
- `tests/journeys.json` — 24 entries of the deleted web, desktop, client and Expo app-weight surfaces and 20 rigs whose test files are gone are deleted; dead consumers on the surviving gateway/mobile rows become `[]`. No surviving ceiling moves. The root, `entries` and `rigs` `approvedDeviation` notes carry the rationale (the ratchet reads the first `approvedDeviation` in the file up to its first quote or backtick, so the root note opens in plain text).
- `.github/workflows/enrichment-live-weekly.yml`, `scripts/test-report/enrichment-live-run.mjs`, its `package.json`, `lane-rules.mjs` and `egress-ledger.json` rows — retired: the workflow read the deleted `packages/model-runtime`. `docs/recognition-automations.md` states there is no live-model lane.
- `scripts/lint-acp-min-versions.mjs` and its `package.json` / `lint:product` rows — retired: the registry it read (`packages/server/src/acp/registry.ts`) is gone.

- `CHANGELOG.md` — one `Changed` line under Unreleased.
- `tests/journeys.json` is re-serialised through `oxfmt`, so one surviving number prints as `293` rather than `293.0`; the value is equal.

Owner rulings (this session): retire the v0-only journey rows, retire the weekly enrichment lane, open the law-estate changes on a second branch.

## Not changed

- `scripts/security/lifecycle-ledger.json` still carries a stale `electron-winstaller` entry, so `security:lifecycle` stays red. The edit was refused by the session's permission layer and was not routed around; it is a one-entry removal for the owner.
- `scripts/ci/gate-classes.json` still classifies `lint:acp-min-versions` (law estate; second change set).

## Verification

Run from the repo root on the branch tip:

```sh
node scripts/security/unsafe-edge-audit.mjs        # OK — every unsafe site is justified and within its ledger. exit 0
bun run lint:journey-ledger                        # journey-ledger: ok. exit 0
bun run lint:ledgers                               # check-ledgers: ok — 19 sections across 5 ledgers hold against origin/main. exit 0
bun run test:ratchet                               # ratchet-floors: ok (no decreases vs origin/main). exit 0
bun run lint:test-reachability                     # 99 test files, every one reached by a runner. exit 0
bun run lint:ci-egress                             # 5 workflow(s) enforce an egress policy, 2 pinned as debt. exit 0
node --test scripts/lint-journey-ledger.test.mjs scripts/check-ledgers.test.mjs scripts/security/unsafe-edge-audit.test.mjs scripts/lint-test-reachability.test.mjs   # pass 56, fail 0
bun run lint:product                               # 21/24 pass; red: test:advisory-expiry, lint:law-registry (law estate), security:lifecycle (refused edit). exit 1
```

The workflow glob is verified by reading the layout `upload-artifact` produces against the run's own log (tarball and sums at the artifact root, identity file under `artifact/<triple>/`); it has not been observed green in CI yet.

`scripts/ci/gate-classes.test.mjs` has four failures that predate this change (`test:qualities` unclassified, `lint:schema-export` undefined, the bundle-size floor of 30) and one this change causes until the law-estate row goes (`lint:acp-min-versions` classified but no script).

## Audit

Verdict: PASS

Independent audit against `git diff origin/main..HEAD` (commits `6bf780f9`, `dd313b45`) plus the untracked receipt. Two nits and one gap below, none of which weakens a gate.

- **1. "What changed" vs the diff.** Every bullet matches the diff and nothing claimed is missing. Two things the bullets do not name: a `CHANGELOG.md` entry (docs only), and an oxfmt-style `293.0` to `293` in a surviving journeys row's `observedBrowseP95CompositeMs` (numerically equal, so not a ceiling change). The `approvedDeviation` note says the consumers of "52" gateway/mobile entries were cleared; the diff clears 51 (a count slip in the note text, not in any number the ratchet reads).
- **2. Verification block re-run.** All outcomes reproduce: unsafe-edge-audit exit 0; `lint:journey-ledger` ok; `lint:ledgers` "19 sections across 5 ledgers"; `test:ratchet` ok; `lint:test-reachability` "99 test files"; `lint:ci-egress` "5 workflows, 2 pinned"; node --test pass 56 / fail 0; `lint:product` 21/24 with exactly `test:advisory-expiry`, `lint:law-registry`, `security:lifecycle` red, exit 1.
- **3. `tests/journeys.json`.**
  - Ceilings: I compared every non-`_` leaf on both sides. 0 differ across `hardware`, `volumes`, `journeys` and `_statusVocabulary`. Across surviving entries and rigs, 697 leaves other than `consumers` exist in the base and all 697 are still present and equal. The only leaf-level differences are the three `approvedDeviation` strings and 51 `consumers` arrays cleared to `[]`.
  - Cleared consumers: every removed consumer path is absent from the tree, and `lint:journey-ledger` rejects a consumer file that does not exist. It also rejects an entry with no span and no consumer, so every emptied row still names spans.
  - Deletions: 24 entries (web 11, desktop 11, client 1, `mobile/app-weight` 1) and 20 rigs, which is every rig row; all 20 rig test files are missing on disk. Nothing was added.
  - Ratchet: `test:ratchet` and `lint:ledgers` pass because of the changed `approvedDeviation` text; that is how they are built (a removed leaf needs a changed note). I checked the waiver is not hiding anything else. In a scratch clone with the three notes restored to their base text, both gates fail with only removals under the deleted web/desktop/client/app-weight keys and the deleted rigs. None sits under a surviving entry.
- **4. `rust-unsafe-ledger.json`.** The audit enforces equality (a count above or below the ledger fails) and every site needs a `SAFETY:` note within five lines; it passes, reporting core-ffi 98, centraid 0 and xtask 1. The script is unchanged in the diff. The ledger went up (core-ffi 86 to 98, xtask 0 to 1). The xtask site is `#[unsafe(no_mangle)]` inside a string fixture at `crates/xtask/src/rules.rs:777`, a scanner false positive rather than real unsafe. A reviewer may prefer to change the fixture than to bump the count. The 12 new core-ffi sites are v1 growth that the receipt states but does not itemise.
- **5. `lane-prebuilt-core.yml` glob.** The upload step lists `centraid-<triple>.tar.gz`, `SHA256SUMS.<triple>` and `artifact/<triple>/…identity.json`, whose least common ancestor is the workspace root. The tarball and sums therefore sit at the artifact root and the identity file under `artifact/<triple>/`. The unchanged tarball and `SHA256SUMS.*` checks use root-level paths, and the identity file is the only one that had a different layout. `download-artifact` with a `pattern` extracts to `artifacts/<artifact-name>/`, so the new glob `artifacts/prebuilt-core-*/artifact/*/centraid-*.identity.json` is consistent with that. I am fairly confident, but I did not observe a CI run.
- **6. Weakening vs retirement.**
  - Journey grid: dropping `desktop` is retirement. `desktop/` and `apps/desktop` no longer exist and no desktop entry survives, so the requirement was unsatisfiable. The mobile and gateway rows are still required, the test now asserts the hole on `mobile`, and the skip-if-missing change to `sources()` only skips directories that do not exist. `SEARCH_ROOTS` still lists `desktop` and `extension`; that is harmless.
  - `lint-acp-min-versions` read `packages/server/src/acp/registry.ts`, which is gone (`packages/server` does not exist). Retired, not weakened.
  - `enrichment-live-weekly` installed and ran `packages/model-runtime`, and `enrichment-live-run.mjs` targeted it; both trees are gone. Retired, and the egress-ledger and `lane-rules` rows went with it (egress can only shrink).
  - Residuals outside this change set: `lint:acp-min-versions` stays in `scripts/ci/gate-classes.json`, as the receipt says. The receipt does not mention that `tests/claims.json` still holds a `real-model-goldens` claim (line 590) and an `enrichment-live` section (line 1536); these are law estate for the second branch.
  - Nothing else in the diff loosens a ceiling, threshold or allowlist.

Not verified:
- The workflow glob against a real CI run (upload-artifact v7 layout inferred from its documented least-common-ancestor behaviour; I could not check the run log).
- The claim that the ledger's core-ffi sites are exactly the v1 ABI and nothing else.
- That the 12 new core-ffi sites and the xtask bump have been reviewed by the owner.
- `cargo xtask gate` profiles, the other CI jobs, and the law-estate change set.
