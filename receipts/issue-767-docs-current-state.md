# Receipt: issue #767 — docs current-state consolidation

## Checklist

- [x] AGENTS.md states the rule (docs = current state; history by reference only; deliberate absences are documentable state), the three-layer model, and the "intent lives in proposal issues" line; no index rows point at `docs/plans/` or `docs/refactors/`.
- [x] CONSTITUTION.md carries the new Principles bullet; `coverage-scope-reachability` rationale reads as current shape + issue citations with no multi-generation narrative (Evolution Log untouched).
- [x] `docs/decisions.md` preamble names it as the adjudication layer; superseded rows are one-line pointers; durable outcomes from retired plans appear as decision rows.
- [x] `docs/plans/` and `docs/refactors/` no longer exist; every file in the disposition table has its content demonstrably relocated (issue comment, TESTING.md section, ARCHITECTURE.md, or decisions.md row) before deletion.
- [x] The five photos docs live under `docs/photos/` with a directory index; AGENTS.md index rows updated; `internal-doc-links` green.
- [x] `docs/photos-design-notes.md` + `docs/docs-app-design-notes.md` are one divergence register with per-app sections and a single stated "do not fix quietly" contract.
- [x] `docs/sonarcloud.md` content lives in `docs/toolchain.md`; TESTING.md owns the photos testing contract and the app-admission checklist; source files removed.
- [x] Narration sweep list exists as child issues linked here, each fixed or explicitly deferred with a reason.
- [x] No receipt, CHANGELOG, Evolution Log, or QUALITY `## Resolved` line is modified anywhere in the umbrella's PRs.
- [x] Tripwire decision recorded in this issue before the umbrella closes.
- [x] Consolidated the four handler-boundary directives into one `handler-contract` directive with named sub-checks, at the maintainer's direction.

## What changed

### Acceptance crosswalk

AGENTS.md states the rule (docs = current state; history by reference only; deliberate absences are documentable state), the three-layer model, and the "intent lives in proposal issues" line; no index rows point at `docs/plans/` or `docs/refactors/`.

CONSTITUTION.md carries the new Principles bullet; `coverage-scope-reachability` rationale reads as current shape + issue citations with no multi-generation narrative (Evolution Log untouched).

`docs/decisions.md` preamble names it as the adjudication layer; superseded rows are one-line pointers; durable outcomes from retired plans appear as decision rows.

`docs/plans/` and `docs/refactors/` no longer exist; every file in the disposition table has its content demonstrably relocated (issue comment, TESTING.md section, ARCHITECTURE.md, or decisions.md row) before deletion.

The five photos docs live under `docs/photos/` with a directory index; AGENTS.md index rows updated; `internal-doc-links` green.

`docs/photos-design-notes.md` + `docs/docs-app-design-notes.md` are one divergence register with per-app sections and a single stated "do not fix quietly" contract.

`docs/sonarcloud.md` content lives in `docs/toolchain.md`; TESTING.md owns the photos testing contract and the app-admission checklist; source files removed.

Narration sweep list exists as child issues linked here, each fixed or explicitly deferred with a reason.

No receipt, CHANGELOG, Evolution Log, or QUALITY `## Resolved` line is modified anywhere in the umbrella's PRs.

Tripwire decision recorded in this issue before the umbrella closes.

### Policy and decisions

- `AGENTS.md` now makes current-state docs, history-by-reference, deliberate absences, supersession markers, the State / Decisions / Evidence model, and issue-owned intent explicit; the obsolete plans/refactors index rows are gone.
- `CONSTITUTION.md` adds the current-state principle and trims the coverage rationale to its present boundary with issue citations; the Evolution Log is untouched.
- `docs/decisions.md` is now a compact adjudication layer covering gateway founding/recovery, ownership, Commons, recognition, blueprint readiness, design grammar, inline apps, and performance/Rust boundaries. Superseded T1, #298, #599, and #724 records are one-line pointers.

### Consolidations and relocations

- `docs/photos/README.md` indexes `derived-ledger.md`, `places.md`, `dogfood.md`, `switcher-walkthrough.md`, and the Photos `design-notes.md` entry point. The five reader moments remain separate because their maintenance triggers differ.
- `docs/design-divergences.md` is the single Docs/Photos sanctioned-divergence register with one “do not fix quietly” contract; `docs/photos/design-notes.md` points to its Photos section.
- The Photos derived ledger, dogfood ritual, Places contract, and switcher walkthrough were moved under `docs/photos/` with relative links repaired and historical narration trimmed to current facts/citations.
- The former SonarCloud document is absorbed into `docs/toolchain.md`; `scripts/ci/configure-sonarcloud.mjs` and `SECURITY.md` point to that owner.
- App admission and Photos native-renderer contracts from the retired plan docs now live in `TESTING.md`; low-end/Rust measurements and boundaries now live in `ARCHITECTURE.md`, `docs/decisions.md`, and the gateway benchmark README.
- Current inline-system-app, block-composition, product-grammar, and Commons outcomes are recorded in `ARCHITECTURE.md`, `docs/design-machinery.md`, `docs/decisions.md`, and issue comments on #505, #690, #731, and #765. The plan/refactor directories and their source files are deleted.
- Moved-document references in `DESIGN.md`, `QUALITY.md` (Open only), `docs/blueprint-seats.md`, `docs/logs.md`, and gateway observability comments now resolve.
- The current #765 design source exposed a pre-existing `mo-advisory-dark` gallery drift on the main branch; `tests/design-gallery/baselines/mo-advisory-dark.png` was refreshed with the gallery's documented `--update` command so the existing design gate is green. No DESIGN.md contract content changed.
- Child issues [#768](https://github.com/srikanth235/centraid/issues/768), [#771](https://github.com/srikanth235/centraid/issues/771), [#770](https://github.com/srikanth235/centraid/issues/770), [#772](https://github.com/srikanth235/centraid/issues/772), and [#769](https://github.com/srikanth235/centraid/issues/769) record fixed/deferred narration-sweep dispositions. The tripwire is deliberately a future warn-only sweep lane, not a new blocking governance directive.

### Changed files

The implementation changed or relocated: `AGENTS.md`, `ARCHITECTURE.md`, `CONSTITUTION.md`, `DESIGN.md`, `QUALITY.md`, `SECURITY.md`, `TESTING.md`, `docs/blueprint-seats.md`, `docs/decisions.md`, `docs/design-divergences.md`, `docs/design-machinery.md`, `docs/glossary.md`, `docs/logs.md`, `docs/photos/README.md`, `docs/photos/derived-ledger.md`, `docs/photos/design-notes.md`, `docs/photos/dogfood.md`, `docs/photos/places.md`, `docs/photos/switcher-walkthrough.md`, `docs/recognition-automations.md`, `docs/toolchain.md`, `packages/gateway/benchmarks/README.md`, `packages/gateway/src/serve/commons-observability.ts`, `scripts/ci/configure-sonarcloud.mjs`, and `tests/design-gallery/baselines/mo-advisory-dark.png`. The review pass additionally changed `QUALITY.md` (inserted `## Resolved` entry) and added `docs/traps/README.md`, updated `docs/dev-environment.md` and `docs/multi-agent.md`, and removed `docs/photos/design-notes.md`. The directive consolidation added `.governance/packs/srikanth235/centraid/directives/handler-contract/` (`check.sh`, `constitution.md`, `directive.yaml`), removed the `query-handlers-read-only`, `actions-declare-table-writes`, `data-runtime-sqlite-separation`, and `handler-uses-ctx-primitives` directive folders, and updated `.governance/packs.lock` and `CONSTITUTION.md`.

The retired source paths were `docs/docs-app-design-notes.md`, `docs/photos-derived-ledger.md`, `docs/photos-design-notes.md`, `docs/photos-dogfood.md`, `docs/photos-places.md`, `docs/photos-switcher-walkthrough.md`, `docs/plans/app-scenario-layer-template.md`, `docs/plans/commons-fixed-window-sync.md`, `docs/plans/gateway-low-end-and-rust-plane.md`, `docs/plans/photos-testing.md`, `docs/refactors/README.md`, `docs/refactors/inline-system-apps.md`, `docs/refactors/one-block-vocabulary-per-dom.md`, `docs/refactors/product-grammar.md`, and `docs/sonarcloud.md`.

### Review amendments (PR #773)

A review pass on the PR surfaced six findings; all are fixed in this branch:

- **Restored the dropped Defaults.** The former "Defaults (so nobody has to ask)" decisions (B3 knip, G1 dev env, I5 staged rollout, I10 packaging, K11 fonts) had been lost rather than relocated; they are back as a compact current-state table in `docs/decisions.md`.
- **Evolution Log entry added.** The new current-state principle in `CONSTITUTION.md` now has its required amendment-process Evolution Log entry (appended; no existing line modified), matching the #659 precedent.
- **Baseline refresh recorded.** The `tests/design-gallery/baselines/mo-advisory-dark.png` refresh is now written down in `QUALITY.md` `## Resolved` (inserted entry; no existing line modified) with its cause, instead of living only in the PR body.
- **decisions.md deduplicated against state docs.** The ownership/peer-transport schema bullets and the performance/Rust mechanics now state the ruling and link `ARCHITECTURE.md` / `SECURITY.md` / `glossary.md` for mechanics, so each fact keeps one maintenance trigger.
- **Evidence out of TESTING.md.** The measured Photos renderer numbers (durations/timings) were replaced by the contract statement with the measurements cited to #716.
- **Photos design-notes stub removed.** `docs/photos/design-notes.md` was a three-line redirect; `docs/photos/README.md` and `docs/design-divergences.md` now link the shared register section directly.
- **AGENTS.md condensed to a map plus judgment rules** (113 → 35 lines): the duplicated "Where to look" section is gone, the repo summary is four sentences, conventions that restate mechanically enforced directives are dropped (the enforcement message teaches them at failure time), and the per-trap table moved to the new `docs/traps/README.md` index. At the maintainer's direction two further cuts landed: the `CLAUDE.md` symlink instruction left AGENTS.md for `docs/dev-environment.md#fresh-clone` (it is a clone-setup fact), the "Rules to follow" block was compressed to the one rule a failing hook cannot teach — that passing every gate does not make a change constitution-compliant — and the docs index collapsed from a 36-row table into grouped link lines, with the State / Decisions / Evidence / Intent layer model kept as the four lines that route everything else. A final maintainer addition records the orchestration norm: umbrella issues are worked by a root agent that owns the plan and coordinates sub-agents, since correctness lives in the plan's intricacies rather than in dispatched jobs (pointing at docs/multi-agent.md for norms and caps). docs/multi-agent.md gained the matching "Root-agent orchestration" section — slice by ownership, order as part of the plan, slice contracts for sub-agents, root-owned seam integration — since the doc previously covered only peer parallelism and the AGENTS.md pointer would otherwise promise content that was not there.

### Directive consolidation (maintainer-directed)

The four repo-local directives that guarded the app-handler boundary — `query-handlers-read-only`, `actions-declare-table-writes`, `data-runtime-sqlite-separation`, and `handler-uses-ctx-primitives` — are now one `handler-contract` directive with four named sub-checks (`query-read-only`, `declared-writes`, `sqlite-separation`, `ctx-primitives`). They scanned the same file set, shared one rationale and one failure signature (the mutation succeeds, the change stream stays quiet, subscribed UI goes stale with no error), and none was a load-bearing axis alone — the reasoning governance-kit already applies to its own `repo-hygiene` and `required-docs`.

Consolidated the four handler-boundary directives into one `handler-contract` directive with named sub-checks, at the maintainer's direction. Surface area:

- Added `.governance/packs/srikanth235/centraid/directives/handler-contract/check.sh`, `.governance/packs/srikanth235/centraid/directives/handler-contract/constitution.md`, and `.governance/packs/srikanth235/centraid/directives/handler-contract/directive.yaml`.
- Deleted `.governance/packs/srikanth235/centraid/directives/query-handlers-read-only/`, `.governance/packs/srikanth235/centraid/directives/actions-declare-table-writes/`, `.governance/packs/srikanth235/centraid/directives/data-runtime-sqlite-separation/`, and `.governance/packs/srikanth235/centraid/directives/handler-uses-ctx-primitives/`.
- Updated the local pack's directive list in `.governance/packs.lock`; the repo-local catalog goes 11 → 8.
- `CONSTITUTION.md` replaces the four directive sections with one and appends the Evolution Log entry the amendment process requires, in this same commit per the cardinal rule.

**No rule changed.** Same patterns, same file globs, same violation messages (now prefixed with the sub-check name for triage). Waivers are backward compatible: the new `allow-handler-contract` token and all three retired per-directive tokens are honoured, so no waiver migration was needed — and a repo-wide grep confirmed zero live waivers for the family in product code.

## Decisions

- The user requested one PR, so the five child issues are tracking/disposition records linked from #767; the implementation is intentionally not split into child PRs.
- The handler-contract consolidation is a deliberate expansion of #767's stated scope, which had listed governance directive rule changes as out of bounds. The maintainer directed it into this PR rather than a separate issue; the rules themselves are unchanged, so the exclusion's intent (no silent policy drift inside a docs PR) still holds.
- The merged directive keeps the three retired waiver tokens working instead of migrating waivers, so no product file had to change to land a governance refactor.
- `.governance/packs.lock` already omitted `no-hardcoded-colors` from the local pack's directive list before this change; directive discovery walks the directory tree rather than the lock, so the omission is inert. Left as found — correcting it is unrelated drift.
- The five Photos documents remain separate under a directory because the derived ledger, dogfood ritual, Places projection, switcher walkthrough, and design entry point have different maintenance triggers.
- The shared divergence register is the single content owner for per-app design divergences; the former Photos entry-point stub was removed in the review pass and its inbound links repointed at the register's Photos section.
- The narration tripwire is recorded as warn-only and deferred until a baseline exists; no governance directive rules changed.
- Existing evidence is frozen: no existing receipt, CHANGELOG, Evolution Log, QUALITY `## Resolved`, COSTS, or STEERING line was modified. The evidence layer gained only additions — this #767 receipt, the appended Evolution Log entry the amendment process requires, and an inserted QUALITY `## Resolved` entry for the gallery-baseline refresh. The acceptance criterion's "Evolution Log untouched" is read as "no existing line modified", which is also what the `doc-integrity` frozen-section rule enforces.

## Out of scope

- Existing receipts, CHANGELOG.md, COSTS.md, and STEERING.md remain untouched; existing Evolution Log and QUALITY.md `## Resolved` lines are unmodified (each gained one appended/inserted entry, as the amendment process and quality-tracking conventions require).
- Governance directive rules and budgets remain unchanged; only current-state policy wording was added to AGENTS.md and CONSTITUTION.md.
- The remaining operational-doc audit is explicitly deferred in child issue #772 because those files are current contracts/runbooks with separate reader moments.
- The warn-only tripwire is a future issue, not a new blocking check in this change.
- DESIGN.md content remains unchanged; only its dead reference to the retired product-grammar path was repaired to point at issue #690.

## Verification

The issue-owned relocation comments were added before the retired sources were removed. The child issue list and tripwire disposition were recorded on #767. Existing evidence was checked by diffing the changed paths; the only receipt path is this new #767 receipt, and no CHANGELOG, Evolution Log, or QUALITY `## Resolved` line is in the diff.

The consolidated directive was proved red before it was trusted green. A seeded app under `packages/blueprints/apps/_govseed/` (one violation per sub-check, staged so `git grep` could see it, then removed) produced five violations — `stmt.run()` and `db.exec()` in a query handler, a `runtime.sqlite` reference, an `openai` import, and an action with no `writes` field — each labelled with its sub-check. A second seeded run with waivers on those lines returned green, covering both the new `allow-handler-contract` token and the retired per-directive tokens. The clean tree passes.

```sh
bash .governance/packs/srikanth235/centraid/directives/handler-contract/check.sh
bash .governance/run.sh
bun run check:pr
bash .governance/run.sh internal-doc-links
test ! -e docs/plans && test ! -e docs/refactors
git diff --check origin/main...HEAD
# fragment anchors are outside internal-doc-links' file-level resolve check;
# sweep every deep link into the rebuilt files and confirm each heading exists
grep -rn "decisions\.md#\|design-divergences\.md#\|photos/[a-z-]*\.md#" --include="*.md" . | grep -v receipts/
```

The manual union check reads the current destinations against the retired sources: TESTING.md owns app admission and Photos testing; ARCHITECTURE.md and docs/decisions.md own gateway performance/Rust boundaries; decisions.md owns durable plan outcomes; issue comments own intent and historical rationale. `AGENTS.md` remains within its required-docs line budget.

## Audit

PASS — a fresh-context audit against issue #767 and the branch diff confirms that the current-state policy, decision adjudication layer, five-document Photos index, shared divergence register, SonarCloud relocation, plan/refactor retirement, child-issue dispositions, warn-only tripwire decision, link repair, and evidence-layer boundaries are represented in the changed files. The user-requested one-PR delivery shape is recorded as the only deliberate deviation from the issue's child-PR recommendation.

A follow-up review pass (recorded above as "Review amendments") restored dropped content, added the required Evolution Log entry, recorded the baseline refresh in QUALITY.md, deduplicated decisions.md against the state docs, moved measurements to their issue, removed the stub, and condensed AGENTS.md; each amendment was verified against the diff and the PASS verdict stands.

The audit also identified three pre-existing references to retired Photos paths in `receipts/issue-721-photos-north-star-core.md`. They remain unchanged deliberately: receipts are frozen evidence, and the repository's internal-document-link gate excludes the evidence layer by design.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-13 | codex | 019ffc0a-6910-73a1-9dbe-b5620a3ca641 |
| 2026-08-14 | claude | 3e6c9797-a768-51b9-8ef6-d7c574444929 |
