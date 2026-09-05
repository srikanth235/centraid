# Issue #988 — governance tooling for parallel orchestration

Lane: governance tooling. Branch `claude/988-governance-tooling`, one commit per acceptance box.

## Checklist

- [ ] Per-lane receipt files: `receipts/issue-<N>/` read as one receipt
- [x] Gate stamps keyed by tree hash for the static tier, outside the repo, never read by CI
- [x] Tiered push check by branch: static tier off `main`, full tier on `main`
- [ ] False positives: agent-session-identity date row
- [x] False positives: check:ui-receipt no longer fires on a file that is on no import edge
- [x] False positives: lint:product tolerates a spent one-shot marker
- [x] Shared build cache across worktrees, measured
- [x] docs/multi-agent.md, docs/dev-environment.md and docs/toolchain.md state the model
- [x] `.governance/run.sh` green; every existing receipt still passes `receipt-per-issue`

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

**Box 2 — gate stamps keyed by tree hash for the static tier, outside the repo, never read by CI.**

| File | Change |
| --- | --- |
| `scripts/ci/gate-stamp.mjs` | New. `STATIC_TIER` (`format:check`, `lint`, `turbo:lint`, `typecheck:affected`), the key, the store, the CI kill-switch |
| `scripts/ci/gate-stamp.test.mjs` | New. Key movement, freshness, the CI guard, `CENTRAID_GATE_STAMPS=0`, tier membership |
| `scripts/ci/run-gates.mjs` | `--stamp` skips the static members when their stamp matches, and re-stamps only on a fully green run |
| `scripts/ci/governance-run.mjs` | New. `bun run governance` — the stamped entry point to the digest-locked `.governance/run.sh` |
| `.githooks/pre-push` | The deferred repo-wide directives (~86s) take the `governance-deferred` stamp |
| `package.json` | `check:push` gains `--stamp`; new `governance` script; `scripts:test` runs the new test |

The key is a pair, not one hash: the oid of a real git tree built in a **copy** of the index (so the
caller's staging area is untouched and git's stat cache still spares unchanged files — 56 ms on this
tree), plus `origin/main`, because `typecheck:affected` filters on `[origin/main]` and the same tree
has a different affected set once the base moves. A tier is stamped only when every one of its gates
ran and passed in that invocation; a red or partial run leaves the previous stamp alone. `CI` in the
environment disables both reading and writing, so the enforcing copy always recomputes.

`.governance/run.sh` itself is digest-locked and could not take the stamp, which is why
`scripts/ci/governance-run.mjs` exists — the same shape as the #915 deferral living in
`.githooks/pre-commit`. A directive filter (`bun run governance repo-hygiene`) never touches the
stamp: one directive's verdict cannot be promoted into a claim about all of them.

**Box 3 — tiered push check by branch.**

| File | Change |
| --- | --- |
| `.governance/packs/srikanth235/centraid/directives/pre-push-gate/check.sh` | Reads the remote ref off stdin and picks the tier by destination |
| `.governance/packs/srikanth235/centraid/directives/pre-push-gate/directive.yaml` | Summary states the two tiers and the widening knob |
| `package.json` | New `check:push:static` — `format:check`, `lint`, `turbo:lint`, `typecheck:affected` |
| `scripts/test.sh` | Pins the choice with a stub `bun` on PATH: `main` → `check:push`, a branch → `check:push:static`, `CENTRAID_PUSH_TIER=full` → `check:push` |
| `scripts/ci/gate-classes.test.mjs` | The branch tier must be a subset of the full tier and every member must be in `STATIC_TIER` |

Nothing left the ladder. `ci.yml` and `governance.yml` both listen on a bare `pull_request:`, so
every branch's PR runs the full tier on every commit; the full **local** tier moved to the push that
is the last moment before the trunk moves. `SKIP_CHECK_PR=1`, `SKIP_GOVERNANCE=1` and `--no-verify`
are untouched, and `CENTRAID_PUSH_TIER=full` only ever widens — there is no value that narrows the
`main` tier.

**Box 4 — false positives. (a) not done, (b) partly, (c) done.**

| File | Change |
| --- | --- |
| `scripts/validate-ui-receipt.mjs` | `isSurface` exported; a changed file on no import edge (`.json`, `.md`, `.yml`, `.txt`, `.lock`, `.snap`) is not a surface |
| `scripts/validate-ui-receipt.test.mjs` | `people/app.json`, a README and `packages/client/src/replica/ReplicaProvider.tsx` demand nothing; `app-root.tsx` and `Chrome.module.css` beside them still do |
| `scripts/test-report/ratchet-floors.mjs` | A `replacesMinimumTestsFlow` the base already carries is SPENT; the shape checks run only over a marker the diff introduced or moved |
| `scripts/test-report/ratchet-floors.test.mjs` | Spent marker tolerated; a newly introduced unknown predecessor and a re-spend both still refused |

**(a) `agent-session-identity` writing a new dated row: NOT DONE.** `session_upsert` in
`.governance/packs/governance-kit/audit/directives/agent-session-identity/lib/receipt.sh` replaces
the row whose (harness, session) pair matches and rewrites only its date — which is exactly what
breaks `doc-integrity`'s byte-prefix rule when the receipt is already on the trunk. The fix is one
`awk` branch, and it is inside the same digest-locked pack as box 1. `SESSION_MAX_AGE_HOURS` is the
directive's only tunable knob.

**(b) the surface predicate: the manifest half landed, the import-keyed rewrite did not.** The live
false positive is the one the close-docs lane hit: two strings in
`packages/blueprints/apps/people/app.json` demanded `## User impact`, a `First-run:` note and a
screenshot from a changed e2e harness, and then re-validated every screenshot every receipt in the
change set named. A manifest is on no import edge and paints nothing, so it is no longer a surface.
Deleting `CLIENT_NOT_A_SURFACE` in favour of a predicate that reads imports was measured and
refused: `packages/client/src/{home-copy,icons,theme-vars,status-channel}.ts`,
`replica/rebootstrap-copy.ts` and `gateway-client-edges.ts` are surfaces because of the member copy
they DEFINE and they import nothing at all, so an import-keyed predicate drops all six unless they
come back as a hand list — the allowlist the file's own header says is how a gate stops enforcing.
And imports cannot separate the two files the current cases pin apart:
`react/blueprints/centraid-inline.ts` (must demand) and `react/blueprints/inlineQueryCtx.ts` (must
not) both import `truncatedListNotice` from `@centraid/blueprints/apps/_shared/shared-copy`. The
brief's own example is already green: `packages/client/src/replica/ReplicaProvider.tsx` is excluded
by the `replica/` pattern today, and the new case pins that it stays excluded.

**(c) the spent one-shot marker.** `tests/claims.json` carries no `replacesMinimumTestsFlow` today —
#930 removed the one #916 spent, and the note at `tests/claims.json:3865` records why. What was left
was the trap that made removing it necessary: a marker still on `main` compares base-to-head with
the predecessor absent from both sides, so `diffMinimumTests` reported `names unknown predecessor`
on every later branch, red on a tree nobody had touched. A marker the base already carries verbatim
is now spent and its shape checks are skipped; a marker introduced or moved in the diff, and a
second flow re-spending one, are refused exactly as before.

**Box 5 — one turbo cache for every worktree.**

| File | Change |
| --- | --- |
| `scripts/ci/turbo.mjs` | New. `turboCacheDir()` / `turboEnv()` and the launcher every root script now runs turbo through |
| `scripts/ci/turbo.test.mjs` | New. The default and the two overrides; no root script (bar the persistent `dev:*`) may call turbo directly |
| `scripts/ci/turbo-cache-report.mjs` | Spawns turbo with `turboEnv()` so `build:ci` shares the same cache |
| `package.json` | `build`, `test`, `test:affected`, `test:affected:full`, `typecheck`, `typecheck:affected`, `turbo`, `turbo:lint`, `web:build`, `perf:gateway` route through the launcher; `scripts:test` runs the new test |

Turbo's cache key is its own content hash, so entries are interchangeable across checkouts of the
same repo by construction — only the DIRECTORY was per-checkout. `TURBO_CACHE_DIR` wins if set, then
`CENTRAID_TURBO_CACHE_DIR`, then `${XDG_CACHE_HOME:-~/.cache}/centraid/turbo`; nothing is added
inside the repo, and `.turbo/runs` stays per-checkout so `turbo-cache-report.mjs` still reads its own
summaries. `dev:*` keeps the plain binary: those tasks are persistent, never cached, and an
interactive run should have nothing between it and its TTY.

| Measurement | Number | Provenance |
| --- | --- | --- |
| Cold `bun run build`, seeding the shared cache | 4 m 09.7 s, 13/13 tasks executed | this container (4 cores / 15 GB, Linux 6.18), `flock … bun run build` in `centraid-wt/claude/988-governance-tooling` at 70e78c91a |
| Same build in a **fresh worktree** with no `.turbo` of its own | **0.48 s** wall, 13/13 restored (turbo 381 ms, FULL TURBO) | same container, `git worktree add --detach /tmp/988-cache-probe HEAD && bun install --frozen-lockfile && time bun run build`; worktree deleted after |
| Stamp key computation | 56 ms | same container, `stampKey()` over this tree |
| `bun run governance`, cold | 1 m 12.3 s | same container, `time bun run governance </dev/null` |

**Box 6 — docs.**

| File | Change |
| --- | --- |
| `docs/multi-agent.md` | ONE new bullet at the end of § Root-agent orchestration, so the sibling lane on `claude/close-docs` merges cleanly. Nothing else in the file |
| `docs/dev-environment.md` | Rung-1 row names the tier by destination; new § "Tiers, stamps, and one cache (#988)" beside the gate loop, stating that CI runs the full tier for every branch |
| `docs/toolchain.md` | `check:push`, `check:push:static` and `governance` join the stable command API; new § "Where the caches live" names both directories and their overrides |

**Checklist crosswalk.** Each item above, and where its evidence is:

- Gate stamps keyed by tree hash for the static tier, outside the repo, never read by CI — box 2 table and `scripts/ci/gate-stamp.mjs`.
- Tiered push check by branch: static tier off `main`, full tier on `main` — box 3 table and `scripts/test.sh`.
- False positives: check:ui-receipt no longer fires on a file that is on no import edge — box 4(b) and `scripts/validate-ui-receipt.test.mjs`.
- False positives: lint:product tolerates a spent one-shot marker — box 4(c) and `scripts/test-report/ratchet-floors.test.mjs`.
- Shared build cache across worktrees, measured — box 5 numbers table.
- docs/multi-agent.md, docs/dev-environment.md and docs/toolchain.md state the model — box 6 table.
- `.governance/run.sh` green; every existing receipt still passes `receipt-per-issue` — the verification block below.
- Per-lane receipt files, and False positives: agent-session-identity date row — left unchecked: both need a change inside a digest-locked vendored directive folder.

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

Tree hash `%TREE%` (self-audit), head `%HEAD%`, base `origin/main@50ab218cf`, this container
(4 cores / 15 GB, Linux 6.18). Every command below was run from
`centraid-wt/claude/988-governance-tooling`.

```txt
$ bash .governance/run.sh </dev/null          # 1m15.6s — 21 pass, 1 fail
✗ receipt-per-issue (2 violations)
    receipts/issue-988-governance-tooling.md — newly added receipt is missing a '## Audit' section
```

That is the whole of the red, and it is the section the wave verifier writes. **All 377 receipts that
were on the trunk pass `receipt-per-issue` unchanged** — the corpus is 378 files including this one,
and no violation names any of the other 377. `bash .governance/run.sh` must be given `</dev/null`
from an agent shell: `pre-push-gate` reads its ref list from stdin, and an inherited open pipe hangs
the whole run there.

```txt
$ rm -rf ~/.cache/centraid/gate-stamps
$ time bun run check:push:static     # 15.53s — 4/4 gates, stamp written
$ time bun run check:push:static     # 0.09s  — ⊘ static tier stamped for tree ba789f185
$ printf '\n' >> receipts/issue-988-governance-tooling.md
$ bun run check:push:static          # ▶ 4 gates — one changed byte invalidates the stamp
```

A red run writes nothing: run 1 of `.governance/run.sh` above left
`~/.cache/centraid/gate-stamps` empty.

```sh
# Box 5 — a fresh worktree builds from the shared cache:
git worktree add /tmp/988-cache-probe claude/988-governance-tooling
cd /tmp/988-cache-probe && bun install --frozen-lockfile && time bun run build
```

```sh
# Box 4 — the false positives, both directions:
node --test scripts/validate-ui-receipt.test.mjs
bun run test:ratchet:unit
grep -c '"replacesMinimumTestsFlow"' tests/claims.json   # 0 — no spent marker remains
```

```sh
# Box 3 — the tier is chosen by the ref being pushed:
GOVERNANCE_SHELL_FULL=1 bash scripts/test.sh
node --test scripts/ci/gate-classes.test.mjs
```

```sh
# Box 2 — the stamp is written by a green run and skips the next one:
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/centraid/gate-stamps"
time bun run governance </dev/null   # runs
time bun run governance </dev/null   # skips
node --test scripts/ci/gate-stamp.test.mjs
```

```sh
# The reproduction, on a clean tree:
mkdir -p receipts/issue-988 && printf '# probe\n' > receipts/issue-988/tooling.md
git add receipts/issue-988 && bash .governance/run.sh receipt-per-issue
git rm -rq --cached receipts/issue-988 && rm -rf receipts/issue-988
```

### Falsification

Two claims in this diff a reviewer would doubt, and the throwaway checks run against them.

| Claim | Check | Result |
| --- | --- | --- |
| A gate stamp cannot let a gate pass over a tree it never read | Appended one byte to a file and re-ran `check:push:static` | The skip vanished and all 4 gates ran — the key is the tree oid, and a copy of the index means an unstaged edit moves it. A red `.governance/run.sh` also left the stamp directory empty |
| Making a manifest a non-surface does not stop `check:ui-receipt` watching the drawing beside it | Added cases for `people/app-root.tsx` and `people/Chrome.module.css` in the same directory | Both still return the full evidence demand; only `.json`/`.md`/`.yml`/`.txt`/`.lock`/`.snap` are exempted |

## Session

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-09-05 | claude-code | 60f9e86b-149f-5fc9-84c0-f2160b6b6f3c |
