# Issue #1072 — main CI still red after #1066 and #1067

Follow-up to [#1052](https://github.com/srikanth235/centraid/issues/1052) and [#1062](https://github.com/srikanth235/centraid/issues/1062). Once those landed, `lint:product` was green on `main`, which let two failures that had been hidden behind the earlier ones show: the release aggregate's digest check and the candidate lane's commit-subject step. Both are territory files; no law-estate file changes here.

## What changed

- `.github/workflows/lane-prebuilt-core.yml` — `prebuilt-core-required` no longer demands that every published artifact report **one digest**. The digest is `cargo xtask artifact-key --triple <triple>`, and the key hashes the triple (`docs/release.md` defines it so), so the four required artifacts carry four different digests by construction; the check had never been reachable because the identity-file glob errored first (#1052). It now requires one `gitSha` and one `schemaVersion` across the artifacts, the fields that mean "built from one tree"; each build leg still proves its binary reports its own triple's key before it publishes. Two header comments now name `crates/core/…` instead of `crates/centraid/…`.
- `.github/workflows/candidate.yml` — the step "Commit message format on the merged tip" ran `bash .governance/run.sh commit-message-format`, a directive that stopped existing when #1005 ported it to a rule of the `law` directive, so it failed with "no directive matching" on every run (which also turned `report` and `lane-health` red). It now runs `bash .governance/run.sh law`.
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
