# Issue #1072 — main CI still red after #1066 and #1067

Follow-up to [#1052](https://github.com/srikanth235/centraid/issues/1052) and [#1062](https://github.com/srikanth235/centraid/issues/1062). Once those landed, `lint:product` was green on `main`, which let two failures that had been hidden behind the earlier ones show: the release aggregate's digest check and the candidate lane's commit-subject step. Both are territory files; no law-estate file changes here.

## What changed

- `.github/workflows/lane-prebuilt-core.yml` — `prebuilt-core-required` no longer demands that every published artifact report **one digest**. The digest is `cargo xtask artifact-key --triple <triple>`, and the key hashes the triple (`docs/release.md` defines it so), so the required artifacts carry different digests by construction; the check had never been reachable because the identity-file glob errored first (#1052). It now requires one `gitSha` and one `schemaVersion` across the artifacts, the fields that mean "built from one tree"; each build leg still proves its binary reports its own triple's key before it publishes. Two header comments now name `crates/core/…` instead of `crates/centraid/…`.
- `.github/workflows/candidate.yml` — the step "Commit message format on the merged tip" ran `bash .governance/run.sh commit-message-format`, a directive that stopped existing when #1005 ported it to a rule of the `law` directive, so it failed with "no directive matching" on every run (which also turned `report` and `lane-health` red). It now runs `bash .governance/run.sh law`, on a checkout with `fetch-depth: 2`: the independent audit below (round 1) found that with the default one-commit clone the range `HEAD~1..HEAD` is empty and the step passes without judging any subject, so the depth is part of the fix.
- `docs/release.md` — the release checklist line and the paragraph on required targets state the new invariant, and say why the digest cannot be the one-tree check.
- `CHANGELOG.md` — two `Changed` lines under Unreleased.

`lane-health`'s park-required rule (the 28-red-runs issue, [#1062](https://github.com/srikanth235/centraid/issues/1062)) needs no edit: it counts consecutive red candidates and clears after a green one.

## Verification

Reproduced from the CI logs, then checked locally on the branch tip:

```sh
# Reproduction (CI, run 36745037021, prebuilt-core-required): four identity files found, four distinct digests,
#   "##[error]the published artifacts report more than one digest" — exit 1.
# Reproduction (CI, run 36745035992, rung1-on-main): "Commit message format on the merged tip" = failure;
#   locally `bash .governance/run.sh commit-message-format` -> "✗ no directive matching 'commit-message-format'".
bash .governance/run.sh law            # on origin/main's tip: law (window door) 10 rules, 0 errors; "all 1 directive(s) passed". exit 0
bun run lint:product                   # 24/24 product gates passed. exit 0
bun run lint:ci-egress                 # 5 workflow(s) enforce an egress policy, 2 pinned as debt. exit 0
bun run lint:path-filters              # every workspace and top-level path covered. exit 0
bun run lint:evidence-mapping          # 53 registered lanes, every evidence step mapped. exit 0
# The new one-tree check, run on sample identity documents with the aggregate's own grep:
#   matching gitSha/schemaVersion, differing digest -> 1 distinct value per field (passes)
#   one differing gitSha                            -> 2 distinct values (fails, as intended)
```

Neither workflow change has run in CI yet; both failures were diagnosed from CI logs of `main`.

## Audit

Verdict: REFUTED

Independent review of `63910295` against `origin/main` `5ac5117c`. Change (1) holds; change (2) fails open on the runner it was written for.

- **1. Receipt vs diff.** The diff touches five files (`candidate.yml`, `lane-prebuilt-core.yml`, `CHANGELOG.md`, `docs/release.md`, this receipt) and the receipt's "What changed" names all of them, including the two `crates/centraid/…` to `crates/core/…` comment fixes. No law-estate file is touched: `.governance/law/packs/centraid.json` `lawPaths` is `.governance/**`, `CONSTITUTION.md`, `scripts/ci/gate-classes.json`, the `tests/*.json` floors, the oxlint and oxfmt configs and `.github/CODEOWNERS`, and none of the five matches. Two inexact statements: the receipt says "the four required artifacts" but three triples are required (four is the number of identity files seen in the CI log, which includes an optional leg), and the new `candidate.yml` comment says the range is "the trunk's own recent commits", which is false (see 3).
- **2. Prebuilt-core check.** The premise is true: `crates/xtask/src/artifact.rs` hashes `triple=…` inside the `build` part, so digests differ per triple by construction. Each build leg still proves `grep -q "\"digest\":\"${KEY}\""` on its own binary's `--version --json` output, so nothing per-leg was lost. The real JSON (`ArtifactIdentity::to_json`, printed by `crates/centraid/src/main.rs`) is compact, with `gitSha` as a string and `schemaVersion` as an i64 number. I ran the workflow's exact loop under `set -euo pipefail` on synthetic identity files in that shape. Agreeing legs pass. One leg with a different `gitSha` exits 1, and one with a different `schemaVersion` exits 1. No matching file at all exits 2 through `pipefail` and `set -e`, and files with no field exit 1, so both fail closed, though silently with no `::error` line. The dropped per-digest comparison lost nothing, because it could not pass with more than one triple. Residual gap: if only SOME files lack a field while the rest agree, the loop passes, because `grep -h` still matches the others. The old check had the same gap, and each leg's own stamp check covers it.
- **3. Candidate step.** `bash .governance/run.sh commit-message-format` prints "no directive matching" and exits 1, confirmed. The rule lives at `.governance/law/rules/commit-message-format.mjs` and runs inside the `law` directive. `bash .governance/run.sh law` on this branch exits 1 with one error: `receipt-per-issue` wanted a `## Audit` section, which this section now supplies. **The replacement FAILS OPEN in CI.** `resolveRange()` in `.governance/law/arrival.mjs` returns the tip commit alone (`HEAD~1..HEAD`) when `origin/main` equals HEAD, and `base = head` (an empty range) when `HEAD~1` does not exist. The `rung1-on-main` job uses a bare `actions/checkout` with no `fetch-depth` (and `.github/actions/setup` does not deepen it), so the clone is depth 1 and `HEAD~1` is an unknown revision. I reproduced this in scratch repos. A depth-1 tip whose subject is "this is a terrible squash subject with no type and no issue" passes `law` with "no findings" and exit 0. The identical bad subject on a depth-2 clone is refused with exit 1. So the step goes green without examining the squash subject, which is the failure it exists to catch (#916's 105-character subject). Fixes belong to the owner: `fetch-depth: 2` on that checkout, or an explicit `--range HEAD~1..HEAD` with that depth. Also no longer true: the comment's claim "the range is the trunk's own recent commits". The estate-separation finding for `2814721f` is `severity: "warn"` in the pack. `node .governance/law/run.mjs --range 2814721f~1..2814721f` prints "0 error(s), 1 warning(s)" and exits 0, and `main()` returns 1 only when an error-severity message exists. On a real tip the range is one commit, so that old commit is out of range anyway. Other rules can still error on the merged tip, for example `receipt-per-issue` on the tip's own receipt.
- **4. Gates.** `bun run lint:product` passes 24/24 (exit 0), `lint:ci-egress` passes (5 workflows, 2 pinned as debt), `lint:path-filters` passes and `lint:evidence-mapping` passes (53 lanes; it prints unmapped-lane warnings, exit 0). All four match the receipt. The working tree had no other changes.
- **5. Weakening.** Change (1) corrects a wrong premise, and what replaces it (same commit, same schema) still catches a leg built from another commit. Change (2) looks like the same kind of fix but, as shown in 3, weakens the merged-tip subject check to a no-op on a depth-1 checkout while the comment and the receipt imply it now runs and judges the squash subject. The receipt's verification also ran `law` only on a tree with history, never on a depth-1 clone, so it does not exercise the CI condition.

Not verified:
- No actual GitHub Actions run of either workflow; the CI run ids and logs quoted in the receipt were not re-fetched.
- I did not build the `centraid` binary. The JSON shape comes from reading `to_json()` and `main.rs`, and the loop was tested on synthetic files of that shape.
- The vendored `commit-message-format` shell directive is gone, so how the old step behaved on a shallow checkout is unknown.
- What the `gh` or `actions/checkout` runner does for `refs/remotes/origin/main` on `push` was not observed. The vacuity holds either way: a depth-1 clone has no `HEAD~1`, and with the ref absent the loop falls to the same fallback.

## Audit (round 2)

Verdict: PASS

Re-audit of the depth-2 fix. The round-1 `## Audit` above is unchanged. Note on state: while I was reviewing, `HEAD` moved from `63910295` to `fafd4444` ("fetch two commits so the commit-subject check can judge one"), so the workflow and "What changed" edits described as uncommitted were already committed; only this receipt's audit text is uncommitted. I audited the tree as it stands.

- **1. Fail-open closed.** `.github/workflows/candidate.yml` parses as valid YAML (python `yaml`; `actionlint` is not installed). In job `rung1-on-main`, step 2 is `actions/checkout@3d3c42e5… # v7.0.1` with `with: {fetch-depth: 2}`, the pin comment intact, followed by `./.github/actions/setup`. I rebuilt the CI condition in scratch repos (`git fetch --depth N`, `origin/main` = HEAD) on the current tree with only the tip subject varied. Depth 1 with the bad subject "this is a terrible squash subject with no type and no issue": `HEAD~1` does not exist, `law` exits 0 with no findings (the round-1 fail-open, reproduced). Depth 2 with the same bad subject: `HEAD~1` = `fafd444`, `commit-message-format` has 1 finding, exit 1. Depth 2 with a 122-character subject: refused, "subject is 122 chars (max 100)", exit 1. Depth 2 with `fix(ci): a perfectly fine squash subject (#1072)`: no findings, exit 0. So the fix closes the hole and does not over-reject a good subject.
- **2. Other steps.** The deeper fetch breaks nothing I could find. `bun run lint:product` passes 24/24 in both a depth-1 and a depth-2 clone at this tree. The ratchet and ledger members compare against `origin/main`, which equals HEAD on this lane, so they take the same standing-check path at either depth. The other steps read `github.sha` and do not depend on history: `write-evidence.mjs`, the upload, and the `report` job, which has its own separate checkout and is untouched. The `rung1-on-main` job is the only one changed.
- **3. Minor findings.** The receipt no longer says "four required artifacts"; it says "the required artifacts". The `candidate.yml` comment now says the range is `HEAD~1..HEAD`, the tip commit alone. The fetch-depth reason is in both the workflow comment and "What changed", which credits the round-1 audit. Law-estate files are still untouched by the two commits combined.
- **4. Law on the result.** The window door reads the receipt from the committed `HEAD`, not the working tree, so `bash .governance/run.sh law` here still reports `receipt-per-issue` ("missing a '## Audit' section") until the audit text is committed; that is the uncommitted state, not a defect. Committing the current working-tree receipt onto `fafd4444` in a scratch depth-2 clone (`origin/main` = HEAD) gives `law` "10 rule(s), no findings", exit 0.

Not verified:
- No real Actions run. That `actions/checkout` with `fetch-depth: 2` yields `HEAD~1` is inferred from documented behaviour and emulated with `git fetch --depth 2`, not observed on a runner.
- `actionlint` was unavailable; validity rests on the python YAML parse and the job-step structure only.
- The squash-merge case where GitHub's merged tip has a parent other than the PR's own commits was not tried; depth 2 always gives the tip and its first parent.
