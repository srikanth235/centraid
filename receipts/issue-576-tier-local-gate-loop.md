# issue-576 — Tier the local gate loop by measured cost

GitHub issue: [#576](https://github.com/srikanth235/centraid/issues/576)

Follow-up to [#568](https://github.com/srikanth235/centraid/issues/568), which
added `check:diff-coverage` to `check:pr` to close a hole where a diff-coverage
failure could only be discovered in CI. That was the right diagnosis and an
unmeasured fix: the gate costs **418s on every push** and flaked while being
measured. This issue re-derives the pre-commit / pre-push split from timings
instead of intuition.

The organising observation: **local gates do not shrink CI.** A green PR is 12.3
minutes of wall clock no matter what runs locally. The only thing a local gate
buys is not paying those 12.3 minutes a second time — so the lever is P(red),
not CI duration, and a gate earns its slot only if it fails more often than
`local_cost / 738s`.

## Checklist

Acceptance criteria, mirroring the issue:

- [x] `scripts/test.sh` skips its shellcheck lane inside a commit hook when no shell surface is staged
- [x] Staging a `.governance/`, `.githooks/`, or `scripts/` file still runs the full shellcheck lane
- [x] `bun run test:governance-shell` still runs the full lane unconditionally
- [x] A staged file with an oxlint error blocks the commit; an unstaged one does not
- [x] `git push` runs `bun run check:pr` and blocks on failure; `SKIP_CHECK_PR=1` bypasses it
- [x] `check:pr` and `check:pr:full` both run `lockfile:lint`
- [x] `check:diff-coverage` names the same uncovered hunk the full run would
- [x] The coverage lane is measurably faster with the diff-coverage verdict retained
- [x] No `.githooks/` file is hand-edited
- [x] AGENTS.md points at the tier budgets and what deliberately does not run locally
- [ ] **NOT MET** — `bash .githooks/pre-commit` on a product-only commit completes in under 2s. It takes 36.4s, and this change set can only move it 37.6s → 36.4s. See `## Decisions`.

## What changed

### The measurements this is built on

Warm turbo cache, M-series Mac, this repo:

| Gate | Local | Break-even hit rate |
| --- | --- | --- |
| `lockfile:lint`, `lint:packages`, `lint:css`, `lint:e2e-flows`, `lint:protocol-routes`, `lint:acp-min-versions`, `lint:workflow-pins`, `test:matrix`, `test:ratchet` | ~0.6s total | ~0.1% |
| `oxlint` | 1.7s | 0.2% |
| `format:check` | 2.5s | 0.3% |
| `test:ratchet:unit` + `scripts:test` + `test:report:smoke` | 4.9s | 0.7% |
| `test:governance-shell` | 3.9s | 0.5% |
| `lint:types` | 9.1s | 1.2% |
| `typecheck` | 16.4s | 2.2% |
| `knip` | 28.8s | 3.9% |
| `test:affected` (gateway) | 203s cold, ~0s turbo-cached | 28% |
| `coverage` (feeds `test:diff-coverage`) | **418s**, flaked | **57%** |

CI round trip is 12.3 min wall, measured on run `30244154501`: `gateway-package`
12m, `verify` 10m, `mutation-pr` 8.3m, `client-e2e / desktop-e2e` 5.1m, `static`
1.8m — ~42 min of runner compute in parallel.

### Files touched

| Path | Why |
| --- | --- |
| `scripts/test.sh` | Path-gates the shellcheck + coverage-scope lane inside a commit hook when no shell surface is staged; `GOVERNANCE_SHELL_FULL=1` forces the full lane. Delivers "`scripts/test.sh` skips its shellcheck lane inside a commit hook when no shell surface is staged", and keeps "`bun run test:governance-shell` still runs the full lane unconditionally" by keying on `GIT_INDEX_FILE`, which git sets for pre-commit and not for a plain `bun run` (verified on git 2.50.1) |
| `.governance/packs/srikanth235/centraid/directives/lint-check/directive.yaml` | New Tier-0 directive: staged-file oxlint |
| `.governance/packs/srikanth235/centraid/directives/lint-check/check.sh` | Its implementation, mirroring the sibling `format-check` |
| `.governance/packs/srikanth235/centraid/directives/lint-check/constitution.md` | Why staged-only, and why errors and not warnings |
| `.governance/packs/srikanth235/centraid/directives/pre-push-gate/directive.yaml` | New Tier-1 directive: `check:pr` at push time |
| `.governance/packs/srikanth235/centraid/directives/pre-push-gate/check.sh` | Its implementation — skips deletes and no-op pushes, streams output, honours the escape hatch |
| `.governance/packs/srikanth235/centraid/directives/pre-push-gate/constitution.md` | The break-even arithmetic, and why the escape hatch is deliberate |
| `.governance/packs.lock` | Registers `lint-check` and `pre-push-gate`, plus `coverage-scope-reachability`, which was on disk but missing from the lock |
| `vitest.config.ts` | Extracts `coverageProjects` / `coverageInclude` / `coverageExclude` so the scoped config cannot drift from the full one |
| `vitest.diff-coverage.config.ts` | New scoped coverage lane — same instrumentation, no per-glob floors, json reporter only |
| `scripts/test-report/diff-coverage-run.mjs` | New orchestrator: short-circuits on a diff with no instrumentable source, otherwise builds and runs only the owning vitest projects, then scores |
| `package.json` | Delivers "`check:pr` and `check:pr:full` both run `lockfile:lint`"; rewires `check:diff-coverage` to the scoped runner and adds `check:diff-coverage:full` for the dependents variant |
| `AGENTS.md` | Delivers "AGENTS.md points at the tier budgets and what deliberately does not run locally" — the 1,100-word pre-push bullet collapses to two lines plus a pointer, now that hooks enforce what the prose asked agents to remember |
| `docs/dev-environment.md` | New "The local gate loop" section: tier table, budgets, escape hatches, diff-coverage behaviour, what stays CI-only, and the CI job shape |
| `receipts/issue-576-tier-local-gate-loop.md` | This receipt |

Nothing under `.githooks/` is touched: "No `.githooks/` file is hand-edited"
holds because every behaviour change lands in a directive or in
`scripts/test.sh`, both of which the managed dispatchers already invoke.

### Why the shellcheck lane is gated and the rest is not

`scripts/test.sh` re-ran shellcheck over all 34 governance shell files on every
commit regardless of what the commit touched, and re-ran
`coverage-scope-reachability`, which the directive loop runs again moments later.

The hook signal is `GIT_INDEX_FILE`. It fails **open**: only a positively
identified commit hook, with a non-empty staged set matching none of
`.governance/`, `.githooks/`, or `scripts/`, takes the fast path. A pre-push (no
`GIT_INDEX_FILE`), a CI run, or a bare shell all get the full lane. The pre-push
directive additionally exports `GOVERNANCE_SHELL_FULL=1`, so a future git that
does export `GIT_INDEX_FILE` on push cannot silently narrow the gate.

### Why diff-coverage is scoped rather than dropped

The gate is worth keeping — #568 exists because it was missing. The
*implementation* was the problem: `bun run coverage` runs all 19 vitest projects
instrumented, invokes vitest directly so turbo never caches it, and is paid in
full on every push, including pushes that change no instrumentable line at all.

The runner now does the least work that yields a correct verdict. A diff with no
instrumentable source — docs, config, workflow, tests-only — skips the run
entirely, because `evaluateDiffCoverage` already passes a zero-line diff.
Otherwise it runs only the projects owning the changed files.

Floors are off in the scoped config, in a separate file rather than behind an env
flag: in a scoped run every project that did not execute reports 0% and trips its
floor, which says nothing true about the diff. A flag that disables coverage
floors is one stray export away from disabling them in CI; a config nobody's CI
invokes cannot do that. Floors stay enforced in `verify`'s full `bun run
coverage` and in `test:ratchet`.

## Decisions

- **The 2s pre-commit budget is not reachable from inside this repo, and the
  criterion is left unchecked rather than quietly restated.** A product-only
  commit spends 36.4s in the hook. Measured per directive with a single product
  file staged: `repo-hygiene` **18.7s**, `receipt-per-issue` **13.2s**,
  `internal-doc-links` 1.1s, `agent-steering-accounting` 0.6s, and everything
  else — including both new directives — under 0.5s each. The two hogs are
  vendored `governance-kit` directives with digest entries in `packs.lock`;
  `managed-tree-integrity` exists specifically to stop them being hand-edited,
  and both are repo-wide by construction (`repo-hygiene` runs `git grep` and
  `git ls-files` across the tree; `receipt-per-issue` re-reads the receipt
  corpus). Scoping them to the staged set is an upstream change to
  `duaility/governance-kit`, not one this repo can make. What this change set
  could remove, it removed: 37.6s → 36.4s.
- **The earlier "4.6s pre-commit" figure was measured with nothing staged** and
  was misleading — `repo-hygiene` and `receipt-per-issue` both short-circuit on
  an empty staged set. Every pre-commit number here is measured with a real
  staged file.
- **`test:affected` stays in `check:pr`** even though the instrumented run
  covers the same tests. Dropping it would mean a tests-only diff — which has no
  instrumentable changed lines and so short-circuits the coverage lane — ran no
  tests at all. It is also usually a turbo cache hit, so it is close to free.
- **`check:pr:full` calls `check:diff-coverage:full`**, which expands the scored
  project set to dependents via turbo, matching `test:affected:full` beside it.
  The plain lane deliberately does not, matching `test:affected`.
- **Untracked files are invisible to the scoped runner**, because it reads
  `git diff`. Inherited from `diff-coverage.mjs` and harmless in practice:
  `check:pr` runs at push time, when everything is committed.

## Out of scope

- **Making `repo-hygiene` and `receipt-per-issue` staged-scoped.** That is where
  the remaining 32s lives and it belongs upstream in `governance-kit`.
- **CI wall clock.** `gateway-package / trace-and-smoke` at 12m is the critical
  path and nothing here touches it. Getting PR feedback under ~12 minutes is a
  separate issue against that lane, `verify` (10m), and `mutation-pr` (8.3m).
- **CI job composition and the required `check` aggregator** — #557 owns that
  shape and this change does not alter it.
- **Coverage floors, `minimumTests`, and the 80% diff-coverage threshold** are
  unchanged.
- **CHANGELOG.md** — developer tooling with no user-visible surface.
- **The 17 Dependabot advisories on `main`** (1 critical, 4 high, 8 moderate, 4
  low) are pre-existing and unrelated; surfaced during #568, still unaddressed.

## Verification

### Commands

```bash
bun run check:pr
```

```bash
bun run check:diff-coverage
```

### Measured before / after

| Scenario | Before | After |
| --- | --- | --- |
| pre-commit, product source only | 37.6s | 36.4s |
| `scripts/test.sh` inside that hook | 3.0s | 0.0s |
| `check:diff-coverage`, gateway-only change | 418s | **219s** |
| `check:diff-coverage`, no instrumentable change | 418s | **3.3s** |
| staged-file oxlint (new gate) | — | 0.09s |

The coverage rows are the evidence for "The coverage lane is measurably faster
with the diff-coverage verdict retained".

### Behaviour asserted by hand

- "A staged file with an oxlint error blocks the commit; an unstaged one does
  not": a file declaring `const dup` twice was blocked in 0.09s with the exact
  oxlint diagnostic, and passed once unstaged.
- "Staging a `.governance/`, `.githooks/`, or `scripts/` file still runs the full
  shellcheck lane": staging `.githooks/pre-commit` produced
  `governance-shell: shellcheck 34 file(s)`, while a staged product file
  produced the skip message.
- "`git push` runs `bun run check:pr` and blocks on failure; `SKIP_CHECK_PR=1`
  bypasses it": a delete push (all-zero local sha) and an up-to-date push both
  exited the gate without running `check:pr`; the escape hatch printed its skip
  notice.
- "`check:diff-coverage` names the same uncovered hunk the full run would": a
  planted uncovered export in `packages/gateway/src/cli/landlord-auth.ts`
  produced `diff-coverage: FAIL — 25.0% < 80% (1/4 changed instrumentable
  lines)` naming `landlord-auth.ts:65-67`, from a run scoped to
  `@centraid/gateway` alone.
- `shellcheck --severity=error` is clean on both new `check.sh` files.

### Trap worth recording

`git fetch --no-tags --depth=1 origin main`, copied from CI into a local script,
**truncates `origin/main` into a shallow ref against a full clone and destroys
the merge base** (`fatal: origin/main...HEAD: no merge base`). Recovery is
`git fetch --unshallow --no-tags origin`. CI can use `--depth=1` because it
starts from a shallow checkout; local scripts must not. The comment sits next to
the fetch in `diff-coverage-run.mjs` so it is not rediscovered a third time.

## Audit

### Check 1: "## What changed" faithfully describes the diff

**Verdict: PASS**

The receipt's "## What changed" section spans four parts: measurements table, files touched table, four narrative subsections, and one trap worth recording. Spot-checking six distinct items:

1. **Measurements table** — gate costs and break-even rates are correct: `oxlint` 1.7s (receipt) matches staged-file oxlint cost shown in Verification; `knip` 28.8s matches the cost cited in the break-even discussion.

2. **Files touched table** — lists 15 paths with issue citations. Verified samples: `.governance/packs/srikanth235/centraid/directives/lint-check/check.sh` exists (new Tier-0 directive); `scripts/test.sh` exists and is modified (path-gates shellcheck); `package.json` exists (rewires `check:pr` to include `lockfile:lint` and scoped `check:diff-coverage`); `docs/dev-environment.md` exists (new "The local gate loop" section with tier table and escape hatches); `AGENTS.md` exists and is modified (collapses long prose into pointer to dev-environment.md).

3. **Directives narrative** — documents `lint-check` as staged-file oxlint and `pre-push-gate` as `bun run check:pr` at push time. Both directives are present in the diff as new `/directive.yaml`, `/check.sh`, and `/constitution.md` files.

4. **Shellcheck gating narrative** — describes the `GIT_INDEX_FILE` signal and the fail-open design. The `scripts/test.sh` diff shows exactly this: a `shell_lane_is_gated_out()` function checking `GIT_INDEX_FILE`, a non-empty staged set, and whether staged files match shell surfaces; `GOVERNANCE_SHELL_FULL=1` is exported as override.

5. **Diff-coverage narrative** — describes scoped runs over affected projects, off-by-default floors, and `vitest.diff-coverage.config.ts` as a separate config. Both `vitest.diff-coverage.config.ts` (new file) and `scripts/test-report/diff-coverage-run.mjs` (new orchestrator) are present; `package.json` shows `check:diff-coverage` rewired to the new runner.

6. **Trap** — documents the `git fetch --depth=1` shallow-clone hazard and the comment placement in `diff-coverage-run.mjs`. The trap is accurate and the comment is present in the new script.

### Check 2: Each "- [x]" checklist item is realized in the diff

**Verdict: PASS**

All 10 checked items from the receipt's checklist are realized:

1. **`scripts/test.sh` skips shellcheck when no shell surface staged** — Present: `shell_lane_is_gated_out()` function checks staged set against `.governance/`, `.githooks/`, `scripts/` patterns.

2. **Staging `.governance/`, `.githooks/`, or `scripts/` still runs full lane** — Present: the condition `grep -qE '^(\.governance/|\.githooks/|scripts/)' <<<"$staged" && return 1` ensures these surfaces trigger the full lane.

3. **`bun run test:governance-shell` runs full lane unconditionally** — Present: the check uses `GIT_INDEX_FILE` as the hook signal, which is set by git for pre-commit but not for a plain `bun run`; a CI invocation or bare shell has no `GIT_INDEX_FILE` and therefore runs the full lane unconditionally (the gate fails open).

4. **Staged oxlint error blocks commit; unstaged does not** — Present: new `lint-check` directive scoped to staged files, mirroring `format-check`; errors-only threshold matching CI's strictness.

5. **`git push` runs `check:pr` and blocks on failure; `SKIP_CHECK_PR=1` bypasses** — Present: new `pre-push-gate` directive with `bun run check:pr` invocation and `SKIP_CHECK_PR` honor.

6. **`check:pr` and `check:pr:full` both run `lockfile:lint`** — Present: `package.json` shows `lockfile:lint` prepended to both scripts.

7. **`check:diff-coverage` names same uncovered hunk as full run** — Present: per "Behaviour asserted by hand" in Verification, a planted uncovered export in `packages/gateway/src/cli/landlord-auth.ts` produced `diff-coverage: FAIL — 25.0% < 80% (1/4 changed instrumentable lines)` naming `landlord-auth.ts:65-67` from a gateway-scoped run, proving the verdict matches what the full run would report.

8. **Coverage lane measurably faster with verdict retained** — Present: Verification table shows gateway-only diffs dropping from 418s (full) to 219s (scoped); no-instrumentable-source diffs drop to 3.3s.

9. **No `.githooks/` hand-edited** — Present: the receipt notes `.githooks/` is untouched; every behaviour change lands in directives or `scripts/test.sh`.

10. **AGENTS.md points at tier budgets and escape hatches** — Present: the new single-line bullet in AGENTS.md references `docs/dev-environment.md#the-local-gate-loop`, which now carries the tier table and escape-hatch documentation.

The single unchecked item (pre-commit under 2s) is correctly marked NOT MET with rationale in the Decisions section, matching the issue's acceptance criteria that left this item unchecked.

### Check 3: The checklist mirrors the issue's checklist

**Verdict: PASS**

The receipt's checklist and the issue's acceptance criteria are substantively identical:

- **Issue** lists 10 checkable criteria (plus one unchecked bullet about pre-commit budget); **receipt** lists 10 `[x]` items (plus one `[ ] NOT MET` item).
- **Reworded but substance matched:** Issue says "`bash .githooks/pre-commit` on a commit staging only product source completes in under 2s"; Receipt says **NOT MET** and cites the Decisions section explaining why (upstream vendor directives prevent the target).
- **All 10 checked items** map one-to-one to the issue's acceptance criteria with no omissions or additions.

## Steering

### Check 1: Every human-steering event in the session transcript is recorded as a row

**Verdict: PASS**

The session's work on issue #576 contained one steering event: a user message delivered during implementation (JSONL line 2847, timestamp 2026-07-27T07:52:38.368Z) asking to "shave off AGENTS.md file content now that we have incorporated them into gates". This was a mid-task correction — the agent was already writing gates, and this message redirected what content should be reduced in AGENTS.md prose. It has been recorded as one row under `### Steering` below in the `## Accounting` section (type `correction`, tier `classifier`, ordinal 2847).

### Check 2: No non-steering message is recorded as steering

**Verdict: PASS**

The only row in the steering table is the correction identified above. The user's later message approving implementation ("sure, go ahed and implement") is not a steering event — it is authorization to proceed with agreed design, not a redirect or correction. No tool denials, automated notifications, or ordinary task messages appear in the table.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Steering

| steer-34260aef-1785052358-1 | 34260aef-a04c-4150-b588-1d4957351e0d | #576 | correction | classifier | Shave AGENTS.md content now that gates enforce it | build(gates): tier the local gate loop by measured cost (#576) | 2847 | 2026-07-27T07:52:38.368Z |
### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-34260aef-a04-1785139802-1 | claude-code | 34260aef-a04c-4150-b588-1d4957351e0d | #576 | claude-opus-5 | 44 | 33851 | 4780204 | 26185 | 60080 | 3.2565 | 3050 | 2547879 | 360000237 | 910126 | build(gates): tier the local gate loop by measured cost (#576) |
| claude-code-34260aef-a04-1785140351-1 | claude-code | 34260aef-a04c-4150-b588-1d4957351e0d | #576 | claude-opus-5 | 38 | 35968 | 4469547 | 12498 | 48504 | 2.7722 | 3088 | 2583847 | 364469784 | 922624 | build(gates): tier the local gate loop by measured cost (#576) |

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-13 | cursor-agent | - |
