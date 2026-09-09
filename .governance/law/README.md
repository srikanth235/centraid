# `.governance/law` — the constitution as lint rules

The governance directives under `.governance/packs/` answer "is this file
well-formed?" one shell script at a time. This directory answers a different
question — "is this *change* lawful?" — and it answers it with a linter rather
than with more bash, because everything such a check needs (a rule catalog,
severities, per-line suppression with a reason, a machine-readable report, a
unit-test harness) is machinery ESLint already ships. Nothing here re-implements
any of it.

## What lives here

| Path | What it is |
| --- | --- |
| `packs/<pack>.json` | The law as *declared*: which rules a pack enables, at which severity, behind which door, and which paths are law |
| `rules/<id>.mjs` | One rule, defined through `lib/rule.mjs` |
| `rules/<id>.test.mjs` | That rule's cases, through ESLint's own `RuleTester` |
| `lib/rule.mjs` | `defineRule` (the metadata every rule carries) and `ruleTester` |
| `lib/digest.mjs` | The managed-tree digest algorithm, in JS, byte-identical to the pack's `lib/digest.sh` |
| `lib/estates.mjs` | The three estates — which body of the repository a path belongs to |
| `lib/gates.mjs` | The gate register: which tighten-only ledgers a change moved, and which way |
| `eslint.config.mjs` | **Derived** from the packs. Never hand-written |
| `arrival.mjs` | The generator: turns a commit range into `out/arrival.json`. Split across `lib/git.mjs`, `lib/registries.mjs` and `lib/managed.mjs`; all of it is under the managed-tree digest |
| `digest.mjs` | `--record` re-records the generator's own digests in `install.yaml` |
| `parity.mjs` | Replays the deleted shell runner against these rules over real history |
| `commitlint.config.mjs` | The commit-subject policy, in commitlint's config shape |
| `run.mjs` | The runner: generate, lint, report one line per rule |
| `front-page.mjs` | Renders a run as the PR-body front page |
| `fixtures/` | Checked-in arrival records the tests pin the generator against |
| `out/` | Generated; git-ignored |

## The three estates

Every tracked path belongs to exactly one estate, and `arrival.json` tags every
file row — per commit and in the aggregate — with it.

| Estate | What it is | Where it is declared |
| --- | --- | --- |
| `law` | The rules themselves. Editing it changes what the *next* change is allowed to do | the union of every pack's `lawPaths` |
| `registry` | The adjudication and evidence layer: receipts, `CHANGELOG.md`, `docs/decisions.md`, `QUALITY.md`, the docket. Editing it records what happened; it never changes what is permitted | `REGISTRY_PATHS` in `lib/estates.mjs` |
| `territory` | Everything else — the product the law is for | everything not matched above |

`registry` is tested first, because `.governance/law/docket.json` also matches
the law glob `.governance/**` and a register of exceptions is evidence, not a
rule.

## The rules

| Rule | Door | What it enforces | Statute |
| --- | --- | --- | --- |
| `commit-message-format` | hook | Conventional Commit subjects that name their issue, ≤ 100 chars | [CONSTITUTION.md](../../CONSTITUTION.md#commit-message-format) |
| `doc-integrity` | hook | Frozen documents may only be added to — receipts, the Evolution Log, COSTS, STEERING, QUALITY's Resolved section | [CONSTITUTION.md](../../CONSTITUTION.md#doc-integrity) |
| `managed-tree-integrity` | hook | Managed governance files, and the law's own generator, match their recorded digests | [CONSTITUTION.md](../../CONSTITUTION.md#managed-tree-integrity) |
| `receipt-per-issue` | window | One well-formed receipt per issue, and a completed change carries it | [CONSTITUTION.md](../../CONSTITUTION.md#receipt-per-issue) |
| `estate-separation` | hook | A commit edits the law or the product, never both | [CONSTITUTION.md](../../CONSTITUTION.md#estate-separation) |

All four were vendored shell directives in `governance-kit/audit` until #1005.
`parity.mjs` replays both runners over the last 50 trunk commits and fails on any
disagreement that is not written down in `parity-expectations.json` with a
reason. Run it before changing any of them.

## The two doors

A rule is answerable somewhere, and where it is answerable is part of what it
is. `GOVERNANCE_DOOR` selects which configuration the runner builds.

- **hook** — answerable from the **commit being written** alone (the runner
  stamps `door` into the record, so a rule can tell the staged set from the
  branch's history), cheap enough for the pre-commit rung, and **fatal there
  whatever the pack row says**. A hook rule
  that cannot stop the commit is a hook rule for nothing, and the hook is the
  one place where the author is still holding the change.
- **window** — the whole law, run over a range at review time, **every rule at
  its declared pack severity**. That is the catalog's one asymmetry, and it is
  deliberate: `estate-separation` is declared `warn` because the host backing
  that would make it a refusal (branch protection over the `law` estate, and
  the reviewers `.github/CODEOWNERS` names) is owner-enabled and not confirmed
  enabled. A red gate must not stand in for a review that has not happened,
  while the hook may still refuse locally, where refusing costs nothing.
- **owner** — recorded on the rule, enforced by neither door. It names a
  judgement that belongs to the repository owner.

## What rules enforce and what they only observe

**Nothing an agent can edit is the authority for what an agent may do.** Every
file in this directory is agent-writable, so nothing here *prevents* anything:
these rules observe a change and report on it. The enforcement is the host's —
GitHub branch protection, required checks, and the reviewers `.github/CODEOWNERS`
names — and only the repository owner can turn those on or off. That boundary is
owner-enabled: the host settings are configured outside the repository, and a
rule can report that a change looks unlawful without being able to stop it.

`defineRule` makes each rule say which half it is: `enforces` (what the rule
makes impossible on its own) and `observes` (what it reports for a human to
settle). A rule must declare at least one.

## Adding a rule

One commit, three edits:

1. `rules/<id>.mjs` — `export default defineRule({ id, statute, door, … })`.
   `statute` is the `CONSTITUTION.md` anchor the rule enforces; it becomes
   `meta.docs.url`, so the citation travels with every finding.
2. `rules/<id>.test.mjs` — `ruleTester().run(id, rule, { valid, invalid })`.
   A rule changed without its test changed is not a reviewable change.
3. A row in the owning `packs/<pack>.json`: `"<id>": { "severity": …, "door": … }`.

`severity: "off"` repeals a rule without deleting it.

## Its own dependency tree

`package.json` here is private and pins ESLint exactly. It is separate from the
root install on purpose: the managed `.github/workflows/governance.yml` runs
`bash .governance/run.sh` with no `bun install` before it, so the law directive
installs its own deps with `npm ci --prefix .governance/law` when they are
missing. That also keeps a second linter's rule packages out of the product's
dependency graph.

## Running it

```
bun run governance:law          # the window door, over the current range
bun run governance:law:test     # the rule and generator tests
bash .governance/run.sh law     # the same, through the one governance entry point
```
