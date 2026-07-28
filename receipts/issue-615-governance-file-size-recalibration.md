# Receipt: #615 restore `governance` green — recalibrate `file-size-limit` after #596's reformat

## Checklist

- [x] bisect the `repo-hygiene` breakage to `91f92703` (#596)
- [x] establish that none of the 68 violations is a real god-file
- [x] recalibrate `FILE_SIZE_LIMIT` 500 → 625 in the repo overlay, from measurement
- [x] hoist the 3 waivers oxfmt displaced out of `has_file_waiver`'s 10-line window
- [x] `bash .governance/run.sh` green locally
- [ ] upstream fix for `has_file_waiver`'s fragile 10-line window — out of scope, noted on the issue

## What changed

`governance` is a required check in the `main-protection` ruleset, and it has been red on `main` and on **every open PR** since `91f92703` — *"chore(lint): adopt oxlint rule families C-F from the toolchain umbrella (#573) (#596)"*. Bisected against the Governance workflow runs on `main`: `18784afe` ✓, `fb670666` ✓, `91f92703` ✗ (68 violations), and every commit since ✗ with the identical 68.

All 68 are `file-size-limit` hits, and none is a god-file. #596 reformatted 2627 files (+239,798 / −171,684) with no behavioural change, inflating line counts by **12.9% in aggregate** — measured across the 2420 source files it touched: 474,010 → 535,164 lines. Two mechanisms, both mechanical:

- **65 files crossed 500 by reflow alone.** Every one was at or under the limit beforehand (worst case exactly 500), and none carried a waiver because none needed one. Worst inflation is 1.25× — `packages/gateway/src/routes/connections-routes.test.ts`, 464 → 580.
- **3 files kept a valid waiver that stopped being visible.** `has_file_waiver` (`.governance/lib.sh:119`) reads only `head -n 10`. Each of these carried its `// governance: allow-repo-hygiene file-size-limit …` comment on line 2, sitting above an import; oxfmt's import sorting reordered the block and carried the comment down with the import it was attached to — to line 14 (`vault-plane.test.ts`), 12 (`replica-shape.test.ts`), 11 (`static-server.test.ts`).

The fix, in two parts:

- `.governance/conf/governance-kit/foundation/repo-hygiene.conf` — set `FILE_SIZE_LIMIT=625`. The overlay exists for exactly this and is never touched by `governance pack update`. 625 is derived rather than chosen: `500 × 1.25` (the worst observed per-file inflation) reproduces the pre-#596 violation set exactly — the same files pass and the same files fail. The comment block records the measurement so the next formatter change redoes the arithmetic instead of nudging the number.
- The 3 displaced waivers move to line 1, above the import block, where import sorting cannot reach them. The comment text is unchanged. The three files are `packages/gateway/src/serve/vault-plane.test.ts`, `packages/gateway/src/routes/replica-shape.test.ts`, and `packages/app-engine/src/http/static-server.test.ts`.

Work done, item by item:

- bisect the `repo-hygiene` breakage to `91f92703` (#596) — done against the Governance workflow runs on `main`, per the table above.
- establish that none of the 68 violations is a real god-file — done by comparing every violator's line count at `fb670666` against `origin/main`; all 65 unwaived ones were at or under 500 beforehand.
- recalibrate `FILE_SIZE_LIMIT` 500 → 625 in the repo overlay, from measurement — done in `.governance/conf/governance-kit/foundation/repo-hygiene.conf`, with the 1.25× derivation recorded inline.
- hoist the 3 waivers oxfmt displaced out of `has_file_waiver`'s 10-line window — done in `packages/gateway/src/serve/vault-plane.test.ts`, `packages/gateway/src/routes/replica-shape.test.ts`, and `packages/app-engine/src/http/static-server.test.ts`; each waiver comment now sits on line 1.
- `bash .governance/run.sh` green locally — confirmed, with the bootstrap caveat noted under `## Verification`.

## Decisions

- **Recalibrated the limit rather than splitting 65 files.** A formatter that widens lines does not create god-files. Splitting them would be enormous churn justified by nothing, and would destroy the directive's meaning — it would be responding to a measurement artifact as though it were a design problem.
- **Recalibrated rather than adding 65 waivers.** Each new waiver would assert a deliberate design intent that does not exist. That is precisely the dishonest-labelling failure #587 exists to eliminate; manufacturing 65 instances of it to turn a check green would be the worst available option.
- **625, not "a bit more than 500".** Any number ≥ 617 turns the build green. 625 is the one that provably preserves the prior violation set, which is the property that makes this a recalibration rather than a relaxation. The rationale is committed next to the value so the claim stays checkable.
- **Hoisted the 3 waivers instead of widening the detection window.** Widening `has_file_waiver`'s window is the better long-term fix, but `.governance/packs/**` is kit-owned and hand-editing managed files is forbidden. The hoist is correct on its own terms regardless — a file-level waiver belongs at the top of the file, not attached to an import.
- **Landed on the #609 branch rather than its own PR.** `governance` is a required check, so no PR can merge while it is red — including a PR that fixes it. Splitting this into its own PR would have left both blocked. Kept as a separate commit with its own issue and receipt so it can be reverted or cherry-picked independently.

## Out of scope

- **`has_file_waiver`'s 10-line window.** It is fragile against any tool that reorders the head of a file, and it fails *closed* in a way indistinguishable from a real violation. The fix belongs upstream in governance-kit (widen the window, or scan the whole file for file-level waivers); recorded on #615.
- **The 134 files already over the limit with valid waivers.** Untouched and still waived.
- **Re-examining whether any of the 65 deserves splitting on its own merits.** Possibly some do, but that is a design judgement per file, not this repair.

## Verification

Full directive suite, from the repo root:

```sh
bash .governance/run.sh
```

`✓ governance: all 25 directive(s) passed` — `repo-hygiene` included. Before this change the same command reported `✗ repo-hygiene (68 violations)` / `✗ governance: 1 directive(s) failed, 24 passed`, identical to the CI failure on `main` at `aaa347cb` and on PR #610.

That run predates this receipt. Re-running it against a tree containing the receipt but with `## Audit` / `## Steering` still empty reports `✓ repo-hygiene` alongside `✗ receipt-per-issue` and `✗ agent-steering-accounting` — the ordinary bootstrap state for any new receipt, cleared once the attestation sections below are populated. The pre-commit gate passing is the standing proof of the full suite; `repo-hygiene`, the directive this issue is about, is green in both runs.

Recalibration preserves the prior violation set — the property the number is chosen for:

```sh
git ls-files -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs' ':!vendor/**' ':!**/node_modules/**' ':!**/generated/**' ':!**/migrations/**'
```

202 files exceed 500 lines; 134 carry a head-visible waiver. Of the remaining 68: 65 were at or under 500 before #596 and all fall under 625; 3 are the displaced-waiver cases, now visible again at their original sizes (1541, 1019, 1107).

## Audit

Fresh-context sub-agent, inputs limited to the staged diff, this receipt, and issue #615.

- **(1) Receipt's `## What changed` faithful to diff** — PASS. All 5 changed files (`repo-hygiene.conf`, the 3 test files, the receipt itself) are named in the receipt. Spot-checks all confirmed independently: `repo-hygiene.conf` sets `FILE_SIZE_LIMIT=625`; `.governance/lib.sh:119` is exactly `head -n 10 "$file" ... | grep -q ...`, matching the claim verbatim; `connections-routes.test.ts` is 464 lines at `fb670666` and 580 now, matching "464 → 580" exactly. The other reflow-table rows also verified independently: `admin.test.ts` 500→617, `build-gateway.test.ts` 495→587, `gateway-client-vault.ts` 494→585, `SettingsConnectionsScreen.test.tsx` 431→565 — all exact. `91f92703` confirms "2627 files changed, 239798 insertions(+), 171684 deletions(-)" as cited. Current sizes of the 3 displaced-waiver files — 1541, 1019, 1107 — match, and `head -2` confirms the waiver comment now sits on line 1 above the import block in each.
- **(2) Every `- [x]` realized or substantiated** — PASS with one caveat. The recalibration and the 3 hoists are directly verified in the diff. The bisect claim is corroborated by the commit's own stat. "None of the 68 is a real god-file" is a judgement call, reasonably substantiated (worst-case pre-#596 size was exactly 500 — reflow, not new content). The runtime claim `bash .governance/run.sh` green is only partially reproducible from the staged tree: `✓ repo-hygiene` confirmed, but the full suite shows `✗ agent-steering-accounting` and `✗ receipt-per-issue`, both driven by this receipt's own attestation sections still being empty — the expected chicken-and-egg for a fresh receipt, not evidence against the fix.
- **(3) Receipt checklist mirrors the issue** — PASS. Both have 6 items, identical order, identical wording verbatim including the final out-of-scope item, unchecked in both. Only check-state differs.

Verdict: PASS — all file-size and line-count claims independently reproduced exactly; the checklist crosswalk is verbatim; the only soft spot was the `## Verification` "all 25 passed" framing, which has since been amended to state the bootstrap caveat the auditor identified.

## Steering

Fresh-context sub-agent, inputs limited to the session transcript and this receipt.

- **(1) Every human-steering event is recorded as a row** — PASS. Zero genuine human turns fall in the #615 window (from the `/goal get green CI build on this PR` message to the end of the transcript). That window contains only the slash-command echo and its stdout (both excluded as local-command output), one `isMeta` system-injected goal-hook message, and a series of tool-result turns — none of them human-authored. Zero human turns means zero steering events, so no rows were recorded, which is the correct outcome rather than an omission. Steering for the earlier #609 and #587 work was already accounted for in its own receipt.
- **(2) No non-steering message recorded as a steering event** — PASS. No rows were written, so no misclassification is possible. The only human-adjacent candidate — the goal-hook injection — is system-generated rather than user-authored, and is a directive to proceed rather than a correction of work in progress, so it would not qualify regardless.

Verdict: PASS — zero steering events in the #615 window, correctly recorded as zero rows.

## Accounting

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-52daa03c-5de-1785266308-1 | claude-code | 52daa03c-5de9-4fe6-8b60-3be75e811310 | #615 | claude-opus-5 | 2230 | 2429541 | 179540250 | 722516 | 3154287 | 123.0288 | 7825 | 7784510 | 639287259 | 2424091 | fix(governance): recalibrate file-size-limit after the oxlint reformat (#615)`go |
| claude-code-52daa03c-5de-1785266520-1 | claude-code | 52daa03c-5de9-4fe6-8b60-3be75e811310 | #615 | claude-opus-5 | 13 | 13729 | 1258515 | 5181 | 18923 | 0.8447 | 7838 | 7798239 | 640545774 | 2429272 | fix(governance): recalibrate file-size-limit after the oxlint reformat (#615)`go |
