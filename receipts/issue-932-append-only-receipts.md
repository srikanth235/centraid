# Receipt — issue #932: umbrella receipts are append-only, not frozen

[#932](https://github.com/srikanth235/centraid/issues/932) — wave 1: the union merge driver for `receipts/*.md`.

## Checklist

- [ ] A slice commit that appends a section to an existing umbrella receipt passes `doc-integrity` with no waiver line
- [ ] A commit that edits a line above the append point still fails without a waiver
- [ ] CONSTITUTION.md and the enforcing test change in the same commit

None of #932's three acceptance criteria is ticked: they are all about the `doc-integrity` rule itself (replacing `frozen-files receipts/*.md` with an `append-only` mode), which this slice deliberately does not touch. This slice removes the *other* cost of the append-only convention — the rebase conflict two sibling slices pay on every appended section — and it is orthogonal to the waiver question.

## What changed

- **`.gitattributes`** (new, repo root — there was none) — `receipts/*.md merge=union`, with a comment block stating the property: receipts are append-only, each slice adds one section at the end, and `doc-integrity` requires the trunk's copy to stay a byte-prefix. Git's built-in `union` driver concatenates a conflicting hunk ours-then-theirs; in a rebase onto `main`, "ours" is `main`, so main's section lands first and the prefix survives. That is the resolution sibling slices were typing by hand — the #928 w1b worker resolved seven in a row before squashing.
- **`docs/dev-environment.md`** — new `### Receipts are append-only, and sibling appends merge by union` under `## Worktrees`, where the multi-agent slice workflow already lives. States the append-only rule, what the driver buys, the blank-line seam to check, and the two limits: the driver cannot tell an append from an edit (so the never-touch-text-above-your-section rule and `doc-integrity` still bind), and `git merge` orders union by the *checked-out* branch, so a slice branch must rebase onto `main` rather than merge `main` into itself.
- **`CONTRIBUTING.md`** — one paragraph under `## House rules pointers`, next to the existing "One receipt per substantive issue" bullet, linking the dev-environment section.

No `.gitattributes` existed anywhere in the tree before this change (`git ls-files '*.gitattributes'` was empty), and nothing in `.governance/`, `scripts/`, `package.json` or `docs/` reads or lints an attributes file (`grep -rn gitattributes` over all four was empty), so the file is inert to every gate and adds no new lint surface.

## Out of scope

- The `doc-integrity` `append-only receipts/issue-*.md` mode itself and its CONSTITUTION.md entry + Evolution Log line — that is #932's actual decision and a separate slice; the directive folder is digest-locked (`managed-tree-integrity`), so it is plausibly an upstream governance-kit change. Slice commits still carry the `governance: allow-doc-integrity` waiver line until it lands.
- `receipt-per-issue`'s shape rules (explicitly out of scope in #932).
- Teaching GitHub's server-side merge about the driver — not possible; see the limit recorded below.
- Any `merge=union` marking outside `receipts/`. Union is only safe on a file whose semantics are "a bag of independent appended blocks"; applying it to prose or code silently produces text nobody wrote.

## Verification

Red-first, in a throwaway lab repo built by `scratchpad/union-lab.sh`: one base commit holding a receipt-shaped `receipts/issue-932-append-only-receipts.md`, two sibling branches off that base each appending one distinct section, then `git rebase sib-a` from `sib-b`. The only difference between the two runs is whether the base commit carries this change's `.gitattributes`.

```sh
# RED — no .gitattributes
$ bash union-lab.sh lab-red no-attr
### rebase sib-b onto sib-a (no-attr)
Auto-merging receipts/issue-932-append-only-receipts.md
CONFLICT (content): Merge conflict in receipts/issue-932-append-only-receipts.md
error: could not apply 56e9370... sib-b appends
rebase exit=1
--- conflicted file ---   (marker lines indented two spaces here, so `repo-hygiene` does not read this receipt as a conflicted file)
  <<<<<<< HEAD
## w1a — first sibling

AAA first slice evidence.
  =======
## w1b — second sibling

BBB second slice evidence.
  >>>>>>> 56e9370 (sib-b appends)

# GREEN — same fixture, base commit carries this change's .gitattributes
$ bash union-lab.sh lab-green with-attr
### rebase sib-b onto sib-a (with-attr)
Successfully rebased and updated refs/heads/sib-b.
rebase exit=0
--- merged file ---
baseline section on main.

## w1a — first sibling

AAA first slice evidence.
## w1b — second sibling

BBB second slice evidence.
--- ordering: first sibling's section before second's ---
13:AAA first slice evidence.
16:BBB second slice evidence.
--- byte-prefix: sib-a's file is a prefix of the result ---
PREFIX OK (first 150 bytes identical)
```

Ordering and prefix are both checked mechanically in the green run: `grep -n` shows the first branch's section at line 13 and the second's at line 16, and `head -c 150 <result> | cmp - <sib-a version>` exits 0, i.e. the upstream branch's whole file is a byte-prefix of the rebased result — exactly the `doc-integrity` rule. The blank line separating the two sections is factored out by the union driver (both hunks begin with one, so it becomes shared context); reinserting it is itself an append after the prefix, so it stays prefix-safe. Both lab repos and their temporary branches live only under the scratchpad and were removed; no temporary branch was created in this worktree.

`git merge` orders union the other way — by the checked-out branch, not by the upstream:

```sh
$ git checkout sib-b && git merge --no-edit sib-a   # ours = sib-b
Auto-merging receipts/issue-932-append-only-receipts.md
Merge made by the 'ort' strategy.
merge exit=0
--- result ---
## w1b — second sibling
BBB
## w1a — first sibling
AAA
```

So the driver only produces the prefix-preserving order under **rebase**. That is the operation this program's workers run: a slice branch is rebased onto `origin/main` before it is pushed, which is where the conflicts were being paid. **GitHub's own PR mergeability check does not honour `.gitattributes` merge drivers** — the server-side merge runs without the working-tree attributes — so the driver buys nothing on the PR page; a receipt-only conflict shown there is still resolved by rebasing locally, which is now clean.

The attribute resolves for real receipt paths in this worktree, and for nothing else:

```sh
$ git check-attr merge -- receipts/issue-932-append-only-receipts.md receipts/issue-928-one-authority-plane.md docs/dev-environment.md CONSTITUTION.md
receipts/issue-932-append-only-receipts.md: merge: union
receipts/issue-928-one-authority-plane.md: merge: union
docs/dev-environment.md: merge: unspecified
CONSTITUTION.md: merge: unspecified
$ git --version
git version 2.43.0
```

Gates (host: 4-core / 15 GB Linux container, shared with sibling agents; heavy gates under the shared `flock`):

```sh
bun run format
bun run lint
bash .governance/run.sh
bun run lint:product
```

No package test suite or package `typecheck` was run, and none is owed: the change set is one repo-root git attributes file and two Markdown documents. It compiles nothing, imports nothing, and is not read by any test, script or workflow — the only executable consumer is git's own merge machinery, which the lab above exercises directly. `internal-doc-links` (rung 0) covers the new `CONTRIBUTING.md` → `docs/dev-environment.md#receipts-are-append-only-and-sibling-appends-merge-by-union` anchor.

## Decisions

- **`.gitattributes` at the repo root, not `receipts/.gitattributes`.** A root file is the one place a reader looks and the one place `git check-attr` output is explainable from; a per-directory file inside `receipts/` would be invisible to anyone reading the tree top-down. The pattern is scoped (`receipts/*.md`), so the location costs nothing in blast radius.
- **`receipts/*.md`, not `receipts/**`.** Union on a non-text file corrupts it silently. The glob matches exactly the append-only Markdown receipts and nothing else; if a non-Markdown artefact is ever committed under `receipts/`, it is untouched by default.
- **The commit carries `governance: allow-toolchain-config`** even though `.gitattributes` may not match `toolchain-config-protection`'s shipped path list. The directive's whole value is that a config change leaves a `git blame`-visible reason; carrying the line unconditionally makes the change greppable alongside every other toolchain change, and a line the directive does not require costs nothing. No lint, test, or CI policy was changed — this is the "tightened the harness" case the directive exists to distinguish, and it weakens no gate: `doc-integrity` still enforces the byte-prefix, and the driver only automates the resolution a human was typing.
- **The driver is a convenience, not a rule.** It is recorded in both docs as such, with the explicit statement that it cannot tell an append from an edit. Nothing about the append-only discipline is delegated to git.

## Audit

Verdict: PASS

Fresh-context verifier, no input from the worker's reasoning. Worktree `claude/932-w1-receipts-union-merge` at `3b33d30eb`.

- **Diff ↔ receipt.** `git diff --stat origin/main...HEAD` is exactly four files, all additions (`.gitattributes` +10 new, `CONTRIBUTING.md` +2, `docs/dev-environment.md` +6, this receipt +126, 0 deletions). Every file is named and correctly described in `## What changed`; nothing described is absent, nothing present is undescribed. All four are inside the slice's in-scope path list; no scope creep. `git diff --numstat` shows no binary file; `grep -lP '\x00'` over the four paths: no match.
- **Checklist ↔ issue.** The three boxes mirror #932's three acceptance criteria verbatim (compared against `issue_read` on srikanth235/centraid#932). None is ticked, and the reading is correct: all three concern the `doc-integrity` `append-only` rule (#932 "Scope: In" is the `doc-integrity.conf` rule text plus the CONSTITUTION.md entry and Evolution Log line), and the diff touches nothing under `.governance/` or `CONSTITUTION.md`. No criterion is claimed.
- **Inertness claims re-run here.** `git ls-tree -r --name-only origin/main | grep -i gitattributes` → none, so the file is genuinely new; `grep -rn gitattributes .governance scripts package.json docs` matches only the new dev-environment prose — nothing reads or lints an attributes file. `git check-attr merge` in this worktree: `receipts/issue-932-append-only-receipts.md: union`, `receipts/issue-928-one-authority-plane.md: union`, `docs/dev-environment.md: unspecified`, `CONSTITUTION.md: unspecified` — scoped as the receipt states. `git --version` 2.43.0 matches the recorded host.
- **Falsification 1 — the union claim, reproduced independently.** Own lab (fresh repo, own script, not the worker's `union-lab.sh`): base commit with a receipt-shaped file, two sibling branches each appending one section, `git rebase sib-a` from `sib-b`. Without `.gitattributes`: `CONFLICT (content)`, rebase exit 1, markers in the file. With this change's `.gitattributes` copied verbatim into the base commit: `Successfully rebased`, exit 0, first sibling's section above the second's, and `head -c 117 <result> | cmp - <sib-a file>` exits 0 — the whole upstream file is a byte-prefix of the result. The blank-line seam is real and as described: union factors out the shared leading blank line, so `## w1b` follows `AAA first slice evidence.` with no blank line between.
- **Falsification 2 — the `git merge` warning.** Third throwaway, same attributes, `git checkout sib-b && git merge --no-edit sib-a`: merges clean but orders the result `w1b` then `w1a`, and the byte-prefix against sib-a's file breaks. The docs' "rebase, do not merge" instruction is therefore justified by behaviour, not asserted.
- **Doctrine.** No widened budget, floor, allowlist or ratchet; no test skipped, quarantined or deleted; no lint or governance config touched. The commit's `governance: allow-toolchain-config` line is an unrequested extra waiver, not a weakening — `.gitattributes` is not on `toolchain-config-protection`'s path list and governance passes either way. The `## Decisions` entries each name a live property (blast radius of the glob, silent corruption of non-text files, the driver being a convenience the append-only rule does not delegate); none is a bare "by design" citation.
- **Numbers.** The only quantitative claims are the lab outcomes and gate counts, all re-run above on this host.
- **Gates run here** (heavy ones under the shared `flock`): `bun run format:check` → "All matched files use the correct format" (5358 files); `bun run lint` → exit 0, no diagnostics; `bun run lint:product` → 39/39; `bash .governance/run.sh` → 21 passed, 1 pending (only the sub-agent attestation this section satisfies), `repo-hygiene` green with the indented conflict-marker lines in `## Verification`. No package suite or `typecheck` is owed and none was run: `git diff --stat origin/main...HEAD` touches no compiled file.
- **One observation, not a defect.** The docs and receipt assert that GitHub's server-side mergeability check ignores `.gitattributes` merge drivers. That is an external behaviour this verifier cannot exercise from here; it is stated in the conservative direction (it claims *less* benefit than the driver may actually deliver) and nothing in the change depends on it, so it is recorded rather than counted against the slice. Separately, the union driver is adjacent to #932's declared "Scope: In" rather than inside it — the receipt says so plainly in `## Out of scope`, and whether wave 1 should carry it is the umbrella owner's call, not a verifier finding.

## Session

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-09-03 | claude-code | 60f9e86b-149f-5fc9-84c0-f2160b6b6f3c |
