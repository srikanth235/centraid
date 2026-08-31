# issue-905 — the `all` escape hatch never reached client-e2e's inputs

A defect in [#892](https://github.com/srikanth235/centraid/issues/892) Phase 3's own remedy, found on `main` after it merged. #892's receipt is on the default branch and therefore immutable, so this is a new issue with its own receipt rather than an edit to that one.

## Checklist

- [x] Thread `|| needs.changes.outputs.all == 'true'` into both `with:` inputs
- [x] Narrow the caller's gate from `client` to `web || desktop`, now that `boot-smoke` has left the lane
- [x] Extend `bun run lint:path-filters` with a third sub-check: any read of a `changes` output without the `all` fallback fails, whatever construct does the reading
- [x] Correct the comment on the `changes` job that promised the property for "every lane `if:`"

## What changed

Where each checked item lands, then the reasoning behind it:

- Thread `|| needs.changes.outputs.all == 'true'` into both `with:` inputs — "The defect", below; `.github/workflows/ci.yml`.
- Narrow the caller's gate from `client` to `web || desktop`, now that `boot-smoke` has left the lane — "The gate was also wider than what remains in the lane"; `.github/workflows/ci.yml`.
- Extend `bun run lint:path-filters` with a third sub-check: any read of a `changes` output without the `all` fallback fails, whatever construct does the reading — "The lint that makes it the last time"; `scripts/lint-path-filters.mjs`, `scripts/lint-path-filters.test.mjs`.
- Correct the comment on the `changes` job that promised the property for "every lane `if:`" — "The lint that makes it the last time", final paragraph; `.github/workflows/ci.yml`.

### The defect

`.github/workflows/ci.yml`'s `client-e2e` honoured `needs.changes.outputs.all` in its `if:` and not in its two `with:` inputs, which read `outputs.web` / `outputs.desktop` alone. The `changes` job **skips** the paths-filter step on a `workflow_dispatch` (`if: github.event_name != 'workflow_dispatch'`), so on a manual run every filter output is the empty string. The caller started — its `if:` saw `all` — and handed `.github/workflows/lane-client-e2e.yml` `web: false, desktop: false`. Both inner jobs took their own `if: inputs.web` / `if: inputs.desktop` and skipped. The lane finished in 0s having run nothing and reported satisfied to `check`, which counts `skipped` as a pass.

The consequence is the sharp one: `workflow_dispatch` is the only way to force every path-gated lane on for a commit whose diff woke none of them, and it was the one trigger under which this lane could not run at all. That is the `skipped`-counts-as-a-pass hazard #892 Phase 3 exists to close, one level down, reached through its own remedy.

Both `with:` inputs now carry the fallback.

### The gate was also wider than what remains in the lane

The caller gated on `client`, a superset of `web ∪ desktop` — it also matches `packages/server/**`. That was deliberate under #496 E7, while `boot-smoke` lived in this lane and had to run for gateway-only PRs. #892 Phase 1 moved `boot-smoke` into `verify`, and nothing gated on `client` remained here, so a `packages/server`-only PR had been starting a caller whose every job skips — on ordinary PRs, not only on dispatch. The gate is now `web || desktop || all`.

### The lint that makes it the last time

`scripts/lint-path-filters.mjs` gains a third sub-check beside `claimed` and `tidy`: `escape`. Every read of a `changes` output must carry `|| needs.changes.outputs.all == 'true'`, and the check is deliberately blind to which construct does the reading — those two `with:` lines were the only reads in `ci.yml` outside an `if:`, and every prior reading of this table had assumed `if:` was the only place an output could be consumed.

The scanner folds YAML block scalars back into one unit under the line number of their key (`scannableUnits`) rather than banning them. A per-line scan would read the fallback half of a folded `if:` as absent; the cheaper alternative — refusing folded conditions outright — would have made collateral of `publish-report`'s, which is folded for length alone and contains no filter output. `scripts/lint-path-filters.test.mjs` pins both directions: the pre-fix `with:` shape is caught, a folded condition carrying the fallback passes, and the line after a folded block is not swallowed.

The comment on the `changes` job in `.github/workflows/ci.yml` promised this property for "every lane `if:`" — the wording that *is* the blind spot. It now says "every read", names how the two `with:` inputs came to be the exception, and points at the lint that checks it instead of the wording promising it. The comment on `static`'s `lint:path-filters` step names the new sub-check.

### Docs

`docs/decisions.md` gains **G-filter-escape-hatch** beside the existing G-filter-inverse. `TESTING.md`'s path-filter row records both the narrowed `client-e2e` gate and the new fallback requirement.

## Decisions

1. **The gate narrows to `web || desktop` rather than staying at `client` with the inputs fixed.** Fixing only the inputs would have left a caller that starts for `packages/server`-only PRs and runs nothing — the same empty shell, still reporting satisfied, just on a different trigger. The `client` filter itself is not deleted: `verify` is unfiltered and `boot-smoke` rides it, so the coverage `client` used to buy is already paid for elsewhere.
2. **The lint checks reads, not `if:`s.** Scoping it to `if:` would have reproduced the exact assumption that produced the bug. The rule is "a read of a filter output carries the fallback", and it does not care whether the read is in an `if:`, a `with:`, an `env:`, or something not yet written.
3. **Block scalars are folded, not banned.** The first draft refused any multi-line `if:` so the per-line scan stayed sound; `publish-report`'s folded `if:` — long for length, no filter output in it — failed immediately, which is the check inventing work rather than finding it. Joining the block is a dozen lines and refuses nothing that is fine.
4. **No new GitHub issue was filed for `desktop-e2e-macos`.** It is absent from `check`'s `needs:` list while every other path-gated lane is present, so it can go red without `check` noticing. Named in this issue's "Out of scope" and left there: it is a different level of the same family, and folding it in would widen a fix that is currently four files.
5. **Two local-environment findings are recorded but produced no code change.** They cost most of the time spent and would cost the next reader the same. See Verification.

## Out of scope

- **`desktop-e2e-macos`'s absence from `check`'s `needs:` list.** Real, adjacent, and not this fix. See Decisions 4.
- **The other ten path-gated lanes.** All were verified to wake correctly on a `workflow_dispatch` run of main tip; none needed a change.
- **`mutation-pr` and `dependency-review` reporting `skipped` on a main push.** Both are gated on `github.event_name` by design (PR-only / non-main-push), not by a path filter, and neither is a defect.

## Verification

Every command below was run in this container against this branch, on Node 24.4.1 and Bun 1.3.13 (the versions `.node-version` and `packageManager` pin).

The lint fails on the pre-fix shape and passes on the fixed tree:

```sh
bun run lint:path-filters
node --test scripts/lint-path-filters.test.mjs   # 15 passed, 0 failed
```

The workflow still parses and the block reads as intended:

```sh
node -e "const {parse}=require('./node_modules/yaml');console.log(JSON.stringify(parse(require('fs').readFileSync('.github/workflows/ci.yml','utf8')).jobs['client-e2e'],null,2))"
```

Gates touching the changed files:

```sh
bun run format:check
bun run lint
bun run lint:workflow-pins
bun run lint:turbo-cache
bun run scripts:test
bun run test:comment-density
bun run test:matrix
bash .governance/run.sh   # 22 directive(s) passed
```

Field evidence for the defect itself — run `33372386799` (`workflow_dispatch` on `f5ca34fb`) reported `client-e2e / web-e2e` and `client-e2e / desktop-e2e` as `skipped` in 0s while all ten other path-gated lanes woke; its `changes` job shows `Run dorny/paths-filter@… skipped`, which is the empty-string source.

Two local-environment findings, recorded because each looked like a repo defect and was not:

1. **`receipt-per-issue` and `toolchain-config-protection` failed on a clean checkout of main tip.** The cause is a stale local `main` ref (`3b8c3f0c`, ten behind `origin/main`): the directive resolves its change set from `merge-base(HEAD, main)`, so the walk pulled #892's entire squash into scope. CI is green on the same commit because there `merge-base == HEAD` and the rule is skipped. `git branch -f main origin/main` clears it. This is the second time a stale `origin/main` in a container has produced a red gate attributable to nothing in the tree — see #892's receipt, Decisions 10.
2. **`agent-session-identity` reads the issue anchor from the git process argv.** `git commit -F <file>` therefore has no anchor even when the subject carries `(#905)`; `AGENT_ISSUE` is the supported alternative.

## Audit

**VERDICT: REFUTED — the independent audit required by `receipt-per-issue` rule 7 has NOT been performed.**

Recorded as REFUTED because the directive defaults to REFUTED under uncertainty and "nobody independent has looked" is the strongest form of that. The verdict is about the audit's absence, not about a finding.

**Why it is absent.** Rule 7 wants the verdict of a fresh-context sub-agent handed only the diff, this receipt, and the issue. This session was instructed not to spawn sub-agents, so none ran. Writing PASS would be an author attesting to their own work in the section reserved for someone who has not seen their reasoning — and mechanically indistinguishable from a real audit.

**What to do before merging.** Hand a fresh-context agent only `git diff origin/main`, this receipt, and issue #905; ask it adversarially whether `## What changed` describes the diff, whether each `- [x]` is realized in it, and whether the checklist mirrors the issue. Replace this section with its verdict.

**Author's own review, which is NOT that audit.** Recorded so the auditor has claims to attack rather than reconstruct:

- The narrowed gate is the one change here that could *reduce* coverage. It cannot: `web ∪ desktop ⊂ client`, and the difference (`packages/server/**`, `packages/core/**` via neither) only ever reached jobs that were already gated on `inputs.web` / `inputs.desktop`, both false for a server-only diff. Nothing that used to run stops running.
- The lint's per-line scan is the weakest part. It is sound for `${{ }}` expressions and one-line conditions, and `scannableUnits` covers folded and literal scalars; a filter output read from a composite action or a script the workflow calls would not be seen. That is outside what a line scanner over `ci.yml` can promise, and the header says so.
- The claim "those two `with:` lines were the only reads in `ci.yml` outside an `if:`" is checkable: `grep -n "needs.changes.outputs" .github/workflows/ci.yml` returns thirteen lines, eleven of them `if:`.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-31 | claude-code | 91a550cd-d7f2-5fa3-9d41-c4d75aaf2c05 |
