# Issue #988 — governance tooling for parallel orchestration

Lane: governance tooling. Branch `claude/988-governance-tooling`, one commit per acceptance box.

## Checklist

- [ ] Per-lane receipt files: `receipts/issue-<N>/` read as one receipt
- [ ] Gate stamps keyed by tree hash for the static tier, outside the repo, never read by CI
- [ ] Tiered push check by branch: static tier off `main`, full tier on `main`
- [ ] False positives: agent-session-identity date row
- [ ] False positives: check:ui-receipt surface predicate keyed on imports
- [ ] False positives: lint:product tolerates a spent one-shot marker
- [ ] Shared build cache across worktrees, measured
- [ ] docs/multi-agent.md, docs/dev-environment.md and docs/toolchain.md state the model
- [ ] `.governance/run.sh` green; every existing receipt still passes `receipt-per-issue`

## What changed

**Box 1 — per-lane receipt files: NOT DONE, and it cannot be done from this repo.**

`receipt-per-issue`, `doc-integrity` and `agent-session-identity` all live in the vendored
`governance-kit/audit` pack. That pack carries a `digest:` map in `.governance/packs.lock`, so
`managed-tree-integrity` fails on any hand edit to the directive folders — the same wall
`docs/dev-environment.md#the-local-gate-loop` records for the #915 rung-0 deferral. The knobs that
would express a directory receipt (`RECEIPTS_DIR`, `RECEIPT_FILENAME_REGEX`,
`NEW_RECEIPT_FILENAME_REGEX`, `REQUIRED_SECTIONS`) are all `tunable: false` in the pack's
`directive.yaml`, and `conf_get`/`conf_list` in `.governance/lib.sh` ignore an overlay row for a
non-tunable key. There is no vendored `governance` CLI to regenerate the pack.

Reproduced before concluding, on a clean tree: a `receipts/issue-988/` directory holding `index.md`
plus `tooling.md` draws eight violations — both filenames rejected by the newly-added-receipt
filename regex, and every required section demanded of the per-lane file. `git ls-files --
'receipts/*.md'` does match nested paths (git's wildmatch spans `/`), so the directive already
*enumerates* a directory receipt; what it cannot do is read the two files as one. Separately,
`agent-session-identity`'s `receipt_resolve` globs `issue-<N>.md` / `issue-<N>-*.md` under a `-f`
test, so it would stamp its Session table into a new sibling `receipts/issue-988.md` rather than
into the directory.

This receipt is therefore a single file, `receipts/issue-988-governance-tooling.md`, not the
directory shape the brief asked for.

## Out of scope

- Editing anything under `.governance/packs/**` or `.governance/run.sh` (digest-locked).
- `receipts/issue-92*`, `docs/decisions.md`, `SECURITY.md`, `docs/harnesses.md`, `tests/perf`, `tests/scale`.
- Migrating any existing receipt.

## Decisions

- **Box 1 is reported, not forced.** Landing it needs a change to a digest-locked directive folder,
  and the only way to make that pass `managed-tree-integrity` is to rewrite the recorded digest in
  `.governance/packs.lock` — defeating the check rather than satisfying it. The lane's rule is to
  stop on a box that cannot be met without weakening a check.

## Verification

```sh
# The reproduction, on a clean tree:
mkdir -p receipts/issue-988 && printf '# probe\n' > receipts/issue-988/tooling.md
git add receipts/issue-988 && bash .governance/run.sh receipt-per-issue
git rm -rq --cached receipts/issue-988 && rm -rf receipts/issue-988
```

## Session

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-09-05 | claude-code | 60f9e86b-149f-5fc9-84c0-f2160b6b6f3c |
