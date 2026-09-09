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
| `eslint.config.mjs` | **Derived** from the packs. Never hand-written |
| `arrival.mjs` | The generator: turns a commit range into `out/arrival.json` |
| `run.mjs` | The runner: generate, lint, report one line per rule |
| `front-page.mjs` | Renders a run as the PR-body front page |
| `fixtures/` | Checked-in arrival records the tests pin the generator against |
| `out/` | Generated; git-ignored |

## The two doors

A rule is answerable somewhere, and where it is answerable is part of what it
is. `GOVERNANCE_DOOR` selects which configuration the runner builds.

- **hook** — answerable from the change set alone, cheap enough for the
  pre-commit rung, and fatal there. The commit does not happen.
- **window** — the whole law, run over a range at review time. Hook rules stay
  fatal; the rest report as warnings, because a warning is the honest verdict
  for something a machine can see but only a person can settle.
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
