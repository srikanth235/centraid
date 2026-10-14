# Issue #1103 — the hook judged the trunk's tip on a branch's first commit

Doctrine: [docs/decisions.md#governance-as-a-constitution-1005](../docs/decisions.md#governance-as-a-constitution-1005).

## What changed

Files changed: `.governance/law/arrival.mjs`, `.governance/law/arrival.test.mjs`, `.governance/install.yaml`, `CHANGELOG.md`, `receipts/issue-1103-law-trunk-tip.md`.

`resolveRange()` in `.governance/law/arrival.mjs` fell back to `HEAD~1..HEAD` whenever the merge-base with the trunk was HEAD. At the hook door that is the first commit on a branch cut from `main`, so the trunk's tip commit was judged instead of the commit being written (main's tip has a 124-character subject, limit 100, so every first commit was refused).

`resolveRange(explicit, { staged })` now takes the hook door's `staged` flag from `buildArrival`. When a trunk candidate resolves, HEAD is that trunk's tip, and the door is the hook, the range is empty (`base == head`, `hasBase: false`) and only the pending commit and staged set are judged. The fallback to the tip commit is unchanged for a checkout with no trunk (fresh or detached CI) and for the window door (a push to main judges the tip). No rule's severity or door changed. `.governance/install.yaml` records the new digest of `arrival.mjs`.

## Verification

```sh
node --test --test-name-pattern=1103 .governance/law/arrival.test.mjs
```

RED before the fix: fail, `the hook door judges no committed commit` (expected tip `0eb06863`, actual its parent `099f220d`). GREEN after: pass 1, fail 0.

```sh
bun run governance:law:test
```

Outcome: 177 pass, 2 fail. The two failures ("the generator reproduces the checked-in fixture byte for byte" and "a --range record is a function of the range, not of the checkout", range `bb964a7e..3df6d552`) fail identically on unmodified `origin/main` here, unrelated.

```sh
node .governance/law/digest.mjs --record && node .governance/law/run.mjs
```

Outcome: exit 0 for `managed-tree-integrity` (pass); the commit itself went through the fixed hook door with no findings, no bypass.

## Decisions

## Audit

**PASS**

Audited by a separate, read-only Sonnet agent that did not write the change. Evidence:

- The new test fails on the base `arrival.mjs` and passes at `ccbcc06dc`.
- The window door and the no-trunk fallback are unchanged.
- The `.governance/install.yaml` digest for `arrival.mjs` matches, and window-door `managed-tree-integrity` is green.
- The two law-suite failures also fail on unmodified main in the same way (176 pass / 2 fail there, 177 pass / 2 fail at the fix).

Limit: the verifier did not run a real hook commit end to end.
