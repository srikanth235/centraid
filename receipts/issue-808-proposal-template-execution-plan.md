# Issue #808 — proposal template carries an execution plan for umbrella work

GitHub issue: [#808](https://github.com/srikanth235/centraid/issues/808)

The proposal template captured what and why but had no home for how. For
umbrella work the how is where correctness lives — [docs/multi-agent.md](../docs/multi-agent.md)
already says the root agent's plan carries invariants, slice ownership, and
ordering, and that "the plan is not a task list". Nothing in the template
asked for any of it.

## Checklist

- [x] `proposal.yml` has a required `Size` dropdown offering a single-PR option and an umbrella option, whose description points at `docs/multi-agent.md`
- [x] `proposal.yml` has an optional `Execution plan` textarea placed between Scope and Acceptance criteria, whose placeholder prompts for invariants, waves with per-slice file ownership and exit criteria, seams, and risks
- [x] The plan field uses `placeholder` rather than `value`, so an unfilled plan leaves no boilerplate in the issue body
- [x] No issue template placeholder names a path that does not exist in this repo
- [x] All three files under `.github/ISSUE_TEMPLATE/` still parse as YAML and keep their existing required fields

## User impact

None at runtime. The change is to the GitHub issue forms a maintainer or agent
fills in before work starts.

## What changed

`proposal.yml` has a required `Size` dropdown offering a single-PR option and
an umbrella option, whose description points at `docs/multi-agent.md`.
`proposal.yml` has an optional `Execution plan` textarea placed between Scope
and Acceptance criteria, whose placeholder prompts for invariants, waves with
per-slice file ownership and exit criteria, seams, and risks. The plan field
uses `placeholder` rather than `value`, so an unfilled plan leaves no
boilerplate in the issue body. No issue template placeholder names a path that
does not exist in this repo.

**`Size` dropdown** in `.github/ISSUE_TEMPLATE/proposal.yml`, required, sits
after Decision. Two options: `Single PR — one agent, one focused diff` and
`Umbrella — orchestrated across slices and PR waves`. Its description restates
the umbrella contract from `CLAUDE.md` — one issue, no child issues, slices are
sub-agents and PR waves under it, one receipt — so a reader knows before the
plan field whether `docs/multi-agent.md` norms apply.

**`Execution plan` textarea**, optional, between Scope and Acceptance criteria.
Scope bounds the work, the plan sequences it, and acceptance plus validation
close the loop. The placeholder is written in the vocabulary
`docs/multi-agent.md` already uses so a root agent's plan and the issue's plan
field are the same artifact: invariants that must hold at every intermediate
commit; waves where a slice owns files no other in-flight slice touches, each
with an exit criterion and its dependency; the seams the root re-checks between
waves; risks paired with a mitigation or a deliberate acceptance to record in
`docs/decisions.md`.

**Optional, not required.** Most proposals are single-PR sized and the
implementing agent plans those itself. A required plan field on those produces
boilerplate, and boilerplate trains both humans and models to skim. The `Size`
answer carries the signal instead; the plan field is a soft norm with no CI
gate.

**Placeholder, not `value`.** GitHub renders `value` into the created issue body
and `placeholder` only as ghost text. Using `placeholder` means an unfilled plan
on a single-PR proposal leaves nothing behind, while the guidance is still in
front of whoever needs it.

**Stale placeholders corrected.** The Decision placeholder named
`governance/SKILL.md` and `governance/references/VERBS.md`, and the bug
template's Environment field asked for a "governance-kit version" — all
inherited from another repo, none present in this tree. Decision now names
`packages/core/src/protocol/routes.ts` and
`packages/server/src/routes/backup-routes.ts`; Environment now asks for the
Centraid version and the surface (desktop / web PWA / mobile).

## Decisions

An execution plan belongs in the issue, not in a `plan.md` file. `CLAUDE.md`
places intent in proposal issues rather than files, and a plan file would drift
from the state docs it duplicates. The ttfx reference plan
(<https://github.com/omacom-io/ttfx/blob/master/plan.md>) is a living
implementation document, effectively the root agent's own working plan, not an
issue-time artifact — its phase-and-exit-criteria shape is worth borrowing, its
file-shaped home is not.

One template with a conditional section, not a separate umbrella template. Two
templates covering the same handoff drift apart, and the split forces the author
to classify before they have written the scope.

## Out of scope

- Restructuring the bug template beyond the one Environment line. It is fit for
  its job.
- Making the plan field required, or adding a CI gate that checks an umbrella
  issue carries one. The `Size` answer is the signal; enforcement can follow if
  umbrella proposals actually ship without plans.
- A `plan.md`-style file in the repo.
- Backfilling a plan onto open umbrella issues.

## Verification

```sh
python3 -c "import yaml; [yaml.safe_load(open(f)) for f in ('.github/ISSUE_TEMPLATE/proposal.yml','.github/ISSUE_TEMPLATE/bug.yml','.github/ISSUE_TEMPLATE/config.yml')]"
```

- All three files under `.github/ISSUE_TEMPLATE/` still parse as YAML and keep
  their existing required fields — the parse enumerates `proposal.yml` as
  markdown, `context` (required), `decision` (required), `size` (required),
  `scope` (required), `execution-plan` (optional), `acceptance` (required),
  `validation` (required), `open-questions` (required), and `bug.yml` unchanged
  at four required fields plus optional `notes`.
- Demonstrated red: the first draft of the `Execution plan` description
  contained an unquoted `loses: what`, and the parse failed with
  `mapping values are not allowed here ... line 62, column 153`. Rewording to
  an em-dash cleared it. The parse check is therefore load-bearing, not
  decorative.
- Every path named in a template placeholder resolves in this tree:
  `packages/core/src/protocol/routes.ts`,
  `packages/server/src/routes/backup-routes.ts`,
  `packages/core/src/protocol/`, `packages/server/src/routes/`,
  `packages/client/`, `docs/multi-agent.md`, `docs/decisions.md`.
- `bun run format:check` not run — `oxfmt` is unavailable in this container
  (no `node_modules`; `bun install` not run). The change touches only
  `.github/ISSUE_TEMPLATE/*.yml`, which oxfmt does not format. CI covers it.
- The rendered forms are not screenshotted; GitHub renders issue forms only
  from the default branch, so the visual check happens after merge.

## Audit

- (1) What changed vs diff: PASS — the diff is two files. `proposal.yml` gains a
  `dropdown` block `id: size` with two options and `required: true`, and a
  `textarea` block `id: execution-plan` with `required: false` and a
  `placeholder` (no `value`), inserted after `scope` and before `acceptance`;
  its Decision placeholder swaps two `governance/*` paths for
  `packages/core/src/protocol/routes.ts` and
  `packages/server/src/routes/backup-routes.ts`. `bug.yml` changes one
  `description` line on the `environment` field. No other field, label, or
  required flag moves.
- (2) Checked items realized in the diff: PASS — the `Size` dropdown, its
  `docs/multi-agent.md` reference, the `Execution plan` field with its
  placement and placeholder contents, and the `placeholder`-not-`value` choice
  are all readable in the diff. The path-existence and YAML-parse items are
  verification claims, evidenced under `## Verification` above.
- (3) Checklist mirrors the issue: PASS — issue #808 carries the same five
  acceptance items, in the same order and wording, as this receipt's
  `## Checklist`. GitHub boxes are unchecked; the receipt marks them `[x]`.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-16 | claude-code | 800943cd-ca5c-52a5-86d5-fde53a00cc4f |
