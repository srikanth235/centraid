# Issue #1005 — governance-kit as a constitution

Lane A: `.governance/law/` — the law directory, the arrival record, the runner and the doors.
Branch `lane/1005-a`, four commits, one per seam.

## Checklist

The umbrella's acceptance boxes. Only the ones this lane owns are checked.

- [x] Directives can be written as lint rules rather than shell scripts: a rule harness, a derived
      config, a runner, and a single entry point that still is `bash .governance/run.sh`
- [x] An arrival record generated once per run — deterministic, fixture-pinned, and the only place
      that talks to git — so rules stay pure and synchronous over a document
- [x] Two doors: `hook` (answerable from the change set, fatal at pre-commit) and `window` (the
      whole law at review time, hook rules still fatal, the rest warned)
- [x] One line per enabled rule on every run, green or red
- [x] The managed tree's digest arithmetic available to rules, byte-identical to the vendored bash
- [ ] The vendored `governance-kit/audit` pack ported to rules and deleted (Lane B)
- [ ] Estates, registries, appeals (Lane B/C)
- [ ] CODEOWNERS and branch protection — what the host enforces (Lane C)
- [ ] CONSTITUTION.md reworked to match (Lane D)
- [ ] The rule/test pairing check itself as a rule (later lane; the convention is documented in
      `.governance/law/README.md` now)

## What changed

Nothing existing was modified except four files: `.gitignore`, `package.json`, `docs/toolchain.md`
and `docs/dev-environment.md`. No managed or digest-locked file was touched.

| File | Change |
| --- | --- |
| `.governance/law/README.md` | New. What lives here, the two doors, the derivation from packs, how to add a rule, and the observe/enforce boundary |
| `.governance/law/package.json` | New. Private, `type: module`, exact pins: `eslint` 10.10.0, `@eslint/json` 2.1.0, `@eslint/markdown` 8.0.3 |
| `.governance/law/package-lock.json` | New. Lockfile for `npm ci --prefix .governance/law` |
| `.governance/law/eslint.config.mjs` | New. **Derived**: `readPacks`, `readGateDoors`, `loadRules`, `buildConfig(door)`. Two blocks — the arrival record under `json/json`, the governance documents under `markdown/commonmark` — both with `reportUnusedDisableDirectives: "error"` |
| `.governance/law/packs/centraid.json` | New. The repo's pack declaration: empty `rules` this lane, and the 11 `lawPaths` globs the law digest covers |
| `.governance/law/packs/governance-kit-audit.json` | New. The vendored pack's declaration, empty, for Lane B to fill as it ports |
| `.governance/law/lib/rule.mjs` | New. `defineRule` (id, statute → `meta.docs.url`, door, surface, `enforces`/`observes` — at least one required) and `ruleTester()` wired to `node:test` and both languages |
| `.governance/law/lib/digest.mjs` | New. `sha256File`, `dirDigest` (the managed-tree algorithm), `globToRegExp`, `lawDigest`, `byteCompare` |
| `.governance/law/arrival.mjs` | New. The generator: `resolveRange`, `collectCommits`, `collectPending`, `collectLaw`, `collectManagedTree`, `parsePacksLock`, `parseManagedDigests`, `serialize`. One function per section; `waivers`/`registries`/`gates`/`ci` present and empty for later lanes |
| `.governance/law/arrival.test.mjs` | New. 9 cases: fixture parity, determinism, section presence, bash/JS digest parity over all four locked directives, managed-tree drift, the law section, `-z` name-status parsing (renames, spaces), the two YAML block readers, serialization |
| `.governance/law/run.mjs` | New. The runner: generate → build config for the door → lint → one line per rule → findings → summary. `--door`, `--range`, `--message-file`, `--arrival`, `--json`, `--front-page`. Exit 1 iff an error-severity finding |
| `.governance/law/run.test.mjs` | New. 8 cases: the empty law is green and silent, both doors build, a firing rule is one line and one finding, hook is fatal and window warns, a hook rule stays fatal under the window door, the exit codes, report-on-pass, the front page |
| `.governance/law/front-page.mjs` | New. `renderFrontPage` — plain markdown: range, law digest at both ends, what law moved, a row per rule, the findings, `token cost: not recorded` |
| `.governance/law/fixtures/arrival/bb964a7e..3df6d552.json` | New. #1002's squash range, generated and checked in whole (8 277 lines) |
| `.governance/packs/srikanth235/centraid/directives/law/directive.yaml` | New. `surface: change-set`, `hook: pre-commit` |
| `.governance/packs/srikanth235/centraid/directives/law/check.sh` | New. Materializes the npm install when missing, picks the door from `GIT_INDEX_FILE`, forwards output and exit code. Skips (exit 0) with no `npm` or no `node` |
| `.governance/packs/srikanth235/centraid/directives/law/hooks/commit-msg.sh` | New. Re-runs the hook door with `--message-file`, so `arrival.pending` carries the message and the staged set together |
| `.gitignore` | `.governance/law/node_modules/` and `.governance/law/out/` named in full, not left to the bare `out` entry |
| `package.json` | New scripts `governance:law` and `governance:law:test`; the latter appended to the `scripts:test` chain, which is how every other `node --test` lane is reached |
| `docs/toolchain.md` | The second linter: what it lints, that `bun run lint` never invokes it, why it exists, and the two new commands in the command-API table |
| `docs/dev-environment.md` | The rung-0 catalog is thirteen, not twelve; the `law` directive, its two doors and its measured 0.48 s |
| `receipts/issue-1005-governance-constitution.md` | This file |

Design decisions worth naming, because they are load-bearing for the later lanes:

- **The config is derived, never written.** A rule is enabled by a row in `packs/<pack>.json` plus a
  file in `rules/`. `severity: "off"` repeals without deleting. There is no third place.
- **`hook` versus `window` is a property of the rule, not of the invocation.** A rule declared at the
  hook door stays fatal under the window door; the window door may only ever widen the law.
- **`lib/digest.mjs` is pinned to `lib/digest.sh` by test, not by comment.** The test sources the
  bash and compares over all four locked directives.
- **Rules observe; the host enforces.** Every file under `.governance/law/` is agent-writable, so
  nothing there can be the authority for what an agent may do. `defineRule` requires each rule to
  declare `enforces`, `observes`, or both. The branch-protection/CODEOWNERS half is Lane C's.

## Verification

Run in `/home/user/centraid-law` at `ce660e62` (the lane's third commit; the fourth is this receipt and the two docs), on this container (4 threads).

| # | Command | Outcome |
| --- | --- | --- |
| 1 | `rm -rf .governance/law/node_modules && npm ci --prefix .governance/law --no-audit --no-fund --silent` | exit 0, 1.72 s |
| 1b | `node .governance/law/run.mjs --door hook` | exit 0 — `✓ law (hook door): 0 rule(s), no findings` |
| 2 | `bun run governance:law:test` | 17 tests, 17 pass, 0 fail |
| 3 | `bash .governance/run.sh` | 13 directives discovered; 12 pass, `receipt-per-issue` red on this receipt's `## Audit` verdict alone (see Audit below) |
| 4a | `time bash .governance/run.sh law` | `✓ governance: all 1 directive(s) passed`, real 0.834 s |
| 4b | `time GIT_INDEX_FILE=x bash .../directives/law/check.sh` | `✓ law` (hook door), real 0.551 s — rung 0 stays inside its 5 s budget |
| 5 | `node .governance/law/arrival.mjs --range bb964a7e..3df6d552 --out /tmp/a.json && cmp /tmp/a.json .governance/law/fixtures/arrival/bb964a7e..3df6d552.json` | identical, exit 0 |
| 6 | `bun run lint:test-reachability` | `test-reachability: 1739 test files, every one reached by a runner` |
| 7 | `bun run format:check` | `All matched files use the correct format.` over 5 560 files |
| 8 | `bun run lint` | exit 0, no diagnostics |
| 9 | `node --test scripts/ci/gate-classes.test.mjs` | 7 tests, 7 pass, 0 fail |
| 10 | `bun run test:governance-shell` | green (shellcheck not installed on this container, so its static shell lint was skipped and is unverified here) |
| 11 | four real `git commit`s, no `SKIP_GOVERNANCE`, no `--no-verify` | each passed `.githooks/pre-commit` and `.githooks/commit-msg` |

Transcript of the same run, commands and their outcome lines:

```
$ rm -rf .governance/law/node_modules && npm ci --prefix .governance/law --no-audit --no-fund --silent
real    0m1.779s                                                    # exit 0
$ node .governance/law/run.mjs --door hook
✓ law (hook door): 0 rule(s), no findings                            # exit 0
$ bun run governance:law:test
# tests 17 / # pass 17 / # fail 0                                    # exit 0 — pass
$ bash .governance/run.sh
✗ governance: 1 directive(s) failed, 12 passed                       # exit 1 — see Audit
$ time bash .governance/run.sh law
✓ governance: all 1 directive(s) passed ; real 0m0.834s              # exit 0 — pass
$ time GIT_INDEX_FILE=x bash .governance/packs/srikanth235/centraid/directives/law/check.sh
✓ law (hook door): 0 rule(s), no findings ; real 0m0.551s            # exit 0 — pass
$ node .governance/law/arrival.mjs --range bb964a7e..3df6d552 --out /tmp/a.json \
    && cmp /tmp/a.json .governance/law/fixtures/arrival/bb964a7e..3df6d552.json
                                                                     # exit 0 — identical, pass
$ bun run lint:test-reachability
test-reachability: 1739 test files, every one reached by a runner    # exit 0 — pass
$ bun run format:check
All matched files use the correct format. (5560 files)               # exit 0 — pass
$ bun run lint
(no diagnostics)                                                     # exit 0 — pass
$ node --test scripts/ci/gate-classes.test.mjs
# tests 7 / # pass 7 / # fail 0                                      # exit 0 — pass
$ bun run test:governance-shell
governance-shell: tier selection ok                                  # exit 0 — pass
$ git status --porcelain
(empty)                                                              # exit 0 — pass
```

Not verified on this container and named rather than implied: `shellcheck` over the two new shell
files (not installed); the behaviour of the `law` directive under the CI image's Node, which is a
different release from the local `v22.22.2`.

## Decisions

Root rulings this lane implemented, recorded verbatim with the reason each was given.

- **R-1005-1 Home.** Everything new lives in `.governance/law/` (not kit-digested), wired into
  `run.sh` through a new local directive `.governance/packs/srikanth235/centraid/directives/law/`, so
  `bash .governance/run.sh` stays the single entry point unchanged. Reason: `run.sh`, `lib.sh` and
  `.github/workflows/governance.yml` are digest-locked by `install.yaml`'s `managed_digests`, and a
  new `check.sh` is the only supported way into the discovery loop.
- **R-1005-2 Deps.** A private `.governance/law/package.json` with exact pins plus its lockfile;
  `check.sh` runs `npm ci --prefix .governance/law` when `node_modules/eslint` is missing. Reason:
  the managed `governance.yml` installs nothing, and `ubuntu-latest` ships node and npm but not bun.
  `node_modules/` and `out/` are named in `.gitignore` in full rather than relying on the bare `out`
  entry.
- **R-1005-3 Config.** `eslint.config.mjs` is derived at load time from the pack declarations plus
  `scripts/ci/gate-classes.json` (read for doors; the `door` field does not exist there yet and its
  absence is tolerated). `GOVERNANCE_DOOR` selects the door, default `window`. Hook config = door
  `hook` rules at `error`; window config = every non-`off` rule, hook rules at `error` and the rest
  at `warn`. `reportUnusedDisableDirectives: "error"`. Reason: two places to look for what the law
  says is one place too many, and an unused suppression is a standing permission slip.
- **R-1005-4 arrival.json.** Schema 1, deterministic, one function per section, every later-lane key
  (`waivers`, `registries`, `gates`, `ci`) present and empty from the first record; fixture-pinned on
  #1002's squash range. Reason: rules that need git are rules that cannot be unit-tested; a consumer
  that must check whether a key exists will get it wrong once.
- **R-1005-8 Rule harness.** `defineRule`/`ruleTester` in `lib/rule.mjs`; every rule ships as
  `rules/<id>.mjs` plus `rules/<id>.test.mjs`. Reason: nothing hand-rolled that a linter already
  provides. The pairing check is a later lane's rule; the convention is documented in the README now.

This lane's own decisions:

- **`buildConfig` and `runLaw` take injection points** (`declared`, `arrivalPath`, `rules`) so a
  throwaway rule and a checked-in fixture go through the *real* config path in tests. The catalog is
  resolved once and handed to the config builder, so the lines a run prints and the rules ESLint ran
  are the same list by construction rather than by two lookups agreeing.
- **The document set is scoped to the change**, for the same reason rung 0 is: a prose gate that
  fires on documents the author never opened is one people learn to bypass.
- **`front-page.mjs` prints `token cost: not recorded`** rather than a blank or a zero. A blank where
  a number belongs reads as zero, and no run has measured it yet.

Limitation, named rather than worked around: the arrival record's `managedTree` section is computed
against the **working tree**, so the checked-in fixture also pins the current digests of the four
locked directives and the three managed files. Lane B changes those by design; the fixture is
regenerated with them, and the diff is the evidence that they moved.

## Audit

judge: pending — root re-judges at close.
