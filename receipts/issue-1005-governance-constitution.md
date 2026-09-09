# Issue #1005 — governance-kit as a constitution

<!-- governance:front-page start -->

**Law** · window door · range `87cf642c..d0c76db0` · law digest `629a7ce80994` → `e9ba379e08d2`

law changed under this run: `.github/CODEOWNERS`, `.governance/conf/governance-kit/audit/commit-message-format.conf`, `.governance/conf/governance-kit/audit/doc-integrity.conf`, `.governance/conf/governance-kit/audit/managed-tree-integrity.conf`, `.governance/conf/governance-kit/audit/receipt-per-issue.conf`, `.governance/conf/srikanth235/centraid/pre-commit-deferred.conf`, `.governance/install.yaml`, `.governance/law/README.md`, `.governance/law/arrival.mjs`, `.governance/law/arrival.test.mjs`, `.governance/law/brief.mjs`, `.governance/law/brief.test.mjs` and 70 more

| Rule | Door | Verdict | Findings |
| --- | --- | --- | --- |
| `amendment-pairing` | hook | ✓ pass | 0 |
| `commit-message-format` | hook | ✓ pass | 0 |
| `constitution-coverage` | window | ✓ pass | 0 |
| `doc-integrity` | hook | ✓ pass | 0 |
| `doctrine-citation` | window | ✓ pass | 0 |
| `estate-separation` | hook | ✗ fail | 6 |
| `managed-tree-integrity` | hook | ✓ pass | 0 |
| `receipt-per-issue` | window | ✗ fail | 1 |
| `registry-completeness` | window | ✓ pass | 0 |
| `waiver-docket` | hook | ✗ fail | 4 |

### Findings

- `.governance/law/out/arrival.json:1` **law/estate-separation** (warn) — a9748c94 edits the law and the territory in one commit — law: '.governance/law/README.md', '.governance/law/eslint.config.mjs', '.governance/law/lib/rule.mjs' and 4 more; territory: '.gitignore'. Split them, or waive with 'governance: allow-estate-separation <reason>' in the commit body.
- `.governance/law/out/arrival.json:1` **law/estate-separation** (warn) — 807feea9 edits the law and the territory in one commit — law: '.governance/law/arrival.mjs', '.governance/law/arrival.test.mjs', '.governance/law/fixtures/arrival/bb964a7e..3df6d552.json' and 1 more; territory: 'package.json'. Split them, or waive with 'governance: allow-estate-separation <reason>' in the commit body.
- `.governance/law/out/arrival.json:1` **law/estate-separation** (warn) — 246d5033 edits the law and the territory in one commit — law: '.governance/law/eslint.config.mjs', '.governance/law/front-page.mjs', '.governance/law/run.mjs' and 4 more; territory: 'package.json'. Split them, or waive with 'governance: allow-estate-separation <reason>' in the commit body.
- `.governance/law/out/arrival.json:1` **law/estate-separation** (warn) — c57f98b6 edits the law and the territory in one commit — law: '.governance/law/arrival.mjs', '.governance/law/arrival.test.mjs', '.governance/law/commitlint.config.mjs' and 9 more; territory: 'package.json'. Split them, or waive with 'governance: allow-estate-separation <reason>' in the commit body.
- `.governance/law/out/arrival.json:1` **law/estate-separation** (warn) — 615be91b edits the law and the territory in one commit — law: '.governance/install.yaml', '.governance/law/arrival.mjs', '.governance/law/arrival.test.mjs' and 13 more; territory: 'package.json'. Split them, or waive with 'governance: allow-estate-separation <reason>' in the commit body.
- `.governance/law/out/arrival.json:1` **law/estate-separation** (warn) — 381682ff edits the law and the territory in one commit — law: '.governance/conf/governance-kit/audit/commit-message-format.conf', '.governance/conf/governance-kit/audit/doc-integrity.conf', '.governance/conf/governance-kit/audit/managed-tree-integrity.conf' and 25 more; territory: 'scripts/test.sh'. Split them, or waive with 'governance: allow-estate-separation <reason>' in the commit body.
- `.governance/law/out/arrival.json:2187` **law/waiver-docket** (warn) — 'doc-integrity' on COSTS.md (commit:db3df05b2c8ea00529e78fe96d410bd16339d559) names docket row D-9, which this same change filed. A row granted and spent in one arrival is a permission slip its author wrote itself; land the row first, and let the owner grant it.
- `.governance/law/out/arrival.json:2194` **law/waiver-docket** (warn) — 'doc-integrity' on STEERING.md (commit:db3df05b2c8ea00529e78fe96d410bd16339d559) names docket row D-10, which this same change filed. A row granted and spent in one arrival is a permission slip its author wrote itself; land the row first, and let the owner grant it.
- `.governance/law/out/arrival.json:2201` **law/waiver-docket** (warn) — 'estate-separation' (commit:db3df05b2c8ea00529e78fe96d410bd16339d559) names docket row D-11, which this same change filed. A row granted and spent in one arrival is a permission slip its author wrote itself; land the row first, and let the owner grant it.
- `.governance/law/out/arrival.json:2208` **law/waiver-docket** (warn) — 'estate-separation' (commit:fedd15cc99fc4fe19b3702b5a8a3775478136b99) names docket row D-11, which this same change filed. A row granted and spent in one arrival is a permission slip its author wrote itself; land the row first, and let the owner grant it.
- `.governance/law/out/arrival.json:5312` **law/receipt-per-issue** (error) — receipts/issue-1005-governance-constitution.md — '## Audit' records no PASS/REFUTED verdict; an independent reviewer must report a verdict + evidence for each check this rule names.

law estate: 11 paths, CODEOWNERS in sync

### Registries

- rulings recorded: #238, #240, #576, #659, #767, #927, #1002, #1003, #1005 in `docs/decisions.md`
- changelog entries: #238, #240, #1003, #1005
- gates moved: `oxfmt.config.ts` (unknown), `scripts/ci/gate-classes.json` (unknown)
- waiver used: `doc-integrity` `COSTS.md` — repealed by G-ledgers-retired in docs/decisions.md; the ledger stopped at #238 and nothing noticed (commit:db3df05b2c8ea00529e78fe96d410bd16339d559)
- waiver used: `doc-integrity` `STEERING.md` — repealed by G-ledgers-retired in docs/decisions.md; the ledger stopped at #240 and nothing noticed (commit:db3df05b2c8ea00529e78fe96d410bd16339d559)
- waiver used: `estate-separation` — a repeal touches the rules and the files being repealed in one act; splitting it would leave the tree citing two deleted paths (commit:db3df05b2c8ea00529e78fe96d410bd16339d559)
- waiver used: `estate-separation` — the law's test roster lived in the product's package.json; this commit replaces that enumeration with a glob so no future rule needs a territory edit (commit:fedd15cc99fc4fe19b3702b5a8a3775478136b99)
- proposal link unverified (offline)
- token cost: not recorded

<!-- governance:front-page end -->

Regenerated by `node .governance/law/run.mjs --front-page <path>`; hand edits inside the
markers are undone by the next run. The `range` head is the commit that existed when the
block was rendered, so the line moves with every later commit — that is the point of the
markers, not a defect in them.

Lane A: `.governance/law/` — the law directory, the arrival record, the runner and the doors.
Branch `lane/1005-a`, four commits, one per seam.

Lane B: the vendored `governance-kit/audit` pack ported to rules and deleted.
Branch `lane/1005-b`, four commits, one per seam.

Lane C: the estates, the registry rules, generated CODEOWNERS, and the repeal of the two
unenforced ledgers. Branch `lane/1005-c`, six commits, one per seam.

Lane D: the docket, the citation and pairing rules, the constitution rework, and the generated
brief. Branch `lane/1005-d`, six commits, one per seam.

## Checklist

The umbrella's fourteen acceptance boxes, verbatim from
[#1005](https://github.com/srikanth235/centraid/issues/1005), each with the evidence that
answers it. Two are the owner's and are left unchecked with the action named; nothing here is
checked on an agent's word about the host.

- [x] A directive is an ESLint rule with `meta.door`, a statute link, and a RuleTester file; a rule
      file changed without its tester changed fails the hook.
      — every file under `.governance/law/rules/` ships as `<id>.mjs` + `<id>.test.mjs`;
      `amendment-pairing` is the hook rule that refuses the unpaired edit
      (`.governance/law/rules/amendment-pairing.test.mjs`).
- [x] `arrival.json` is generated deterministically from a git range, carries the law digest at
      branch point and HEAD, is under the managed-tree digest, and has a checked-in fixture.
      — `node .governance/law/arrival.mjs --range bb964a7e..3df6d552` is byte-identical to
      `.governance/law/fixtures/arrival/bb964a7e..3df6d552.json` (Verification, Lane A row 5);
      `digest.mjs --record` holds `arrival.mjs` and every `lib/` module.
- [x] Every rule emits one line on pass; the front page in the PR body is the formatter's output and
      nothing else. — the rule table at the top of this receipt, ten rows, rendered by
      `run.mjs --front-page`; `## PR body` below is that block plus a summary, nothing hand-drawn.
- [ ] CODEOWNERS covers every pack-declared law path and branch protection requires owner review
      there; a law-only PR authored by a non-owner cannot merge, demonstrated and recorded in the
      receipt. — **owner action.** The repository half is done and machine-checked: the front page
      reads `law estate: 11 paths, CODEOWNERS in sync`, and `node .governance/law/codeowners.mjs
      --check` exits 1 on drift. Branch protection over those paths, and the blocked-PR
      demonstration, are host configuration this repository cannot assert (Q-1005-3, `## Owner
      items`).
- [x] `estate-separation`: a commit touching a law path together with territory, or without a
      proposal link, is refused in the hook and shown on the front page; the same check over the
      arrival catches the split-across-commits case within one PR.
      — fatal at the hook door, `warn` at the window; the six front-page findings above are the
      whole-arrival half reading this branch's own history.
- [x] `registry-completeness`: a ruling, waiver, or gate move without its registry row is a finding;
      a routine arrival needs only its receipt and changelog row; COSTS.md and STEERING.md are
      removed, their constitution clauses repealed, and the ruling recorded in docs/decisions.md.
      — `✓ registry-completeness` on the front page; the Registries block is generated text, "no
      rulings recorded" included; `G-ledgers-retired` in
      [docs/decisions.md](../docs/decisions.md#governance-as-a-constitution-1005).
- [x] `waiver-docket`: every disable directive names a docket row with reason, authority, expiry,
      merged to `origin/main` under owner review before use; `reportUnusedDisableDirectives` is
      `error`. — the rule is live and its four findings above are precisely the self-grant case it
      exists to catch (D-9..D-11, `## Owner items`); `reportUnusedDisableDirectives: "error"` in
      `.governance/law/eslint.config.mjs` (R-1005-3).
- [x] `constitution-coverage`: every principle in CONSTITUTION.md resolves to a rule id or a
      decision id. — `✓ constitution-coverage` on the front page; the principles that resolve to
      neither are recorded as Q-1005-1 and Q-1005-2 rather than dropped.
- [x] The doctrine digest in a brief is generated from config with the law digest stamped; an
      amendment landing during a run produces a front-page line naming it.
      — `node .governance/law/brief.mjs`; the `law changed under this run:` line at the top of this
      receipt is that line, produced by this very branch moving the law under itself.
- [x] The four existing audit directives are ported with parity proven on the last 50 `main`
      commits, and the old runner is gone. — `node .governance/law/parity.mjs --last 50`: 0
      unexplained disagreements (Verification, Lane B row 4); `.governance/packs/governance-kit/`
      and its four conf overlays are deleted.
- [x] `scripts/ci/gate-classes.json` carries `door` per gate and the hook/window configs are derived
      from it. — every row carries `door`; `scripts/ci/gate-classes.test.mjs` fails on a missing or
      unknown one (R-1005-25).
- [x] Replaying #1002's range through the window surfaces the widened gate, the uncited ruling, and
      the missing registry rows as findings. — `node .governance/law/run.mjs --range
      bb964a7e..3df6d552`: estate-separation 1, registry-completeness 1, doctrine-citation 2,
      waiver-docket 7; pinned in `.governance/law/fixtures/replay/1002.json` and asserted by
      `replay.test.mjs` (R-1005-18, R-1005-26).
- [x] Each rule's doc states what the host enforces and what the rule only observes.
      — every `### <id>` section of [CONSTITUTION.md](../CONSTITUTION.md) carries the pair, and
      `constitution-coverage` fails a rule with no section.
- [x] Rung 0 stays under 5s; docs listed under Scope describe current state; one receipt for this
      issue whose front page is machine-written. — `time bash .githooks/pre-commit` with one staged
      registry file: **3.6 s** total on this container (`## Inherited red` records the machine);
      the doc pass is the first commit of this lane; this file is the one receipt and its head is
      the formatter's output.

### Validation

The issue's six validation items, in its order.

| Item | Result |
| --- | --- |
| RuleTester suites for every rule, `valid` and `invalid`, at rung 0 | `bun run governance:law:test` — 176 tests, 176 pass; the `law` directive runs them inside `bash .governance/run.sh` |
| Parity replay: old and new runners over the last 50 `main` commits, diff empty | `node .governance/law/parity.mjs --last 50` — 50 replayed, 0 unexplained disagreements, 1 recorded divergence with its reason in `parity-expectations.json` |
| #1002 replay: expected findings checked in as a fixture | `.governance/law/fixtures/replay/1002.json`, asserted by `replay.test.mjs`; 11 findings across four rules |
| Boundary demonstration: a law-only PR from a non-owner blocked by branch protection | **not done — owner action.** Needs a second GitHub account and branch protection enabled; neither is reachable from this repository (Q-1005-3) |
| `bash .governance/run.sh` green in hook and CI; rung-0 wall clock measured and recorded | hook: measured, `3.6 s`, and every directive green through the real hooks on every commit of this lane. Window: 8 of 9 green, `law` red on this receipt's `## Audit` verdict alone — the finding that stays until an independent reviewer writes it. CI: **pending the required check**, which is owner-enabled (`## Owner items`) |
| `bun run lint:ledgers`, `lint:product`, `gate-classes.test.mjs` green with the new field | `lint:ledgers` green; `gate-classes.test.mjs` 7/7 green; `lint:product` carries three failures that are inherited, not caused — see `## Inherited red` |

## What changed

### Lane B — the port and the deletion

| File | Change |
| --- | --- |
| `.governance/law/rules/commit-message-format.mjs` + `.test.mjs` | New. Conventional Commit subjects with an issue reference, over `arrival.commits` and `arrival.pending` |
| `.governance/law/rules/doc-integrity.mjs` + `.test.mjs` | New. `frozen-files` / `append-only` / `frozen-section`, over `arrival.registries.frozen` |
| `.governance/law/rules/managed-tree-integrity.mjs` + `.test.mjs` | New. Recorded-versus-actual digests, unrecorded directive folders, and the stamped-kit-version check, over `arrival.managedTree` |
| `.governance/law/rules/receipt-per-issue.mjs` + `.test.mjs` | New. Filename shape, uniqueness, completed-change association and receipt shape, over `arrival.registries.receipts` |
| `.governance/law/commitlint.config.mjs` | New. The commit-subject policy in commitlint's config shape |
| `.governance/law/lib/git.mjs` | New. The one place the generator talks to git |
| `.governance/law/lib/registries.mjs` | New. `collectWaivers`, `documentIntegrityRules`, `extractSection`, `collectFrozen`, `collectReceipts` |
| `.governance/law/lib/managed.mjs` | New. `parsePacksLock`, `parseManagedDigests`, `collectManagedTree` |
| `.governance/law/lib/rule.mjs` | `defineArrivalRule` and `locate` (JSON-pointer reporting) |
| `.governance/law/arrival.mjs` | Schema 2: `range.hasBase`, `commits[].authorEmail`, `waivers`, `registries.frozen`, `registries.receipts`. Split into the three `lib/` modules above when it crossed the 625-line ceiling |
| `.governance/law/arrival.test.mjs` | Cases for waivers, the rule set, section extraction, both registries, the pending-message path, and the bash/JS digest parity — now read out of history |
| `.governance/law/digest.mjs` + `.test.mjs` | New. `--record` rewrites exactly the law generator's rows in `install.yaml` |
| `.governance/law/parity.mjs` | New. Replays both runners over the last 50 trunk commits |
| `.governance/law/parity-expectations.json` | New. The one recorded divergence, with its reason |
| `.governance/law/eslint.config.mjs` | Pack `options` become rule options; the window door no longer demotes a declared `error` to a warning |
| `.governance/law/packs/governance-kit-audit.json` | The four rule rows, their doors, and the ported `doc-integrity` overlay |
| `.governance/law/fixtures/arrival/bb964a7e..3df6d552.json` | Regenerated for schema 2 and for the deleted pack |
| `.governance/law/README.md` | The rule table, the new files, and the parity requirement |
| `.governance/packs/governance-kit/` | **Deleted** — all four directive folders, their manifests, `constitution.md` files and `lib/digest.sh` |
| `.governance/conf/governance-kit/` | **Deleted** — the four overlays; `doc-integrity`'s three rows moved into the pack declaration |
| `.governance/packs.lock` | The `governance-kit/audit` entry removed |
| `.governance/install.yaml` | `managed_digests` gains the law generator's six files |
| `.governance/conf/srikanth235/centraid/pre-commit-deferred.conf` | Emptied, with the reason |
| `CONSTITUTION.md` | Four `Enforced by` lines now name the rule and its cases; one appended Evolution Log line; the Compliance paragraph's deferral sentence corrected |
| `docs/dev-environment.md` | Nine directives, no deferral, the `law` directive's measured 0.96 s, and why the deferral mechanism had already stopped operating |
| `docs/decisions.md` | `G-rung0-deferral` gains a dated supersession sentence; the row itself is untouched |
| `scripts/test.sh` | The comment describing `receipt-per-issue` as vendored and deferred |
| `package.json` | `governance:law:test` names the seven law test files |

**The port is stricter in exactly one place, and it is on record.** The shell
`commit-message-format` skipped bot authors with `*[bot]*@*`. In a shell `case`,
`[bot]` is a character class, so that pattern matches any address containing
`b`, `o` or `t` before the `@` — `srikanth235@gmail.com` included. Its whole
range mode was therefore judging almost no commit. The rule matches the literal
token, and three of the last 50 trunk subjects it flags were passing silently.
Reproducing the defect would have been carrying a hole forward.

**A second thing the replay surfaced.** Under governance-kit 0.15.0 nothing in
`.githooks/` reads `pre-commit-deferred.conf` — the dispatchers select on the
`hook:` field alone — so the rung-0 deferral that CONSTITUTION.md,
`docs/dev-environment.md` and `docs/decisions.md` all described had already
stopped operating. `receipt-per-issue` was running at pre-commit. All three
documents are corrected.

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

### Lane C — estates, the registries, CODEOWNERS, and the repeal

| File | What changed |
| --- | --- |
| `.governance/law/lib/estates.mjs` | **New.** The three estates and the classifier; `REGISTRY_PATHS` is fixed here, not pack-declared |
| `.governance/law/lib/gates.mjs` | **New.** The gate register: which tighten-only ledgers moved and which way, over the ledger validator's own `SECTIONS` table |
| `.governance/law/lib/registries.mjs` | `collectDocument` (changelog, decisions — issues on ADDED lines only), `collectDocket`; receipt rows grow `issue`, `touched`, `recordsRuling`, `cost` |
| `.governance/law/arrival.mjs` | Schema 2 → 3; every file row tagged with its estate (commit, aggregate, staged); `gates` filled; `registries.{changelog,decisions,docket}`; `buildArrival` is now async |
| `.governance/law/arrival.test.mjs` | Async call sites; seven new cases for estates, gate direction, the documents and the receipt fields; the COSTS/STEERING expectations dropped with the repeal |
| `.governance/law/fixtures/arrival/bb964a7e..3df6d552.json` | Regenerated for schema 3 and again for the repeal |
| `.governance/law/rules/estate-separation.mjs` `.test.mjs` | **New.** The rule and its 14 cases |
| `.governance/law/rules/registry-completeness.mjs` `.test.mjs` | **New.** The rule and its 15 cases |
| `.governance/law/eslint.config.mjs` | The window door reads the pack row; the hook door is fatal for every rule it runs |
| `.governance/law/run.mjs` | Stamps the door into the record; carries `codeowners` in the report; hands the arrival to the front page |
| `.governance/law/run.test.mjs` | The two duplicated door tests become one that pins the asymmetry both ways; the front-page registry lines |
| `.governance/law/front-page.mjs` | `renderRegistries` — every line generated, including the silences; the law-estate/CODEOWNERS line |
| `.governance/law/codeowners.mjs` `.test.mjs` | **New.** `.github/CODEOWNERS` generated from the packs' `lawPaths`; `--check` exits 1 on drift |
| `.github/CODEOWNERS` | **New**, generated. 11 law paths, owner `@srikanth235` |
| `.governance/law/replay.test.mjs`, `fixtures/replay/1002.json` | **New.** The catalog replayed over #1002's merged squash, findings pinned |
| `.governance/law/packs/centraid.json` | Rows for `estate-separation` (hook, `warn`) and `registry-completeness` (window, `error`) |
| `.governance/law/packs/governance-kit-audit.json` | The two `frozen-files` rows for the repealed ledgers removed |
| `.governance/law/README.md` | The estates table, the two new rules, the door asymmetry, and a "Who enforces it" section stating what the host does and that it is unconfirmed |
| `.governance/install.yaml` | `managed_digests` re-recorded for the two new `lib/` modules; the two `install_assets_seeded` rows removed |
| `.governance/packs/srikanth235/centraid/directives/format-check/check.sh` | The two repealed paths leave the exclusion case list |
| `CONSTITUTION.md` | `### estate-separation` and `### registry-completeness`; two Principles lines reworded; one Evolution Log line appended (the 2026-06-12 line is untouched) |
| `docs/decisions.md` | **New section** `## Governance as a constitution (#1005)` — `G-ledgers-retired` and `R-1005-11`..`R-1005-18`, each with its reason, plus two deliberate non-goals |
| `CHANGELOG.md` | One `### Changed` bullet citing #1005 |
| `docs/dev-environment.md` | The `law` directive's two doors restated (scope, not severity), the two new directives, the CODEOWNERS commands, and what the host would enforce |
| `oxfmt.config.ts` | The two repealed ignore rows removed |
| `COSTS.md`, `STEERING.md` | **Deleted** (R-1005-17) |
| `package.json` | `governance:law:test` becomes a glob, so a new rule never needs a manifest edit |
| `scripts/lint-test-reachability.mjs` `.test.mjs` | A test-file glob in a script now reaches its files; one new case pins that `*` does not cross `/` |


### Lane D — the docket, citation, pairing, coverage, and the generated brief

| File | What changed |
| --- | --- |
| `.governance/law/lib/estates.mjs` | `docs/**` moved from `territory` to `registry` (R-1005-19) |
| `.governance/law/lib/waivers.mjs` | **New.** Every place a waiver can be written, read into one list with one shape: commit bodies (reason = a paragraph, not a line), comment-form tokens on added lines, `eslint-disable` directives in governance documents. Split out of `registries.mjs`, which would otherwise pass the 625-line ceiling |
| `.governance/law/lib/registries.mjs` | `collectRulings` and `collectCites` for touched receipts; `collectDocket(range)` gains `rowsOnBase` |
| `.governance/law/arrival.mjs` | Schema 3 → 5. `law.domains`, `law.rules`, `law.rulesAtBase`, `registries.docket.rowsOnBase`, `registries.receipts[*].{rulings,cites}`, `waivers[*].docket`; `lawDigestAt` and `lawPathsChanged` exported for the brief |
| `.governance/law/docket.json` | **New.** The register of standing exceptions: eleven rows for what the tree already spends |
| `.governance/law/rules/waiver-docket.{mjs,test.mjs}` | **New.** The register's own shape, the spending against it, and `eslint-disable` directives that name no row |
| `.governance/law/rules/amendment-pairing.{mjs,test.mjs}` | **New.** Rule with its cases, new rule with its pack row, severity/door with its statute |
| `.governance/law/rules/doctrine-citation.{mjs,test.mjs}` | **New.** Doctrine domains, and rulings recorded with nothing cited |
| `.governance/law/rules/constitution-coverage.{mjs,test.mjs}` | **New.** Every principle resolves; every directive has a section and vice versa |
| `.governance/law/rules/registry-completeness.{mjs,test.mjs}` | Loses its fourth (docket) question to `waiver-docket` |
| `.governance/law/lib/rule.mjs` | `SURFACES` gains `all`; `defineRule` gains `clock` and `catalog`, the two declared injections |
| `.governance/law/eslint.config.mjs` | A third config block for the docket; `rulesIn(...surfaces)`; the clock and the catalog injected as options; `readGateDoors()` refuses a door outside `DOORS` |
| `.governance/law/brief.mjs` (+ test) | **New.** The generated doctrine digest: law digest at HEAD, rules with door/severity/statute, domains, docket |
| `.governance/law/run.mjs` (+ test) | `--brief-digest` / `GOVERNANCE_BRIEF_DIGEST`, and `briefDrift` |
| `.governance/law/front-page.mjs` | The brief line; `nameFiles` caps the "law changed" list at twelve paths |
| `.governance/law/packs/centraid.json` | Four new rule rows; five doctrine domains |
| `.governance/law/fixtures/` | Arrival regenerated at schema 5; the #1002 replay now reproduces four failing rules |
| `CONSTITUTION.md` | Principles all cited; four missing directive sections written; every section states Door / Host enforces / Rule observes; amendment process and escape hatches rewritten; one Evolution Log line |
| `scripts/ci/gate-classes.json` (+ test) | A `door` on every row, in the rules' vocabulary, asserted against the rung; `governance` and `governance:law:test` classified |
| `docs/decisions.md` | R-1005-19..26, and Q-1005-1..3 — the three principles that could be made no statute |
| `docs/multi-agent.md` · `docs/dev-environment.md` | The brief is generated and stamped; the door is the placement and cost is the tiebreaker within it |
| `CHANGELOG.md` | The docket, the three new rules and the generated brief, on the existing #1005 line |

This lane's changes sit in the **pr-gate** doctrine domain (`scripts/ci/gate-classes.json`,
`scripts/ci/**`) and answer to [The PR gate loop (#892)](../docs/decisions.md#the-pr-gate-loop-892):
the door field is the same "where is this answerable" question that ruling's rung ladder answers,
written in one vocabulary instead of two.

## Verification

### Lane B

| # | Command | Outcome |
| --- | --- | --- |
| 1 | `bun run governance:law:test` | 82 tests, 82 pass, 0 fail |
| 2 | `bash .governance/run.sh` | 9 directives; 8 pass, `law` red on this receipt's Audit verdict alone |
| 3 | `time GIT_INDEX_FILE=x bash .../directives/law/check.sh` | `✓ law`, real 0.96 s — inside the 5 s rung-0 budget with all four rules |
| 4 | `node .governance/law/parity.mjs --last 50` | 50 commits replayed, **0 unexplained disagreements**, 1 recorded divergence over 3 commits; exit 0 |
| 5 | three demonstrated reds by hand | quoted below |
| 6 | `bun run format:check`, `bun run lint`, `bun run lint:test-reachability`, `bun run test:governance-shell`, `node --test scripts/ci/gate-classes.test.mjs` | all green |
| 7 | four real commits through the hooks | no `SKIP_GOVERNANCE`, no `--no-verify` |
| 8 | `git status --porcelain` | empty |

The three reds, quoted from the refused commits:

```
$ git commit -m "bad subject"
✗ commit-message-format — 1 finding
    law/commit-message-format — pending commit — 'bad subject' is not a Conventional Commit
    subject ending in an issue reference (<type>(scope)?: <subject> (#123))
✗ Commit blocked by governance.                                       # exit 1 — refused

$ echo tampered >> receipts/issue-988-governance-tooling.md && git commit -m "docs(governance): tamper (#1005)"
    law/doc-integrity — frozen-files: 'receipts/issue-988-governance-tooling.md' was modified;
    it is immutable once on the default branch (add a new file instead, or waive with
    'governance: allow-doc-integrity receipts/issue-988-governance-tooling.md <reason>')
✗ Commit blocked by governance.                                       # exit 1 — refused

$ printf '\n// tampered\n' >> .governance/law/arrival.mjs && git commit -m "chore(governance): tamper with the generator (#1005)"
✗ managed-tree-integrity — 1 finding
    law/managed-tree-integrity — .governance/law/arrival.mjs: drifted from the digest recorded
    at apply time. If you meant to change it, re-record it (`node .governance/law/digest.mjs
    --record` for the law's own generator) — otherwise restore it
✗ Commit blocked by governance.                                       # exit 1 — refused
```

Both edits were reverted with `git checkout HEAD --` and `node .governance/law/digest.mjs`
reports all six generator files recorded — exit 0, green.

The parity table's shape (50 rows, abridged; `old/new` per directive):

```
| commit   | commit-message-format | doc-integrity | managed-tree-integrity | receipt-per-issue |
| 3e555c8d | pass/pass             | pass/pass     | FAIL/FAIL              | pass/pass         |
| f5ca34fb | pass/pass             | pass/pass     | FAIL/FAIL              | pass/pass         |
| bb964a7e | pass/FAIL             | pass/pass     | FAIL/FAIL              | FAIL/FAIL         |
| 3df6d552 | pass/FAIL             | pass/pass     | FAIL/FAIL              | FAIL/FAIL         |
| 87cf642c | pass/FAIL             | pass/pass     | pass/pass              | FAIL/FAIL         |

old runner taken from f298ee7c; 50 commit(s) replayed; 0 unexplained disagreement(s),
3 recorded divergence(s)                                              # exit 0 — pass
```

`managed-tree-integrity` reads FAIL/FAIL on historical commits because the replay
overlays the 0.15.0 pack onto trees whose `packs.lock` records an earlier audit
version — both runners see the same mismatch and agree, which is the property
under test.

**A markdown hazard worth recording.** `oxfmt` reflows long markdown table rows, and a row
containing the literal `## Audit` can be wrapped so that a line begins with `## ` — a synthetic
level-2 heading that every section extractor then believes. It happened to this receipt while it
was being written and scrambled its section order. Prose in a governed document should not put a
`##` token where a wrap can reach column zero.

**Both halves are proven, separately, because history can only show one.** At a
historical commit the merge-base with the trunk IS that commit, so `--last 50`
exercises the repo-state and HEAD-only paths. The range path is proven by
`node .governance/law/parity.mjs --range-only`, which replays both runners in a
scratch worktree at HEAD, where the merge-base against `origin/main` is real:

```
| commit | commit-message-format | doc-integrity | managed-tree-integrity | receipt-per-issue |
| HEAD   | pass/pass             | pass/pass     | pass/pass              | FAIL/FAIL         |

range path at HEAD: 0 unexplained disagreement(s), 0 recorded divergence(s)   # exit 0 - pass
```

Both runners agree on all four, `receipt-per-issue` included: both are red on
this receipt's Audit verdict, which is the finding that stays until an
independent reviewer writes it.

The arbitrary range `bb964a7e..3df6d552` could not be driven through the old
runner at all: it takes its base from the default branch and exposes no range
flag, and giving it a synthetic base would mean rewriting refs. The generator
side of that range is pinned by the checked-in fixture instead.

### Lane A

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

### Lane C

Every command below was run in the lane worktree at `6edde758`.

```
bun run governance:law:test
# tests 124 / # pass 124 / # fail 0                                  # exit 0 — pass
```

```
bash .governance/run.sh
# ✗ governance: 1 directive(s) failed, 8 passed                      # exit 1
```

The **one** red is the receipt's own audit verdict, which only an independent
reviewer can write:

```
law/receipt-per-issue — receipts/issue-1005-governance-constitution.md —
'## Audit' records no PASS/REFUTED verdict
```

`estate-separation` reports six warnings in the same run, all against Lane A
and Lane B commits that predate the rule (each mixed `.governance/**` with
`package.json`, `.gitignore`, `docs/dev-environment.md` or `scripts/test.sh`).
They are warnings by the pack row and do not fail the run; they are the rule
telling the truth about this branch's own history.

```
time GIT_INDEX_FILE=x bash .governance/packs/srikanth235/centraid/directives/law/check.sh
# ✓ law (hook door): 4 rule(s), no findings
# real 0m1.270s                                                      # exit 0 — under the 2.0 s budget
```

```
node .governance/law/codeowners.mjs --check
# ✓ .github/CODEOWNERS in sync (11 law paths)                        # exit 0 — pass
```

Replaying #1002's merged squash (R-1005-18) — the two new directives catch what
the four ported ones passed:

```
node .governance/law/run.mjs --range bb964a7e..3df6d552
# ✗ estate-separation — 1 finding
#     3df6d552 edits the law and the territory in one commit — law:
#     'tests/claims.json', 'tests/inventory.json'; territory:
#     '.github/workflows/mobile-ios-lock.yml', 'ARCHITECTURE.md',
#     'SECURITY.md' and 1015 more.
# ✗ registry-completeness — 1 finding
#     CHANGELOG.md carries no line citing #996.
# ✓ commit-message-format  ✓ doc-integrity  ✓ receipt-per-issue
```

Both findings are pinned in `.governance/law/fixtures/replay/1002.json` and
regenerated by `replay.test.mjs`.

**Demonstrated reds, by hand.** Staging `tests/floors.json` (law) with
`packages/server/src/index.ts` (territory) and running `git commit`:

```
law/estate-separation — the staged change edits the law and the territory in
one commit — law: 'tests/floors.json'; territory:
'packages/server/src/index.ts'.
✗ law (hook door): 4 rule(s), 1 error(s), 0 warning(s)
✗ Commit blocked by governance.
```

`git log --oneline -1` still showed `06efb79c`; both files were reverted. The
refusal comes from the **commit-msg** rung of the hook door, not pre-commit:
`check.sh` runs without `--message-file`, so the staged set is not in the record
there, and `hooks/commit-msg.sh` re-runs the hook door with it attached. Both
rungs are inside one `git commit`, so the commit does not happen either way.

Second red: a throwaway commit adding `receipts/issue-9999-demonstrated-red.md`
with a `## Decisions` section and no matching line in `docs/decisions.md`:

```
law/registry-completeness — receipts/issue-9999-demonstrated-red.md records a
ruling but docs/decisions.md carries no line citing #9999.
law/registry-completeness — CHANGELOG.md carries no line citing #9999.
```

The commit was dropped with `git reset --hard HEAD~1`; `git status --porcelain`
is clean.

```
bun run lint:ledgers
# check-ledgers: ok — 20 sections across 5 ledgers hold against origin/main   # exit 0
bun run format:check                     # All matched files use the correct format — exit 0
bun run lint                             # exit 0 — pass
bun run lint:test-reachability           # 1748 test files, every one reached — exit 0
bun run test:governance-shell            # self-test ok (synthetic violation observed) — exit 0
node --test scripts/ci/gate-classes.test.mjs
# tests 7 / # pass 7 / # fail 0          # exit 0 — pass
bun run check:push:static
# ✓ 4/4 gates passed in 25.1s            # exit 0 — pass
```

`bun run lint:product` is **38/42**. Three of the four failures
(`lint:quality-knobs`, `lint:mobile-testids`, `lint:e2e-wiring`) reproduce at
the lane's base commit `381682ff` and are not this lane's; the fourth,
`lint:test-reachability`, was this lane's and is fixed in `6edde758`.

```
git status --porcelain      # empty (bar the untracked lane note)
git ls-files COSTS.md STEERING.md   # empty
```


### Lane D

Every command below was run in the lane worktree at `4a03e3ab`, except the receipt and decisions
edits of the last commit.

```
bun run governance:law:test
# tests 176 / # pass 176 / # fail 0                                   exit 0 — pass

bash .governance/run.sh
✓ coverage-scope-reachability  ✓ format-check  ✓ gateway-engine-mode-agnostic
✓ handler-contract  ✓ lint-check  ✓ no-hardcoded-colors  ✓ no-hardcoded-model-ids
✓ pre-push-gate
✗ law (1 violation) — the ONE tolerated red, quoted in full:
    receipts/issue-1005-governance-constitution.md — '## Audit' records no PASS/REFUTED
    verdict; an independent reviewer must report a verdict + evidence for each check this
    rule names.
  The window door's other findings are warnings and are the intended output, below.

time GIT_INDEX_FILE=x bash .governance/packs/srikanth235/centraid/directives/law/check.sh
real 0m1.592s                                                        under the 2.0 s budget

node .governance/law/run.mjs --range bb964a7e..3df6d552               the #1002 replay, by hand
  law/estate-separation — 3df6d552 edits the law and the territory in one commit — law:
    'tests/claims.json', 'tests/inventory.json'; territory: ... and 1004 more.
  law/registry-completeness — CHANGELOG.md carries no line citing #996.
  law/doctrine-citation — receipts/issue-996-one-vault-every-seat.md:4059 records ruling
    W6-D1 and cites nothing.
  law/doctrine-citation — receipts/issue-996-one-vault-every-seat.md:4497 records ruling
    W6-D2 and cites nothing.
  (plus seven law/waiver-docket findings: every waiver #1002 spent, against a register that
   did not exist when it merged)

node .governance/law/brief.mjs                                        prints; 10 rules, 5 domains, 11 docket rows
node .governance/law/run.mjs --brief-digest 0000…0000 --front-page /tmp/fp.md
  law changed under this run: brief stamped `000000000000`, HEAD is `f2141b5417bb` —
  changed: unknown commit (no commit in this range carries the stamped digest)

node --test scripts/ci/gate-classes.test.mjs
# pass 8 / # fail 0                                                   exit 0 — pass

bun run lint:ledgers                 ok — 20 sections across 5 ledgers hold
bun run format:check                 all matched files use the correct format
bun run lint                         exit 0 — pass
bun run lint:test-reachability       exit 0 — pass
bun run test:governance-shell        exit 0 — pass
bun run lint:workflow-pins           exit 0 — pass
bun run check:push:static            ✓ 4/4 gates passed in 23.6s
git status --porcelain               clean
```

`bun run lint:product` fails on `lint:quality-knobs`, `lint:mobile-testids` and
`lint:e2e-wiring`. All three reproduce unchanged at the lane's base `da7656fb`, verified by
running the same gate in the root checkout at that commit — inherited, not caused here.

#### Demonstrated reds, by hand

Each was produced against the real hooks and then reverted; `git log` and `git status` confirm
neither the probe commit nor the probe edit survives.

```
1. A rule edited without its cases, staged and committed:
   ✗ amendment-pairing — the staged change changes .governance/law/rules/estate-separation.mjs
     but not estate-separation.test.mjs. A rule changed without its cases is a claim, not a
     reviewable change — CONSTITUTION.md's amendment process is one commit, three edits.
   → the commit did not happen (HEAD unchanged at 4a03e3ab)

2. An uncited principle appended to CONSTITUTION.md, then `bash .governance/run.sh law`:
   ✗ constitution-coverage — CONSTITUTION.md:32 this principle cites nothing. End it with
     '— rule: <id>', '— decision: <docs/decisions.md anchor>' or '— owner question: <anchor>'…

3. `<!-- eslint-disable law/receipt-per-issue -->` appended to this receipt, staged and committed:
   ✗ waiver-docket — receipts/issue-1005-governance-constitution.md:558 this 'eslint-disable'
     names no docket row. Write it as '-- docket:D-<n> <why>' and file the row in
     .governance/law/docket.json; a suppression with no register entry is an exception nobody
     is tracking.
   → the commit did not happen
```

#### What this pull request's own window door says, and why it is right

```
✗ doctrine-citation — 4 findings
✗ estate-separation — 6 findings
✗ waiver-docket    — 4 findings
```

- **`waiver-docket` ×4 — self-granted.** The umbrella's own waivers (two `doc-integrity` for the
  COSTS/STEERING repeal, two `estate-separation`) name rows `D-9`, `D-10` and `D-11`, which this
  same change filed at `authority: pending owner grant`. That is precisely what the rule is for and
  precisely what it should say: a row filed and spent in one arrival is a permission slip its author
  wrote itself, and only the owner's grant converts it. Nothing here should be "fixed" to go green.
- **`estate-separation` ×6 — lanes A–C.** Six commits from the earlier lanes edited the law and one
  territory file (`package.json`, `.gitignore`, `scripts/test.sh`) together. They are on the trunk
  side of no merge-base and cannot be split now; the finding is `warn` and is the honest record.
- **`doctrine-citation` ×3 — rulings R-1005-5..7** in this receipt's Lane A section cite nothing in
  their paragraphs. Lane D does not rewrite earlier lanes' receipt text, so the finding stands as
  written rather than being edited away. The fourth was the `pr-gate` domain, and is answered above.

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

### Lane B decisions
- **R-1005-5** — the commit policy lives in `.governance/law/commitlint.config.mjs` in
  commitlint's shape and `@commitlint/cli` is not installed. The reason is mechanical:
  commitlint's API is asynchronous and an ESLint rule is synchronous. What the shape buys is a
  vocabulary contributors and editors already read, and the option of running the real tool later. Ruled by the root under [#1005](https://github.com/srikanth235/centraid/issues/1005).
- **R-1005-6** — `managed-tree-integrity` is a rule over `arrival.managedTree`, and the law's own
  generator is now inside `install.yaml`'s `managed_digests`, re-recorded by
  `node .governance/law/digest.mjs --record`. The helper is a convenience, not the boundary: every
  file here is agent-writable, and what makes the record trustworthy is that `install.yaml` is
  owner-reviewed and that a change to it is visible in the diff. Ruled by the root under [#1005](https://github.com/srikanth235/centraid/issues/1005).
- **R-1005-7** — the four directive folders, the `governance-kit/audit` lock entry and
  `.governance/conf/governance-kit/` are deleted, after the parity replay was recorded and not
  before. `doc-integrity`'s three overlay rows moved into the pack declaration's
  `options.doc-integrity.rules`. Ruled by the root under
  [#1005](https://github.com/srikanth235/centraid/issues/1005).
- **Door assignment** — `commit-message-format`, `doc-integrity` and `managed-tree-integrity` at
  the hook door; `receipt-per-issue` at the window door, with its corpus-wide half made answerable
  at either door by the generator's receipt registry.

Two deliberate deviations from a literal reading of the rulings, both because the
literal reading would have weakened the policy:

1. **The window door no longer demotes severity.** R-1005-3 said non-hook rules run at `warn` at
   the window door. Applied literally, porting `receipt-per-issue` — a directive that BLOCKED —
   would have turned it into a warning, which is weakening policy without editing it. The door now
   decides which rules run and the pack row decides how loud each is; a rule that declares no
   severity still warns.
2. **The receipt extractor and the document extractor are two functions, not one.** The shell
   pack had two: `doc-integrity`'s awk ended a section at a heading of any level, while lib.sh's
   `extract_md_section` ended it only at the next `##`. Collapsing them looked like tidying and
   silently stopped reading any receipt whose `## Verification` has `###` sub-sections — this one
   included. `arrival.test.mjs` now pins both behaviours against each other.
3. **`digest.mjs` records more than the two named files.** R-1005-6 named `arrival.mjs` and
   `lib/digest.mjs`. When `arrival.mjs` crossed the 625-line ceiling it was split across
   `lib/git.mjs`, `lib/registries.mjs` and `lib/managed.mjs`, so the recorded set is every module
   under `lib/` — otherwise splitting a file would be a way to move half the generator out from
   under its own digest.

### Lane C decisions

- **G-ledgers-retired** — `COSTS.md` and `STEERING.md` are deleted. Both stopped
  at #238/#240 while the work reached #1003 and nothing noticed for seven hundred
  issues. The reason is not that the numbers were wrong; it is that a register
  nobody is required to write records the beginning of a habit and nothing after
  it. The one number that mattered is now generated: the front page reads token
  cost out of the touched receipt's Accounting section, or prints "not recorded".
- **R-1005-13** — three estates, `registry` tested first, because
  `.governance/law/docket.json` also matches the law glob `.governance/**` and a
  register of exceptions is evidence rather than a rule.
- **R-1005-14** — `estate-separation` at the hook door, pack severity `warn`. The
  window door now reads the pack row rather than promoting every hook rule to
  `error`; the hook door is fatal for everything it runs. The four ported rules
  are declared `error`, so nothing they do changed.
- **R-1005-15** — `registry-completeness` at `error`, because its host backing is
  real and already documented (`governance` is a required check). Event-driven
  throughout: nothing is asked of a change that did not cause the event.
- **R-1005-16** — `.github/CODEOWNERS` generated from the packs' `lawPaths`.
  It does not turn branch protection on and cannot check that it is on; every doc
  says so.
- **R-1005-18** — the catalog replayed over #1002's merged squash, findings
  pinned. A catalog that has only ever seen its own fixtures is a catalog of
  opinions.

Four deviations from a literal reading of the rulings, each because the literal
reading would have been wrong or unworkable:

1. **A fifth gate direction, `unchanged`.** R-1005-13 fixed the enum at
   `widened | narrowed | mixed | unknown`. A ledger whose prose rows moved but
   whose numbers did not is neither narrowed (nothing tightened) nor unknown (the
   direction was perfectly judgeable), and collapsing the two would make the
   front page report an unmoved ledger as unjudgeable. `unknown` still means
   exactly what it did: no direction table applies.
2. **`registry-completeness` also fires on `mixed`.** The ruling named `widened`.
   A `mixed` file contains a widening; exempting it would be a way to loosen a
   number under cover of tightening a neighbour.
3. **The two doors see different change sets.** R-1005-14 is about severity, and
   severity alone was not enough: at the hook door the record's `commits` are the
   branch's history, so the rule refused every commit on a branch that already
   contained a mixed one — a refusal no edit to the commit being written could
   clear. The runner now stamps the door into the record and the rule judges only
   the staged set at the hook. This is scope, not softening: the same commits are
   still judged, in the window, where they are what is under review.
4. **The aggregate finding is suppressed when a commit already mixed.** The
   ruling asked for the aggregate "so the PR-level window catches what
   commit-level cannot". Reporting it as well as the commit-level finding is the
   same fact twice with a worse message.

One friction worth the owner's attention, reported rather than papered over: the
estate map puts `docs/**` (bar `docs/decisions.md`) in `territory`, so **the law
and its own documentation cannot land in one commit**. Lane C hit this twice.
`package.json` was solved for good by making `governance:law:test` a glob; the
`docs/dev-environment.md` half was carried into the repeal commit, which needed a
waiver anyway. The options are to make `docs/**` a fourth estate, to fold it into
`registry`, or to leave it and accept a waiver on every commit that documents a
rule outside `CONSTITUTION.md`. A recommendation: fold `docs/**` into `registry`
— it is the same kind of thing (a record of what is, written by the change that
made it so), and it never changes what the next change is permitted to do.


### Lane D decisions

Root rulings this lane implemented, and the reason each was given. All eight are recorded in
[docs/decisions.md § Governance as a constitution (#1005)](../docs/decisions.md#governance-as-a-constitution-1005)
as **R-1005-19** through **R-1005-26**, with the three owner questions as **Q-1005-1..3**.

- **R-1005-19 Estates.** `docs/**` is `registry`, not `territory`. Reason: a doc records what is and
  never changes what the next change may do, which is the one thing that makes a path law
  ([#1005](https://github.com/srikanth235/centraid/issues/1005)).
- **R-1005-20 The docket.** `.governance/law/docket.json`, and `waiver-docket` over it. Reason: an
  exception nobody can enumerate is not an exception but a hole, and the only mechanical difference
  between a granted exception and a self-written one is which side of the merge-base its row was on
  ([#1005](https://github.com/srikanth235/centraid/issues/1005)).
- **R-1005-21 `constitution-coverage`.** Reason: no unwritten law — an agent is held only to what was
  published before it acted ([#1005](https://github.com/srikanth235/centraid/issues/1005)).
- **R-1005-22 `doctrine-citation`.** Reason: the expensive failures are changes made in a settled
  area by somebody who did not know it was settled ([#1002](https://github.com/srikanth235/centraid/issues/1002)).
- **R-1005-23 `amendment-pairing`.** Reason: the cardinal rule was enforced by attention, which is to
  say by nobody ([#1005](https://github.com/srikanth235/centraid/issues/1005)).
- **R-1005-24 The generated brief.** Reason: a digest typed by hand is wrong the first time somebody
  amends the law ([#1005](https://github.com/srikanth235/centraid/issues/1005)).
- **R-1005-25 Doors on gates.** Reason: one question, one vocabulary; cost is a tiebreaker within a
  door and never a reason to move one ([#576](https://github.com/srikanth235/centraid/issues/576),
  [The PR gate loop](../docs/decisions.md#the-pr-gate-loop-892)).
- **R-1005-26 The extended replay.** Reason: a catalog that has only seen its own fixtures is a
  catalog of opinions ([#1002](https://github.com/srikanth235/centraid/issues/1002)).

Three judgements this lane made inside those rulings, recorded because they differ from the brief:

- **Eleven docket rows, not twelve.** The umbrella spent four waivers, but its two
  `estate-separation` waivers are one exception in docket terms — same rule, neither path-scoped —
  so they are one row (`D-11`) rather than two identical ones a matcher would have to choose between
  ([#1005](https://github.com/srikanth235/centraid/issues/1005)).
- **`waiver-docket` is one rule across three surfaces, at the hook door.** The brief asked for a
  window/`warn` half and a hook/`error` half; a pack row carries one door per rule id. The rule is
  declared `hook`/`warn`, so the register's shape and the docket-less suppression are fatal at the
  commit hook, and the spending half returns early when `stamp.door === "hook"` — the same asymmetry
  `estate-separation` already carries, for the same reason
  ([R-1005-14](../docs/decisions.md#governance-as-a-constitution-1005)).
- **`governance:law:test` is classified rung 1, not rung 2.** It already runs in CI inside
  `scripts:test`, which `check:push` names at rung 1 and `ci.yml` re-runs, so no `ci.yml` change was
  invented for it; the register records where it is enforced rather than where it might be
  ([R-1005-25](../docs/decisions.md#governance-as-a-constitution-1005)).

## Inherited red

Measured against `origin/main` at `87cf642c` in a sibling worktree
(`git worktree add /home/user/centraid-main 87cf642c` + `bun install --frozen-lockfile`, removed
after), then on this branch at `da7656fb`. Same three gates, same three messages, failure for
failure. None of them touches `.governance/`, `scripts/ci/gate-classes.json` or any file this issue
edits.

| Gate | Failure at `origin/main` 87cf642c | On this branch |
| --- | --- | --- |
| `lint:quality-knobs` | `tests/quality/classification-ratchet.json`: stale fingerprint for `packages/server/src/automation/manifest/manifest.ts` and for `packages/server/src/serve/health-registry.ts` | identical, both lines |
| `lint:mobile-testids` | `apps/mobile/src/kit/test-ids.ts:165 [unapplied-id]` — declares `locker-gate-field`, nothing in `apps/mobile/src` applies it | identical |
| `lint:e2e-wiring` | `[matrix-owner]` — the claims ledger names `tests/agent-e2e-mobile/flows/volume-proof.mjs` as evidence for `removedMinimumTestsFlows.mobile-volume-proof.owner`, no lane schedules it | identical |

`39/42 product gates passed` on both sides. The remaining `lint:product` gates, and every other
gate this lane ran, are green.

## Corrections to the plan

What the waves did differently from the issue's execution plan, and the ruling that decided each.

- **Wave 5 (doors) folded into wave 4 rather than running as its own wave.** The `door` field is
  read by the config builder from the first commit of wave 1; by the time the last rule landed
  there was nothing left for a separate wave to do but add the field to
  `scripts/ci/gate-classes.json`, which is one commit ([R-1005-25](../docs/decisions.md#governance-as-a-constitution-1005)).
- **`docs/**` is registry, not territory.** The plan's estate sketch put law against territory and
  left docs unstated. A doc records what is; it never changes what the next change may do, so
  filing it as territory would have made every doc pass an estate violation
  ([R-1005-19](../docs/decisions.md#governance-as-a-constitution-1005)).
- **`waiver-docket` is one door, not two.** The plan implies the whole rule runs at the window. Its
  register-shape half is answerable from the commit being written and its spending half is not, so
  the rule is declared `hook`/`warn` and returns early on the spending half at the hook door — the
  same asymmetry `estate-separation` carries ([R-1005-14](../docs/decisions.md#governance-as-a-constitution-1005)).
- **`.github/workflows/ci.yml` was not touched.** `governance:law:test` already runs in CI inside
  `scripts:test`, which `check:push` names at rung 1 and `ci.yml` re-runs. The gate register records
  where a check is enforced, not where it might be
  ([R-1005-25](../docs/decisions.md#governance-as-a-constitution-1005)).
- **commitlint is a config shape, not a CLI.** The issue says "`commit-message-format` via commitlint
  config ownership". commitlint's API is asynchronous and an ESLint rule is synchronous, so the
  policy lives in `.governance/law/commitlint.config.mjs` in commitlint's shape and
  `@commitlint/cli` is not installed — the vocabulary without the dependency
  ([R-1005-5](https://github.com/srikanth235/centraid/issues/1005)).
- **Eleven docket rows, not twelve.** The sweep found twelve escape-hatch uses; two of them are the
  same rule, unscoped by path, spent twice by the same repeal, so they are one row rather than two
  identical ones ([R-1005-20](../docs/decisions.md#governance-as-a-constitution-1005)).
- **The window door does not demote severity.** R-1005-3 read literally would have turned
  `receipt-per-issue` — a directive that blocked — into a warning at the window. That is weakening
  policy without editing it, so the door decides which rules run and the pack row decides how loud
  (Lane B decisions, deviation 1).

## Owner items

Five things this issue cannot finish on an agent's authority. Each is an explicit question with the
options and a recommendation; none is recorded as done.

1. **Q-1005-3 — is branch protection on?** `estate-separation`, `doctrine-citation` and
   `waiver-docket` are declared `warn` because their host backing is owner-enabled and unconfirmed.
   *Options:* (a) enable required review from code owners on `main` over the eleven law paths and
   move the three rows to `error` in one commit; (b) leave them `warn` and accept that the law
   estate is advisory. **Recommendation: (a).** The rules are the whole trust boundary of this
   issue; without the host behind them an agent can land a law change and use it in the next PR,
   which is the failure the issue was opened to close.
2. **Q-1005-3, second half — the boundary demonstration.** The acceptance box asks for a law-only PR
   from a non-owner account, blocked, recorded here. *Options:* (a) the owner opens one from a
   second account after enabling protection and pastes the block into this receipt; (b) the box
   stays unchecked and the claim is never made. **Recommendation: (a), after item 1** — it is the
   only evidence that distinguishes "configured" from "believed configured".
3. **Enable the required check `governance`.** `governance.yml` is kit-managed and rolls up into no
   aggregate, so nothing requires it today; `registry-completeness` and `receipt-per-issue` are
   `error` on the assumption that it does. *Options:* (a) add `governance` to the required set
   beside `check`; (b) demote both rules to `warn`. **Recommendation: (a)** — (b) would mean a
   receipt-less merge passes, which is the state before #988.
4. **Grant D-9, D-10 and D-11 by merging this PR under owner review.** All three were filed and
   spent inside this arrival, which `waiver-docket` correctly reports as a self-grant. They cannot
   be pre-landed: D-9 and D-10 waive `doc-integrity` over the deletion of `COSTS.md` and
   `STEERING.md`, and D-11 waives `estate-separation` for the repeal that touches the rules and the
   files being repealed in one act. *Options:* (a) merge under owner review, which is what makes the
   authority the owner's; (b) split the repeal across two PRs so the rows land first.
   **Recommendation: (a)** — (b) leaves the trunk citing two deleted paths between the PRs.
5. **Q-1005-1 and Q-1005-2 — two doctrines with no statute.** The docs doctrine (link integrity, no
   narrated history) and the performance doctrine (latency budgets, nothing size-scaling on the
   request path). *Options for each:* (a) a rule — a link checker plus a narration tripwire for the
   first, `tests/journeys.json` as the statute for the second; (b) a `docs/decisions.md` row that
   makes it a cited doctrine without a rule; (c) leave it reviewer-judged and cited here.
   **Recommendation: (a) for the docs link half — it is mechanical and it lost its enforcing
   directive when the vendored `governance-kit/docs` pack went; (b) for the other three**, which
   #659 and #767 both recorded as shape-level and not `grep`-decidable.

## Audit

judge: pending — root re-judges at close.
