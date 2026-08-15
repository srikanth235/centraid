# Receipt — issue #782: restore testing honesty invariants (wave 1 of the 2026-08 audit)

This receipt covers wave 1 of the remediation of the 2026-08 testing-strategy
audit. The audit's remaining findings are the open backlog in #781; this change
restores the invariants the gates claim to enforce, so that #781's follow-ups
land against a truthful baseline.

## Checklist

- [x] `tests/matrix.json#trackingIssues` agrees with GitHub for every listed issue; no skip, partial cell, or gap cites a closed issue
- [x] `bun run test:matrix` and the skip-inventory gate pass with the corrected ledger
- [x] Skip inventory scans nested script directories; budget equals the true population
- [x] `wal-shipper.test.ts [G4]` passes as root and still fails when the shipper misreports a failed segment write
- [x] A CI job runs the deterministic local-only gates and is required via the `check` aggregator
- [x] TESTING.md floor table matches `tests/coverage-floors.json` exactly; seed count and `scheduler-no-backfill` minimumTests corrected; `check:pr` description matches the real gate chain
- [x] QUALITY.md wal-shipper item moved to Resolved with this issue's number; stale counts refreshed

## What changed

### Ledger truth-sync (S1)

`tests/matrix.json#trackingIssues` recorded #656/#657/#659 as open; GitHub
closed all three on 2026-07-31/2026-08-01. Because the skip gate and the
partial-cell validator read only this ledger, every skip (29/29), every
`partial` cell (92/92), both `gap` entries, and four `revisitTriggers` cited a
closed issue while the gates passed green. The ledger now marks the three
closed and registers #781 (the audit's gap backlog) as open; all citations are
re-homed to #781 with their provenance preserved in the existing
"(originally #N)" chain style. No grade, flow, law, owner, or minimumTests
changed — `flows`, `laws`, `surfaces`, `dimensions`, `qualities`,
`cellOwners`, `appEngines`, and `demonstratedRed` are byte-identical.

`scripts/test-report/skip-inventory.mjs` scanned only one directory level
under `scripts/`, so the `t.skip` in
`scripts/gateway-package/assemble-runtime.test.mjs` was invisible — the true
skip population was 30 against a budget of 29. The scan globs now cover
`scripts/**/*.test.mjs` (preserving the deliberate `scripts/test-report/`
exclusion) and `apps/*/scripts/**/*.test.mjs`; the surfaced skip is
inventoried citing #781; `_budget` is 30 with the increase recorded as an
approved deviation (see Decisions). The stale recorded line for
`packages/gateway/src/cli/cli.test.ts#1` (244 → 261) is corrected, and the
skip-inventory test now covers nested-directory scanning.

The matrix fingerprint in `tests/quality/classification-ratchet.json` is
refreshed for the citation sweep, with the approved deviation below.

### wal-shipper root-proof fault injection (S2)

`packages/vault/src/wal-shipper.test.ts` `[G4]` injected its failed segment
write with `chmodSync(groupDir, 0o500)`, which root ignores — so the test
failed deterministically for every root agent session (QUALITY.md's top Open
item). The injection is now a path-shape fault: the group dir is stashed aside
and a regular file is left at its path, so `writeFileDurable`'s leading
`mkdirSync(path.dirname(file), { recursive: true })` throws for every uid —
there is no capability that makes the kernel treat a regular file as a
directory. The failure lands in the same `capture()` try-block the chmod
targeted, so every assertion (error reported, nothing shipped, no marker,
offset frozen, WAL unchanged, same range re-ships) keeps its meaning. The
shipper itself is byte-identical.

Demonstrated red, both halves: removing the injection fails
`expect(err).toBeDefined()`; sabotaging the shipper (swallowing the error, or
advancing `stream.offset` before returning `error`) fails the error assertion
and `expect(offset).toBe(offsetBefore)` respectively. Three consecutive
full-file runs green as root.

### CI enforcement for local-only gates (S3)

~19 `check:push` gates had no CI job: they ran only on developers' machines,
and receipts (#765, #731) record `check:push` being skipped locally — the hole
behind the #767 red-on-main gallery baseline and #765's unsanctioned Insights
UI removal. `ci.yml` now has a `gates` job running the sixteen deterministic,
container-runnable gates (`check:reachability`, `lint:design-tokens`,
`lint:mobile-design`, `lint:logical-insets`, `lint:hairline`,
`lint:aria-labels`, `lint:container-opacity`, `lint:type-floor`,
`lint:motion-rule`, `lint:design-md`, `lint:engine-conformance`,
`lint:law-registry`, `lint:quality-knobs`, `lint:schema-export`,
`check:ui-receipt`, `test:quarantine`; ~6.5s combined), wired into the
required `check` aggregator. `test:qualities` — the lane carrying quality
gates R4/D4/U3 — needs built `dist/`, so it runs in `verify` immediately after
`bun run build` (~50s inside the 35-minute budget) rather than paying a second
cold build. Two gates deliberately remain outside CI: `design:gallery` (needs
a pinned Playwright browser download) and `check:mobile-native-state`
(delegates to the existing `mobile-smoke` job on mobile-touching diffs); #781
tracks their lanes. Actions reuse the existing SHA-pinned checkout and the
local setup composite; `lint:workflow-pins` stays green.

### Docs reconciliation (S4)

TESTING.md's floor table now mirrors `tests/coverage-floors.json` row-for-row:
the three drifted rows (vault 87/73, design/src 94/70, gateway 79/65) follow
the JSON's #638/#709 reseed provenance, and the three scopes the table omitted
(`packages/blob-format/src/**`, `packages/client/src/*.{ts,tsx}`,
`apps/desktop/src/main/*-core.ts`) are present, with a lead-in stating the
JSON, not the table, is the enforced contract. The `test:mutation` row says
sixteen seeds (matching `scripts/mutation/seeds.mjs`, the canonical list —
the eight `tests/mutation/` pointers are recorded as vestigial), the
`scheduler-no-backfill` `minimumTests` reads the matrix's 19, and the
`check:pr` row describes the real chain (`check:push` →
`scripts/ci/run-gates.mjs`, 40 gates) instead of enumerating eleven of them.
The workflows table lists the new `gates` job, and a paragraph names the two
gates still outside CI (`design:gallery`, `check:mobile-native-state`) with
their #781 tracking. Both #717 references now state the offline
write/reconnect journey is not yet built, tracked in #781 (originally #717).

QUALITY.md: the wal-shipper `[G4]` item moved to Resolved under #782; the
#496 hygiene figures are re-measured on the current tree (1,023
`toHaveBeenCalled*` sites; all 186 bare calls are negated
`.not.toHaveBeenCalled()`, zero positive bare remain; 2026-08-14); and the
band-owner item moved to Resolved because the gap is genuinely closed —
#778 deleted `useBandOwner.ts` and web/desktop honour a claim on the
structural condition in `inlineAppFrame.tsx`, while #712 E3 moved the mobile
preference to `apps/mobile/src/kit/band/band-owner.ts`.

`tests/mutation-floors.json` `_layer3Comment` names `packages/model-runtime`
(named enrichment-service until #753 renamed it); no key or value changed.

### Acceptance crosswalk

The sections above are the evidence for each checked item, quoted verbatim:
**`tests/matrix.json#trackingIssues` agrees with GitHub for every listed issue; no skip, partial cell, or gap cites a closed issue** (S1);
**`bun run test:matrix` and the skip-inventory gate pass with the corrected ledger** (S1 + Verification);
**Skip inventory scans nested script directories; budget equals the true population** (S1);
**`wal-shipper.test.ts [G4]` passes as root and still fails when the shipper misreports a failed segment write** (S2);
**A CI job runs the deterministic local-only gates and is required via the `check` aggregator** (S3);
**TESTING.md floor table matches `tests/coverage-floors.json` exactly; seed count and `scheduler-no-backfill` minimumTests corrected; `check:pr` description matches the real gate chain** (S4);
**QUALITY.md wal-shipper item moved to Resolved with this issue's number; stale counts refreshed** (S4).

Changed files (every path in this change set):

```text
.github/workflows/ci.yml
QUALITY.md
TESTING.md
packages/vault/src/wal-shipper.test.ts
receipts/issue-782-testing-honesty-wave-1.md
scripts/ci/hygiene-gates.mjs
scripts/test-report/skip-inventory.mjs
scripts/test-report/skip-inventory.test.mjs
tests/matrix.json
tests/mutation-floors.json
tests/quality/classification-ratchet.json
tests/skips.json
```

## Out of scope

Per #782: floor/ceiling reseeds that need a fresh full-coverage measurement
(suite wall-clock, coverage floors, experience budgets), new matrix
surfaces/laws for sharing/Insights/experimental gating, nightly mobile and
accessibility lane repair, and CI lanes for the pixel gallery and
mobile-native-state gates. All tracked in #781.

## Decisions

- Approved deviation (quality knobs): "#782 re-homes closed-issue citations (#656/#657/#659 -> #781) in tests/matrix.json notes, gaps, revisitTriggers, and trackingIssues; no quality gate, grade, flow, law, or owner changed, so the fingerprint refresh is bookkeeping for the citation sweep."
- Approved deviation (skip budget): the `tests/skips.json` `_budget` rises 29 → 30 because the widened scan glob surfaced a skip that always existed (`scripts/gateway-package/assemble-runtime.test.mjs#1`); no new skip was added. Recorded as `approvedDeviation` in `tests/skips.json` citing #782.

## Verification

```sh
bun run check:pr
# 39/40 gates green (slowest: test:affected 252.8s). The one red,
# design:gallery, is environmental: this container has Chromium build 1194
# and the repo pins Playwright's 1234; downloading browsers is unavailable
# here, and running pixel comparisons under a mismatched build produces the
# false-diff noise #765 documented. This change touches no design source,
# stylesheet, or baseline, so the gate's inputs are identical to main, where
# it is green as of #773. Its CI lane remains tracked in #781.
bun run test:matrix        # 15 surfaces × 11 dimensions, 94 flows, 30 skips
bun run test:ratchet       # ok — no decreases vs origin/main; skips 30/30
bun run lint:quality-knobs # no silent widening (fingerprint + deviation)
bun run lint:workflow-pins # 19 workflows clean
bun run scripts:test       # green (includes the hygiene-gates anchor fix)
bun run test:report:smoke  # ok — QUALITY.md Open section still parses
node node_modules/vitest/vitest.mjs run packages/vault/src/wal-shipper.test.ts
# 10/10 as root (uid 0), three consecutive runs; demonstrated-red evidence in
# "What changed"
```

Seam fix found by the full run: the new `gates` job introduced the literal
string `check:reachability` before the `check` job, and
`scripts/ci/hygiene-gates.mjs` anchored its needs-list checks with
`ci.split("check:")[1]`, which then captured the wrong slice. The anchor now
matches the top-level `check` job definition (same mechanism its own test
file already used); the asserted contract is unchanged.

## Audit

Fresh-context audit against `git diff origin/main` (staged + unstaged + the
untracked receipt), issue #782's acceptance criteria, and the tree as it
stands. Three checks, three verdicts.

**(1) `## What changed` faithfully describes the diff — PASS.** Every claim
was checked against the hunks. `tests/matrix.json`: a structural key-by-key
comparison against `origin/main` shows exactly `trackingIssues`, `gaps`,
`revisitTriggers`, and `notes` changed; `flows`, `laws`, `surfaces`,
`dimensions`, `qualities`, `cellOwners`, `appEngines`, `demonstratedRed`,
`legend`, `workspaceSurfaces`, `version`, and `$schema` are byte-identical, as
claimed. Citations: no `"trackingIssue": 656|657|659` remains anywhere in the
matrix, all 30 `tests/skips.json` sites cite 781, and every re-homed string
keeps its "(originally #N)" provenance. `ci.yml`'s new `gates` job contains
exactly sixteen `bun run` steps, and they are precisely the sixteen the receipt
names; `gates` is present in the `check` aggregator's `needs:` list;
`test:qualities` was added to `verify` after `bun run build`; none of the
seventeen gate names appears anywhere in `origin/main`'s `ci.yml`, confirming
the "no CI job" premise. `packages/vault/src/wal-shipper.ts` is untouched —
only the test changed. TESTING.md's floor table now has the same 22 scope rows
(plus repo-wide) as `tests/coverage-floors.json`, with every floor pair equal
to the JSON's; the three previously absent scopes (`packages/blob-format/src`,
`packages/client/src/*.{ts,tsx}`, `apps/desktop/src/main/*-core.ts`) are
present. `scripts/mutation/seeds.mjs` has 16 seed entries and `tests/mutation/`
holds 8 pointers, matching the "sixteen seeds / eight vestigial pointers"
prose; `scheduler-no-backfill`'s `minimumTests` in the matrix is 19, matching
the corrected row. QUALITY.md's re-measured hygiene figures reproduce exactly:
1,023 `toHaveBeenCalled*` sites, 186 bare `toHaveBeenCalled()`, 0 of them
positive. No diff content is undisclosed: `scripts/ci/hygiene-gates.mjs`'s
anchor fix is described (in `## Verification` rather than `## What changed` —
the one placement nit in an otherwise complete account), its asserted contract
is unchanged (the `check` job's `needs:` list must still name `gitleaks` and
`osv-scanner`, both of which it does; its own test file is untouched and
`bun run scripts:test` is 173/173 green), and the two `ci.yml` niceties the
prose does not itemize (`fetch-depth: 0` and the `git fetch origin main` step)
serve the merge-base gates the job comment names.

**(2) Each `- [x]` item is realized in the diff — PASS.** Verified item by
item, not from the receipt's word. #656/#657/#659 are `closed` on GitHub
(#656 closed 2026-07-31 by PR #661) and are now marked `closed` in
`trackingIssues`; #781 is open on GitHub and registered open. `bun run
test:matrix` is green ("15 surfaces × 11 dimensions, 94 canonical flows … 30
inventoried skips") and `node scripts/test-report/skip-inventory.mjs` reports
"30 inventoried skip sites, budget 30" with exit 0. The scan globs are now
`scripts/**/*.test.mjs` + `apps/*/scripts/**/*.test.mjs` with the
`scripts/test-report/` exclusion preserved, and the newly visible
`scripts/gateway-package/assemble-runtime.test.mjs#1` is inventoried; the new
`discoverSkipSites` tests pin both the nested-scan behaviour and the exclusion.
`node node_modules/vitest/vitest.mjs run packages/vault/src/wal-shipper.test.ts`
is 10/10 green as uid 0 in this container. Demonstrated red was re-derived
independently, not accepted: sabotaging the shipper to swallow the failed
segment write (deleting the `report.errors.push` in `shipSegment`'s catch)
makes `[G4]` fail at `expect(err).toBeDefined()`; the shipper was restored from
a scratch copy and `git status` confirms it is unmodified. The CI job exists
and is required through `check`. TESTING.md's floor table matches the JSON
exactly (above), the seed count reads sixteen, `scheduler-no-backfill` reads
19, and the `check:pr` row now describes the real chain (`check:push` →
`scripts/ci/run-gates.mjs`, whose argument list is exactly 40 gates).
QUALITY.md's wal-shipper item is gone from Open and present under Resolved
citing #782, with counts refreshed. `bun run lint:quality-knobs`,
`bun run lint:workflow-pins` (19 workflows clean), and `bun run
test:report:smoke` are green here.

**(3) The receipt's `## Checklist` mirrors the issue's — PASS.** All seven
acceptance criteria are present, in the issue's order, with the same
obligations and no item dropped, split, or narrowed. Two parenthetical glosses
are elided: "(i.e. the gates now enforce the invariant they were skipping)"
from item 2 and "(values and row set)" from item 6. Neither elision weakens the
item — both are restatements of the obligation rather than extra obligations,
and both were independently verified satisfied above (the gates run and pass on
the corrected ledger; the floor table matches the JSON in both values and row
set).

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-14 | claude-code | 36f0a126-2d40-5128-b3ea-59456606a925 |
