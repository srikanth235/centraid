# Receipt: adopt governance-kit 0.15.0 + audit 0.11.0, restore the file ceiling under oxlint (#1003)

## What changed

**Kit runtime to 0.15.0.** `.governance/run.sh`, `.governance/lib.sh` and `.github/workflows/governance.yml` re-stamped by the fetched target's own engine; hook dispatchers regenerated; `install.yaml` re-pinned to `gh:duaility/governance-kit/kit@kit/v0.15.0` (`b00eab2`). Diffs were marker bumps plus a doc-comment example in `run.sh`.

**Audit pack to 0.11.0, and the pack consolidation absorbed.** governance-kit now ships one pack; `packs/commits` and `packs/foundation` are deleted upstream (duaility/governance-kit#370), so their pinned tags are dead ends. `pack add gh:…/packs/audit@audit/v0.11.0` then `pack remove` on both. The bundled catalog is `commit-message-format`, `doc-integrity`, `managed-tree-integrity`, `receipt-per-issue`; with the eight repo-local directives the suite is 12, down from 22. Ten directives were retired: `agent-session-identity`, `commit-issue-receipt-match` (folded into `receipt-per-issue`), `issue-templates`, `issues-tracked`, `toolchain-config-protection`, `no-orphan-todos`, `no-unjustified-suppressions`, `internal-doc-links`, `repo-hygiene`, `required-docs`.

**A homonym collision repaired.** `pack remove` strips CONSTITUTION.md subsections by heading id, so removing `commits`/`foundation` deleted the `commit-message-format` and `managed-tree-integrity` sections that audit 0.11.0 had just upserted under new ownership. Re-running `pack-apply add` for audit re-upserted all four. Also removed two empty `## governance-kit/{foundation,commits}` headings left behind, and replaced a stray `<!-- pack: governance-kit/foundation -->` marker — which docsurgery does not read and which mislabelled the local directives — with a real `## srikanth235/centraid` heading.

**Three freeze rules restored.** audit 0.11.0 slims `doc-integrity`'s shipped `RULES` to receipts plus the Evolution Log. This repo was inheriting the old defaults through an empty overlay, so `COSTS.md`, `STEERING.md` and `QUALITY.md#Resolved` silently stopped being frozen; re-added with `RULES+=` in the overlay, which no lifecycle verb rewrites.

**Residue removed.** Five orphaned `.conf` overlays for retired ids. 196 dead `governance: allow-*` waiver tokens across 189 files, with the comment blocks carrying them; where a waiver sat on something functional (an `oxlint-disable`, a `@ts-nocheck`, a line of code, a `git commit -m` string, a generated-banner template literal) only the governance clause was cut. Stale prose corrected in `pre-push-gate` and `handler-contract` (both cited retired directives), `docs/decisions.md#G-rung0-deferral`, `docs/dev-environment.md`, `scripts/test.sh`, `docs/traps/device-only-runtime-gaps.md`, and CONSTITUTION.md's compliance and escape-hatch sections.

**The 625-line ceiling is back, as oxlint's `max-lines`.** `oxlint.config.ts` already carried `"max-lines": "off"` in the #210 repo-profile block; it is now `["error", { max: 625 }]` — the same raw-line count `repo-hygiene` used, at ~0.4s against that directive's 51.2s, inside a lint pass that already runs. The 131 files predating the rule are exempt **by name** in a new `tests/inventory.json#fileSize` section, registered down-only in `scripts/check-ledgers.mjs`, not by inline `oxlint-disable` comments: a suppression is free to add and invisible in review, a ledger row must survive the section's `_budget` and an `approvedDeviation`. `scripts/lint-oversized-files.mjs` builds the override list and refuses if budget and rows disagree; it is a separate module because the config is itself subject to the ceiling (adding the loader inline pushed it to 635 lines and the rule failed on it).

**Local behavior change:** `core.hooksPath` was unset in the working clone, so `required-docs` failed the post-update smoke test; set to `.githooks`. `repo-hygiene` was dropped from `.governance/conf/srikanth235/centraid/pre-commit-deferred.conf`, which now lists only `receipt-per-issue`.

## Verification

```sh
bash .governance/run.sh
```
`✓ governance: all 12 directive(s) passed`.

```sh
bun run lint
```
Exit 0, no findings, with `max-lines` active and `reportUnusedDisableDirectives: "deny"`.

```sh
bun run typecheck
```
`Tasks: 25 successful, 25 total`.

```sh
bun run format
```
Clean over 5560 files; no reformatting beyond the waiver removals themselves (every changed source file's diff is waiver-related).

```sh
bun run lint:ledgers
```
`check-ledgers: ok — 20 sections across 5 ledgers hold against origin/main`.

```sh
node --test scripts/check-ledgers.test.mjs
```
19 tests, 19 pass, 0 fail — after adding the new `fileSize` section to the synthetic fixture, which the "clean rename of every ledger passes" case had correctly failed on.

Both new guards were exercised rather than assumed. A fresh 700-line file fails with `max-lines … Maximum allowed is 625`. Setting `_budget` to 999 against 131 rows fails the oxlint config load with `tests/inventory.json#fileSize: _budget is 999 but 131 sites are listed`.

Per-directive timings taken after the update (this machine, serial, one process per directive): full suite 4.30s; slowest `receipt-per-issue` at 2.36s, against the 35.1s its pre-0.11.0 check cost.

## Decisions

- **Accepted the loss of nine directives rather than porting them.** Upstream calls them community/repo-local concerns; the operator chose the clean migration over vendoring them into `srikanth235/centraid`.
- **Replaced only the file-length ceiling.** `repo-hygiene`'s other four sub-checks — the 5 MB tracked-file limit, merge markers, committed build artefacts, debug statements — are deliberately not replaced. Recorded as `G-file-ceiling` in `docs/decisions.md` so the omission is a decision rather than a gap someone rediscovers.
- **Exemptions as a ledger row, not inline suppressions.** Restoring the ceiling at 625 makes 131 files fail; the obvious fix would re-add, in a weaker form, the 184 waivers this change deletes. The ledger keeps one reviewable list under a down-only budget.
- **Whole waiver comments deleted, rationale included**, per the operator's instruction — except where the token sat on functional code, where only the clause was cut.
- **Receipts and the Evolution Log left alone.** 15 waiver references survive in `receipts/*.md`; they are frozen by `doc-integrity` and are accurate history.
- **Two upstream-owned files still name retired directives** and are not edited here: `.governance/lib.sh:115` and `.governance/run.sh:78` are digest-managed, so a hand edit fails `managed-tree-integrity`. Worth reporting upstream along with the retire-then-remove heading bug.

## Limitations

- The `fileSize` ratchet is inert on this change: `check-ledgers` compares against the merge base, `origin/main` has no such section, so it takes the documented first-land path. It binds from the next change that touches the section. The `_budget`-vs-rows guard is live immediately.
- `apps/mobile/ios/ShareExtension/ShareViewController.swift` is over 625 lines and is now genuinely unenforced — oxlint does not read Swift. It is the only such file.
- `docs/dev-environment.md`'s gate-loop timings were measured on a reference machine before this catalog change. They are marked superseded rather than re-derived, because I could not reproduce that machine's conditions.
- The rung-0 deferral's arithmetic no longer holds — the whole suite now fits inside the 5s budget the deferral exists to escape. The mechanism is left running unchanged; collapsing it is a separate decision.

## Audit

Independent review against `git diff origin/main...HEAD`, this receipt, and issue #1003.

- PASS — `## What changed` matches the diff. The kit re-stamp, the pack move and both `pack remove`s are in `.governance/`; the overlay restore is three `RULES+=` lines; the waiver sweep is 189 files whose every hunk removes a `governance: allow-*` token or its comment; the ceiling is `oxlint.config.ts`, `scripts/lint-oversized-files.mjs`, `tests/inventory.json#fileSize`, and the `SECTIONS` row plus fixture in `scripts/check-ledgers.{mjs,test.mjs}`.
- PASS — the claimed non-replacements are absent from the diff: nothing re-implements the 5 MB, merge-marker, artefact or debug-statement checks, and the receipt says so rather than implying full parity.
- PASS — every command under `## Verification` names its outcome, and the two guard probes describe failures that were produced, not predicted. The timing figures are attributed to the machine that produced them.
- CONCERN — the ratchet's first-land inertness means this PR's own 131-row exemption list lands without a down-only comparison behind it. That is inherent to the validator's design, is stated under `## Limitations`, and the row count is reviewable here.
